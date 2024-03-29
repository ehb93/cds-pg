'use strict';

const { setProp } = require('../base/model');
const { csnRefs } = require('../model/csnRefs');
const { sortCsn, cloneCsnDictionary: _cloneCsnDictionary } = require('../json/to-csn');
const version = require('../../package.json').version;

// Low-level utility functions to work with compact CSN.

/**
 * Generic Callback
 *
 * @callback genericCallback
 * @param {CSN.Artifact} art
 * @param {CSN.FQN} name Artifact Name
 * @param {string} prop Dictionary Property
 * @param {CSN.Path} path Location
 * @param {CSN.Artifact} [dictionary]
 */

/**
 * @callback refCallback
 * @param {any} ref
 * @param {object} node
 * @param {CSN.Path} path
 */

/**
 * @callback queryCallback
 * @param {CSN.Query} query
 * @param {CSN.Path} path
 */

/**
 * Get utility functions for a given CSN.
 * @param {CSN.Model} model (Compact) CSN model
 */
function getUtils(model) {
  const { artifactRef, inspectRef, effectiveType, getOrigin } = csnRefs(model);

  return {
    getCsnDef,
    isStructured,
    getFinalType,
    getFinalTypeDef,
    isManagedAssociationElement,
    isAssocOrComposition,
    isAssociation,
    isComposition,
    getArtifactDatabaseNameOf,
    getNamespaceOfArtifact,
    getContextOfArtifact,
    addStringAnnotationTo,
    getServiceName,
    hasAnnotationValue,
    cloneWithTransformations,
    getFinalBaseType,
    inspectRef,
    artifactRef,
    effectiveType,
    get$combined,
    getOrigin,
  };

  /**
   * Compute and return $combined for the given query.
   *
   * @param {CSN.Query} query
   * @returns {object}
   */
  function get$combined(query) {
    const sources = getSources(query);
    return sources;

    /**
     * Get the union of all elements from the from clause
     * - descend into unions, following the lead query
     * - merge all queries in case of joins
     * - follow subqueries
     *
     * @param {CSN.Query} query Query to check
     * @returns {object} Map of sources
     */
    function getSources(query, isSubquery=false) {
      // Remark CW: better just a while along query.SET.args[0]
      if (query.SET) {
        if (query.SET.args[0].SELECT && query.SET.args[0].SELECT.elements)
          return mergeElementsIntoMap(Object.create(null), query.SET.args[0].SELECT.elements, query.SET.args[0].$location);

        return getSources(query.SET.args[0], isSubquery);
      }
      else if (query.SELECT) {
        if (query.SELECT.from.args) {
          return walkArgs(query.SELECT.from.args);
        }
        else if (query.SELECT.from.ref) {
          let art = artifactRef(query.SELECT.from);

          if(art.target)
            art = artifactRef(art.target);

          if(isSubquery && !query.SELECT.elements)
            throw new Error('Expected subquery to have .elements');

          return mergeElementsIntoMap(Object.create(null), isSubquery ? query.SELECT.elements : art.elements, art.$location,
            query.SELECT.from.as || query.SELECT.from.ref[query.SELECT.from.ref.length - 1],
            query.SELECT.from.ref[query.SELECT.from.ref.length - 1] || query.SELECT.from.as );
        }
        else if (query.SELECT.from.SET || query.SELECT.from.SELECT) {
          return getSources(query.SELECT.from, true);
        }
      }

      function walkArgs(args) {
        let elements = Object.create(null);
        for (const arg of args) {
          if (arg.args) {
            elements = mergeElementMaps(elements, walkArgs(arg.args));
          }
          else if (arg.ref) {
            const art = artifactRef(arg);
            elements = mergeElementsIntoMap(elements, art.elements, art.$location, arg.as || arg.ref[arg.ref.length - 1], arg.ref[arg.ref.length - 1] || arg.as);
          }
          else if (arg.SELECT || arg.SET) {
            elements = mergeElementMaps(elements, getSources(arg));
          }
        }

        return elements;
      }

      return {};

      /**
       * Merge two maps of elements together
       *
       * @param {object} mapA Map a - will be returned
       * @param {object} mapB Map b - will not be returned
       * @returns {object} mapA
       */
      function mergeElementMaps(mapA, mapB) {
        for (const elementName in mapB) {
          if (!mapA[elementName])
            mapA[elementName] = [];

          mapB[elementName].forEach(e => mapA[elementName].push(e));
        }

        return mapA;
      }

      /**
       * Merge elements into an existing map
       *
       * @param {any} existingMap map to merge into - will be returned
       * @param {object} elements elements to merge into the map
       * @param {CSN.Location} $location $location of the elements - where they come from
       * @param {any} [parent] Name of the parent of the elements, alias before ref
       * @param {any} [error_parent] Parent name to use for error messages, ref before alias
       * @returns {object} existingMap
       */
      function mergeElementsIntoMap(existingMap, elements, $location, parent, error_parent) {
        for (const elementName in elements) {
          const element = elements[elementName];
          if (!existingMap[elementName])
            existingMap[elementName] = [];


          existingMap[elementName].push({
            element, name: elementName, source: $location, parent: getBaseName(parent), error_parent,
          });
        }

        return existingMap;
      }
    }

      /**
   * Return the name part of the artifact name - no namespace etc.
   * @param {string|object} name Absolute name of the artifact
   */
    function getBaseName(name) {
      if (!name)
        return name;

      if (name.id)
        return name.id.substring( name.id.lastIndexOf('.')+1 );

      return name.substring( name.lastIndexOf('.')+1 )
    }
  }


  /**
   * Create an object to track visited objects identified by a unique string.
   * @param {string} [id] Initial entry (optional)
   */
  function createVisited(id) {
    let visited = Object.create(null);
    check(id);
    return { check };

    /**
     * Check if an identifier has already been visited and
     * add it to the list of visited identifiers.
     * @param {string} id unique identifier
     */
    function check(id) {
      if (!id) return;
      if (visited[id]) {
        throw new Error('Circular dependency');
      }
      visited[id] = true;
    }
  }

  /**
   * Get the CSN definition for an artifact name.
   * @param {string} defName Absolute name of the artifact
   */
  function getCsnDef(defName) {
    if (model.definitions[defName])
      return model.definitions[defName]
    else
      throw new Error(`Nonexistent definition in the model: '${defName}'`);
  }

  /**
   * Returns true if an artifact is a structured type
   * or a typedef of a structured type.
   *
   * @param {CSN.Artifact} obj
   */
  function isStructured(obj) {
    return obj.elements ||
      (obj.type && ((getFinalTypeDef(obj.type).elements) || (obj.type.ref && getFinalBaseType(obj.type).elements)));
  }

  /**
   * Resolves typedefs to its final typedef which is returned.
   * If the artifact for typename isn't a typedef, the name itself is returned.
   *
   * @param {string} typeName Absolute type name
   * @returns {object}
   */
  function getFinalTypeDef(typeName) {
    let visited = createVisited(typeName);
    let type = model.definitions[typeName];
    if (!type) {
      return typeName;
    }
    for (let nextType = type; nextType;) {
      type = nextType;
      visited.check(type.type);
      nextType = model.definitions[nextType.type];
    }
    return type;
  }

  /**
   * Resolves typedefs to its final type (name) which is returned.
   * @param {string} typeName Absolute type name
   * @returns {string}
   */
  function getFinalType(typeName) {
    let visited = createVisited(typeName);
    let type = model.definitions[typeName];
    while (type && type.type) {
      typeName = type.type;
      visited.check(typeName);
      type = model.definitions[typeName];
    }
    return typeName;
  }

  // Return true if 'node' is a managed association element
  // TODO: what about elements having a type, which (finally) is an assoc?
  function isManagedAssociationElement(node) {
    return node.target !== undefined && node.on === undefined && node.keys;
  }

  /**
   * Returns if a type is an association or a composition or a typedef
   * to any of them.
   * @param {string} typeName Absolute type name
   */
  function isAssocOrComposition(typeName) {
    if (typeName === 'cds.Association' || typeName === 'cds.Composition')
      return true;
    let visited = createVisited(typeName);
    let type = model.definitions[typeName];
    while (type) {
      if (type.type === 'cds.Association' || type.type === 'cds.Composition')
        return true;
      visited.check(type.type);
      type = model.definitions[type.type];
    }
    return false;
  }

  /**
   * Returns if a type is an association or a typedef to it.
   * @param {string} typeName Absolute type name
   */
  function isAssociation(typeName) {
    if (typeName === 'cds.Association')
      return true;
    let visited = createVisited(typeName);
    let type = model.definitions[typeName];
    while (type) {
      if (type.type === 'cds.Association')
        return true;
      visited.check(type.type);
      type = model.definitions[type.type];
    }
    return false;
  }

  /**
   * Returns if a type is an composition or a typedef to it.
   * @param {string} typeName Absolute type name
   */
  function isComposition(typeName) {
    if (typeName === 'cds.Composition')
      return true;
    let visited = createVisited(typeName);
    let type = model.definitions[typeName];
    while (type) {
      if (type.type === 'cds.Composition')
        return true;
      visited.check(type.type);
      type = model.definitions[type.type];
    }
    return false;
  }

  /**
   * Return the namespace part of the artifact name.
   * @param {string} name Absolute name of artifact
   */
  function getNamespaceOfArtifact(name) {
    let lastDotIdx = name.lastIndexOf('.');
    if (lastDotIdx === -1) return undefined;
    while (model.definitions[name]) {
      if (model.definitions[name].kind === 'namespace')
        return name;
      lastDotIdx = name.lastIndexOf('.');
      if (lastDotIdx === -1) return undefined;
      name = name.substring(0, lastDotIdx);
    }
    return name;
  }

  /**
   * Return the context part of the artifact name if any.
   * @param {string} name Absolute name of artifact
   */
  function getContextOfArtifact(name) {
    let lastDotIdx = name.lastIndexOf('.');
    while (model.definitions[name]) {
      if (model.definitions[name].kind === 'context' || model.definitions[name].kind === 'service')
        return name;
      lastDotIdx = name.lastIndexOf('.');
      if (lastDotIdx === -1) return undefined;
      name = name.substring(0, lastDotIdx);
    }
    return undefined;
  }

  /**
   * Add an annotation with absolute name 'absoluteName' (including the at-sign) and string value 'theValue' to 'node'
   *
   * @param {string} absoluteName Name of the annotation, including the at-sign
   * @param {any} theValue string value of the annotation
   * @param {any} node Node to add the annotation to
   */
  function addStringAnnotationTo(absoluteName, theValue, node) {
    // Sanity check
    if (!absoluteName.startsWith('@')) {
      throw Error('Annotation name should start with "@": ' + absoluteName);
    }
    // Only overwrite if undefined or null
    if(node[absoluteName] === undefined || node[absoluteName] === null) {
      // Assemble the annotation
      node[absoluteName] = theValue;
    }
  }

  /**
   * Return the name of the service in which the artifact is contained.
   * Returns null if the artifact doesn't live in a service.
   *
   * @param {string} artifactName Absolute name of artifact
   * @returns {string|null}
   */
  function getServiceName(artifactName) {
    for(;;) {
      let idx = artifactName.lastIndexOf('.');
      if (idx == -1) return null;
      artifactName = artifactName.substring(0, idx);
      let artifact = model.definitions[artifactName];
      if (artifact && artifact.kind === 'service') {
        return artifactName;
      }
    }
  }

  /**
   * Clone 'node', transforming nodes therein recursively. Object 'transformers' is expected
   * to contain a mapping of property 'key' names to transformer functions. The node's properties
   * are walked recursively, calling each transformer function on its corresponding property
   * 'key' of 'node', replacing 'value' in 'resultNode' with the function's return value
   * (returning 'undefined' will delete the property).
   * If no transformation function is found for 'key', the first letter of 'key' is tried
   * instead (this seems to be intended for handling annotations that start with '@' ?)
   *
   * Regardless of their names, transformers are never applied to dictionary elements.
   *
   * The transformer functions are called with the following signature:
   * transformer(value, node, resultNode, key)
   *
   * @param {any} node Node to transform
   * @param {any} transformers Object defining transformer functions
   * @returns {object}
   */
  function cloneWithTransformations(node, transformers) {

    return transformNode(node);

  // This general transformation function will be applied to each node recursively
    function transformNode(node) {
    // Return primitive values and null unchanged, but let objects and dictionaries through
    // (Note that 'node instanceof Object' would be false for dictionaries).
      if (node === null || typeof node !== 'object') {
        return node
      }
    // Simply return if node is to be ignored
      if (node == undefined || node._ignore)
        return undefined;
    // Transform arrays element-wise
      if (Array.isArray(node)) {
        return node.map(transformNode);
      }
    // Things not having 'proto' are dictionaries
      let proto = Object.getPrototypeOf(node);
    // Iterate own properties of 'node' and transform them into 'resultNode'
      let resultNode = Object.create(proto);
      for (let key of Object.keys(node)) {
      // Dictionary always use transformNode(), other objects their transformer according to key
        let transformer = (proto == undefined) ? transformNode : transformers[key] || transformers[key.charAt(0)];
      // Apply transformer, or use transformNode() if there is none
        let resultValue = (transformer || transformNode)(node[key], node, resultNode, key);
        if (resultValue !== undefined) {
          resultNode[key] = resultValue;
        }
      }
      return resultNode;
    }
  }
  
  
  /**
   * Resolve to the final type of a type, that means follow type chains, references to other types or
   * elements a.s.o
   * Works for all kinds of types, strings as well as type objects. Strings need to be absolute type names.
   * Returns the final type as string (if it has a name, which is not always the case, think of embedded structures),
   * else the type object itself is returned. If a type is structured, you can navigate into it by providing a path,
   * e.g. given the following model
   *     type bar: S.foo;
   *     type s1 {
   *       s: s2;
   *     };
   *     type s2 {
   *       u: type of S.e:t;
   *     }
   *     service S {
   *       type foo: type of S.e:i.j1;
   *       entity e {
   *         key i: { j1: Integer };
   *         t: bar;
   *         v: s1;
   *         x: blutz.s.u;
   *       };
   *       type blutz: S.e.v;
   *       view V as select from e {
   *         1+1 as i: bar,
   *       };
   *       type tt: type of V:i;
   *    }
   * the following calls will all return 'cds.Integer'
   *     getFinalBaseType('S.tt')
   *     getFinalBaseType('S.e',['i','j1'])
   *     getFinalBaseType('S.e',['t'])
   *     getFinalBaseType('S.e',['x'])
   *     getFinalBaseType('S.blutz',['s', 'u'])
   * Types are always resolved as far as possible. A type name which has no further definition is simply returned.
   * Composed types (structures, entities, views, ...) are returned as type objects, if not drilled down into
   * the elements. Path steps that have no corresponding element lead to 'undefined'. Refs to something that has
   * no type (e.g. expr in a view without explicit type) returns 'null'
   * 
   * @param {string|object} type Type - either string or ref
   * @param {CSN.Path} path 
   * @param {WeakMap} [resolved=new WeakMap()] WeakMap containing already resolved refs - if a ref is not cached, it will be resolved JIT
   * @param {object} [cycleCheck] Dictionary to remember already resolved types - to be cycle-safe 
   * @returns 
   */
  function getFinalBaseType(type, path = [], resolved = new WeakMap(), cycleCheck = undefined) {
    if (!type)
      return type;
    if (typeof(type) === 'string') {
      if (isBuiltinType(type)) // built-in type
        return type;
      if (cycleCheck) {
        let visited = path.length? type + ':' + path.join('.') : type;
        if (cycleCheck[visited])
          throw new Error('Circular type chain on type ' + type);
        else
          cycleCheck[visited] = true;
      }
      else {
        cycleCheck = Object.create(null);
      }
      let definedType = model.definitions[type];
      if (definedType && definedType.type)
        return getFinalBaseType(definedType.type, path, resolved, cycleCheck);
      else
        return getFinalBaseType(definedType, path, resolved, cycleCheck);
    }
    else if (typeof(type) === 'object') {
      if (type.ref) {
        // assert type.ref instanceof Array && type.ref.length >= 1
        const ref = resolved.has(type) ? resolved.get(type).art : artifactRef(type);
        return getFinalBaseType(ref, path, resolved, cycleCheck);
      }
      else if (type.elements) {
        if (path.length) {
          let [e, ...p] = path;
          return getFinalBaseType(type.elements[e], p, resolved, cycleCheck);
        }
      }
      else if (type.type)
        return (getFinalBaseType(type.type, path, resolved, cycleCheck));
      else if (type.items)
        return type;
      else
        // TODO: this happens if we don't have a type, e.g. an expression in a select list
        // in a view without explicit type. Instead of returning null we might want to return
        // the object instead?
        return null;
    }
    return type;
  }
}

// Tell if a type is (directly) a builtin type
// Note that in CSN builtins are not in the definition of the model, so we can only check against their absolute names.
// Builtin types are "cds.<something>", i.e. they are directly in 'cds', but not for example
// in 'cds.foundation'. Also note, that a type might be a ref object, that refers to something else,
// so if you consider type chains don't forget first to resolve to the final type before
function isBuiltinType(type) {
  return typeof(type) === 'string' && type.startsWith('cds.') && !type.startsWith('cds.foundation.')
}


/**
 * Deeply clone the given CSN model and return it.
 * In testMode (or with testSortCsn), definitions are sorted.
 * Note that annotations are only copied shallowly.
 *
 * @param {object} csn Top-level CSN.  You can pass non-dictionary values.
 * @param {CSN.Options} options CSN Options, only used for `dictionaryPrototype`, `testMode`, and `testSortCsn`
 */
function cloneCsn(csn, options) {
  return sortCsn(csn, options);
}

/**
 * Deeply clone the given CSN dictionary and return it.
 * Note that annotations are only copied shallowly.
 * This function does _not_ sort the given dictionary.
 * See cloneCsn() if you want sorted definitions.
 *
 * @param {object} csn
 * @param {CSN.Options} options Only cloneOptions.dictionaryPrototype is
 *                              used and cloneOptions are passed to sort().
 */
function cloneCsnDictionary(csn, options) {
  return _cloneCsnDictionary(csn, options);
}

/**
 * Apply function `callback` to all artifacts in dictionary
 * `model.definitions`.  See function `forEachGeneric` for details.
 * Callback will be called with artifact, artifact name, property
 * name ('definitions') and csn-path to artifact.
 *
 * @param {CSN.Model} csn
 * @param {(genericCallback|genericCallback[])} callback
 * @param {object} iterateOptions can be used to skip certain kinds from being iterated
 */
function forEachDefinition( csn, callback, iterateOptions = {} ) {
  forEachGeneric( csn, 'definitions', callback, [], iterateOptions );
}

/**
 * Apply function `callback` to all members of object `construct` (main artifact or
 * parent member).  Members are considered those in dictionaries `elements`,
 * `enum`, `actions` and `params` of `construct`, `elements` and `enums` are also
 * searched inside property `items` (array of) and `returns` (actions).
 * See function `forEachGeneric` for details.
 *
 * @param {CSN.Artifact} construct
 * @param {genericCallback|genericCallback[]} callback
 * @param {CSN.Path} [path]
 * @param {boolean} [ignoreIgnore]
 * @param {object} iterateOptions can be used to skip certain kinds from being iterated
 */
function forEachMember( construct, callback, path=[], ignoreIgnore=true, iterateOptions = {}) {
  // Allow processing _ignored elements if requested
  if (ignoreIgnore && construct._ignore) {
    return;
  }

  // `items` itself is a structure that can contain "elements", and more.
  if (construct.items) {
    // TODO: Should we go to the deepest items.items?
    forEachMember( construct.items, callback, [...path, 'items'], ignoreIgnore, iterateOptions );
  }

  // Unlike XSN, we don't make "returns" a "params" in the callback.
  // Backends rely on the fact that `forEachElement` also goes through all
  // `elements` of the return type (if structured).
  // TODO: `returns` should be handled like a parameter just like XSN (maybe with different prop name)
  if (construct.returns && !iterateOptions.elementsOnly) {
    forEachMember( construct.returns, callback, [...path, 'returns'], ignoreIgnore, iterateOptions );
  }

  path = [...path]; // Copy
  const propsWithMembers = (iterateOptions.elementsOnly ? ['elements'] : ['elements', 'enum', 'foreignKeys', 'actions', 'params']);
  propsWithMembers.forEach((prop) => forEachGeneric( construct, prop, callback, path, iterateOptions ));
}

/**
 * Apply function `callback(member, memberName)` to each member in `construct`,
 * recursively (i.e. also for sub-elements of elements).
 *
 * @param {CSN.Artifact} construct
 * @param {genericCallback|genericCallback[]} callback
 * @param {CSN.Path} [path]
 * @param {boolean} [ignoreIgnore]
 * @param {object} iterateOptions can be used to skip certain kinds from being iterated
 */
function forEachMemberRecursively( construct, callback, path=[], ignoreIgnore=true, iterateOptions = {}) {
  forEachMember( construct, ( member, memberName, prop, subpath ) => {
    if(Array.isArray(callback))
      callback.forEach(cb => cb( member, memberName, prop, subpath, construct ));
    else
      callback( member, memberName, prop, subpath, construct );
    // Descend into nested members, too
    forEachMemberRecursively( member, callback, subpath, ignoreIgnore, iterateOptions);
  }, path, ignoreIgnore, iterateOptions);
}

/**
 * Apply function `callback` to all objects in dictionary `dict`, including all
 * duplicates (found under the same name).  Function `callback` is called with
 * the following arguments: the object, the name, and -if it is a duplicate-
 * the array index and the array containing all duplicates.
 *
 * @param {object} obj
 * @param {string} prop
 * @param {genericCallback|genericCallback[]} callback
 * @param {CSN.Path} path
 * @param {object} iterateOptions can be used to skip certain kinds from being iterated
 */
function forEachGeneric( obj, prop, callback, path = [], iterateOptions = {}) {
  const dict = obj[prop];
  for (const name in dict) {
    if (!Object.prototype.hasOwnProperty.call(dict, name))
      continue;
    const dictObj = dict[name];
    if((iterateOptions.skip && iterateOptions.skip.includes(dictObj.kind))
       || (iterateOptions.skipArtifact && typeof iterateOptions.skipArtifact === 'function'
           && iterateOptions.skipArtifact(dictObj, name)))
      continue;
    cb( dictObj, name );
  }
  function cb(o, name ) {
    if (Array.isArray(callback))
      callback.forEach(cb => cb( o, name, prop, path.concat([prop, name])));
    else
      callback( o, name, prop, path.concat([prop, name]))
  }
}

/**
 * For each property named 'ref' in 'node' (recursively), call callback(ref, node, path)
 *
 * @param {object} node
 * @param {refCallback|refCallback[]} callback
 * @param {CSN.Path} path
 */
function forEachRef(node, callback, path = []) {
  if (node === null || typeof node !== 'object') {
    // Primitive node
    return;
  }

  if(node._ignore){
    return;
  }

  if(Array.isArray(node)){
    for (let i = 0; i < node.length; i++) {
      // Descend recursively
      forEachRef(node[i], callback, path.concat([i]));
    }
  } else {
    for (let name in node) {
      if (!Object.hasOwnProperty.call( node, name ))
        continue;
      // If ref found within a non-dictionary, call callback
      if (name === 'ref' && Object.getPrototypeOf(node)) {
        if(Array.isArray(callback))
          callback.forEach(cb => cb( node.ref, node, path ));
        else
          callback( node.ref, node, path );
      }
      // Descend recursively
      forEachRef(node[name], callback, path.concat([name]));
    }
  }
}

// Like Object.assign() but copies also non enumerable properties
function assignAll(target, ...sources) {
  sources.forEach(source => {
    let descriptors = Object.getOwnPropertyNames(source).reduce((descriptors, key) => {
      descriptors[key] = Object.getOwnPropertyDescriptor(source, key);
      return descriptors;
    }, {});
    // by default, Object.assign copies enumerable Symbols too
    Object.getOwnPropertySymbols(source).forEach(sym => {
      let descriptor = Object.getOwnPropertyDescriptor(source, sym);
      if (descriptor.enumerable) {
        descriptors[sym] = descriptor;
      }
    });
    Object.defineProperties(target, descriptors);
  });
  return target;
}

/**
 * @param {CSN.Query} query
 * @param {queryCallback|queryCallback[]} callback
 * @param {CSN.Path} path
 */
function forAllQueries(query, callback, path = []){
  return traverseQuery(query, callback, path);
  function traverseQuery( q, callback, p ) {
    if (q.SELECT) {
      // The projection is turned into a normalized query - there
      // is no real SELECT, it is fake
      if(!(path.length === 3 && path[2] === 'projection'))
        p.push('SELECT');
      cb( q, p );
      q = q.SELECT;
    }
    else if (q.SET) {
      p.push('SET');
      cb( q, p );
      q = q.SET;
    }

    if (q.from)
      traverseFrom( q.from, callback, p.concat(['from']) );

    for (const prop of ['args', 'xpr', 'columns', 'where', 'having']) {
      // all properties which could have sub queries (directly or indirectly)
      const expr = q[prop];
      if (expr && typeof expr === 'object') {
        if(Array.isArray(expr)){
          for(let i = 0; i < expr.length; i++){
            traverseQuery(expr[i], callback, p.concat([prop, i]));
          }
        } else {
          for(const argName of Object.keys( expr )){
            traverseQuery(expr[argName], callback, p.concat([prop, argName]))
          }
        }
      }
    }
    function cb(q, p) {
      if(Array.isArray(callback))
        callback.forEach(cb => cb( q, p ));
      else
        callback( q, p );
    }
  }

  /**
   * @param {CSN.QueryFrom} from
   * @param {Function} callback
   * @param {CSN.Path} path
   */
  function traverseFrom( from, callback, path = [] ) {
    if (from.ref) // ignore
      return;
    else if (from.args){ // join
      for(let i = 0; i < from.args.length; i++){
        traverseFrom(from.args[i], callback, path.concat(['args', i]));
      }
    }
    else
      traverseQuery( from, callback, path ); // sub query in FROM
  }
}

function forAllElements(artifact, artifactName, cb){
  if(artifact.elements) {
    cb(artifact, artifact.elements, ['definitions', artifactName, 'elements']);
  }

  if(artifact.query) {
    forAllQueries(artifact.query, (q, p) => {
      const s = q.SELECT;
      if(s) {
        if(s.elements) {
          cb(s, s.elements, [...p, 'elements']);
        } else if(s.$elements) { // huh?, is just refloc output
          cb(s, s.$elements, [...p, '$elements']);
        }
      }
    }, ['definitions', artifactName, 'query'])
  }
}

/**
 * Compare a given annotation value with an expectation value and return
 *
 *          | Expected
 *          | true  | false | null  | arb val
 * Anno Val |-------|-------|-------|--------
 * true     | true  | false | false | false
 * false    | false | true  | false | false
 * null     | false | true  | true  | false
 * arb val  | false | false | false | true/false
 *
 * If the annotation value is 'null', 'true' is returned for the expectation values
 * 'null' and 'false'. Expecting 'null' for an annotation value 'false' returns
 * 'false'.
 *
 * @param {CSN.Artifact} artifact
 * @param {string} annotationName Name of the annotation (including the at-sign)
 * @param {any} expected
 * @returns {boolean}
 */
function hasAnnotationValue(artifact, annotationName, expected = true) {
  if(expected === false)
    return artifact[annotationName] === expected || artifact[annotationName] === null;
  else
    return artifact[annotationName] === expected;
}

/**
 * EDM specific check: Render (navigation) property if element is NOT ...
 * 1) ... annotated @cds.api.ignore
 * 2) ... annotated @odata.navigable: false
 * 2) ... annotated @odata.foreignKey4 and odataFormat: structured
 * function accepts EDM internal and external options
 *
 * @param {CSN.Element} elementCsn
 * @param {CSN.Options & CSN.ODataOptions} options EDM specific options
 */
function isEdmPropertyRendered(elementCsn, options) {
  if(options.toOdata)
    options = options.toOdata;
  // FKs are rendered in
  // V2/V4 flat: always on
  // V4 struct: on/off
  const renderForeignKey = (options.version === 'v4' && options.odataFormat === 'structured') ? !!options.odataForeignKeys : true;
  const isNotIgnored = !elementCsn.target ? !elementCsn['@cds.api.ignore'] : true;
  const isNavigable = elementCsn.target ?
    (elementCsn['@odata.navigable'] === undefined ||
     elementCsn['@odata.navigable'] !== undefined && (elementCsn['@odata.navigable'] === null || elementCsn['@odata.navigable'] === true)) : true;
  // Foreign Keys can be ignored
  if(elementCsn['@odata.foreignKey4'])
    return isNotIgnored && renderForeignKey;
  // ordinary elements can be ignored and isNavigable is always true for them
  // assocs cannot be ignored but not navigable
  return isNotIgnored && isNavigable;
}


/**
 * Return the resulting database name for (absolute) 'artifactName', depending on the current naming
 * convention.
 *
 * - For the 'hdbcds' naming convention, this means converting '.' to '::' on
 *   the border between namespace and top-level artifact and correctly replacing some '.' with '_'.
 * - For the 'plain' naming convention, it means converting all '.' to '_' and uppercasing.
 * - For the 'quoted' naming convention, this means correctly replacing some '.' with '_'.
 *
 * If the old function signature is used - with a namespace as the third argument - the result might be wrong,
 * since the '.' -> '_' conversion for quoted/hdbcds is missing.
 *
 * @param {string} artifactName The name of the artifact
 * @param {('plain'|'quoted'|'hdbcds')} namingConvention The naming convention to use
 * @param {CSN.Model|string|undefined} csn
 * @returns {string} The resulting database name for (absolute) 'artifactName', depending on the current naming convention.
 */
function getArtifactDatabaseNameOf(artifactName, namingConvention, csn) {
  if(csn && typeof csn === 'object' && csn.definitions)
    if (namingConvention === 'quoted' || namingConvention === 'hdbcds') {
      return getResultingName(csn, namingConvention, artifactName);
    }
    else if (namingConvention === 'plain') {
      return artifactName.replace(/\./g, '_').toUpperCase();
    } else {
      throw new Error('Unknown naming convention: ' + namingConvention);
    }
  else {
    const namespace = csn;
    console.error(`This invocation of "getArtifactCdsPersistenceName" is deprecated, as it doesn't produce correct output with definition names containing dots - please provide a CSN as the third parameter.`);
    if (namingConvention === 'hdbcds') {
      if (namespace) {
        return `${namespace}::${artifactName.substring(namespace.length + 1)}`;
      }
      return artifactName;
    }
    else if (namingConvention === 'plain') {
      return artifactName.replace(/\./g, '_').toUpperCase();
    }
    else if (namingConvention === 'quoted') {
      return artifactName;
    }
    else {
      throw new Error('Unknown naming convention: ' + namingConvention);
    }
  }
}

/**
 * Get the name that the artifact definition has been rendered as - except for plain, there we just return the name as-is.
 * Without quoting/escaping stuff.
 *
 * Example: namespace.context.entity.with.dot
 * - plain: namespace.context.entity.with.dot
 * - quoted: namespace.context.entity_with_dot
 * - hdbcds: namespace::context.entity_with_dot
 *
 * @param {CSN.Model} csn CSN model
 * @param {string} namingMode Naming mode to use
 * @param {string} artifactName Artifact name to use
 * @returns {string} The resulting name
 */
function getResultingName(csn, namingMode, artifactName) {
  if (namingMode === 'plain' || artifactName.indexOf('.') === -1)
    return artifactName;

  const namespace = getNamespace(csn, artifactName);

  // Walk from front to back until we find a non-namespace/context
  // and join everything we've seen until that point with ., the rest
  // with _ (and the namespace with :: for hdbcds naming)
  const stopIndex = namespace ? namespace.split('.').length : 0;

  const parts = artifactName.split('.');

  const realParts = getUnderscoredName(stopIndex, parts, csn);
  const name = realParts ? realParts.join('.') : artifactName;


  return (namespace && namingMode === 'hdbcds') ? `${namespace}::${name.slice(namespace.length + 1)}` : name;
}


/**
 * Get the suffix and prefix part - with '.' join for prefix, '_' for suffix.
 * We determine when to start using '_' by walking from front to back until we find
 * the first shadowing definition that is not a namespace, context or service.
 *
 * Anything following is joined by '_'.
 *
 *
 * @param {number} startIndex Index to start looking at the parts - used to skip the namespace
 * @param {string[]} parts Parts of the name, split at .
 * @param {CSN.Model} csn
 * @returns {string[]|null} Array of at most 2 strings: if both: [prefix, suffix], otherwise just one - or null
 */
function getUnderscoredName(startIndex, parts, csn) {
  for (let i = startIndex; i < parts.length; i++) {
    const namePart = parts.slice(0, i).join('.');
    const art = csn.definitions[namePart];
    if (art && !(art.kind === 'namespace' || art.kind === 'context' || art.kind === 'service')) {
      const prefix = parts.slice(0, i - 1).join('.');
      const suffix = parts.slice(i - 1).join('_');
      const result = [];
      if (prefix)
        result.push(prefix);
      if (suffix)
        result.push(suffix);

      return result;
    } else if(art && art.kind === 'service') {
      // inside services, we immediatly turn . into _
      const prefix = parts.slice(0, i).join('.');
      const suffix = parts.slice(i).join('_');
      const result = [];
      if (prefix)
        result.push(prefix);
      if (suffix)
        result.push(suffix);

      return result;
    }
  }

  return null;
}


/**
 *  Return the resulting database element name for 'elemName', depending on the current naming
 *  convention.
 *  - For the 'hdbcds' naming convention, this is just 'elemName'.
 *  - For the 'plain' naming convention, it means converting all '.' to '_' and uppercasing.
 *  - For the 'quoted' naming convention, it means converting all '.' to '_'.
 *  No other naming conventions are accepted
 *
 * @param {string} elemName Name of the element
 * @param {('plain'|'quoted'|'hdbcds')} namingConvention The naming convention to use
 * @returns {string} The resulting database element name for 'elemName', depending on the current naming convention.
 */
function getElementDatabaseNameOf(elemName, namingConvention) {
  if (namingConvention === 'hdbcds') {
    return elemName;
  }
  else if (namingConvention === 'plain') {
    return elemName.replace(/\./g, '_').toUpperCase();
  }
  else if (namingConvention === 'quoted') {
    return elemName.replace(/\./g, '_');
  }
  else {
    throw new Error('Unknown naming convention: ' + namingConvention);
  }
}


/**
 * Loop through the model, applying the custom transformations on the node's matching.
 *
 * Each transformer gets:
 * - the parent having the property
 * - the name of the property
 * - the value of the property
 * - the path to the property
 *
 * @param {object} csn CSN to enrich in-place
 * @param {object} customTransformers Map of prop to transform and function to apply
 * @param {Function[]} [artifactTransformers=[]] Transformations to run on the artifacts, like forEachDefinition
 * @param {Boolean} [skipIgnore=true] Wether to skip _ignore elements or not
 * @param {object} [options={}] "skipArtifact": (artifact, name) => Boolean to skip certain artifacts, drillRef: boolean - whether to drill into infix/args
 * @returns {object} CSN with transformations applied
 */
function applyTransformations( csn, customTransformers={}, artifactTransformers=[], skipIgnore = true, options = {} ) {
  const transformers = {
    elements: dictionary,
    definitions: dictionary,
    actions: dictionary,
    params: dictionary,
    enum: dictionary,
    mixin: dictionary,
    ref: pathRef,
    //type: simpleRef,
    //target: simpleRef,
    //includes: simpleRef,
  }

  const csnPath = [];
  if (csn.definitions)
    definitions( csn, 'definitions', csn.definitions );
  return csn;

  function standard( parent, prop, node ) {
    if (!node || typeof node !== 'object' || !{}.propertyIsEnumerable.call( parent, prop ) || (typeof prop === 'string' && prop.startsWith('@')) || (skipIgnore && node._ignore))
      return;

    csnPath.push( prop );

    if (Array.isArray(node)) {
      node.forEach( (n, i) => standard( node, i, n ) );
    }

    else {
      for (let name of Object.getOwnPropertyNames( node )) {
        const trans = transformers[name] || standard;
        if(customTransformers[name])
          customTransformers[name](node, name, node[name], csnPath, parent, prop);

        trans( node, name, node[name], csnPath );
      }
    }
    csnPath.pop();
  }

  function dictionary( node, prop, dict ) {
    // Allow skipping dicts like actions in forHanaNew
    if(options.skipDict && options.skipDict[prop])
      return;
    csnPath.push( prop );
    for (let name of Object.getOwnPropertyNames( dict )) {
      standard( dict, name, dict[name] );
    }
    if (!Object.prototype.propertyIsEnumerable.call( node, prop ))
      setProp(node, '$' + prop, dict);
    csnPath.pop();
  }

  function definitions( node, prop, dict ) {
    csnPath.push( prop );
    for (let name of Object.getOwnPropertyNames( dict )) {
      const skip = options && options.skipArtifact && options.skipArtifact(dict[name], name) || false;
      if(!skip) {
        artifactTransformers.forEach(fn => fn(dict, name, dict[name]));
        standard( dict, name, dict[name] );
      }
    }
    if (!Object.prototype.propertyIsEnumerable.call( node, prop ))
      setProp(node, '$' + prop, dict);
    csnPath.pop();
  }

  //Keep looping through the pathRef
  function pathRef( node, prop, path ) {
    csnPath.push( prop );
    path.forEach( function step( s, i ) {
      if (s && typeof s === 'object') {
        csnPath.push( i );
        if(options.drillRef) {
          standard(path, i, s);
        } else {
          if (s.args)
            standard( s, 'args', s.args );
          if (s.where)
            standard( s, 'where', s.where );
        }
        csnPath.pop();
      }
    } );
    csnPath.pop();
  }
}

const _dependencies = Symbol('_dependencies');
const _dependents = Symbol('_dependents');

/**
 * Calculate the hard dependencies between artifacts (as needed to ensure the correct view order).
 * Only works on A2Jed HANA CSN!
 *
 * _dependents: All artifacts that depend on this artifact (because they have a ref that points to it)
 * _dependencies: All artifacts this artifact depends on (because it has a ref to it)
 *
 * @param {object} csn A CSN to enrich in-place
 * @returns {object} CSN with _dependents/_dependencies set, "cleanup" function, _dependents/_dependencies Symbol used
 */
function setDependencies( csn ) {
  const cleanup = [];
  const { artifactRef } = csnRefs(csn);

  forEachDefinition(csn, (artifact, artifactName) => {
    if(getNormalizedQuery(artifact).query) {
      initDependencies(artifact);
      forAllQueries(getNormalizedQuery(artifact).query, (query) => {
        if(query.SELECT && query.SELECT.from) {
          if(query.SELECT.from.args) {
            handleArgs(artifact, artifactName, query.SELECT.from.args);
          } else {
            if(typeof query.SELECT.from === 'string' || query.SELECT.from.ref )
              handleDependency(artifactRef(query.SELECT.from), artifact, artifactName);
          }
        }
      },  ['definitions', artifactName, (artifact.projection ? 'projection' : 'query')])
    }
  })

  return {cleanup, csn, _dependents, _dependencies};

  function handleArgs(artifact, artifactName, args){
    for(let arg of args){
      if (arg.args) {
        handleArgs(artifact, artifactName, arg.args);
      } else if (arg.ref) {
        handleDependency(artifactRef(arg), artifact, artifactName)
      }
    }
  }

  function handleDependency(dependency, dependant, dependantName) {
    dependant[_dependencies].add(dependency);
    initDependents(dependency);
    dependency[_dependents][dependantName] = dependant;
  }

  function initDependents(obj){
    if(!obj[_dependents]) {
      obj[_dependents] = Object.create(null);
      cleanup.push(() => delete obj[_dependents]);
    }
  }

  function initDependencies(obj){
    if(!obj[_dependencies]) {
      obj[_dependencies] = new Set();
      cleanup.push(() => delete obj[_dependencies]);
    }
  }
}

/**
 * If the artifact is either abstract or assigned '@cds.persistence.skip' it
 * never reaches the Database layer.
 *
 * @param {CSN.Artifact} art
 * @returns {boolean}
 */
function isPersistedOnDatabase(art) {
  return !([ 'entity', 'view' ].includes(art.kind) && (art.abstract || hasAnnotationValue(art, '@cds.persistence.skip')));
}

/**
 * Central generated by cds-compiler string generator function without further decoration
 *  for unified tagging of generated content
 *
 * @returns {string} String containing compiler version that was used to generate content
 */
function generatedByCompilerVersion() {
  return `generated by cds-compiler version ${version}`;
}

/**
 * Return the projection to look like a query.
 *
 * @param {CSN.Artifact} art Artifact with a query or a projection
 * @returns {object} Object with a query property.
 */
function getNormalizedQuery(art) {
  if (art.projection) {
    return { query: { SELECT: art.projection } };
  }
  return art;
}

/**
 * Merge multiple 'options' objects (from right to left, i.e. rightmost wins). Structured option values are
 * merged deeply. Structured option value from the right may override corresponding bool options on the left,
 * but no other combination of struct/scalar values is allowed. Array options are not merged, i.e. their
 * content is treated like scalars.
 * Returns a new options object.
 *
 * @param {...CSN.Options} optionsObjects
 * @return {CSN.Options}
 */
function mergeOptions(...optionsObjects) {
  let result = {};
  for (const options of optionsObjects) {
    if (options)
      result = mergeTwo(result, options, 'options');
  }

  // Reverse the array to ensure that the rightmost option has priority
  const reversedOptions = [...optionsObjects].reverse(); // de-structure and create a new array, so reverse doesn't impact optionsObject
  const msgOptions = reversedOptions.find(opt => opt && Array.isArray(opt.messages));
  if (msgOptions) {
    result.messages = msgOptions.messages;
  }

  return result;

  // Recursively used for scalars, too
  function mergeTwo(left, right, name) {
    let result;
    // Copy left as far as required
    if (Array.isArray(left)) {
      // Shallow-copy left array
      result = left.slice();
    } else if (isObject(left)) {
      // Deep-copy left object (unless empty)
      result = Object.keys(left).length ? mergeTwo({}, left, name) : {};
    } else {
      // Just use left scalar
      result = left;
    }
    // Check against improper overwriting
    if (isObject(left) && !Array.isArray(left) && (Array.isArray(right) || isScalar(right))) {
      throw new Error(`Cannot overwrite structured option "${name}" with array or scalar value`);
    }
    if ((isScalar(left) && typeof left !== 'boolean' || Array.isArray(left)) && isObject(right) && !Array.isArray(right)) {
      throw new Error(`Cannot overwrite non-boolean scalar or array option "${name}" with structured value`);
    }

    // Copy or overwrite properties from right to left
    if (Array.isArray(right)) {
      // Shallow-copy right array
      result = right.slice();
    } else if (isObject(right)) {
      // Object overwrites undefined, scalars and arrays
      if (result === undefined || isScalar(result) || Array.isArray(result)) {
        result = {};
      }
      // Deep-copy right object into result
      for (let key of Object.keys(right)) {
        result[key] = mergeTwo(result[key], right[key], `${name}.${key}`);
      }
    } else {
      // Right scalar wins (unless undefined)
      result = (right !== undefined) ? right : result;
    }
    return result;
  }

  // Return true if 'o' is a non-null object or array
  function isObject(o) {
    return typeof o === 'object' && o !== null
  }

  // Return true if 'o' is a non-undefined scalar
  function isScalar(o) {
    return o !== undefined && !isObject(o);
  }
}

// Return the name of the top-level artifact surrounding the artifact 'name'
// in 'model'.
// We define "top-level artifact" to be an artifact that has either no parent or only
// ancestors of kind 'namespace'. Note that it is possible for a non-top-level artifact
// to have a namespace as parent and e.g. a context as grandparent (weird but true).
// Will return the artifact 'name' if it is a top-level artifact itself, and 'undefined'
// if there is no artifact surrounding 'name' in the model
// TODO: to be checked by author: still intended behaviour with 'cds' prefix?
// TODO: Can this be replaced by getRootArtifactName? Or maybe not rely on namespace-hacking...
// FIXME: This only works with namespace-hacking, i.e. adding them as artifacts...
function getTopLevelArtifactNameOf(name, model) {
  let dotIdx = name.indexOf('.');
  if (dotIdx == -1) {
    // No '.' in the name, i.e. no parent - this is a top-level artifact (if it exists)
    return model.definitions[name] ? name : undefined;
  }
  // If the first name part is not in the model, there is nothing to find
  if (!model.definitions[name.substring(0, dotIdx)]) {
    return undefined;
  }
  // Skip forward through '.'s until finding a non-namespace
  while (dotIdx != -1 && (!model.definitions[name.substring(0, dotIdx)] || model.definitions[name.substring(0, dotIdx)].kind === 'namespace')) {
    dotIdx = name.indexOf('.', dotIdx + 1);
  }
  if (dotIdx == -1) {
    // This is a top-level artifact
    return name;
  }
  // The skipped part of 'name' is the top-level artifact name
  return name.substring(0, dotIdx);
}

/**
* If the artifact with the name given is part of a context (or multiple), return the top-most context.
* Else, return the artifact itself. Namespaces are not of concern here.
*
* @param {string} artifactName Name of the artifact
* @param {CSN.Model} csn
* @returns {string} Name of the root
*/
function getRootArtifactName(artifactName, csn) {
  const parts = artifactName.split('.');

  if (parts.length === 1)
    return artifactName;

  let seen = getNamespace(csn, artifactName) || '';
  const startIndex = (seen === '') ? 0 : seen.split('.').length;
  for (let i = startIndex; i < parts.length; i++) {
    if (seen === '')
      seen = parts[i];
    else
        seen = `${seen}.${parts[i]}`;

    const art = csn.definitions[seen];
      // Our artifact seems to be contained in this context
    if (art && (art.kind === 'context' || art.kind === 'service'))
      return seen;
  }
    // Our artifact is a root artifact itself
  return seen;
}

// Return the last part of 'name'.
// Examples:
//   'foo.bar.wiz' => 'wiz'
//   'foo' => 'foo';
//   'foo::bar' => 'bar'
function getLastPartOf(name) {
  return name.substring(name.search(/[^.:]+$/));
}

// Return the last part of reference array 'ref'
// Examples:
//   ['foo.bar', 'wiz'] => 'wiz'
//   ['foo.bar.wiz'] => 'wiz'
//   ['foo'] => 'foo';
//   ['foo::bar'] => 'bar'
function getLastPartOfRef(ref) {
  let lastPathStep = ref[ref.length - 1];
  return getLastPartOf(lastPathStep.id || lastPathStep);
}

// Return the name of the parent artifact of the artifact 'name' or
// '' if there is no parent.
function getParentNameOf(name) {
  return name.substring(0, name.lastIndexOf('.'));
}

// Return an array of parent names of 'name' (recursing into grand-parents)
// Examples:
//   'foo.bar.wiz' => [ 'foo.bar', 'foo' ]
//   'foo' => []
//   'foo::bar.wiz' => 'foo::bar'
//   'foo::bar' => []
function getParentNamesOf(name) {
  let remainder = name.slice(0, -getLastPartOf(name).length);
  if (remainder.endsWith('.')) {
    let parentName = remainder.slice(0, -1);
    return [parentName, ...getParentNamesOf(parentName)];
  } else {
    return [];
  }
}


// Copy all annotations from 'fromNode' to 'toNode'. Overwrite existing ones only if 'overwrite' is true
function copyAnnotations(fromNode, toNode, overwrite=false) {
  // Ignore if no toNode (in case of errors)
  if (!toNode) {
    return;
  }
  for (let prop in fromNode) {
    if (!Object.hasOwnProperty.call( fromNode, prop ))
      continue;
    if (prop.startsWith('@')) {
      if (toNode[prop] === undefined || overwrite) {
        toNode[prop] = fromNode[prop];
      }
    }
  }
}

function isAspect(node) {
  return node && node.kind === 'aspect';
}

// For each property named 'path' in 'node' (recursively), call callback(path, node)
function forEachPath(node, callback) {
  if (node === null || typeof node !== 'object') {
    // Primitive node
    return;
  }
  for (let name in node) {
    if (!Object.hasOwnProperty.call( node, name ))
      continue;
    // If path found within a non-dictionary, call callback
    if (name === 'path' && Object.getPrototypeOf(node)) {
      callback(node.path, node);
    }
    // Descend recursively
    forEachPath(node[name], callback);
  }
}


/**
 * Return true if the artifact has a valid, truthy persistence.exists/skip annotation
 *
 * @param {CSN.Artifact} artifact
 * @returns {boolean}
 */
function hasValidSkipOrExists(artifact) {
  return (artifact.kind === 'entity' || artifact.kind === 'view') &&
         (hasAnnotationValue(artifact, '@cds.persistence.exists', true) || hasAnnotationValue(artifact, '@cds.persistence.skip', true))

}

/**
 * Get the namespace part of the artifact name - not the whole prefix, just the part caused by namespaces.
 *
 * @param {CSN.Model} csn CSN model
 * @param {string} artifactName artifact name to get the namespace for
 * @returns {string | null} The namespace name
 */
function getNamespace(csn, artifactName) {
  const parts = artifactName.split('.');
  let seen = parts[0];
  const art = csn.definitions[seen];

  // First step is not a namespace (we faked those in the CSN)
  // No subsequent step can be a namespace then
  if (art && art.kind !== 'namespace')
    return null;


  for (let i = 1; i < parts.length; i++) {
    // This was definitely a namespace so far
    const previousArtifactName = seen;
    seen = `${seen}.${parts[i]}`;
    // This might not be - if it isn't, return the result.
    const currentArtifact = csn.definitions[seen];
    if (currentArtifact && currentArtifact.kind !== 'namespace')
      return previousArtifactName;
  }
  // We came till here - so the full artifactName is a namespace
  return artifactName;
}

/**
 * Sorts the definition dictionary in tests mode.
 *
 * @param {CSN.Model} csn
 * @param {CSN.Options} options
 */
function sortCsnDefinitionsForTests(csn, options) {
  if (!options.testMode)
    return;
  const sorted = Object.create(null);
  Object.keys(csn.definitions).sort().forEach((name) => {
    sorted[name] = csn.definitions[name];
  });
  csn.definitions = sorted;
}

/**
 * Return an array of non-abstract service names contained in CSN
 *
 * @param {CSN.Model} csn
 * @returns {CSN.Service[]}
 */
function getServiceNames(csn) {
  let result = [];
  forEachDefinition(csn, (artifact, artifactName) => {
    if (artifact.kind === 'service' && !artifact.abstract) {
      result.push(artifactName);
    }
  });
  return result;
}

/**
 * Check wether the artifact is @cds.persistence.skip
 * 
 * @param {CSN.Artifact} artifact 
 * @returns {Boolean}
 */
function isSkipped(artifact) {
  return hasAnnotationValue(artifact, '@cds.persistence.skip', true)
}

/**
 * Walk path in the CSN and return the result.
 * 
 * @param {CSN.Model} csn 
 * @param {CSN.Path} path 
 * @returns {object} Whatever is at the end of path
 */
function walkCsnPath(csn, path) {
  /** @type {object} */
  let obj = csn;
  for(let i = 0; i < path.length; i++){
    obj = obj[path[i]];
  }

  return obj;
}

module.exports = {
  getUtils,
  cloneCsn,
  cloneCsnDictionary,
  isBuiltinType,
  assignAll,
  forEachGeneric,
  forEachDefinition,
  forEachMember,
  forEachMemberRecursively,
  forEachRef,
  forAllQueries,
  forAllElements,
  hasAnnotationValue,
  isEdmPropertyRendered,
  getArtifactDatabaseNameOf,
  getResultingName,
  getUnderscoredName,
  getElementDatabaseNameOf,
  applyTransformations,
  setDependencies,
  isPersistedOnDatabase,
  generatedByCompilerVersion,
  getNormalizedQuery,
  mergeOptions,
  getTopLevelArtifactNameOf,
  getRootArtifactName,
  getLastPartOfRef,
  getParentNamesOf,
  getParentNameOf,
  getLastPartOf,
  copyAnnotations,
  isAspect,
  forEachPath,
  hasValidSkipOrExists,
  getNamespace,
  sortCsnDefinitionsForTests,
  getServiceNames,
  isSkipped,
  walkCsnPath,
};
