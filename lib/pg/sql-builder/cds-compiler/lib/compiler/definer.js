// Compiler phase "define": transform dictionary of AST-like CSNs into augmented CSN

// AST-like CSN looks as follows:
//   { kind: 'source', env: <dictionary of artifact defs>, namespace: {}, ... }
//
// The property `artifacts` of a source contains the top-level definitions.
// Definitions inside a context are not listed here (as opposed to
// `definitions`, see below), but inside the property `artifacts` of that context.

// The define phase (function 'define' below) enriches a dictionary of
// (file names to) AST-like CSNs and restructure them a little bit, the result
// is called "augmented CSN":
//   { sources: <dictionary of ASTs>, definitions: <dictionary of artifact defs> }
//
// The property `sources` is the input argument (dictionary of source ASTs).
//
// The property `definitions` is set by this compiler phase.  It contains the
// definitions of all main artifacts (i.e. not elements) from all sources, the
// key is the absolute name of that artifact.  These definitions are the same
// objects as the definitions accessible via `sources` and `artifacts` of the
// corresponding source/context.
//
// Because different sources could define artifacts with the same absolute
// name, this compiler phase also put a property `messages` to the resulting
// model, which is a vector of messages for the redefinitions.  (Using the same
// name for different definitions in one source is already recognized during
// parsing.)
//
// You get the compact "official" CSN format by applying the function exported
// by "../json/to-csn.js" to the augmented CSN.

// Example 'file.cds':
//   namespace A;
//   context B {
//     type C { elem: String(4); }
//   }
// Check the augmented CSN by compiling it with
//   cdsc --raw-output + file.cds
//
// ┌───────────────┐           ┌───────────────────────────────────────────┐
// │    sources    │           │                 definitions               │
// └──┬────────────┘           └──┬────────────────────────────┬───────────┘
//    │                           │                            │
//    │ ['file.cds']              │ ['A.B']                    │ ['A.B.C']
//    ↓                           ↓                            ↓
// ┌───────────────┐  _parent  ┌────────────────┐  _parent  ┌──────────────┐
// │ kind:'source' │←──────────┤ kind:'context' │←──────────┤ kind: 'type' │
// │ artifacts: ───┼──────────→│ artifacts: ────┼──────────→│ ...          │
// └───────────────┘   ['B']   └────────────────┘   ['C']   └──────────────┘
//
// The _parent properties are not shown in the JSON - they are used for name
// resolution, see file './resolver.js'.

// An artifact definition looks as follows (example: context "A.B" above):
//   {
//     kind: 'context',
//     name: { id: 'B', absolute: 'A.B', location: { <for the id "B"> } },
//     artifacts: <for contexts, a dictionary of artifacts defined within>,
//     location: { <of the complete artifact definition> } },
//     _parent: <the parent artifact, here the source 'file.cds'>
//   }
// The properties `name.absolute`, `name.component` and `_parent` are set
// during this compiler phase.

// The definition of an entity or a structured type would contain an `elements`
// property instead of an `artifacts` property.

// An element definition looks as follows (example: "elem" above):
//   {
//     kind: 'element',
//     name: { id: 'elem', component: 'elem', location: { <for the id "elem"> } }
//     type: { path: [ { id: 'String', location: ... } ] },
//     $typeArgs: [ { number: '4', location: ... } ]
//     location: { <of the complete element definition> } },
//     _parent: <the parent artifact, here the type "A.B.C">
//   }
// References are resolved in the "resolve" phase of the compiler, see
// './resolver.js'.  We then get the properties `type.absolute` and `length`.

// Sub phase 1 (addXYZ) - only for main artifats
//  - set _block links
//  - store definitions (including context extensions), NO duplicate check
//  - artifact name check
//  - Note: the only allow name resolving is resolveUncheckedPath(),
//    TODO: make sure that _no_ _artifact link is set
//  - POST: all user-written definitions are in model.definitions

// Sub Phase 2 (initXYZ)
//  - set _parent, _main (later: _service?) links, and _block links of members
//  - add _subArtifacts dictionary and "namespace artifacts" for name resolution
//  - duplicate checks (TODO - currently via preProcessArtifact in definer)
//  - structure checks ?
//  - annotation assignments
//  - POST: resolvePath() can be called for artifact references (if complete model)

// More sub phases...

// The main difficulty is the correct behavior concerning duplicate definitions
//  - We need a unique object for the _subArtifacts dictionary.
//  - We must have a property at the artifact whether there are duplicates in order
//    to avoid consequential or repeated errors.
//  - But: The same artifact is added to multiple dictionaries.
//  - Solution part 1: $duplicates as property of the artifact or member
//    for 'definitions', '_artifacts' and member dictionaries.
//  - Solution part 2: array value in dictionary for duplicates in CDL 'artifacts'
//    dictionary, also used for `_combined` in query search dictionary.

'use strict';

const { searchName, weakLocation } = require('../base/messages');
const {
  isDeprecatedEnabled, isBetaEnabled,
  setProp, forEachGeneric, forEachInOrder,
  forEachMember, forEachDefinition,
  forEachMemberRecursivelyWithQuery,
} = require('../base/model');
const {
  dictAdd, dictAddArray, dictForEach, pushToDict,
} = require('../base/dictionaries');
const {
  dictLocation,
} = require('../base/location');
const {
  annotationVal, annotationIsFalse, annotateWith,
} = require('./utils');
const {
  dictKinds,
  kindProperties,
  fns,
  linkToOrigin,
  setMemberParent,
  storeExtension,
  dependsOnSilent,
} = require('./shared');
const { compareLayer, layer } = require('./moduleLayers');
const { initBuiltins } = require('./builtins');
const setLink = setProp;

/**
 * Export function of this file.  Transform argument `sources` = dictionary of
 * AST-like CSNs into augmented CSN.  If a vector is provided for argument
 * `messages` (usually the combined messages from `parse` for all sources), do
 * not throw an exception in case of an error, but push the corresponding error
 * object to that vector.  If at least one AST does not exist due to a parse
 * error, set property `lintMode` of `options` to `true`.  Then, the resolver
 * does not report errors for using directives pointing to non-existing
 * artifacts.
 *
 * @param {XSN.Model} model Model with `sources` property that contain AST-like CSNs.
 */
function getDefinerFunctions( model ) {
  const { options } = model;
  // Get simplified "resolve" functionality and the message function:
  const {
    message, error, warning, info, messages,
  } = model.$messageFunctions;
  const {
    resolveUncheckedPath,
    resolvePath,
    resolveTypeArguments,
    defineAnnotations,
    attachAndEmitValidNames,
  } = fns( model );
  const extensionsDict = Object.create(null);
  let addTextsLanguageAssoc = false;

  return {
    define,
    initArtifact,
    lateExtensions,
    projectionAncestor,
    hasTruthyProp,
  };

  /**
   * Main function of the definer.
   *
   * @returns {XSN.Model}
   */
  function define() {
    if (options.deprecated &&
        messages.every( m => m.messageId !== 'api-deprecated-option' )) {
      warning( 'api-deprecated-option', {},
               { prop: 'deprecated', '#': (options.beta ? 'beta' : 'std') }, {
               // TODO: make the text scarier in future versions
                 std: 'With option $(PROP), many newer features are disabled',
                 // eslint-disable-next-line max-len
                 beta: 'With option $(PROP), beta features and many other newer features are disabled',
               } );
    }
    model.definitions = Object.create(null);
    setProp( model, '_entities', [] ); // for entities with includes
    model.$entity = 0;
    model.$compositionTargets = Object.create(null);
    model.$lateExtensions = Object.create(null); // for generated artifacts

    initBuiltins( model );
    for (const name in model.sources)
      addSource( model.sources[name] );
    for (const name in model.sources)
      initNamespaceAndUsing( model.sources[name] );
    dictForEach( model.definitions, initArtifact );
    dictForEach( model.vocabularies, initVocabulary );

    mergeI18nBlocks( model );

    if (options.parseCdl) {
      initExtensionsWithoutApplying();
      // Check for redefinitions
      Object.keys( model.definitions ).forEach( preProcessArtifact );
      // If no extensions shall be applied then we can skip further
      // artifact processing and return the model with an `extensions` property.
      return model;
    }

    applyExtensions();

    Object.keys( model.definitions ).forEach( preProcessArtifact );
    const commonLanguagesEntity // TODO: remove beta after a grace period
        = (options.addTextsLanguageAssoc || isBetaEnabled( options, 'addTextsLanguageAssoc' )) &&
          model.definitions['sap.common.Languages'];
    addTextsLanguageAssoc = !!(commonLanguagesEntity && commonLanguagesEntity.elements &&
                               commonLanguagesEntity.elements.code);
    Object.keys( model.definitions ).forEach( processArtifact );
    lateExtensions( false );
    // Set _service link (sorted to set it on parent first).  Could be set
    // directly, but beware a namespace becoming a service later.
    Object.keys( model.definitions ).sort().forEach( setAncestorsAndService );
    forEachGeneric( model, 'definitions', postProcessArtifact );
    return model;
  }

  // Phase 1: ----------------------------------------------------------------

  /**
   * Add definitions of the given source AST, both CDL and CSN
   *
   * @param {XSN.AST} src
   */
  function addSource( src ) {
    // handle sub model from CSN parser
    if (!src.kind)
      src.kind = 'source';

    let namespace = src.namespace && src.namespace.path;
    let prefix = namespace ? `${ pathName( namespace ) }.` : '';
    if (prefix.startsWith( 'cds.') && !prefix.match(/^cds\.foundation(\.|$)/)) {
      error( 'reserved-namespace-cds', [ src.namespace.location, src.namespace ], {},
             // TODO: use $(NAME)
             'The namespace "cds" is reserved for CDS builtins' );
      namespace = null;
    }
    if (src.$frontend !== 'json') { // CDL input
      // TODO: set _block to builtin
      if (src.artifacts)
        addPathPrefixes( src.artifacts, prefix ); // before addUsing
      else if (src.usings || src.namespace)
        src.artifacts = Object.create(null);
      if (src.usings)
        src.usings.forEach( u => addUsing( u, src ) );
      if (namespace)
        addNamespace( namespace, src );
      if (src.artifacts)     // addArtifact needs usings for context extensions
        dictForEach( src.artifacts, a => addArtifact( a, src, prefix ) );
    }
    else if (src.definitions) {      // CSN input
      prefix = '';
      dictForEach( src.definitions, v => addDefinition( v, src ) );
    }
    if (src.vocabularies) {
      if (!model.vocabularies)
        model.vocabularies = Object.create(null);
      dictForEach( src.vocabularies, v => addVocabulary( v, src, prefix ) );
    }
    if (src.extensions) {       // requires using to be known!
      src.extensions.forEach( e => addExtension( e, src ) );
    }
  }

  function addDefinition( art, block ) {
    const { absolute } = art.name;
    // TODO: check reserved, see checkName()/checkLocalizedObjects() of checks.js
    if (absolute === 'cds' ||
        absolute.startsWith( 'cds.') && !absolute.match(/^cds\.foundation(\.|$)/)) {
      error( 'reserved-namespace-cds', [ art.name.location, art ], {},
             // TODO: use $(NAME)
             'The namespace "cds" is reserved for CDS builtins' );
    }
    else if (absolute === 'localized' || absolute.startsWith( 'localized.' )) {
      if (!art.query && art.kind !== 'context') { // context for recompilation (TODO: necessary?)
        error( 'reserved-namespace-localized', [ art.name.location, art ], {},
               'The namespace "localized" is reserved for localization views' );
      }
      else if (block.$frontend !== 'json') {
        info( 'ignored-localized-definition', [ art.name.location, art ], {},
              'This definition in the namespace "localized" is ignored' );
      }
      else if (!block.$withLocalized && !options.$recompile) { // block = src
        block.$withLocalized = true;
        info( 'recalculated-localized', [ art.name.location, null ], {},
              'Input CSN contains localization view definitions which are re-calculated' );
      }
      art.$inferred = 'LOCALIZED-IGNORED';
      return false;
    }
    else {
      setLink( art, '_block', block );
      // dictAdd might set $duplicates to true if def in other source
      dictAdd( model.definitions, absolute, art );
      return true;
    }
    return false;
  }

  // If 'A.B.C' is in 'artifacts', also add 'A' for name resolution
  function addPathPrefixes( artifacts, prefix ) {
    for (const name in artifacts) {
      const d = artifacts[name];
      const a = Array.isArray(d) ? d[0] : d;
      if (!a.name.absolute)
        a.name.absolute = prefix + name;
      const index = name.indexOf( '.' );
      if (index < 0)
        continue; // also for newly added (i.e. does not matter whether visited or not)
      const id = name.substring( 0, index );
      if (artifacts[id])
        continue;
      // TODO: enable optional locations
      const location = a.name.path && a.name.path[0].location || a.location;
      const absolute = prefix + id;
      artifacts[id] = {
        kind: 'using',          // !, not namespace - we do not know artifact yet
        name: {
          id, absolute, location, $inferred: 'as',
        },
        // TODO: use global ref (in general - all uses of splitIntoPath)
        extern: { path: splitIntoPath( location, absolute ), location },
        location,
        $inferred: 'path-prefix',
      };
    }
  }


  /**
   * Add the names of a USING declaration to the top-level search environment
   * of the source, and set the absolute name referred by the USING
   * declaration.
   *
   * @param {XSN.Using} decl Node to be expanded and added to `src`
   * @param {XSN.AST} src
   */
  function addUsing( decl, src ) {
    if (decl.usings) {
      // e.g. `using {a,b} from 'file.cds'` -> recursive
      decl.usings.forEach( u => addUsing( u, src ) );
      return;
    }
    const { path } = decl.extern;
    if (path.broken || !path[0]) // syntax error
      return;
    if (!decl.name)
      decl.name = { ...path[path.length - 1], $inferred: 'as' };
    decl.name.absolute = pathName( path );
    const name = decl.name.id;
    // TODO: check name: no "."
    if (path[0].id === 'localized' || path[0].id.startsWith( 'localized.' )) {
      decl.$inferred = 'LOCALIZED-IGNORED';
      warning( 'using-localized-view', [ path.location, decl ], {},
               'Localization views can\'t be referred to - ignored USING' );
      // actually not ignored anymore
    }
    const found = src.artifacts[name];
    if (found && found.$inferred === 'path-prefix' &&
        found.name.absolute === decl.name.absolute)
      src.artifacts[name] = decl;
    else
      dictAddArray( src.artifacts, name, decl );
  }

  function addNamespace( path, src ) {
    const absolute = pathName( path );
    if (path.broken) // parsing may have failed
      return;
    // create using for own namespace:
    const last = path[path.length - 1];
    const { id } = last;
    if (src.artifacts[id] || last.id.includes('.'))
      // not used as we have a definition/using with that name, or dotted last path id
      return;
    src.artifacts[id] = {
      kind: 'using',
      name: {
        id, absolute, location: last.location, $inferred: 'as',
      },
      extern: src.namespace,
      location: src.namespace.location,
      $inferred: 'namespace',
    };
  }
  function addArtifact( art, block, prefix ) {
    if (art.kind === 'using')
      return;
    art.name.absolute = prefix + pathName( art.name.path );
    addDefinition( art, block );
    if (art.artifacts) {
      const p = `${ art.name.absolute }.`;
      // path prefixes (usings) must be added before extensions in artifacts:
      addPathPrefixes( art.artifacts, p );
      dictForEach( art.artifacts, a => addArtifact( a, art, p ) );
    }
    if (art.extensions) {       // requires using to be known!
      art.extensions.forEach( e => e.name && addExtension( e, art ) );
    }
  }

  function addExtension( ext, block ) {
    setLink( ext, '_block', block );
    const absolute = ext.name && resolveUncheckedPath( ext.name, 'extend', ext );
    if (!absolute)                    // broken path
      return;
    delete ext.name.path[0]._artifact; // might point to wrong JS object in phase 1
    ext.name.absolute = absolute; // definition might not be there yet, no _artifact link
    pushToDict( extensionsDict, absolute, ext );
    if (!ext.artifacts)
      return;
    // Directly add the artifacts of context and service extension:
    if (!model.$blocks)
      model.$blocks = Object.create( null );
    // Set block number for debugging (--raw-output):
    // eslint-disable-next-line no-multi-assign
    ext.name.select = model.$blocks[absolute] = (model.$blocks[absolute] || 0) + 1;
    const prefix = `${ absolute }.`;
    dictForEach( ext.artifacts, a => addArtifact( a, ext, prefix ) );
  }

  function addVocabulary( vocab, block, prefix ) {
    setLink( vocab, '_block', block );
    const { name } = vocab;
    if (!name.absolute)
      name.absolute = prefix + name.path.map( id => id.id ).join('.');
    dictAdd( model.vocabularies, name.absolute, vocab );
  }

  // Phase 2 ("init") --------------------------------------------------------

  function initNamespaceAndUsing( src ) {
    if (src.namespace) {
      const decl = src.namespace;
      const { path } = decl;
      if (path.broken) // parsing may have failed
        return;
      const { id } = path[path.length - 1];
      const absolute = pathName( path );
      if (!model.definitions[absolute]) {
        // TODO: do we really need this namespace entry - try without (msg change)
        const location = path.location || decl.location;
        // TODO: make it possible to have no location
        const ns = { kind: 'namespace', name: { absolute, location }, location };
        model.definitions[absolute] = ns;
        initParentLink( ns, model.definitions );
      }
      const builtin = model.$builtins[id];
      if (builtin && !builtin.internal &&
          src.artifacts[id] && src.artifacts[id].extern === decl) {
        warning( 'ref-shadowed-builtin', [ decl.location, null ], // no home artifact
                 { id, art: absolute, code: `using ${ builtin.name.absolute };` },
                 '$(ID) now refers to $(ART) - consider $(CODE)' );
      }
      // setLink( decl, '_artifact', model.definitions[absolute] ); // TODO: necessary?
    }
    if (!src.usings)
      return;
    for (const name in src.artifacts) {
      const entry = src.artifacts[name];
      if (!Array.isArray(entry)) // no local name duplicate
        continue;
      for (const decl of entry) {
        if (!decl.$duplicates) { // do not have two duplicate messages
          error( 'duplicate-using', [ decl.name.location, null ], { name }, // TODO: semantic
                 'Duplicate definition of top-level name $(NAME)' );
        }
      }
    }
  }

  function initArtifact( art, reInit = false ) {
    if (!reInit)
      initParentLink( art, model.definitions );
    const block = art._block;
    defineAnnotations( art, art, block );
    initMembers( art, art, block );
    initDollarSelf( art );      // $self
    if (art.params)
      initParams( art );        // $parameters
    if (art.includes && !(art.name.absolute in extensionsDict)) // TODO: in next phase?
      extensionsDict[art.name.absolute] = []; // structure with includes must be "extended"

    if (!art.query)
      return;
    art.$queries = [];
    setLink( art, '_from', [] ); // for sequence of resolve steps
    if (!setLink( art, '_leadingQuery', initQueryExpression( art.query, art ) ) )
      return;                   // null or undefined in case of parse error
    setProp( art._leadingQuery, '_$next', art );
    // the following we be removed soon if we have:
    // view elements as proxies to elements of leading query
    if (art.elements) { // specified element via compilation of client-style CSN
      setProp( art, 'elements$', art.elements );
      delete art.elements;
    }
  }

  function initVocabulary( art ) {
    initParentLink( art, model.vocabularies );
    const block = art._block;
    defineAnnotations( art, art, block );
    initMembers( art, art, block );
  }

  function initParentLink( art, definitions ) {
    setLink( art, '_parent', null );
    const { absolute } = art.name;
    const dot = absolute.lastIndexOf('.');
    if (dot < 0)
      return;
    art.name.id = absolute.substring( dot + 1 ); // XSN TODO: remove name.id for artifacts
    const prefix = absolute.substring( 0, dot );
    let parent = definitions[prefix];
    if (!parent) {
      const { location } = art.name; // TODO: make it possible to have no location
      parent = { kind: 'namespace', name: { absolute: prefix, location }, location };
      definitions[prefix] = parent;
      initParentLink( parent, definitions );
    }
    if (art.kind !== 'namespace' &&
        isDeprecatedEnabled( options, 'generatedEntityNameWithUnderscore' )) {
      let p = parent;
      while (p && kindProperties[p.kind].artifacts)
        p = p._parent;
      if (p) {
        error( 'subartifacts-not-supported', [ art.name.location, art ],
               { art: p, prop: 'deprecated.generatedEntityNameWithUnderscore' },
               // eslint-disable-next-line max-len
               'With the option $(PROP), no sub artifact can be defined for a non-context/service $(ART)' );
      }
    }
    setLink( art, '_parent', parent );
    if (!parent._subArtifacts)
      setLink( parent, '_subArtifacts', Object.create(null) );
    if (art.$duplicates !== true) // no redef or "first def"
      parent._subArtifacts[absolute.substring( dot + 1 )] = art; // not dictAdd()
  }

  // From here til EOF, reexamine code ---------------------------------------

  // currently called from preProcessArtifact(), do be called in "init"
  function checkRedefinitions( obj, name, prop ) {
    forEachMember( obj, checkRedefinitions, obj.targetAspect );
    if (!obj.$duplicates)
      return;
    if (obj.name.location.file === '<built-in>') {
      // builtin types like namespace 'cds' or namespace 'localized' shouldn't be printed.
      // The error shall only be printed for the user-defined conflicting artifact.
      return;
    }
    error( 'duplicate-definition', [ obj.name.location, obj ],
           { name, '#': (obj.kind === 'namespace') ? 'namespace' : dictKinds[prop] } );
  }

  function initDollarSelf( art ) {
    const selfname = '$self';
    // TODO: use setMemberParent() ?
    const self = {
      name: { id: selfname, alias: selfname, absolute: art.name.absolute },
      kind: '$self',
      location: art.location,
    };
    setProp( self, '_parent', art );
    setProp( self, '_main', art ); // used on main artifact
    setProp( self, '_origin', art );
    art.$tableAliases = Object.create(null);
    art.$tableAliases[selfname] = self;
    setProp( art, '_$next', model.$magicVariables );
  }

  function initParams( art ) {
    // TODO: use setMemberParent() ?
    const parameters = {
      name: { id: '$parameters', param: '$parameters', absolute: art.name.absolute },
      kind: '$parameters',
      location: art.location,
    };
    setProp( parameters, '_parent', art );
    setProp( parameters, '_main', art );
    // Search for :const after :param.  If there will be a possibility in the
    // future that we can extend <query>.columns, we must be sure to use
    // _block of that new column after :param (or just allow $parameters there).
    setProp( parameters, '_block', art._block );
    if (art.params) {
      parameters.elements = art.params;
      parameters.$tableAliases = art.params; // TODO: find better name - $lexical?
    }
    art.$tableAliases.$parameters = parameters;
  }

  function initSubQuery( query ) {
    if (query.on)
      initExprForQuery( query.on, query );
    // TODO: MIXIN with name = ...subquery (not yet supported anyway)
    initSelectItems( query, query.columns );
    if (query.where)
      initExprForQuery( query.where, query );
    if (query.having)
      initExprForQuery( query.having, query );
    initMembers( query, query, query._block );
  }

  function initSelectItems( parent, columns ) {
    // TODO: forbid expand/inline with :param, global:true, in ref-where, outside queries (CSN), ...
    let wildcard = null;
    for (const col of columns || parent.expand || parent.inline || []) {
      if (!col)                 // parse error
        continue;
      if (!columns) {
        if (parent.value)
          setProp( col, '_pathHead', parent ); // also set for '*' in expand/inline
        else if (parent._pathHead)
          setProp( col, '_pathHead', parent._pathHead );
      }
      if (col.val === '*') {
        if (!wildcard) {
          wildcard = col;
        }
        else {
          // a late syntax error (this code also runs with parse-cdl), i.e.
          // no semantic loc (wouldn't be available for expand/inline anyway)
          error( 'syntax-duplicate-clause', [ col.location, null ],
                 { prop: '*', line: wildcard.location.line, col: wildcard.location.col },
                 'You have provided a $(PROP) already at line $(LINE), column $(COL)' );
          // TODO: extra text variants for expand/inline? - probably not
          col.val = null;       // do not consider it for expandWildcard()
        }
      }
      else if (col.value || col.expand) {
        setProp( col, '_block', parent._block );
        defineAnnotations( col, col, parent._block ); // TODO: complain with inline
        // TODO: allow sub queries? at least in top-level expand without parallel ref
        if (columns)
          initExprForQuery( col.value, parent );
        initSelectItems( col );
      }
    }
  }

  function initExprForQuery( expr, query ) {
    if (Array.isArray(expr)) { // TODO: old-style $parens ?
      expr.forEach( e => initExprForQuery( e, query ) );
    }
    else if (!expr) {
      return;
    }
    else if (expr.query) {
      initQueryExpression( expr.query, query );
    }
    else if (expr.args) {
      const args = Array.isArray(expr.args) ? expr.args : Object.values( expr.args );
      args.forEach( e => initExprForQuery( e, query ) );
    }
    else if (expr.path && expr.$expected === 'exists') {
      expr.$expected = 'approved-exists';
      approveExistsInChildren(expr);
    }
  }

  /**
   * If we have a valid top-level exists, exists in filters of sub-expressions can be translated,
   * since we will have a top-level subquery after exists-processing in the forHanaNew.
   *
   * Recursively drill down into:
   * - the .path
   * - the .args
   * - the .where.args
   *
   * Any $expected === 'exists' encountered along the way are turned into 'approved-exists'
   *
   * working:     exists toE[exists toE] -> select from E where exists toE
   * not working: toE[exists toE] -> we don't support subqueries in filters
   *
   * @param {object} exprOrPathElement starts w/ an expr but then subelem from .path or .where.args
   */
  function approveExistsInChildren(exprOrPathElement) {
    if (exprOrPathElement.$expected === 'exists')
      exprOrPathElement.$expected = 'approved-exists';
    // Drill down
    if (exprOrPathElement.args)
      exprOrPathElement.args.forEach(elem => approveExistsInChildren(elem));
    else if (exprOrPathElement.where && exprOrPathElement.where.args)
      exprOrPathElement.where.args.forEach(elem => approveExistsInChildren(elem));
    else if (exprOrPathElement.path)
      exprOrPathElement.path.forEach(elem => approveExistsInChildren(elem));
  }

  // table is table expression in FROM, becomes an alias
  function initTableExpression( table, query, joinParents ) {
    if (!table)                 // parse error
      return;
    if (table.path) {           // path in FROM
      if (!table.path.length || table.path.broken)
        // parse error (e.g. final ',' in FROM), projection on <eof>
        return;
      if (!table.name) {
        const last = table.path[table.path.length - 1];
        const dot = last.id.lastIndexOf('.');
        const id = (dot < 0) ? last.id : last.id.substring( dot + 1 );
        // TODO: if we have too much time, we can calculate the real location with '.'
        table.name = { $inferred: 'as', id, location: last.location };
      }
      addAsAlias();
      // _origin is set when we resolve the ref
      if (query._parent.kind !== 'select')
        query._main._from.push( table ); // store tabref if outside "real" subquery
    }
    else if (table.query) {
      if (!table.name || !table.name.id) {
        error( 'query-req-alias', [ table.location, query ], {}, // TODO: not subquery.location ?
               'Table alias is required for this subquery' );
        return;
      }
      addAsAlias();
      setProp( table, '_effectiveType', table.query ); // TODO: remove!
      // Store _origin to leading query of table.query for name resolution
      setProp( table, '_origin', initQueryExpression( table.query, table ) );
    }
    else if (table.join) {
      if (table.on) {
        setProp( table, '_$next', query ); // or query._$next?
        setProp( table, '_block', query._block );
        table.kind = '$join';
        table.name = { location: query.location }; // param comes later
        table.$tableAliases = Object.create( null ); // table aliases and mixin definitions
        joinParents = [ ...joinParents, table ];
      }
      if (table.args) {
        table.args.forEach( (tab, index) => {
          // set for A2J such that for every table alias `ta`:
          // ta === (ta._joinParent
          //        ? ta._joinParent.args[ta.$joinArgsIndex] // in JOIN
          //        : ta._parent.from )                      // directly in FROM
          // Note for --raw-output: _joinParent pointing to CROSS JOIN node has not name
          if (!tab)             // parse error; time for #6241
            return;             // (parser method to only add non-null to array)
          setProp( tab, '_joinParent', table );
          tab.$joinArgsIndex = index;
          initTableExpression( tab, query, joinParents );
        } );
      }
      if (table.on) {         // after processing args to get the $tableAliases
        setMemberParent( table, query.name.select, query ); // sets _parent,_main
        initSubQuery( table );  // init sub queries in ON
        const aliases = Object.keys( table.$tableAliases || {} );
        // Use first tabalias name on the right side of the join to name the
        // (internal) query, should only be relevant for --raw-output, not for
        // user messages or references - TODO: correct if join on left?
        table.name.param = aliases[1] || aliases[0] || '<unknown>';
        setProp( table, '_$next', query._$next );
        // TODO: probably set this to query if we switch to name restriction in JOIN
      }
    }
    return;

    function addAsAlias() {
      table.kind = '$tableAlias';
      setMemberParent( table, table.name.id, query );
      setProp( table, '_block', query._block );
      dictAdd( query.$tableAliases, table.name.id, table, ( name, loc ) => {
        error( 'duplicate-definition', [ loc, table ], { name, '#': '$tableAlias' } );
      } );
      // also add to JOIN nodes for name restrictions:
      for (const p of joinParents) {
        // console.log('ADD:', query.name.id, parents.length, p)
        dictAdd( p.$tableAliases, table.name.id, table );
      }
      if (table.name.id[0] === '$') {
        warning( 'syntax-dollar-ident', [ table.name.location, table ], {
          '#': (table.name.$inferred ? '$tableImplicit' : '$tableAlias'),
          name: '$',
          keyword: 'as',
        } );
      }
    }
  }

  // art is:
  // - entity for top-level queries (including UNION args)
  // - $tableAlias for sub query in FROM
  // - $query for real sub query (in columns, WHERE, ...)
  function initQueryExpression( query, art ) {
    if (!query)                 // parse error
      return query;
    if (query.from) {      // select
      initQuery();
      initTableExpression( query.from, query, [] );
      if (query.mixin)
        addMixin();
      if (!query.$tableAliases.$self) { // same as $projection
        const self = {
          name: { alias: '$self', query: query.name.select, absolute: art.name.absolute },
          kind: '$self',
          location: query.location,
        };
        setProp( self, '_origin', query );
        setProp( self, '_parent', query );
        setProp( self, '_main', query._main );
        setProp( self, '_effectiveType', query ); // TODO: remove
        query.$tableAliases.$self = self;
        query.$tableAliases.$projection = self;
      }
      initSubQuery( query );    // check for SELECT clauses after from / mixin
    }
    else if (query.args) {      // UNION, INTERSECT, ..., query in parens
      const leading = initQueryExpression( query.args[0], art );
      for (const q of query.args.slice(1))
        initQueryExpression( q, art );
      setProp( query, '_leadingQuery', leading );
      if (leading && query.orderBy) {
        if (leading.$orderBy)
          leading.$orderBy.push( ...query.orderBy );
        else
          leading.$orderBy = [ ...query.orderBy ];
      }
      // ORDER BY to be evaluated in leading query (LIMIT is literal)
    }
    else { // with parse error (`select from <EOF>`, `select from E { *, ( select }`)
      return undefined;
    }
    return query._leadingQuery || query;

    function initQuery() {
      const main = art._main || art;
      setProp( query, '_$next',
               // if art is $tableAlias, set to embedding query
               (!art._main || art.kind === 'select' || art.kind === '$join')
                 ? art : art._parent ); // TODO: check with name resolution change
      setProp( query, '_block', art._block );
      query.kind = 'select';
      query.name = { location: query.location };
      setMemberParent( query, main.$queries.length + 1, main );
      // console.log(JSON.stringify(query.name))
      // if (query.name.query === 1 && query.name.absolute === 'S') throw Error();
      main.$queries.push( query );
      setProp( query, '_parent', art ); // _parent should point to alias/main/query
      query.$tableAliases = Object.create( null ); // table aliases and mixin definitions
      dependsOnSilent( main, query );
    }

    function addMixin() {
      // TODO: re-check if mixins have already duplicates
      for (const name in query.mixin) {
        const mixin = query.mixin[name];
        if (!(mixin.$duplicates)) {
          setMemberParent( mixin, name, query );
          mixin.name.alias = mixin.name.id;
          setProp( mixin, '_block', art._block );
          // TODO: do some initMembers() ?  If people had annotation
          // assignments on the mixin... (also for future mixin definitions
          // with generated values)
          dictAdd( query.$tableAliases, name, query.mixin[name], ( dupName, loc ) => {
            error( 'duplicate-definition', [ loc, query ], { name: dupName, '#': '$tableAlias' } );
          } );
          if (mixin.name.id[0] === '$') {
            warning( 'syntax-dollar-ident', [ mixin.name.location, mixin ],
                     { '#': 'mixin', name: '$' } );
          }
        }
      }
    }
  }

  function isDirectComposition( art ) {
    const type = art.type && art.type.path;
    return type && type[0] && type[0].id === 'cds.Composition';
  }

  // Return whether the `target` is actually a `targetAspect`
  function targetIsTargetAspect( elem ) {
    const { target } = elem;
    if (target.elements) {
      // TODO: error if CSN has both target.elements and targetAspect.elements -> delete target
      return true;
    }
    if (elem.targetAspect || options.parseCdl || !isDirectComposition( elem ))
      return false;
    const name = resolveUncheckedPath( target, 'compositionTarget', elem );
    const aspect = name && model.definitions[name];
    return aspect && (aspect.kind === 'aspect' || aspect.kind === 'type'); // type is sloppy
  }

  /**
   * Set property `_parent` for all elements in `parent` to `parent` and do so
   * recursively for all sub elements.  Also set the property
   * `name.component` of the element with the help of argument `prefix`
   * (which is basically the component name of the `parent` element plus a dot).
   */
  function initMembers( construct, parent, block, initExtensions = false ) {
    // TODO: split extend from init
    const isQueryExtension = kindProperties[construct.kind].isExtension &&
          (parent._main || parent).query;
    let obj = construct;
    if (obj.items) {
      obj = obj.items;
      setProp( obj, '_outer', construct );
      setProp( obj, '_block', block );
    }
    if (obj.target && targetIsTargetAspect( obj )) {
      obj.targetAspect = obj.target;
      delete obj.target;
    }
    if (obj.targetAspect) {
      if (obj.foreignKeys) {
        error( 'unexpected-keys-for-composition', [ dictLocation( obj.foreignKeys ), construct ],
               {},
               'A managed aspect composition can\'t have a foreign keys specification' );
        delete obj.foreignKeys; // continuation semantics: not specified
      }
      if (obj.on && !obj.target) {
        error( 'unexpected-on-for-composition', [ dictLocation( obj.foreignKeys ), construct ],
               {},
               'A managed aspect composition can\'t have a specified ON condition' );
        delete obj.on;          // continuation semantics: not specified
      }
      if (obj.targetAspect.elements) {
        obj = obj.targetAspect;
        setProp( obj, '_outer', construct );
      }
    }
    if (obj !== parent && obj.elements && parent.enum) {
      // in extensions, extended enums are represented as elements
      for (const n in obj.elements) {
        const e = obj.elements[n];
        if (e.kind === 'element')
          e.kind = 'enum';
      }
      // obj = Object.assign( { enum: obj.elements}, obj );
      // delete obj.elements;      // No extra syntax for EXTEND enum
      forEachGeneric( { enum: obj.elements }, 'enum', init );
    }
    else {
      if (checkDefinitions( construct, parent, 'elements', obj.elements || false ))
        forEachInOrder( obj, 'elements', init );
      if (checkDefinitions( construct, parent, 'enum', obj.enum || false ))
        forEachGeneric( obj, 'enum', init );
    }
    if (obj.foreignKeys)  // cannot be extended or annotated - TODO: check anyway?
      forEachInOrder( obj, 'foreignKeys', init );
    if (checkDefinitions( construct, parent, 'actions' ))
      forEachGeneric( construct, 'actions', init );
    if (checkDefinitions( construct, parent, 'params' ))
      forEachInOrder( construct, 'params', init );
    const { returns } = construct;
    if (returns) {
      returns.kind = (kindProperties[construct.kind].isExtension) ? construct.kind : 'param';
      init( returns, '' );      // '' is special name for returns parameter
    }
    return;

    function init( elem, name, prop ) {
      if (!elem.kind)           // wrong CSN input
        elem.kind = dictKinds[prop];
      if (!elem.name) {
        const ref = elem.targetElement || elem.kind === 'element' && elem.value;
        if (ref && ref.path) {
          elem.name = Object.assign( { $inferred: 'as' },
                                     ref.path[ref.path.length - 1] );
        }
        else {                  // if JSON parser misses to set name
          elem.name = { id: name, location: elem.location };
        }
      }
      // if (!kindProperties[ elem.kind ]) console.log(elem.kind,elem.name)
      if (kindProperties[elem.kind].isExtension && !initExtensions) {
        storeExtension( elem, name, prop, parent, block );
        return;
      }
      if (isQueryExtension && elem.kind === 'element') {
        error( 'extend-query', [ elem.location, construct ], // TODO: searchName ?
               { art: parent._main || parent },
               'Query entity $(ART) can only be extended with actions' );
        return;
      }

      const bl = elem._block || block;
      setProp( elem, '_block', bl );
      setMemberParent( elem, name, parent, construct !== parent && prop );
      // console.log(message( null, elem.location, elem, {}, 'Info', 'INIT').toString())
      defineAnnotations( elem, elem, bl );
      initMembers( elem, elem, bl, initExtensions );

      // for a correct home path, setMemberParent needed to be called

      if (elem.value && elem.kind === 'element' ) {
        // For enums in extensions, `elem.kind` is only changed to `enum` for non-parseCdl
        // mode *and* if the referenced artifact is found.
        // This means that for non-applicable extensions and parseCdl mode, this check
        // is not used.
        //
        // `parent` is the extended entity/type/enum/... and *not* the "extend: ..."
        // itself (which is `construct`).
        if ( ![ 'select', 'extend' ].includes(parent.kind) ) {
          error( 'unexpected-val', [ elem.value.location, elem ],
                 { '#': construct.kind },
                 {
                   std: 'Elements can\'t have a value',
                   entity: 'Entity elements can\'t have a value',
                   type: 'Type elements can\'t have a value',
                   extend: 'Cannot extend type/entity elements with values',
                 });
          return;
        }
      }

      if (parent.enum && elem.type) {
        // already rejected by from-csn, can only happen in extensions
        error( 'unexpected-type', [ elem.type.location, elem ], {},
               'Enum values can\'t have a custom type' );
      }
    }
  }

  function checkDefinitions( construct, parent, prop, dict = construct[prop] ) {
    // TODO: do differently, see also annotateMembers() in resolver
    // To have been checked by parsers:
    // - artifacts (CDL-only anyway) only inside [extend] context|service
    if (!dict)
      return false;
    const names = Object.getOwnPropertyNames( dict );
    if (!names.length)
      return false;
    const feature = kindProperties[parent.kind][prop];
    if (feature &&
        (feature === true || construct.kind !== 'extend' || feature( prop, parent )))
      return true;
    const location = dictLocation( names.map( name => dict[name] ) );
    if (prop === 'actions') {
      error( 'unexpected-actions', [ location, construct ], {},
             'Actions and functions only exist top-level and for entities' );
    }
    else if (parent.kind === 'action' || parent.kind === 'function') {
      error( 'extend-action', [ construct.location, construct ], {},
             'Actions and functions can\'t be extended, only annotated' );
    }
    else if (prop === 'params') {
      if (!feature) {
        // Note: This error can't be triggered at the moment.  But as we likely want to
        //       allow extensions with params in the future, we keep the code.
        error( 'unexpected-params', [ location, construct ], {},
               'Parameters only exist for entities, actions or functions' );
      }
      else {
        // remark: we could allow this
        error( 'extend-with-params', [ location, construct ], {},
               'Extending artifacts with parameters is not supported' );
      }
    }
    else if (feature) {         // allowed in principle, but not with extend
      error( 'extend-type', [ location, construct ], {},
             'Only structures or enum types can be extended with elements/enums' );
    }
    else if (prop === 'elements') {
      error( 'unexpected-elements', [ location, construct ], {},
             'Elements only exist in entities, types or typed constructs' );
    }
    else { // if (prop === 'enum') {
      error( 'unexpected-enum', [ location, construct ], {},
             'Enum symbols can only be defined for types or typed constructs' );
    }
    return construct === parent;
  }

  /**
   * Set projection ancestors, and _service link for artifact with absolute name 'name':
   *  - not set: internal artifact
   *  - null: not within service
   *  - service: the artifact of the embedding service
   * This function must be called ordered: parent first
   *
   * @param {string} name Artifact name
   */
  function setAncestorsAndService( name ) {
    const art = model.definitions[name];
    if (!('_parent' in art))
      return;                   // nothing to do for builtins and redefinitions
    if (art._from && !('_ancestors' in art))
      setProjectionAncestors( art );

    let parent = art._parent;
    if (parent === model.definitions.localized)
      parent = model.definitions[name.substring( 'localized.'.length )];
    const service = parent && (parent._service || parent.kind === 'service' && parent);
    setProp( art, '_service', service );
    if (!parent || !service)
      return;
    // To be removed when nested services are allowed
    if (!isBetaEnabled(options, 'nestedServices') && art.kind === 'service') {
      while (parent.kind !== 'service')
        parent = parent._parent;
      message( 'service-nested-service', [ art.name.location, art ], { art: parent },
               'A service can\'t be nested within a service $(ART)' );
    }
    else if (art.kind === 'context') {
      while (parent.kind !== 'service')
        parent = parent._parent;
      // TODO: remove this error
      message( 'service-nested-context', [ art.name.location, art ], { art: parent },
               'A context can\'t be nested within a service $(ART)' );
    }
  }

  function setProjectionAncestors( art ) {
    // Must be run after processLocalizedData() as we could have a projection
    // on a generated entity.

    // TODO: do not do implicit redirection across services, i.e. Service2.E is
    // no redirection target for E if Service2.E = projection on Service1.E and
    // Service1.E = projection on E
    const chain = [];
    const autoexposed = annotationVal( art['@cds.autoexposed'] );
    const preferredRedirectionTarget = annotationVal( art['@cds.redirection.target'] );
    // no need to set preferredRedirectionTarget in the while loop as we would
    // use the projection having @cds.redirection.target anyhow instead of
    // `art` anyway (if we do the no-x-service-implicit-redirection TODO above)
    while (art && !('_ancestors' in art) &&
           art._from && art._from.length === 1 &&
           (preferredRedirectionTarget || !annotationIsFalse( art['@cds.redirection.target'] ) ) &&
           art.query.op && art.query.op.val === 'SELECT') {
      chain.push( art );
      setProp( art, '_ancestors', null ); // avoid infloop with cyclic from
      const name = resolveUncheckedPath( art._from[0], 'include', art ); // TODO: 'include'?
      art = name && projectionAncestor( model.definitions[name], art.params );
      if (autoexposed)
        break;                  // only direct projection for auto-exposed
    }
    let ancestors = art && (!autoexposed && art._ancestors || []);
    for (const a of chain.reverse()) {
      ancestors = (ancestors ? [ ...ancestors, art ] : []);
      setProp( a, '_ancestors', ancestors );
      art = a;
    }
  }

  // Return argument `source` if entity `source` has parameters like `params`
  // - same parameters, although `params` can contain a new optional one (with DEFAULT)
  // - a parameter in `params` can be optional which is not in `source.params`, but not vice versa
  // - exactly the same types (type argument do not matter)
  function projectionAncestor( source, params ) {
    if (!source)
      return source;
    if (!params)                // proj has no params => ok if source has no params
      return !source.params && source;
    const sourceParams = source.params || Object.create(null);
    for (const n in sourceParams) {
      if (!(n in params))       // source param is not projection param
        return null;            // -> can't be used as implicit redirection target
    }
    for (const n in params) {
      const pp = params[n];
      const sp = sourceParams[n];
      if (sp) {
        if (sp.default && !pp.default) // param DEFAULT clause not supported yet
          return null;          // param is not optional anymore
        const pt = pp.type && resolveUncheckedPath( pp.type, 'type', pp );
        const st = sp.type && resolveUncheckedPath( sp.type, 'type', sp );
        if ((pt || null) !== (st || null))
          return null;          // params have different type
      }
      else if (!pp.default) {
        return null;
      }        // non-optional param in projection, but not source
    }
    return source;
  }

  function postProcessArtifact( art ) {
    tagCompositionTargets( art );
    if (art.$queries) {
      for (const query of art.$queries) {
        if (query.mixin)
          forEachGeneric( query, 'mixin', tagCompositionTargets );
      }
    }
    if (!art._ancestors || art.kind !== 'entity')
      return;                   // redirections only to entities
    const service = art._service;
    if (!service)
      return;
    const sname = service.name.absolute;
    art._ancestors.forEach( expose );
    return;

    function expose( ancestor ) {
      if (ancestor._service === service)
        return;
      const desc = ancestor._descendants ||
            setLink( ancestor, '_descendants', Object.create(null) );
      if (!desc[sname])
        desc[sname] = [ art ];
      else
        desc[sname].push( art );
    }
  }

  function processAspectComposition( base ) {
    // TODO: we need to forbid COMPOSITION of entity w/o keys and ON anyway
    // TODO: consider entity includes
    // TODO: nested containment
    // TODO: better do circular checks in the aspect!
    if (base.kind !== 'entity' || base.query)
      return;
    const keys = baseKeys();
    if (keys)
      forEachGeneric( base, 'elements', expand ); // TODO: recursively here?
    return;

    function baseKeys() {
      const k = Object.create(null);
      for (const name in base.elements) {
        const elem = base.elements[name];
        if (elem.$duplicates)
          return false;           // no composition-of-type unfold with redefined elems
        if (elem.key && elem.key.val)
          k[name] = elem;
      }
      return k;
    }

    function expand( elem ) {
      if (elem.target)
        return;
      let origin = elem;
      // included element do not have target aspect directly
      while (origin && !origin.targetAspect && origin._origin)
        origin = origin._origin;
      let target = origin.targetAspect;
      if (target && target.path)
        target = resolvePath( origin.targetAspect, 'compositionTarget', origin );
      if (!target || !target.elements)
        return;
      const entityName = (isDeprecatedEnabled( options, 'generatedEntityNameWithUnderscore' ))
        ? `${ base.name.absolute }_${ elem.name.id }`
        : `${ base.name.absolute }.${ elem.name.id }`;
      const entity = allowAspectComposition( target, elem, keys, entityName ) &&
            createTargetEntity( target, elem, keys, entityName, base );
      elem.target = {
        location: (elem.targetAspect || elem).location,
        $inferred: 'aspect-composition',
      };
      setLink( elem.target, '_artifact', entity );
      if (entity) {
        model.$compositionTargets[entity.name.absolute] = true;
        processAspectComposition( entity );
        processLocalizedData( entity );
      }
    }
  }

  function allowAspectComposition( target, elem, keys, entityName ) {
    if (!target.elements || Object.values( target.elements ).some( e => e.$duplicates ))
      return false;             // no elements or with redefinitions
    const location = elem.target && elem.target.location || elem.location;
    if ((elem._main._upperAspects || []).includes( target ))
      return 0;               // circular containment of the same aspect

    const keyNames = Object.keys( keys );
    if (!keyNames.length) {
      // TODO: for "inner aspect-compositions", signal already in type
      error( null, [ location, elem ], { target },
             'An aspect $(TARGET) can\'t be used as target in an entity without keys' );
      return false;
    }
    // if (keys.up_) {  // only to be tested if we allow to provide a prefix, which could be ''
    //   // Cannot be in an "inner aspect-compositions" as it would already be wrong before
    //   // TODO: if anonymous type, use location of "up_" element
    //   // FUTURE: add sub info with location of "up_" element
    //   message( 'id', [location, elem], { target, name: 'up_' }, 'Error',
    //      'An aspect $(TARGET) can't be used as target in an entity with a key named $(NAME)' );
    //   return false;
    // }
    if (target.elements.up_) {
      // TODO: for "inner aspect-compositions", signal already in type
      // TODO: if anonymous type, use location of "up_" element
      // FUTURE: if named type, add sub info with location of "up_" element
      error( null, [ location, elem ], { target, name: 'up_' },
             'An aspect $(TARGET) with an element named $(NAME) can\'t be used as target' );
      return false;
    }
    if (model.definitions[entityName]) {
      error( null, [ location, elem ], { art: entityName },
             // eslint-disable-next-line max-len
             'Target entity $(ART) can\'t be created as there is another definition with this name' );
      return false;
    }
    const names = Object.keys( target.elements )
      .filter( n => n.startsWith('up__') && keyNames.includes( n.substring(4) ) );
    if (names.length) {
      // FUTURE: if named type, add sub info with location of "up_" element
      error( null, [ location, elem ], { target: entityName, names }, {
        std: 'Key elements $(NAMES) can\'t be added to $(TARGET) as these already exist',
        one: 'Key element $(NAMES) can\'t be added to $(TARGET) as it already exist',
      });
      return false;
    }
    return true;
  }

  function createTargetEntity( target, elem, keys, entityName, base ) {
    const { location } = elem.targetAspect || elem.target || elem;
    elem.on = {
      location,
      op: { val: '=', location },
      args: [
        augmentPath( location, elem.name.id, 'up_' ),
        augmentPath( location, '$self' ),
      ],
      $inferred: 'aspect-composition',
    };

    const elements = Object.create(null);
    const art = {
      kind: 'entity',
      name: { path: splitIntoPath( location, entityName ), absolute: entityName, location },
      location,
      elements,
      $inferred: 'aspect-composition',
    };
    if (target.name) {          // named target aspect
      setLink( art, '_origin', target );
      setLink( art, '_upperAspects', [ target, ...(elem._main._upperAspects || []) ] );
    }
    else {
      // TODO: do we need to give the anonymous target aspect a kind and name?
      setLink( art, '_upperAspects', elem._main._upperAspects || [] );
    }

    const up = { // elements.up_ = ...
      name: { location, id: 'up_' },
      kind: 'element',
      location,
      $inferred: 'aspect-composition',
      type: augmentPath( location, 'cds.Association' ),
      target: augmentPath( location, base.name.absolute ),
      cardinality: {
        targetMin: { val: 1, literal: 'number', location },
        targetMax: { val: 1, literal: 'number', location },
        location,
      },
    };
    // By default, 'up_' is a managed primary key association.
    // If 'up_' shall be rendered unmanaged, infer the parent
    // primary keys and add the ON condition
    if (isDeprecatedEnabled( options, 'unmanagedUpInComponent' )) {
      addProxyElements( art, keys, 'aspect-composition', target.name && location,
                        'up__', '@odata.containment.ignore' );
      up.on = augmentEqual( location, 'up_', Object.values( keys ), 'up__' );
    }
    else {
      up.key = { location, val: true };
      // managed associations must be explicitly set to not null
      // even if target cardinality is 1..1
      up.notNull = { location, val: true };
    }
    if (isDeprecatedEnabled( options, 'generatedEntityNameWithUnderscore' ))
      setLink( art, '_base', base._base || base );

    dictAdd( art.elements, 'up_', up);
    addProxyElements( art, target.elements, 'aspect-composition', target.name && location );

    setLink( art, '_block', model.$internal );
    model.definitions[entityName] = art;
    initArtifact( art );
    return art;
  }

  function addProxyElements( proxyDict, elements, inferred, location, prefix = '', anno = '' ) {
    // TODO: also use for includeMembers()?
    for (const name in elements) {
      const pname = `${ prefix }${ name }`;
      const origin = elements[name];
      const proxy = linkToOrigin( origin, pname, null, null, location || origin.location );
      proxy.$inferred = inferred;
      if (origin.masked)
        proxy.masked = Object.assign( { $inferred: 'include' }, origin.masked );
      if (origin.key)
        proxy.key = Object.assign( { $inferred: 'include' }, origin.key );
      if (anno)
        annotateWith( proxy, anno );
      dictAdd( proxyDict.elements, pname, proxy );
    }
  }

  function tagCompositionTargets( elem ) {
    const type = elem.type && elem.type.path;
    if (elem.target && type && type[0] && type[0].id === 'cds.Composition') {
      // Currently not as sub element
      // Composition always via [{id:'cds.Composition'}] in both CSN and CDL
      const expected = elem.key && elem.key.val ? 'target' : 'compositionTarget';
      const target = resolvePath( elem.target, expected, elem );
      if (target)
        model.$compositionTargets[target.name.absolute] = true;
    }
    forEachGeneric( elem, 'elements', tagCompositionTargets );
  }

  /**
   * @param {Function|false} [veryLate]
   */
  function lateExtensions( veryLate ) {
    for (const name in model.$lateExtensions) {
      const art = model.definitions[name];
      const exts = model.$lateExtensions[name];
      if (art && art.kind !== 'namespace') {
        if (art.builtin) {
          for (const ext of exts)
            info( 'anno-builtin', [ ext.name.location, ext ] );
        }
        // created texts entity, autoexposed entity
        if (exts) {
          extendArtifact( exts, art, 'gen' );
          if (veryLate)
            veryLate( art );
          model.$lateExtensions[name] = null; // done
        }
      }
      else if (veryLate) {
        // Complain about unused extensions, i.e. those
        // which do not point to a valid artifact
        for (const ext of exts) {
          delete ext.name.path[0]._artifact;      // get message for root
          // TODO: make resolvePath('extend'/'annotate') ignore namespaces
          if (resolvePath( ext.name, ext.kind, ext )) { // should issue error/info
            // should issue error for cds extensions (annotate ok)
            if (art.kind === 'namespace') {
              info( 'anno-namespace', [ ext.name.location, ext ], {},
                    'Namespaces can\'t be annotated' );
            }
            // Builtin annotations would be represented as annotations in to-csn.js
            else if (art.builtin) {
              info( 'anno-builtin', [ ext.name.location, ext ] );
            }
          }
          // TODO: warning for context/service extension on non-correct
          if (ext.kind === 'annotate')
            delete ext.name._artifact; // make it be considered by extendArtifact()
        }
        // create "super" ANNOTATE containing all non-applied ones
        const first = exts[0];
        const { location } = first.name;

        /** @type {XSN.Definition} */
        const annotationArtifact = {
          kind: 'annotate',
          name: { path: [ { id: name, location } ], absolute: name, location },
          location: first.location,
        };

        if (!model.extensions)
          model.extensions = [];

        model.extensions.push(annotationArtifact);
        extendArtifact( exts, annotationArtifact ); // also sets _artifact link in extensions
        // if one of the annotate statement mentions 'returns', assume it
        // TODO: with warning/info?
        for (const ext of exts) {
          if (ext.$syntax === 'returns')
            annotationArtifact.$syntax = 'returns';
        }
      }
    }
  }

  function initExtensionsWithoutApplying() {
    // TODO: think of a better function name
    if (!model.extensions)
      model.extensions = [];

    for (const name in extensionsDict) {
      const extensions = extensionsDict[name];

      for (const ext of extensions) {
        ext.name.absolute = resolveUncheckedPath( ext.name, 'extend', ext );
        // Define annotations of this top-level extension
        defineAnnotations( ext, ext, ext._block );
        // Initialize members and define annotations in sub-elements.
        initMembers( ext, ext, ext._block, true);
        resolveAllArtifactPathsUnchecked( ext );

        model.extensions.push(ext);
      }
    }

    // `model.definitions` also contains e.g. "includes" that need to be resolved
    forEachDefinition(model, definition => resolveAllArtifactPathsUnchecked(definition));
    forEachGeneric(model, 'vocabularies', resolveAllArtifactPathsUnchecked );

    function resolveAllArtifactPathsUnchecked( art ) {
      if (!art)
        return;

      checkArtifact(art);
      forEachMemberRecursivelyWithQuery(art, checkArtifact);
    }

    // Function for parse.cdl
    /** @param {XSN.Artifact} artifact */
    function checkArtifact( artifact ) {
      // columns are initialized (and made to elements) in the resolver - do init here
      for (const col of artifact.columns || []) {
        if (!col.name)
          col.name = {};
        setMemberParent( col, null, artifact );
        if (col.value)
          recursivelyResolveExpressionCastTypes(col.value, artifact);
      }

      resolveTypeUnchecked(artifact, artifact);

      if (artifact.items)
        resolveTypeUnchecked(artifact.items, artifact);

      for (const include of (artifact.includes || []))
        resolveUncheckedPath(include, 'include', artifact);

      if (artifact.returns) {
        const returnType = (artifact.returns.items || artifact.returns);
        if (returnType.type)
          resolveTypeUnchecked(returnType, artifact);
      }

      if (artifact.targetAspect) {
        if (artifact.targetAspect.path)
          resolveUncheckedPath(artifact.targetAspect, 'target', artifact);
        else if (artifact.targetAspect.elements) // ad-hoc composition
          forEachMemberRecursivelyWithQuery(artifact.targetAspect, checkArtifact);
      }
      if (artifact.target) {
        if (artifact.target.path)
          resolveUncheckedPath(artifact.target, 'target', artifact);
        else if (artifact.target.elements) // ad-hoc composition
          forEachMemberRecursivelyWithQuery(artifact.target, checkArtifact);
      }

      // User provided 'from'
      if (artifact.from) // may be `null` due to EOF
        resolveUncheckedPath(artifact.from, 'from', artifact);

      // Calculated 'from'.  TODO: for parse-cdl?
      for (const from of (artifact._from || []))
        resolveUncheckedPath(from, 'from', artifact);
    }

    /**
     * Recursively resolve `type`s in expressions.
     * This happens e.g. in `cast()` calls.
     *
     * @param {object} expr Expression to check for `type`s.
     * @param {XSN.Artifact} artifact Surrounding artifact, used for error reporting.
     */
    function recursivelyResolveExpressionCastTypes( expr, artifact ) {
      // TODO: named argument, cast in query clauses, cast in filters, ...
      while (Array.isArray(expr)) // old-style XSN paren representation
        expr = expr[0];
      if (expr.args) {
        for (const arg of Array.isArray(expr.args) ? expr.args : Object.values( expr.args ))
          recursivelyResolveExpressionCastTypes(arg, artifact);
      }
      if (expr.type) {
        const name = resolveUncheckedPath( expr.type, 'type', artifact );
        const def = name && model.definitions[name];
        if (def)
          resolveTypeArguments( expr, def, artifact );
      }
    }

    /**
     * Resolves `artWithType.type` in an unchecked manner. Handles `type of` cases.
     *
     * @param {object} artWithType
     * @param {XSN.Artifact} artifact
     */
    function resolveTypeUnchecked(artWithType, artifact) {
      if (!artWithType.type)
        return;
      const root = artWithType.type.path && artWithType.type.path[0];
      if (!root) // parse error
        return;
      // `scope` is only `typeOf` for `type of element` and not
      // `type of Entity:element`. For the latter we can resolve the path
      // without special treatment.
      if (artWithType.type.scope !== 'typeOf') {
        // elem: Type   or   elem: type of Artifact:elem
        const name = resolveUncheckedPath(artWithType.type, 'type', artifact);
        const def = name && model.definitions[name];
        if (def)
          resolveTypeArguments( artWithType, def, artifact );
        return;
      }
      else if (!artifact._main) {
        error( 'ref-undefined-typeof', [ artWithType.type.location, artifact ], {},
               'Current artifact has no element to refer to as type' );
        return;
      }
      else if (root.id === '$self' || root.id === '$projection') {
        setLink( root, '_artifact', artifact._main );
      }
      else {
        const fake = { name: { absolute: artifact.name.absolute } };
        // to-csn just needs a fake element whose absolute name and _parent/_main links are correct
        setLink( fake, '_parent', artifact._parent );
        setLink( fake, '_main', artifact._main ); // value does not matter...
        setLink( root, '_artifact', fake );
      }
      resolveTypeArguments( artifact, {}, artifact ); // issue error for type args
    }
  }

  /**
   * Apply the extensions inside the extensionsDict on the model.
   *
   * Phase 1: context extends, 2: extends with structure includes, 3: extends
   * without structure includes (in the case of cyclic includes)
   *
   * Before phase 1: all artifact extensions have been collected (even those
   * inside extend context), only "empty" ones from structure includes are still unknown.
   * After phase 1, all main artifacts are known, also "empty" extensions are known.
   */
  function applyExtensions() {
    let phase = 1;              // TODO: basically remove phase 1
    let extNames = Object.keys( extensionsDict ).sort();
    // Remark: The sort() makes sure that an extend for artifact C.E is applied
    // after the extend for C has been applied (which could have defined C.E).
    // Looping over model.definitions in Phase 1 would miss the `extend
    // context` for a context C.C defined in an `extend context C`.
    //
    // TODO: no need to sort anymore
    while (extNames.length) {
      const { length } = extNames;
      for (const name of extNames) {
        const art = model.definitions[name];
        if (!art || art.kind === 'namespace') {
          model.$lateExtensions[name] = extensionsDict[name];
          delete extensionsDict[name];
        }
        else if (art.$duplicates) { // cannot extend redefinitions
          delete extensionsDict[name];
        }
        else if (phase === 1
                 ? extendContext( name, art )
                 : extendArtifact( extensionsDict[name], art, phase > 2 )) { // >2: no self-include
          delete extensionsDict[name];
        }
      }
      extNames = Object.keys( extensionsDict ); // no sort() required anymore
      if (phase === 1)
        phase = 2;
      else if (extNames.length >= length)
        phase = 3;
    }
  }

  function extendContext( name, art ) {
    // (ext.expectedKind == art.kind) already checked by parser except for context/service
    if (!kindProperties[art.kind].artifacts) {
      // no context or service => warn about context extensions
      for (const ext of extensionsDict[name]) {
        if ([ 'context', 'service' ].includes( ext.expectedKind )) {
          const loc = ext.name.location;
          // TODO: warning is enough
          error( 'extend-with-artifacts', [ loc, ext ], { name, '#': ext.expectedKind }, {
            std: 'Cannot extend non-context / non-service $(NAME) with artifacts',
            service: 'Cannot extend non-service $(NAME) with artifacts',
            context: 'Cannot extend non-context $(NAME) with artifacts',
          });
        }
      }
      return false;
    }

    for (const ext of extensionsDict[name]) {
      setProp( ext.name, '_artifact', art );
      checkDefinitions( ext, art, 'elements'); // error for elements etc
      checkDefinitions( ext, art, 'enum');
      checkDefinitions( ext, art, 'actions');
      checkDefinitions( ext, art, 'params');
      defineAnnotations( ext, art, ext._block, ext.kind );
    }
    return true;
  }

  /**
   * Extend artifact `art` by `extensions`.  `noIncludes` can have values:
   * - false: includes are applied, extend and annotate is performed
   * - true:  includes are not applied, extend and annotate is performed
   * - 'gen': no includes and no extensions allowed, annotate is performed
   *
   * @param {XSN.Extension[]} extensions
   * @param {XSN.Definition} art
   * @param {boolean|'gen'} [noIncludes=false]
   */
  function extendArtifact( extensions, art, noIncludes = false) {
    if (!noIncludes && !(canApplyIncludes( art ) && extensions.every( canApplyIncludes )))
      return false;
    if (!art.query) {
      model._entities.push( art ); // add structure with includes in dep order
      art.$entity = ++model.$entity;
    }
    if (!noIncludes && art.includes)
      applyIncludes( art, art );
    extendMembers( extensions, art, noIncludes === 'gen' );
    if (!noIncludes && art.includes) {
      // early propagation of specific annotation assignments
      propagateEarly( art, '@cds.autoexpose' );
      propagateEarly( art, '@fiori.draft.enabled' );
    }
    // TODO: complain about element extensions inside projection
    return true;
  }

  /**
   * @param {XSN.Definition} art
   * @param {string} prop
   */
  function propagateEarly( art, prop ) {
    if (art[prop])
      return;
    for (const ref of art.includes) {
      const aspect = ref._artifact;
      if (aspect) {
        const anno = aspect[prop];
        if (anno && (anno.val !== null || !art[prop]))
          art[prop] = Object.assign( { $inferred: 'include' }, anno );
      }
    }
  }

  /**
   * @param {XSN.Definition} art
   */
  function canApplyIncludes( art ) {
    if (art.includes) {
      for (const ref of art.includes) {
        const template = resolvePath( ref, 'include', art );
        if (template && template.name.absolute in extensionsDict)
          return false;
      }
    }
    return true;
  }

  function extendMembers( extensions, art, noExtend ) {
    // TODO: do the whole extension stuff lazily if the elements are requested
    const elemExtensions = [];
    extensions.sort( compareLayer );
    for (const ext of extensions) {
      // console.log(message( 'id', [ext.location, ext], { art: ext.name._artifact },
      //                      'Info', 'EXT').toString())
      if (!('_artifact' in ext.name)) { // not already applied
        setProp( ext.name, '_artifact', art );
        if (noExtend && ext.kind === 'extend') {
          error( 'extend-for-generated', [ ext.name.location, ext ], { art },
                 'You can\'t use EXTEND on the generated $(ART)' );
          continue;
        }
        if (ext.includes) {
          // TODO: currently, re-compiling from gensrc does not give the exact
          // element sequence - we need something like
          //    includes = ['Base1',3,'Base2']
          // where 3 means adding the next 3 elements before applying include 'Base2'
          if (art.includes)
            art.includes.push(...ext.includes);
          else
            art.includes = [ ...ext.includes ];
          applyIncludes( ext, art );
        }
        defineAnnotations( ext, art, ext._block, ext.kind );
        // TODO: do we allow to add elements with array of {...}?  If yes, adapt
        initMembers( ext, art, ext._block ); // might set _extend, _annotate
        dependsOnSilent(art, ext); // art depends silently on ext (inverse to normal dep!)
      }
      for (const name in ext.elements) {
        const elem = ext.elements[name];
        if (elem.kind === 'element') { // i.e. not extend or annotate
          elemExtensions.push( elem );
          break;
        }
      }

      if (ext.columns)          // extend projection
        extendColumns( ext, art );
    }
    if (elemExtensions.length > 1)
      reportUnstableExtensions( elemExtensions );

    [ 'elements', 'actions' ].forEach( (prop) => {
      const dict = art._extend && art._extend[prop];
      for (const name in dict) {
        let obj = art;
        if (obj.targetAspect)
          obj = obj.targetAspect;
        while (obj.items)
          obj = obj.items;
        const validDict = obj[prop] || prop === 'elements' && obj.enum;
        const member = validDict[name];
        if (!member)
          extendNothing( dict[name], prop, name, art, validDict );
        else if (!(member.$duplicates))
          extendMembers( dict[name], member );
      }
    });
  }

  /**
   * Copy columns for EXTEND PROJECTION
   *
   * @param {XSN.Extension} ext
   * @param {XSN.Artifact} art
   */
  function extendColumns( ext, art ) {
    // TODO: consider reportUnstableExtensions
    const { location } = ext.name;
    const { query } = art;
    if (!query) {
      if (art.kind !== 'annotate')
        error( 'extend-columns', [ location, ext ], { art } );
      return;
    }
    if (!query.from || !query.from.path) {
      error( 'extend-columns', [ location, ext ], { art } );
    }
    else {
      if (!query.columns)
        query.columns = [ { location, val: '*' } ];

      for (const column of ext.columns) {
        setProp( column, '_block', ext._block );
        query.columns.push(column);
      }
    }
  }

  function reportUnstableExtensions( extensions ) {
    // Report 'Warning: Unstable element order due to repeated extensions'.
    // Similar to chooseAssignment(), TODO there: also extra intralayer message
    // as this is a modeling error
    let lastExt = null;
    let open = [];              // the "highest" layers
    for (const ext of extensions) {
      const extLayer = layer( ext ) || { realname: '', _layerExtends: Object.create(null) };
      if (!open.length) {
        lastExt = ext;
        open = [ extLayer.realname ];
      }
      else if (extLayer.realname === open[open.length - 1]) { // in same layer
        if (lastExt) {
          message( 'extend-repeated-intralayer', [ lastExt.location, lastExt ] );
          lastExt = null;
        }
        message( 'extend-repeated-intralayer', [ ext.location, ext ] );
      }
      else {
        if (lastExt && (open.length > 1 || !extLayer._layerExtends[open[0]])) {
          // report for lastExt if that is unrelated to other open exts or current ext
          message( 'extend-unrelated-layer', [ lastExt.location, lastExt ], {},
                   'Unstable element order due to other extension in unrelated layer' );
        }
        lastExt = ext;
        open = open.filter( name => !extLayer._layerExtends[name] );
        open.push( extLayer.realname );
      }
    }
  }
  /**
   * @param {XSN.Extension[]} extensions
   * @param {string} prop
   * @param {string} name
   * @param {XSN.Artifact} art
   * @param {object} validDict
   */
  function extendNothing( extensions, prop, name, art, validDict ) {
    for (const ext of extensions) {
      // TODO: use shared functionality with notFound in resolver.js
      const { location } = ext.name;
      const msg
        = error( 'extend-undefined', [ location, ext ],
                 { art: searchName( art, name, dictKinds[prop] ) },
                 {
                   std: 'Unknown $(ART) - nothing to extend',
                   // eslint-disable-next-line max-len
                   element: 'Artifact $(ART) has no element or enum $(MEMBER) - nothing to extend',
                   action: 'Artifact $(ART) has no action $(MEMBER) - nothing to extend',
                 } );
      attachAndEmitValidNames(msg, validDict);
    }
  }

  /**
   * @param {XSN.Extension} ext
   * @param {XSN.Artifact} art
   */
  function applyIncludes( ext, art ) {
    if (!art._ancestors)
      setProp( art, '_ancestors', [] ); // recursive array of includes
    for (const ref of ext.includes) {
      const template = ref._artifact; // already resolved
      if (template) {
        if (template._ancestors)
          art._ancestors.push( ...template._ancestors );
        art._ancestors.push( template );
      }
    }
    includeMembers( ext, 'elements', forEachInOrder, ext === art && art );
    includeMembers( ext, 'actions', forEachGeneric, ext === art && art );
  }

  /**
   * @param {XSN.Extension} ext
   * @param {string} prop
   * @param {function} forEach
   * @param {XSN.Artifact} parent
   */
  function includeMembers( ext, prop, forEach, parent ) {
    // TODO two kind of messages:
    // Error 'More than one include defines element "A"' (at include ref)
    // Warning 'Overwrites definition from include "I" (at elem def)
    const members = ext[prop];
    ext[prop] = Object.create(null); // TODO: do not set actions property if there are none
    for (const ref of ext.includes) {
      const template = ref._artifact; // already resolved
      if (template) {           // be robust
        forEach( template, prop, ( origin, name ) => {
          if (members && name in members)
            return;               // TODO: warning for overwritten element
          const elem = linkToOrigin( origin, name, parent, prop, weakLocation( ref.location ) );
          if (!parent)          // not yet set for EXTEND foo WITH bar
            dictAdd( ext[prop], name, elem );
          elem.$inferred = 'include';
          if (origin.masked)
            elem.masked = Object.assign( { $inferred: 'include' }, origin.masked );
          if (origin.key)
            elem.key = Object.assign( { $inferred: 'include' }, origin.key );
          // TODO: also complain if elem is just defined in art
        });
      }
    }
    // TODO: expand elements having direct elements (if needed)
    if (members) {
      forEach( { [prop]: members }, prop, ( elem, name ) => {
        dictAdd( ext[prop], name, elem );
      });
    }
  }

  // TODO: move to "init" phase
  /**
   * Check whether redefinitions of the given artifact name exist and
   * adapt to `targetAspect`.
   *
   * @param {string} name
   */
  function preProcessArtifact( name ) {
    const art = model.definitions[name];
    if (Array.isArray(art.$duplicates)) {
      // A definition name containing a `.` is not invalid (TODO: starting or
      // ending with a dot is invalid and could be checked here)
      for (const a of art.$duplicates)
        checkRedefinitions( a, name, 'definitions' );
    }
    checkRedefinitions( art, name, 'definitions' );
  }

  /**
   * Process "composition of" artifacts.
   *
   * @param {string} name
   */
  function processArtifact( name ) {
    const art = model.definitions[name];
    if (!(art.$duplicates)) {
      processAspectComposition( art );
      if (art.kind === 'entity' && !art.query && art.elements)
        // check potential entity parse error
        processLocalizedData( art );
    }
  }

  /**
   * @param {XSN.Artifact} art
   */
  function processLocalizedData( art ) {
    const fioriAnno = art['@fiori.draft.enabled'];
    const fioriEnabled = fioriAnno && (fioriAnno.val === undefined || fioriAnno.val);

    const textsName = (isDeprecatedEnabled( options, 'generatedEntityNameWithUnderscore' ))
      ? `${ art.name.absolute }_texts`
      : `${ art.name.absolute }.texts`;
    const textsEntity = model.definitions[textsName];
    const localized = localizedData( art, textsEntity, fioriEnabled );
    if (!localized)
      return;
    if (textsEntity)            // expanded localized data in source
      return;                   // -> make it idempotent
    createTextsEntity( art, textsName, localized, fioriEnabled );
    addTextsAssociations( art, textsName, localized );
  }

  /**
   * @param {XSN.Artifact} art
   * @param {XSN.Artifact|undefined} textsEntity
   * @param {boolean} fioriEnabled
   */
  function localizedData( art, textsEntity, fioriEnabled ) {
    let keys = 0;
    const textElems = [];
    const conflictingElements = [];
    const protectedElements = [ 'locale', 'texts', 'localized' ];
    if (fioriEnabled)
      protectedElements.push('ID_texts');
    if (addTextsLanguageAssoc)
      protectedElements.push('language');

    for (const name in art.elements) {
      const elem = art.elements[name];
      if (elem.$duplicates)
        return false;           // no localized-data unfold with redefined elems
      if (protectedElements.includes( name ))
        conflictingElements.push( elem );

      const isKey = elem.key && elem.key.val;
      const isLocalized = hasTruthyProp( elem, 'localized' );

      if (isKey) {
        keys += 1;
        textElems.push( elem );
      }
      else if (isLocalized) {
        textElems.push( elem );
      }

      if (isKey && isLocalized) { // key with localized is wrong - ignore localized
        const errpos = elem.localized || elem.type || elem.name;
        warning( 'localized-key', [ errpos.location, elem ], { keyword: 'localized' },
                 'Keyword $(KEYWORD) is ignored for primary keys' );
      }
    }
    if (textElems.length <= keys)
      return false;

    if (!keys) {
      warning( null, [ art.name.location, art ], {},
               'No texts entity can be created when no key element exists' );
      return false;
    }

    if (textsEntity) {
      if (textsEntity.$duplicates)
        return false;
      if (textsEntity.kind !== 'entity' || textsEntity.query ||
          // already have elements "texts" and "localized" (and optionally ID_texts)
          conflictingElements.length !== 2 || art.elements.locale ||
          (fioriEnabled && art.elements.ID_texts)) {
        // TODO if we have too much time: check all elements of texts entity for safety
        warning( null, [ art.name.location, art ], { art: textsEntity },
                 // eslint-disable-next-line max-len
                 'Texts entity $(ART) can\'t be created as there is another definition with that name' );
        info( null, [ textsEntity.name.location, textsEntity ], { art },
              'Texts entity for $(ART) can\'t be created with this definition' );
      }
      else if (!art._block || art._block.$frontend !== 'json') {
        info( null, [ art.name.location, art ], {},
              'Localized data expansions has already been done' );
        return textElems;       // make double-compilation even with after toHana
      }
      else if (!art._block.$withLocalized && !options.$recompile) {
        art._block.$withLocalized = true;
        info( 'recalculated-text-entities', [ art.name.location, null ], {},
              'Input CSN contains expansions for localized data' );
        return textElems;       // make compilation idempotent
      }
      else {
        return textElems;
      }
    }
    for (const elem of conflictingElements) {
      warning( null, [ elem.name.location, art ], { name: elem.name.id },
               'No texts entity can be created when element $(NAME) exists' );
    }
    return !textsEntity && !conflictingElements.length && textElems;
  }

  /**
   * TODO: set _parent also for main artifacts!
   *
   * @param {XSN.Artifact} base
   * @param {string} absolute
   * @param {XSN.Element[]} textElems
   * @param {boolean} fioriEnabled
   */
  function createTextsEntity( base, absolute, textElems, fioriEnabled ) {
    const elements = Object.create(null);
    const { location } = base.name;
    const art = {
      kind: 'entity',
      name: { path: splitIntoPath( location, absolute ), absolute, location },
      location: base.location,
      elements,
      $inferred: 'localized',
    };
    const locale = {
      name: { location, id: 'locale' },
      kind: 'element',
      type: augmentPath( location, 'cds.String' ),
      length: { literal: 'number', val: 14, location },
      location,
    };

    if (!fioriEnabled) {
      locale.key = { val: true, location };
      // To be compatible, we switch off draft without @fiori.draft.enabled
      // TODO (next major version): remove?
      annotateWith( art, '@odata.draft.enabled', art.location, false );
    }
    else {
      const textId = {
        name: { location, id: 'ID_texts' },
        kind: 'element',
        key: { val: true, location },
        type: augmentPath( location, 'cds.UUID' ),
        location,
      };
      dictAdd( art.elements, 'ID_texts', textId );
    }
    if (isDeprecatedEnabled( options, 'generatedEntityNameWithUnderscore' ))
      setProp( art, '_base', base );

    dictAdd( art.elements, 'locale', locale );
    if (addTextsLanguageAssoc) {
      const language = {
        name: { location, id: 'language' },
        kind: 'element',
        location,
        type: augmentPath( location, 'cds.Association' ),
        target: augmentPath( location, 'sap.common.Languages' ),
        on: {
          op: { val: '=', location },
          args: [
            { path: [ { id: 'language', location }, { id: 'code', location } ], location },
            { path: [ { id: 'locale', location } ], location },
          ],
          location,
        },
      };
      setProp( language, '_block', model.$internal );
      dictAdd( art.elements, 'language', language );
    }
    setLink( art, '_block', model.$internal );
    model.definitions[absolute] = art;
    initArtifact( art );

    // assertUnique array value, first entry is 'locale'
    const assertUniqueValue = [ {
      path: [ { id: locale.name.id, location: locale.location } ],
      location: locale.location,
    } ];

    for (const orig of textElems) {
      const elem = linkToOrigin( orig, orig.name.id, art, 'elements' );
      if (orig.key && orig.key.val) {
        // elem.key = { val: fioriEnabled ? null : true, $inferred: 'localized', location };
        // TODO: the previous would be better, but currently not supported in toCDL
        if (!fioriEnabled) {
          elem.key = { val: true, $inferred: 'localized', location };
          // If the propagated elements remain key (that is not fiori.draft.enabled)
          // they should be omitted from OData containment EDM
          annotateWith( elem, '@odata.containment.ignore', location );
        }
        else {
          // add the former key paths to the unique constraint
          assertUniqueValue.push({
            path: [ { id: orig.name.id, location: orig.location } ],
            location: orig.location,
          });
        }
      }
      if (hasTruthyProp( orig, 'localized' )) { // use location of LOCALIZED keyword
        const localized = orig.localized || orig.type || orig.name;
        elem.localized = { val: null, $inferred: 'localized', location: localized.location };
      }
    }
    if (fioriEnabled)
      annotateWith( art, '@assert.unique.locale', art.location, assertUniqueValue, 'array' );
  }

  /**
   * @param {XSN.Artifact} art
   * @param {string} textsName
   * @param {XSN.Element[]} textElems
   */
  function addTextsAssociations( art, textsName, textElems ) {
    // texts : Composition of many Books.texts on texts.ID=ID;
    /** @type {array} */
    const keys = textElems.filter( e => e.key && e.key.val );
    const { location } = art.name;
    const texts = {
      name: { location, id: 'texts' },
      kind: 'element',
      location,
      $inferred: 'localized-texts',
      type: augmentPath( location, 'cds.Composition' ),
      cardinality: { targetMax: { literal: 'string', val: '*', location }, location },
      target: augmentPath( location, textsName ),
      on: augmentEqual( location, 'texts', keys ),
    };
    setMemberParent( texts, 'texts', art, 'elements' );
    setProp( texts, '_block', model.$internal );
    // localized : Association to Books.texts on
    //             localized.ID=ID and localized.locale = $user.locale;
    keys.push( [ 'localized.locale', '$user.locale' ] );
    const localized = {
      name: { location, id: 'localized' },
      kind: 'element',
      location,
      $inferred: 'localized-texts',
      type: augmentPath( location, 'cds.Association' ),
      target: augmentPath( location, textsName ),
      on: augmentEqual( location, 'localized', keys ),
    };
    setMemberParent( localized, 'localized', art, 'elements' );
    setProp( localized, '_block', model.$internal );
  }

  /**
   * @param {XSN.Artifact} art
   * @param {string} prop
   */
  function hasTruthyProp( art, prop ) {
    // Returns whether art directly or indirectly has the property 'prop',
    // following the 'origin' and the 'type' (not involving elements).
    //
    // TODO: we should issue a warning if we get localized via TYPE OF
    // TODO XSN: for anno short form, use { val: true, location, <no literal prop> }
    // ...then this function also works with annotations
    const processed = Object.create(null); // avoid infloops with circular refs
    let name = art.name.absolute;        // is ok, since no recursive type possible
    while (art && !processed[name]) {
      if (art[prop])
        return art[prop].val;
      processed[name] = art;
      if (art._origin) {
        art = art._origin;
        name = art && art.name.absolute;
      }
      else if (art.type && art._block && art.type.scope !== 'typeOf') {
        // TODO: also do something special for TYPE OF inside `art`s own elements
        name = resolveUncheckedPath( art.type, 'type', art );
        art = name && model.definitions[name];
      }
      else {
        return false;
      }
    }
    return false;
  }
}

/**
 * Merge (optional) translations into the XSN model.
 *
 * @param {XSN.Model} model
 */
function mergeI18nBlocks( model ) {
  const sortedSources = Object.keys(model.sources)
    .filter(name => !!model.sources[name].i18n)
    .sort( (a, b) => compareLayer( model.sources[a], model.sources[b] ) );

  if (sortedSources.length === 0)
    return;

  if (!model.i18n)
    model.i18n = Object.create( null );

  for (const name of sortedSources)
    initI18nFromSource( model.sources[name] );

  /**
   * Add the source's translations to the model. Warns if the sources translations
   * do not match the ones from previous sources.
   *
   * @param {XSN.AST} src
   */
  function initI18nFromSource( src ) {
    for (const langKey of Object.keys( src.i18n )) {
      if (!model.i18n[langKey])
        model.i18n[langKey] = Object.create( null );

      for (const textKey of Object.keys( src.i18n[langKey] )) {
        const sourceVal = src.i18n[langKey][textKey];
        const modelVal = model.i18n[langKey][textKey];
        if (!modelVal) {
          model.i18n[langKey][textKey] = sourceVal;
        }
        else if (modelVal.val !== sourceVal.val) {
          // TODO: put mergeI18nBlocks() into main function instead
          model.$messageFunctions.warning( 'i18n-different-value', sourceVal.location,
                                           { prop: textKey, otherprop: langKey } );
        }
      }
    }
  }
}

/**
 * Return string 'A.B.C' for parsed source `A.B.C` (is vector of ids with
 * locations).
 *
 * @param {XSN.Path} path
 */
function pathName(path) {
  return path.map( id => id.id ).join('.');
}

/**
 * Generates an XSN path out of the given name. Path segments are delimited by a dot.
 * Each segment will have the given location assigned.
 *
 * @param {CSN.Location} location
 * @param {string} name
 * @returns {XSN.Path}
 */
function splitIntoPath( location, name ) {
  return name.split('.').map( id => ({ id, location }) );
}

/**
 * @param {CSN.Location} location
 * @param  {...any} args
 */
function augmentPath( location, ...args ) {
  return { path: args.map( id => ({ id, location }) ), location };
}

function augmentEqual( location, assocname, relations, prefix = '' ) {
  const args = relations.map( eq );
  return (args.length === 1)
    ? args[0]
    : { op: { val: 'and', location }, args, location };

  function eq( refs ) {
    if (Array.isArray(refs))
      return { op: { val: '=', location }, args: refs.map( ref ), location };

    const { id } = refs.name;
    return {
      op: { val: '=', location },
      args: [
        { path: [ { id: assocname, location }, { id, location } ], location },
        { path: [ { id: `${ prefix }${ id }`, location } ], location },
      ],
      location,
    };
  }
  function ref( path ) {
    return { path: path.split('.').map( id => ({ id, location }) ), location };
  }
}

// these function could be used to a future lib/compiler/utils.js, but DO NOT
// SHARE with utility functions for CSN processors

module.exports = {
  define: model => getDefinerFunctions( model ).define(),
  getDefinerFunctions,
  augmentPath,
  splitIntoPath,
};
