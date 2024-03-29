'use strict';

const { forAllQueries, forEachDefinition, walkCsnPath } = require('../../model/csnUtils');
const { setProp } = require('../../base/model');
const { getRealName } = require('../../render/utils/common');
const { csnRefs } = require('../../model/csnRefs');

/**
 * Turn a `exists assoc[filter = 100]` into a `exists (select 1 as dummy from assoc.target where <assoc on condition> and assoc.target.filter = 100)`.
 *
 * Sample: select * from E where exists assoc[filter=100]
 *
 * E: assoc with target F, id as key
 * F: id as key, filter: Integer
 *
 * For a managed association `assoc`:
 * - For each of the foreign keys, create <assoc.target, assoc.target.key.ref> = <query source, assoc name, assoc.target.key.ref>
 *
 * Given the sample above:
 * - F.id = E.assoc.id -> which will later on be translated to the real foreign key E.assoc_id
 *
 * The final subselect looks like (select 1 as dummy from F where F.id = E.assoc.id and filter = 100).
 *
 * For an unmanaged association:
 * - For each part of the on-condition, we check:
 *   + Is it part of the target side: <assoc>.<path> is turned into <assoc.target>.<path>
 *   + Is it part of the source side: <path> is turned into <query source>.<path> - a leading $self is stripped-off
 *   + Is it something else: Don't touch it, leave as is
 *
 * Given that `assoc` from above has the on-condition assoc.id = id, we would generate the following:
 * - F.id = E.id
 *
 * The final subselect looks like (select 1 as dummy from E where F.id = E.id and filter = 100).
 *
 * For a $self backlink:
 * - For $self = <assoc>.<another-assoc>, we do the following for each foreign key of <another-assoc>
 *   + <assoc>.<another-assoc>.<fk> -> <assoc.target>.<another-assoc>.<fk>
 *   + Afterwards, we get the corresponding key from the source side: <query-source>.<fk>
 *   + And turn this into a comparison: <assoc.target>.<another-assoc>.<fk> = <query-source>.<fk>
 *
 * So for the sample above, given an on-condition like $self = assoc.backToE, we would generate:
 * - F.backToE.id = E.id
 *
 * The final subselect looks like (select 1 as dummy from E where F.backToE.id = E.id and filter = 100).
 *
 * @param {CSN.Model} csn
 * @param {CSN.Options} options
 * @param {Function} error
 */
function handleExists(csn, options, error) {
  const { inspectRef } = csnRefs(csn);
  forEachDefinition(csn, (artifact, artifactName) => {
    if (artifact.query) {
      forAllQueries(artifact.query, (query, path) => {
        if (!query.$generatedExists) {
          const toProcess = []; // Collect all expressions we need to process here
          if (query.SELECT && query.SELECT.where && query.SELECT.where.length > 1)
            toProcess.push([ path.slice(0, -1), path.concat('where') ]);


          if (query.SELECT && query.SELECT.columns)
            toProcess.push([ path.slice(0, -1), path.concat('columns') ]);


          if (query.SELECT && query.SELECT.from.on )
            toProcess.push([ path.slice(0, -1), path.concat([ 'from', 'on' ]) ]);

          for (const [ , exprPath ] of toProcess) {
            const expr = nestExists(exprPath);
            walkCsnPath(csn, exprPath.slice(0, -1))[exprPath[exprPath.length - 1]] = expr;
          }

          while (toProcess.length > 0) {
            const [ queryPath, exprPath ] = toProcess.pop();
            // leftovers can happen with nested exists - we then need to drill down into the created SELECT
            // to check for further exists
            const { result, leftovers } = processExists(queryPath, exprPath);
            walkCsnPath(csn, exprPath.slice(0, -1))[exprPath[exprPath.length - 1]] = result;
            toProcess.push(...leftovers.reverse()); // any leftovers - schedule for further processing
          }
        }
      }, [ 'definitions', artifactName, 'query' ]);
    }
  });

  /**
   * Get the source aliases from a join
   *
   * @param {Array} args Join args
   * @returns {object}
   */
  function getJoinSources(args) {
    let sources = Object.create(null);
    for (const join of args) {
      if (join.as) {
        sources[join.as] = join.as;
      }
      else if (join.args) {
        const subsources = getJoinSources(join.args);
        sources = Object.assign(sources, subsources);
      }
      else if (join.ref) {
        sources[join.ref[join.ref.length - 1]] = join.ref[join.ref.length - 1];
      }
    }

    return sources;
  }

  /**
   * Get the source aliases from a query - drill down somewhat into joins (is that correct?)
   *
   * @param {CSN.Query} query
   * @returns {object}
   */
  function getQuerySources(query) {
    const sources = Object.create(null);
    if (query.from.as)
      sources[query.from.as] = query.from.as;
    else if (query.from.args)
      return Object.assign(sources, getJoinSources(query.from.args));
    else if (query.from.ref)
      sources[query.from.ref[query.from.ref.length - 1]] = query.from.ref[query.from.ref.length - 1];

    return sources;
  }

  /**
   * Get the index of the first association that is found - starting the
   * search at the given startIndex.
   *
   * @param {number} startIndex Where to start searching
   * @param {object[]} links links for a ref, produced by inspectRef
   * @returns {number|null} Null if no association was found
   */
  function getFirstAssocIndex(startIndex, links) {
    for (let i = startIndex; i < links.length; i++) {
      if (links[i] && links[i].art && links[i].art.target)
        return i;
    }

    return null;
  }

  /**
   * For a given ref-array, this function is called for the first assoc-ref in the array.
   *
   * It then runs over the rest of the array and puts all other steps in the first assocs filter.
   * If the rest contains another assoc, we put all following things into that assocs filter and
   * add the sub-assoc to the previous assoc filter.
   *
   * Or in other words:
   * - exists toF[1=1].toG[1=1].toH[1=1] is found
   * - we get called with toF[1=1].toG[1=1].toH[1=1]
   * - we return toF[1=1 and exists toG[1=1 and exists toH[1=1]]]
   *
   * @param {number} startIndex The index of the thing AFTER _main in the ref-array
   * @param {string|object} startAssoc The path step that is the first assoc
   * @param {Array} startRest Any path steps after startAssoc
   * @param {CSN.Path} path to the overall ref where _main is contained
   * @returns {Array} Return the now-nested ref-array
   */
  function nestFilters(startIndex, startAssoc, startRest, path) {
    let revert;
    if (!startAssoc.where) { // initialize first filter if not present
      if (typeof startAssoc === 'string') {
        startAssoc = {
          id: startAssoc,
          where: [],
        };
        revert = () => {
          startAssoc = startAssoc.id;
        };
      }
      else {
        startAssoc.where = [];
        revert = () => {
          delete startAssoc.where;
        };
      }
    }
    const stack = [ [ null, startAssoc, startRest, startIndex ] ];
    const { links } = inspectRef(path);
    while (stack.length > 0) {
      // previous: to nest "up" if the previous assoc did not originaly have a filter
      // assoc: the assoc path step
      // rest: path steps after assoc
      // index: index of after-assoc in the overall ref-array - so we know where to start looking for the next assoc
      const workPackage = stack.pop();
      const [ previous, , rest, index ] = workPackage;
      let [ , assoc, , ] = workPackage;

      const firstAssocIndex = getFirstAssocIndex(index, links);

      const head = rest.slice(0, firstAssocIndex - index);
      const nextAssoc = rest[firstAssocIndex - index];
      const tail = rest.slice(firstAssocIndex - index + 1);

      const hasAssoc = nextAssoc !== undefined;

      if (!assoc.where && hasAssoc) { // no existing filter - and there is stuff we need to nest afterwards
        if (typeof assoc === 'string') {
          assoc = {
            id: assoc,
            where: [],
          };
          // We need to "hook" this into the previous filter.
          // Since we create a new object, we don't have a handy reference we can just manipulate
          if (previous)
            previous.where[previous.where.length - 1] = { ref: [ assoc ] };
        }
        else {
          assoc.where = [];
        }
      }
      else if (assoc.where && assoc.where.length > 0 && (hasAssoc || rest.length > 0)) {
        assoc.where.push('and');
      } // merge with existing filter

      if (hasAssoc)
        assoc.where.push('exists', { ref: [ ...head, nextAssoc ] });
      else if (rest.length > 0)
        assoc.where.push({ ref: rest });

      if (hasAssoc)
        stack.push([ assoc, nextAssoc, tail, firstAssocIndex ]);
    }

    // Seems like we did not have anything to nest into the filter - then kill it
    if (startAssoc.where.length === 0 && revert !== undefined)
      revert();

    return startAssoc;
  }

  /**
   * Walk to the expr using the given path and scan it for the "exists" + "ref" pattern.
   * If such a pattern is found, nest association steps therein into filters.
   *
   * @param {CSN.Path} exprPath
   * @returns {Array}
   */
  function nestExists(exprPath) {
    const expr = walkCsnPath(csn, exprPath);
    for (let i = 0; i < expr.length; i++) {
      if (i < expr.length - 1 && expr[i] === 'exists' && expr[i + 1].ref) {
        i++;
        const current = expr[i];
        const {
          ref, head, tail,
        } = getFirstAssoc(current, exprPath.concat(i));

        const lastAssoc = getLastAssoc(current, exprPath.concat(i));
        // toE.toF.id -> we must not end on a non-assoc - this will also be caught downstream by
        // '“EXISTS” can only be used with associations/compositions, found $(TYPE)'
        // But the error might not be clear, since it could be because of our rewritten stuff. The later check
        // checks for exists id -> our rewrite turns toE.toF.id into toE[exists toF[exists id]], leading to the same error
        if (lastAssoc.tail.length > 0)
          error(null, current.$path, { id: lastAssoc.tail[0].id ? lastAssoc.tail[0].id : lastAssoc.tail[0], name: lastAssoc.ref.id ? lastAssoc.ref.id : lastAssoc.ref }, 'Unexpected path step $(ID) after association $(NAME) in "EXISTS"');

        const newThing = [ ...head, nestFilters(head.length + 1, ref, tail, exprPath.concat([ i ])) ];
        expr[i].ref = newThing;
      }
    }

    return expr;
  }

  /**
   * Process the given expr of the given query and translate a `EXISTS assoc` into a `EXISTS (subquery)`. Also, return paths to things we need to process in a second step.
   *
   * @param {CSN.Path} queryPath Path to the query-object
   * @param {CSN.Path} exprPath Path to the expression-array to process
   * @returns {{result: TokenStream, leftovers: Array[]}} result: A new token stream expression - the same as expr, but with the expanded EXISTS, leftovers: path-tuples to further subqueries to process.
   */
  function processExists(queryPath, exprPath) {
    const toContinue = [];
    const newExpr = [];
    const query = walkCsnPath(csn, queryPath);
    const expr = walkCsnPath(csn, exprPath);
    const queryBase = query.SELECT.from.ref ? (query.SELECT.from.as || query.SELECT.from.ref[0]) : null;
    const sources = getQuerySources(query.SELECT);

    for (let i = 0; i < expr.length; i++) {
      if (i < expr.length - 1 && expr[i] === 'exists' && expr[i + 1].ref) {
        i++;
        const current = expr[i];
        const isPrefixedWithTableAlias = firstLinkIsEntityOrQuerySource(exprPath.concat(i));
        const base = getBase(queryBase, isPrefixedWithTableAlias, current, exprPath.concat(i));
        const { root, ref } = getFirstAssoc(current, exprPath.concat(i));

        if (!root.target) {
          error(null, exprPath.concat(i), { type: root.type }, '“EXISTS” can only be used with associations/compositions, found $(TYPE)');
          return { result: [], leftovers: [] };
        }

        const subselect = getSubselect(root.target, ref, sources);

        const target = subselect.SELECT.from.as; // use subquery alias as target - prevent shadowing
        if (root.keys) { // managed assoc
          translateManagedAssocToWhere(root, target, subselect, isPrefixedWithTableAlias, base, current);
        }
        else { // unmanaged assoc
          translateUnmanagedAssocToWhere(root, target, subselect, isPrefixedWithTableAlias, base, current);
        }

        newExpr.push('exists');
        if (ref && ref.where)
          subselect.SELECT.where.push(...[ 'and', ...remapExistingWhere(target, ref.where) ]);

        newExpr.push(subselect);
        toContinue.push([ exprPath.concat(newExpr.length - 1), exprPath.concat([ newExpr.length - 1, 'SELECT', 'where' ]) ]);
      }
      else { // Drill down into other places that might contain a `EXISTS <assoc>`
        if (expr[i].xpr) {
          const { result, leftovers } = processExists(queryPath, exprPath.concat([ i, 'xpr' ]));
          expr[i].xpr = result;
          toContinue.push(...leftovers);
        }
        if (expr[i].args && Array.isArray(expr[i].args)) {
          const { result, leftovers } = processExists(queryPath, exprPath.concat([ i, 'args' ]));
          expr[i].args = result;
          toContinue.push(...leftovers);
        }
        newExpr.push(expr[i]);
      }
    }

    return { result: newExpr, leftovers: toContinue };
  }

  /**
   * Translate an `EXISTS <managed assoc>` into a part of a WHERE condition.
   *
   * For each of the foreign keys, do:
   * + build the target side by prefixing `target` infront of the ref
   * + build the source side by prefixing `base` (if not already part of `current`)
   *  and the assoc name itself (current) infront of the ref
   * + Compare source and target with `=`
   *
   * If there is more than one foreign key, join with `and`.
   *
   * The new tokens are immediatly added to the WHERE of the subselect
   *
   * @param {CSN.Element} root
   * @param {string} target
   * @param {CSN.Query} subselect This subselect will in the end replace <assoc> in EXISTS <assoc>
   * @param {boolean} isPrefixedWithTableAlias
   * @param {string} base
   * @param {Token} current
   */
  function translateManagedAssocToWhere(root, target, subselect, isPrefixedWithTableAlias, base, current) {
    for (let j = 0; j < root.keys.length; j++) {
      const lop = { ref: [ target, ...root.keys[j].ref ] }; // target side
      const rop = { ref: (isPrefixedWithTableAlias ? [] : [ base ]).concat([ ...toRawRef(current.ref), ...root.keys[j].ref ]) }; // source side

      if (j > 0)
        subselect.SELECT.where.push('and');

      subselect.SELECT.where.push(...[ lop, '=', rop ]);
    }
  }

  /**
   * Turn a ref-array into an array of strings.
   *
   * @param {Array} ref Array of strings or objects with `id`
   * @returns {string[]}
   */
  function toRawRef(ref) {
    return ref.map(r => (r.id ? r.id : r));
  }

  /**
   * Translate an `EXISTS <unmanaged assoc>` into a part of a WHERE condition.
   *
   * A valid $self-backlink is handled in translateDollarSelfToWhere.
   *
   * For an ordinary unmanaged association, we do the the following for each part of the on-condition:
   * - target side: We prefix the real target and cut off the assoc-name from the ref
   * - source side w/ leading $self: We remove the $self and add the source side entity/query source
   * - source side w/o leading $self: We simply add the source side entity/query source in front of the ref
   * - all other: Leave intact, usually operators
   *
   * @param {CSN.Element} root
   * @param {string} target
   * @param {CSN.Query} subselect This subselect will in the end replace <assoc> in EXISTS <assoc>
   * @param {boolean} isPrefixedWithTableAlias
   * @param {string} base
   * @param {Token} current
   */
  function translateUnmanagedAssocToWhere(root, target, subselect, isPrefixedWithTableAlias, base, current) {
    for (let j = 0; j < root.on.length; j++) {
      const part = root.on[j];

      // we can only resolve stuff on refs - skip literals like =
      // but also keep along stuff like null and undefined, so compiler
      // can have a chance to complain/ we can fail later nicely maybe
      if (!(part && part.ref)) {
        subselect.SELECT.where.push(part);
        continue;
      }

      // root.$path should be safe - we can only reference things in exists that exist when we enrich
      // so all of them should have a $path.
      const { art, links } = inspectRef(root.$path.concat([ 'on', j ]));
      // Dollar Self Backlink
      if (isValidDollarSelf(root.on[j], root.$path.concat([ 'on', j ]), root.on[j + 1], root.on[j + 2], root.$path.concat([ 'on', j + 2 ]))) {
        if (root.on[j].ref[0] === '$self' && root.on[j].ref.length === 1)
          subselect.SELECT.where.push(...translateDollarSelfToWhere(base, target, root.on[j + 2], root.$path.concat([ 'on', j + 2 ])));
        else
          subselect.SELECT.where.push(...translateDollarSelfToWhere(base, target, root.on[j], root.$path.concat([ 'on', j ])));

        j += 2;
      }
      else if (links && links[0].art === root) { // target side
        subselect.SELECT.where.push({ ref: [ target, ...part.ref.slice(1) ] });
      }
      else if (part.$scope === '$self') { // source side - "absolute" scope
        // cut off the $self, as we prefix the entity name now
        subselect.SELECT.where.push({ ref: [ base, ...part.ref.slice(1) ] });
      }
      else if (art) { // source side - with local scope
        if (isPrefixedWithTableAlias)
          subselect.SELECT.where.push({ ref: [ ...current.ref.slice(0, -1), ...part.ref ] });
        else
          subselect.SELECT.where.push({ ref: [ base, ...current.ref.slice(0, -1), ...part.ref ] });
      }
      else { // operator - or any other leftover
        subselect.SELECT.where.push(part);
      }
    }

    /**
     * Check that an expression triple is a valid $self
     *
     * @param {Token} leftSide
     * @param {CSN.Path} pathLeft
     * @param {Token} middle
     * @param {Token} rightSide
     * @param {CSN.Path} pathRight
     * @returns {boolean}
     */
    function isValidDollarSelf(leftSide, pathLeft, middle, rightSide, pathRight) {
      if (leftSide && leftSide.ref && rightSide && rightSide.ref && middle === '=') {
        const right = inspectRef(pathRight);
        const left = inspectRef(pathLeft);

        if (!right || !left)
          return false;

        const rightSideArt = right.art;
        const leftSideArt = left.art;

        return leftSide.ref[0] === '$self' && leftSide.ref.length === 1 && rightSideArt && rightSideArt.target ||
               rightSide.ref[0] === '$self' && rightSide.ref.length === 1 && leftSideArt && leftSideArt.target;
      }

      return false;
    }
  }

  /**
   * From the given expression (having inspectRef -> links), find the first association.
   *
   * @param {object} xprPart
   * @param {CSN.Path} path
   * @returns {{head: Array, root: CSN.Element, ref: string|object, tail: Array}} The first assoc (root), the corresponding ref (ref), anything before the ref (head) and the rest of the ref (tail).
   */
  function getFirstAssoc(xprPart, path) {
    const { links, art } = inspectRef(path);
    for (let i = 0; i < xprPart.ref.length - 1; i++) {
      if (links[i].art && links[i].art.target) {
        return {
          head: (i === 0 ? [] : xprPart.ref.slice(0, i)), root: links[i].art, ref: xprPart.ref[i], tail: xprPart.ref.slice(i + 1),
        };
      }
    }
    return {
      head: (xprPart.ref.length === 1 ? [] : xprPart.ref.slice(0, xprPart.ref.length - 1)), root: art, ref: xprPart.ref[xprPart.ref.length - 1], tail: [],
    };
  }

  /**
   * Get the last association from the expression part - similar to getFirstAssoc
   *
   * @param {object} xprPart
   * @param {CSN.Path} path
   * @returns {{head: Array, root: CSN.Element, ref: string|object, tail: Array}} The last assoc (root), the corresponding ref (ref), anything before the ref (head) and the rest of the ref (tail).
   */
  function getLastAssoc(xprPart, path) {
    const { links, art } = inspectRef(path);
    for (let i = xprPart.ref.length - 1; i > -1; i--) {
      if (links[i].art && links[i].art.target) {
        return {
          head: (i === 0 ? [] : xprPart.ref.slice(0, i)), root: links[i].art, ref: xprPart.ref[i], tail: xprPart.ref.slice(i + 1),
        };
      }
    }
    return {
      head: (xprPart.ref.length === 1 ? [] : xprPart.ref.slice(0, xprPart.ref.length - 1)), root: art, ref: xprPart.ref[xprPart.ref.length - 1], tail: [],
    };
  }

  /**
   * Check (using inspectRef -> links), wether the first path step is an entity or query source
   *
   * @param {CSN.Path} path
   * @returns {boolean}
   */
  function firstLinkIsEntityOrQuerySource(path) {
    const { links } = inspectRef(path);
    return links && (links[0].art.kind === 'entity' || links[0].art.query || links[0].art.from);
  }

  /**
   * For a given xpr, check in which entity/query source the ref "is".
   *
   * If the ref already starts with an entity/query source, simply return the first ref step.
   * Otherwise, use $env to figure it out:
   * - $env=<string> -> the string is the source
   * - $env=<number> && $scope='mixin' -> the current query is the source
   * - $env=<number> && $scope!=='mixin' -> such refs start with entity/query source, are already handled
   * - $env=true -> does not apply for "EXISTS" handling, only happens in ORDER BY or explicit on-cond redirection
   *
   * If we have a ref but no $env, throw to trigger recompile - but such cases should have already led to a recompile with
   * the validator/enricher.
   *
   * Since we only call this function when it is not just a simple SELECT FROM X,
   * we can be sure that resolving the ref requires $env information.
   *
   * @param {object} xpr
   * @param {CSN.Path} path
   * @returns {string|undefined} undefined in case of errors
   * @throws {Error} Throws if xpr.ref but no xpr.$env
   * @todo $env is going to be removed from CSN, but csnRefs will provide it
   */
  // eslint-disable-next-line consistent-return
  function getParent(xpr, path) {
    if (firstLinkIsEntityOrQuerySource(path)) {
      return xpr.ref[0];
    }
    else if (xpr.$env) {
      if (typeof xpr.$env === 'string') {
        return xpr.$env;
      }
      else if (typeof xpr.$env === 'number') {
        if (xpr.$scope === 'mixin')
          return '';
        return error(null, xpr.$path, '$env with number is not handled yet - please report this error!');
      }

      return error(null, xpr.$path, 'Boolean $env is not handled yet - please report this error!');
    }
    else if (xpr.ref) {
      throw new Error('Missing $env and missing leading artifact ref - throwing to trigger recompilation!');
    }
  }

  /**
   * Build an initial subselect for the final `EXISTS <subselect>`.
   *
   * @param {string} target The target of `EXISTS <assoc>` - will be selected from
   * @param {string|object} assocRef The ref "being" the association
   * @param {object} _sources Object containing the names of the query sources of the current query
   * @returns {CSN.Query}
   */
  function getSubselect(target, assocRef, _sources) {
    let subselectAlias = `_${assocRef.id ? assocRef.id : assocRef}_exists`;

    while (_sources[subselectAlias])
      subselectAlias = `_${subselectAlias}`;

    const subselect = {
      SELECT: {
        // use alias to prevent shadowing of upper-level table alias
        from: { ref: [ target ], as: subselectAlias },
        columns: [ { val: 1, as: 'dummy' } ],
        where: [],
      },
    };
    // Because the generated things don't have _links, _art etc. set
    // We could also make getParent more robust to calculate the links JIT if they are missing
    setProp(subselect, '$generatedExists', true);

    const nonEnumElements = Object.create(null);
    nonEnumElements.dummy = {
      type: 'cds.Integer',
    };

    setProp(subselect.SELECT, 'elements', nonEnumElements);

    return subselect;
  }

  /**
   * Get the name of the source-side query source
   *
   * @param {string|null} queryBase
   * @param {boolean} isPrefixedWithTableAlias
   * @param {CSN.Column} current
   * @param {CSN.Path} path
   * @returns {string}
   */
  function getBase(queryBase, isPrefixedWithTableAlias, current, path) {
    if (queryBase)
      return getRealName(csn, queryBase);
    else if (isPrefixedWithTableAlias)
      return current.ref[0];
    return getParent(current, path);
  }


  /**
   * If the assoc-base for EXISTS <assoc> has a filter, we need to merge this filter into the WHERE-clause of the subquery.
   *
   * This function does this by adding the assoc target before all the refs so that the refs are resolvable in the WHERE.
   *
   * @param {string} target
   * @param {TokenStream} where
   * @returns {TokenStream} The input-where with the refs "absolutified"
   */
  function remapExistingWhere(target, where) {
    return where.map((part) => {
      if (part.ref) {
        part.ref = [ target, ...part.ref ];
        return part;
      }

      return part;
    });
  }

  /**
   * Turn the would-be on-condition of a $self backlink into a WHERE condition.
   *
   * Prefix the target/source side base accordingly and build the source = target comparisons.
   *
   * @param {string} base The source entity/query source name
   * @param {string} target The target entity/query source name
   * @param {CSN.Element} assoc The association element - the "not-$self" side of the comparison
   * @param {CSN.Path} path
   * @returns {TokenStream} The WHERE representing the $self comparison
   */
  function translateDollarSelfToWhere(base, target, assoc, path) {
    const where = [];
    const { art } = inspectRef(path);
    if (art.keys) {
      for (let i = 0; i < art.keys.length; i++) {
        const lop = { ref: [ target, ...assoc.ref.slice(1), ...art.keys[i].ref ] }; // target side
        const rop = { ref: [ base, ...art.keys[i].ref ] }; // source side
        if (i > 0)
          where.push('and');

        where.push(...[ lop, '=', rop ]);
      }
    }
    else if (art.on) {
      for (let i = 0; i < art.on.length; i++) {
        const part = art.on[i];
        const partInspect = inspectRef(art.$path.concat([ 'on', i ]));
        if (partInspect.links && partInspect.links[0].art === art) { // target side
          where.push({ ref: [ base, ...part.ref.slice(1) ] });
        }
        else if (part.$scope === '$self') { // source side - "absolute" scope
          // Same message as in forHanaNew/transformDollarSelfComparisonWithUnmanagedAssoc
          error(null, part.$path, 'An association that uses "$self" in its ON-condition can\'t be compared to "$self"');
        }
        else if (partInspect.art) { // source side - with local scope
          where.push({ ref: [ target, ...assoc.ref.slice(1, -1), ...part.ref ] });
        }
        else { // operator - or any other leftover
          where.push(part);
        }
      }
    }
    return where;
  }
}


module.exports = handleExists;

/**
 * @typedef {Token[]} TokenStream Array of tokens.
 */

/**
 * @typedef {string|object} Token Could be an object or a string - strings are usually operators.
 */
