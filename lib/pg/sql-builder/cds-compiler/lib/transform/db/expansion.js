'use strict';

const {
  hasAnnotationValue, getUtils,
  applyTransformations,
  setDependencies,
  walkCsnPath,
} = require('../../model/csnUtils');
const { csnRefs, implicitAs } = require('../../model/csnRefs');
const { setProp, isBetaEnabled } = require('../../base/model');

/**
 * For keys, columns, groupBy and orderBy, expand structured things.
 * Replace them with their flattened leaves, keeping the overall order intact.
 *
 * @param {CSN.Model} csn
 * @param {CSN.Options} options
 * @param {string} pathDelimiter
 * @param {object} messageFunctions
 * @param {Function} messageFunctions.error
 * @param {Function} messageFunctions.info
 * @param {Function} messageFunctions.throwWithError
 */
function expandStructureReferences(csn, options, pathDelimiter, { error, info, throwWithError }) {
  const {
    isStructured, get$combined, getFinalBaseType, getServiceName,
  } = getUtils(csn);
  let { effectiveType, inspectRef } = csnRefs(csn);

  if (isBetaEnabled(options, 'nestedProjections'))
    rewriteExpandInline();


  applyTransformations(csn, {
    keys: (parent, name, keys, path) => {
      parent.keys = expand(keys, path.concat('keys'), true);
    },
    columns: (parent, name, columns, path) => {
      const artifact = csn.definitions[path[1]];
      if (!hasAnnotationValue(artifact, '@cds.persistence.table')) {
        const root = get$combined({ SELECT: parent });
        parent.columns = replaceStar(root, columns, parent.excluding);
        parent.columns = expand(parent.columns, path.concat('columns'), true);
      }
    },
    groupBy: (parent, name, groupBy, path) => {
      parent.groupBy = expand(groupBy, path.concat('groupBy'));
    },
    orderBy: (parent, name, orderBy, path) => {
      parent.orderBy = expand(orderBy, path.concat('orderBy'));
    },
  });

  /**
   * Turn .expand/.inline into normal refs. @cds.persistence.skip .expand with to-many (and all transitive views).
   * For such skipped things, error for usage of assoc pointing to them and and ignore publishing of assoc pointing to them.
   */
  function rewriteExpandInline() {
    const { cleanup, _dependents } = setDependencies(csn);

    const entity = findAnEntity();
    const toDummyfy = [];

    applyTransformations(csn, {
      columns: (parent, name, columns, path) => {
        const artifact = csn.definitions[path[1]];
        // get$combined expects a SET/SELECT - so we wrap the parent
        // (which is the thing inside SET/SELECT)
        // We can directly use SELECT here, as only projections and SELECT can have .columns
        const root = get$combined({ SELECT: parent });
        if (!hasAnnotationValue(artifact, '@cds.persistence.table')) {
          const rewritten = rewrite(root, parent.columns, parent.excluding);
          parent.columns = rewritten.columns;
          if (rewritten.toMany.length > 0) {
            markAsToDummyfy(artifact, path[1]);
            if (getServiceName(path[1]) === null)
              error( null, [ 'definitions', path[1] ], { name: path[1] }, 'Unexpected .expand with to-many association in entity $(NAME), which is outside any service');
          }
        }
      },
    });

    dummyfy();

    cleanup.forEach(fn => fn());

    ({ effectiveType, inspectRef } = csnRefs(csn));


    const publishing = [];

    applyTransformations(csn, {
      target: (parent, name, target, path) => {
        if (toDummyfy.indexOf(target) !== -1) {
          publishing.push({
            parent, name, target, path: [ ...path ],
          });
        }
      },
      from: check,
      columns: check,
      where: check,
      groupBy: check,
      orderBy: check,
      having: check,
      limit: check,
    });


    /**
     * Check for usage of associations to skipped.
     * While we're at it, kill publishing of such assocs in columns.
     *
     * @param {object} parent
     * @param {string} name
     * @param {Array} parts
     * @param {CSN.Path} path
     */
    function check(parent, name, parts, path) {
      const inColumns = name === 'columns';
      const kill = [];
      for (let i = 0; i < parts.length; i++) {
        const obj = parts[i];
        if (!(obj && obj.ref) || obj.$scope === 'alias')
          continue;

        const links = obj._links || inspectRef(path.concat([ name, i ])).links;

        if (!links)
          continue;

        // Don't check the last element - to allow association publishing in columns
        for (let j = 0; j < (inColumns ? links.length - 1 : links.length); j++) {
          const link = links[j];
          if (!link)
            continue;

          const { art } = link;
          if (!art)
            continue;

          const pathStep = obj.ref[j].id ? obj.ref[j].id : obj.ref[j];
          const target = art.target ? art.target : pathStep;
          if (toDummyfy.indexOf(target) !== -1) {
            error( null, obj.$path, {
              id: pathStep, elemref: obj, name,
            }, 'Unexpected “@cds.persistence.skip” annotation on Association target $(NAME) of $(ID) in path $(ELEMREF) was skipped because of .expand in conjunction with to-many');
          }
        }

        if (inColumns) {
          const { art } = links[links.length - 1];

          if (art) {
            const pathStep = obj.ref[obj.ref.length - 1].id ? obj.ref[obj.ref.length - 1].id : obj.ref[obj.ref.length - 1];
            const target = art.target ? art.target : pathStep;
            if (toDummyfy.indexOf(target) !== -1)
              kill.push(i);
          }
        }
      }

      for (let i = kill.length - 1; i >= 0; i--)
        parent[name].splice(kill[i]);
    }

    // We would be broken if we continue with assoc usage to now skipped
    throwWithError();


    for (const {
      parent, target, path,
    } of publishing) {
      const last = parent.$path[parent.$path.length - 1];
      const grandparent = walkCsnPath(csn, parent.$path.slice(0, -1));

      if (typeof last === 'number')
        grandparent.splice(last);
      else
        delete grandparent[last];

      info(null, path, { name: last, target }, 'Ignoring association $(NAME) with target $(TARGET), because it was skipped because of .expand in conjunction with to-many');
    }

    /**
     * Mark the given artifact and all (transitively) dependent artifacts as `toDummify`.
     * This means that they will be replaced with simple dummy views in @dummify
     *
     * @param {CSN.Artifact} artifact
     * @param {string} name
     */
    function markAsToDummyfy(artifact, name) {
      const stack = [ [ artifact, name ] ];
      while (stack.length > 0) {
        const [ a, n ] = stack.pop();
        if (a[_dependents]) {
          Object.entries(a[_dependents]).forEach(([ dependentName, dependent ]) => {
            stack.push([ dependent, dependentName ]);
          });
        }
        toDummyfy.push(n);
      }
    }

    /**
     * Replace the artifacts in `toDummify` with simple dummy views as produced by createDummyView.
     */
    function dummyfy() {
      for (const artifactName of [ ...new Set(toDummyfy) ])
        csn.definitions[artifactName] = createDummyView(entity);
    }


    /**
     * Get the next base for resolving  a *.
     * Keep the current base unless we are now navigating into a structure or association.
     *
     * @param {CSN.Column} parent
     * @param {CSN.Artifact} base The current base
     * @returns {CSN.Artifact}
     */
    function nextBase(parent, base) {
      if (parent.ref) {
        const finalBaseType = getFinalBaseType(parent._art.type);
        const art = parent._art;

        if (finalBaseType === 'cds.Association' || finalBaseType === 'cds.Composition')
          return csn.definitions[art.target].elements;

        return art.elements || finalBaseType.elements;
      }

      return base;
    }

    /**
     * Rewrite expand and inline to "normal" refs
     *
     * @param {CSN.Artifact} root All elements visible fromt he query source ($combined)
     * @param {CSN.Column[]} columns
     * @param {string[]} excluding
     * @returns {{columns: Array, toManys: Array}} Object with rewritten columns (.expand/.inline) and with any .expand + to-many
     */
    function rewrite(root, columns, excluding) {
      const allToMany = [];
      const newThing = [];
      // Replace stars - needs to happen here since the .expand/.inline first path step affects the root *
      columns = replaceStar(root, columns, excluding);
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        if (col.expand) {
          // TODO: Can col.ref be empty without an as? Assumption is it cannot - if it has, it's an error, we throw, compiler checks.
          const { expanded, toManys } = expandInline(root, col, col.ref || [], [ dbName(col) ]);

          allToMany.push(...toManys);
          newThing.push(...expanded);
        }
        else if (col.inline) {
          const { expanded, toManys } = expandInline(root, col, col.ref || [], []);

          allToMany.push(...toManys);
          newThing.push(...expanded);
        }
        else {
          newThing.push(col);
        }
      }

      return { columns: newThing, toMany: allToMany };
    }

    /**
     * Check wether the given object is a to-many association
     *
     * @param {CSN.Element} obj
     * @returns {boolean}
     */
    function isToMany(obj) {
      if (!obj._art)
        return false;
      const eType = effectiveType(obj._art);
      return (eType.type === 'cds.Association' || eType.type === 'cds.Composition') && eType.cardinality && eType.cardinality.max !== 1;
    }

    /**
     * Rewrite the expand/inline. For expand, keep along the alias - for inline, only leaf-alias has effect.
     * Expand * into the corresponding leaves - correctly handling .exlcluding and shadowing.
     *
     * Iterative, to not run into stack overflow.
     *
     * @param {CSN.Artifact} root All elements visible fromt he query source ($combined)
     * @param {CSN.Column} col Column to expand
     * @param {Array} ref Ref so far
     * @param {Array} alias Any start-alias
     * @returns {{expanded: Array, toManys: Array}} Object with expanded .expand/.inline and with any .expand + to-many
     */
    function expandInline(root, col, ref, alias) {
      const toManys = [];
      const expanded = [];
      const stack = [ [ root, col, ref, alias ] ];

      while (stack.length > 0) {
        const [ base, current, currentRef, currentAlias ] = stack.pop();
        if (isToMany(current) && current.expand) {
          toManys.push({ art: current, ref: currentRef, as: currentAlias.join(pathDelimiter) });
        }
        else if (current.expand) {
          current.expand = replaceStar(nextBase(current, base), current.expand, current.excluding);
          for (let i = current.expand.length - 1; i >= 0; i--) {
            const sub = current.expand[i];
            stack.push([ nextBase(current, base), sub, sub.ref ? currentRef.concat(sub.ref) : currentRef, !sub.inline ? currentAlias.concat(dbName(sub)) : currentAlias ]);
          }
        }
        else if (current.inline) {
          current.inline = replaceStar(nextBase(current, base), current.inline, current.excluding);
          for (let i = current.inline.length - 1; i >= 0; i--) {
            const sub = current.inline[i];
            stack.push([ nextBase(current, base), sub, sub.ref ? currentRef.concat(sub.ref) : currentRef, !sub.inline ? currentAlias.concat(dbName(sub)) : currentAlias ]);
          }
        }
        else if (current.xpr || current.args) {
          // We need to re-write refs in the .xpr/.args so they stay resolvable - we need to prepend the currentRef
          rewriteXprArgs(current, currentRef);
          expanded.push(Object.assign({}, current, { as: currentAlias.join(pathDelimiter) } ));
        }
        else if (current.val !== undefined || current.func !== undefined) {
          expanded.push(Object.assign(current, { as: currentAlias.join(pathDelimiter) }));
        }
        else {
          expanded.push({ ref: currentRef, as: currentAlias.join(pathDelimiter) });
        }
      }

      return { expanded, toManys };
    }

    /**
     * Rewrite refs in the .xpr/.args to stay resolvable
     *
     * @param {object} parent Thing that has an .xpr/.args
     * @param {string[]} ref Ref so far
     */
    function rewriteXprArgs(parent, ref) {
      const stack = [ [ parent, ref ] ];
      while (stack.length > 0) {
        const [ current, currentRef ] = stack.pop();
        if (current.xpr) {
          for (let i = 0; i < current.xpr.length; i++) {
            const part = current.xpr[i];
            if (part.ref) {
              part.ref = currentRef.concat(part.ref);
              // part.as = currentAlias.concat(part.as || part.ref[ref.length - 1]).join(pathDelimiter);
              current.xpr[i] = part;
              stack.push([ part, part.ref ]);
            }
            else {
              stack.push([ part, currentRef ]);
            }
          }
        }
        if (current.args) {
          for (let i = 0; i < current.args.length; i++) {
            const part = current.args[i];
            if (part.ref) {
              part.ref = currentRef.concat(part.ref);
              // part.as = currentAlias.concat(part.as || part.ref[ref.length - 1]).join(pathDelimiter);
              current.args[i] = part;
              stack.push([ part, part.ref ]);
            }
            else {
              stack.push([ part, currentRef ]);
            }
          }
        }
      }
    }

    /**
     * Find any entity from the model so we can use it as the query source for our dummies.
     *
     * @returns {string|null} Name of any entity
     */
    function findAnEntity() {
      for (const [ name, artifact ] of Object.entries(csn.definitions)) {
        if (artifact.kind === 'entity' && !artifact.query)
          return name;
      }
      return null;
    }

    /**
     * Create a simple dummy view marked with @cds.persistence.skip
     *
     * @param {string} source
     * @returns {CSN.Artifact}
     */
    function createDummyView(source) {
      const elements = Object.create(null);
      elements.one = {
        '@Core.Computed': true,
        type: 'cds.Integer',
      };
      const artifact = {
        '@cds.persistence.skip': true,
        kind: 'entity',
        query: {
          SELECT: {
            from: {
              ref: [
                source,
              ],
            },
            columns: [
              {
                val: 1,
                as: 'one',
                cast: {
                  type: 'cds.Integer',
                },
              },
            ],
          },
        },
        elements,
      };

      setProp(artifact, '$wasToMany', true);

      return artifact;
    }
  }


  /**
   * Process thing and expand all structured refs inside
   *
   * @param {Array} thing
   * @param {CSN.Path} path
   * @param {boolean} [withAlias=false] Wether to "expand" the (implicit) alias aswell.
   * @returns {Array} New array - with all structured things expanded
   */
  function expand(thing, path, withAlias = false) {
    const newThing = [];
    for (let i = 0; i < thing.length; i++) {
      const col = thing[i];
      if (col.ref && col.$scope !== '$magic') {
        const _art = col._art || inspectRef(path.concat(i)).art;
        if (_art && isStructured(_art))
          newThing.push(...expandRef(_art, col.ref, col.as, col.key || false, withAlias));

        else
          newThing.push(col);
      }
      else if (col.ref && col.$scope === '$magic' && col.ref[0] === '$user' && !col.as) {
        col.as = implicitAs(col.ref);
        newThing.push(col);
      }
      else {
        newThing.push(col);
      }
    }

    return newThing;
  }

  /**
   * Expand the ref and - if requested - expand the alias with it.
   *
   * Iterative, to not run into stack overflow.
   *
   * @param {CSN.Element} art
   * @param {Array} ref
   * @param {Array} alias
   * @param {boolean} isKey True if the ref obj has property key: true
   * @param {boolean} withAlias
   * @returns {Array}
   */
  function expandRef(art, ref, alias, isKey, withAlias) {
    const expanded = [];
    const stack = [ [ art, ref, [ alias || ref[ref.length - 1] ] ] ];
    while (stack.length > 0) {
      const [ current, currentRef, currentAlias ] = stack.pop();
      if (isStructured(current)) {
        for (const [ n, e ] of Object.entries(current.elements || effectiveType(current).elements).reverse())
          stack.push([ e, currentRef.concat(n), currentAlias.concat(n) ]);
      }
      else {
        const obj = { ref: currentRef };
        if (withAlias) {
          const newAlias = currentAlias.join(pathDelimiter);
          // if (alias !== undefined) // explicit alias
          obj.as = newAlias;
          // alias was implicit - to later distinguish expanded s -> s.a from explicitly written s.a
          if (alias === undefined)
            setProp(obj, '$implicitAlias', true);
        }
        if (isKey)
          obj.key = true;
        expanded.push(obj);
      }
    }

    return expanded;
  }

  /**
   * Get the effective name produced by the object
   *
   * @param {object} part A thing with a ref/as/func
   * @returns {string}
   */
  function dbName(part) {
    if (part.as)
      return part.as;
    else if (part.ref)
      return implicitAs(part.ref);
    else if (part.func)
      return part.func;
    return null;
  }

  /**
   * Replace the star and correctly put shadowed things in the right place.
   *
   * @param {Object} base The raw set of things a * can expand to
   * @param {Array} subs Things - the .expand/.inline or .columns
   * @param {string[]} [excluding=[]]
   * @returns {Array} If there was a star, expand it and handle shadowing/excluding, else just return subs
   */
  function replaceStar(base, subs, excluding = []) {
    const stars = [];
    const names = Object.create(null);
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      if (sub !== '*') {
        const name = dbName(sub);
        names[name] = i;
      }
      else {
        // There should only be one * - but be prepared for more than one
        stars.push(i);
      }
    }


    // We have stars - replace/expand them
    if (stars.length > 0) {
      const replaced = Object.create(null);
      const final = [];
      const star = [];
      // Build the result of a * - for later use
      for (const part of Object.keys(base)) {
        if (excluding.indexOf(part) === -1) {
          // The thing is shadowed - ignore names present because of .inline, as those "disappear"
          if (names[part] !== undefined && !subs[names[part]].inline) {
            replaced[part] = true;
            star.push(subs[names[part]]);
          }
          else { // the thing is not shadowed - use the name from the base
            star.push({ ref: [ part ] });
          }
        }
      }
      // Finally: Replace the stars and leave out the shadowed things
      for (let i = 0; i < subs.length; i++) {
        const sub = subs[i];
        if (sub !== '*' && !replaced[dbName(sub)])
          final.push(sub);
        else if (sub === '*')
          final.push(...star);
      }

      return final;
    }

    return subs;
  }
}

module.exports = {
  expandStructureReferences,
};
