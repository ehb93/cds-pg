// Compiler functions and utilities shared across all phases


'use strict';

const { searchName } = require('../base/messages');
const { dictAdd, dictAddArray, pushToDict } = require('../base/dictionaries');
const { setProp } = require('../base/model');

const dictKinds = {
  definitions: 'absolute',
  elements: 'element',
  enum: 'enum',
  foreignKeys: 'key',
  actions: 'action',
  params: 'param',
};

const kindProperties = {
  // TODO: also foreignKeys ?
  namespace: { artifacts: true }, // on-the-fly context
  context: { artifacts: true, normalized: 'namespace' },
  service: { artifacts: true, normalized: 'namespace' },
  entity: { elements: true, actions: true, params: () => false },
  select: { normalized: 'select', elements: true },
  $join: { normalized: 'select' },
  $tableAlias: { normalized: 'alias' }, // table alias in select
  $self: { normalized: 'alias' }, // table alias in select
  $navElement: { normalized: 'element' },
  $inline: { normalized: 'element' }, // column with inline property
  event: { elements: true },
  type: { elements: propExists, enum: propExists },
  aspect: { elements: propExists },
  annotation: { elements: propExists, enum: propExists },
  enum: { normalized: 'element' },
  element: { elements: propExists, enum: propExists, dict: 'elements' },
  mixin: { normalized: 'alias' },
  action: {
    params: () => false, elements: () => false, enum: () => false, dict: 'actions',
  }, // no extend params, only annotate
  function: {
    params: () => false, elements: () => false, enum: () => false, normalized: 'action',
  }, // no extend params, only annotate
  key: { normalized: 'element' },
  param: { elements: () => false, enum: () => false, dict: 'params' },
  source: { artifacts: true },  // TODO -> $source
  using: {},
  extend: {
    isExtension: true,
    noDep: 'special',
    elements: true, /* only for parse-cdl */
    actions: true,  /* only for parse-cdl */
  },
  annotate: {
    isExtension: true, noDep: 'special', elements: true, enum: true, actions: true, params: true,
  },
  builtin: {},                  // = CURRENT_DATE, TODO: improve
  $parameters: {},              // $parameters in query entities
};

function propExists( prop, parent ) {
  const obj = parent.returns || parent;
  return (obj.items || obj.targetAspect || obj)[prop];
}

function artifactsEnv( art ) {
  return art._subArtifacts || Object.create(null);
}

/**
 * Main export function of this file.  Return "resolve" functions shared for phase
 * "define" and "resolve".  Argument `model` is the augmented CSN.  Optional
 * argument `environment` is a function which returns the search environment
 * defined by its argument - it defaults to the dictionary of subartifacts of
 * the argument.
 *
 * @param {XSN.Model} model
 * @param {(a, b?, c?) => any} environment
 * @returns {object} Commonly used "resolve" functions.
 */
function fns( model, environment = artifactsEnv ) {
  /** @type {CSN.Options} */
  const options = model.options || {};
  const {
    info, warning, error, message,
  } = model.$messageFunctions;
  // TODO: combine envFn and assoc ?
  const specExpected = {
    global: { // for using declaration
      envFn: artifactsEnv,
      artItemsCount: Number.MAX_SAFE_INTEGER,
      useDefinitions: true,
      global: 'definitions',
    },
    // TODO: re-check --------------------------------------------------------
    annotation: { useDefinitions: true, noMessage: true, global: 'vocabularies' },
    // TODO: artifact references ---------------------------------------------
    extend: {
      useDefinitions: true,
      envFn: artifactsEnv,
      artItemsCount: Number.MAX_SAFE_INTEGER,
    },
    // ref in top-level EXTEND
    annotate: {
      useDefinitions: true,
      envFn: artifactsEnv,
      artItemsCount: Number.MAX_SAFE_INTEGER,
      undefinedDef: 'anno-undefined-def',
      undefinedArt: 'anno-undefined-art',
      allowAutoexposed: true,
    },
    type: { // TODO: more detailed later (e.g. for enum base type?)
      envFn: artifactsEnv,
      check: checkTypeRef,
      expectedMsgId: 'expected-type',
      sloppyMsgId: 'ref-sloppy-type',
      deprecateSmart: true,
    },
    actionParamType: {
      envFn: artifactsEnv,
      check: checkActionParamTypeRef,
      expectedMsgId: 'expected-actionparam-type',
      sloppyMsgId: 'ref-sloppy-actionparam-type',
      deprecateSmart: true,
    },
    eventType: {
      envFn: artifactsEnv,
      check: checkEventTypeRef,
      expectedMsgId: 'expected-event-type',
      sloppyMsgId: 'ref-sloppy-event-type',
      deprecateSmart: true,
    },
    include: {
      check: checkIncludesRef,
      expectedMsgId: 'expected-struct',
      envFn: artifactsEnv,
    },
    target: {
      check: checkEntityRef,
      expectedMsgId: 'expected-entity',
      noDep: true,
      envFn: artifactsEnv,
    },
    compositionTarget: {
      check: checkTargetRef,
      expectedMsgId: 'expected-target',
      sloppyMsgId: 'ref-sloppy-target',
      noDep: 'only-entity',
      envFn: artifactsEnv,
    },
    from: {
      envFn: artifactsEnv,
      check: checkSourceRef,
      expectedMsgId: 'expected-source',
      assoc: 'from',
      argsSpec: 'expr',
      deprecateSmart: true,
    },
    // element references ----------------------------------------------------
    // if we want to disallow assoc nav for TYPE, do not do it here
    typeOf: { next: '_$next', dollar: true }, // TODO: disallow in var
    // TODO: dep for (explicit+implicit!) foreign keys
    targetElement: { next: '__none_', assoc: false, dollar: false },
    filter: { next: '_$next', lexical: 'main', dollar: 'none' },
    default: {
      next: '_$next',
      dollar: true,
      check: checkConstRef,
      expectedMsgId: 'expected-const',
    },
    expr: {                     // in: from-on,
      next: '_$next', dollar: true, escape: 'param', assoc: 'nav',
    },
    exists: { // same as expr
      next: '_$next', dollar: true, escape: 'param', assoc: 'nav',
    },
    'approved-exists': { // same as expr
      next: '_$next', dollar: true, escape: 'param', assoc: 'nav',
    },
    on: {               // TODO: there will also be a 'from-on' (see 'expr')
      noAliasOrMixin: true,     // TODO: some headReject or similar
      next: '_$next',           // TODO: lexical: ... how to find the (next) lexical environment
      dollar: true,
      rootEnv: 'elements',      // the final environment for the path root
      noDep: true,              // do not set dependency for circular-check
    }, // TODO: special assoc for only on user
    'mixin-on': {
      escape: 'param',    // TODO: extra check that assocs containing param in ON is not published
      next: '_$next',           // TODO: lexical: ... how to find the (next) lexical environment
      dollar: true,
      noDep: true,              // do not set dependency for circular-check
    }, // TODO: special assoc for only on user
    rewrite: {
      next: '_$next', dollar: true, escape: 'param', noDep: true, rewrite: true,
    }, // TODO: assertion that there is no next/escape used
    'order-by-union': {
      next: '_$next', dollar: true, escape: 'param', noDep: true, noExt: true,
    },
    // expr TODO: better - on condition for assoc, other on
    // expr TODO: write dependency, but care for $self
    param: {
      check: checkConstRef,
      expectedMsgId: 'expected-const',
    },
  };

  return {
    resolveUncheckedPath,
    resolvePath,
    resolveTypeArguments,
    defineAnnotations,
    attachAndEmitValidNames,
  };

  function checkConstRef( art ) {
    return ![ 'builtin', 'param' ].includes( art.kind );
  }

  function checkIncludesRef( art ) {
    // We currently disallow using
    // - derived structure types: would have to follow type in extend/include;
    // - entities with params: clarify inheritance, use of param in ON/DEFAULT;
    // - query entities/events: difficult sequence of resolve steps
    return !(art.elements && !art.query && !art.type && !art.params);
  }

  function checkTypeRef( art ) {
    if (art.kind === 'type' || art.kind === 'element')
      return false;
    return ![ 'entity', 'aspect', 'event' ].includes( art.kind ) || 'sloppy';
  }

  function checkActionParamTypeRef( art ) {
    return !(art.kind === 'entity' && art._service) && checkTypeRef( art );
  }

  function checkEventTypeRef( art ) {
    return art.kind !== 'event' && checkActionParamTypeRef( art );
  }

  function checkEntityRef( art ) {
    return art.kind !== 'entity';
  }

  function checkTargetRef( art ) {
    if (art.kind === 'entity' || art.kind === 'aspect')
      return false;
    return art.kind !== 'type' || 'sloppy';
  }

  function checkSourceRef( art, path ) { // for FROM
    if (art.kind === 'entity' )
      return false;
    if (art.kind !== 'element')
      return true;
    const elem = path.find( item => item._artifact._main )._artifact;
    // TODO: better error location if error for main
    if (elem._main.kind !== 'entity' )
      return true;              // elem not starting at entity
    environment( art );         // sets _effectiveType on art
    return !(art._effectiveType || art).target;
  }

  // Return absolute name for unchecked path `ref`.  We first try searching for
  // the path root starting from `env`.  If it exists, return its absolute name
  // appended with the name of the rest of the path and set `ref.absolute` to
  // the return value.  Otherwise, complain if `unchecked` is false, and set
  // `ref.absolute` to the path name of `ref`.
  // Used for collecting artifact extension, and annotation assignments.
  function resolveUncheckedPath( ref, expected, user ) {
    if (!ref.path || ref.path.broken) // incomplete type AST
      return undefined;
    const spec = specExpected[expected];
    let art = (ref.scope === 'global' || spec.global)
      ? getPathRoot( ref.path, spec, user, {}, model[spec.global || 'definitions'] )
      : getPathRoot( ref.path, spec, user, user._block, null, true );
    if (art === false)          // redefinitions
      art = ref.path[0]._artifact[0]; // array stored in head's _artifact
    else if (!art)
      return (spec.useDefinitions) ? pathName( ref.path ) : null;
    // art can be using proxy...
    if (ref.path.length > 1)
      return `${ art.name.absolute }.${ pathName( ref.path.slice(1) ) }`;
    return art.name.absolute;
  }

  function userQuery( user ) {
    // TODO: we need _query links set by the definer
    while (user._main) {
      if (user.kind === 'select' || user.kind === '$join')
        return user;
      user = user._parent;
    }
    return null;
  }

  // Return artifact or element referred by the path in `ref`.  The first
  // environment we search in is `env`.  If no such artifact or element exist,
  // complain with message and return `undefined`.  Record a dependency from
  // `user` to the found artifact if `user` is provided.
  function resolvePath( ref, expected, user, extDict, msgArt ) {
    if (ref == null)       // no references -> nothing to do
      return undefined;
    if ('_artifact' in ref)     // also true for _artifact: undefined
      return ref._artifact;
    if (!ref.path || ref.path.broken || !ref.path.length) {
      // incomplete type AST or empty env (already reported)
      return setLink( ref, undefined );
    }
    setLink( ref, 0 );   // avoid cycles for  type T: association to T.m;

    let spec = specExpected[expected];
    const { path } = ref;
    const head = path[0];
    // message(null,head.location,{art:user,expected, id: head.id},
    //   'Info','User $(ART), $(EXPECTED) $(ID)')
    let env = user._block;     // artifact references: block

    if (ref.scope === 'param') {
      if (!spec.escape) {
        error( 'ref-unexpected-scope', [ ref.location, user ], {},
               'Unexpected parameter reference' );
        return setLink( ref, null );
      }
      spec = specExpected[spec.escape];
      // In queries and query entities, the first lexical search environment
      // are the parameters, otherwise the block.  It is currently ensured that
      // _block in queries is the same as _block of the query entity:
      const lexical = (user._main || user).$tableAliases; // queries (but also query entities)
      env = lexical && lexical.$parameters || user._block;
      extDict = null;           // let getPathRoot() choose it
    }
    else if (spec.next === '__none_') {
      env = {};
    }
    else if (spec.next) {       // TODO: combine spec.next / spec.lexical to spec.lexical
      // TODO: SIMPLIFY this function
      const query = (spec.lexical === 'main') ? user._main : userQuery( user );
      // in path filter, just $magic (and $parameters)
      env = (spec.lexical === 'from') ? query._parent : query || user._main || user;
      // queries: first tabaliases, then $magic - value refs: first $self, then $magic
      if (!extDict && !spec.noExt) {
        // TODO: change to name restriction for $joins, not own environments
        extDict = query && spec.rootEnv !== 'elements' &&
                  // first step: only use _combined of real query - TODO:
                  // reject if not visible, but not allow more (!)
                  (query._combined || query._parent._combined) ||
                  environment( user._main ? user._parent : user );
      }
    }

    // 'global' for CSN later in value paths, CDL for Association/Composition:
    let art = (ref.scope === 'global' || spec.global)
      ? getPathRoot( path, spec, user, {}, model[spec.global || 'definitions'] )
      : getPathRoot( path, spec, user, env, extDict, msgArt || 0 );
    if (!art) {
      return setLink( ref, art );
    }
    else if (!spec.envFn && user._pathHead) {
      // eslint-disable-next-line no-empty
    }
    else if (art.kind === 'using') {
      art = model.definitions[art.name.absolute];
      if (!art)
        return setLink( ref, art );
      else if (art.$duplicates)  // redefined art referenced by using proxy
        return setLink( ref, false );
      setLink( head, art );     // we do not want to see the using
    }
    else if (art.kind === 'mixin') {
      if (spec.noAliasOrMixin) {
        // TODO: good enough for now - change later to not search for table aliases at all
        signalNotFound( 'ref-rejected-on', [ head.location, user ], extDict && [ extDict ],
                        { '#': 'mixin', id: head.id } );
        // also set link on head?
        return setLink( ref, false );
      }
      // console.log(message( null, art.location, art, {}, 'Info','MIX').toString())
      setLink( head, art, '_navigation' );
    }
    else if (art.kind === '$navElement') {
      setLink( head, art, '_navigation' );
      setLink( head, art._origin );
      // TODO: set art?
    }
    else if (art.kind === '$tableAlias' || art.kind === '$self') {
      if (spec.noAliasOrMixin && art.kind !== '$self') { // TODO: extra kind $self?
        // TODO: good enough for now - change later to not search for table aliases at all
        signalNotFound( 'ref-rejected-on', [ head.location, user ], extDict && [ extDict ],
                        { '#': 'alias', id: head.id } );
        // also set link on head?
        return setLink( ref, false );
      }
      setLink( head, art, '_navigation' );
      setLink( head, art._origin ); // query source or leading query in FROM
      // require('../model/revealInternalProperties').log(model, 'foo.bar.S.V1a')
      if (!art._origin)
        return setLink( ref, art._origin );
    }

    // how many path items are for artifacts (rest: elements)
    const artItemsCount = (typeof ref.scope === 'number')
      ? ref.scope || Number.MAX_SAFE_INTEGER
      : spec.artItemsCount || 1;
    // console.log(expected, ref.path.map(a=>a.id),artItemsCount)
    art = getPathItem( path, spec, user, artItemsCount, !spec.envFn && user._pathHead && art);
    if (!art)
      return setLink( ref, art );

    if (art.$autoElement) {
      const { location } = path[path.length - 1];
      const step = { id: art.$autoElement, $inferred: '$autoElement', location };
      art = art.elements[step.id];
      setLink( step, art );
      path.push( step );
    }
    if (spec.check) {
      const fail = spec.check( art, path );
      if (fail === true) {
        signalNotFound( spec.expectedMsgId, [ ref.location, user ], null );
        return setLink( ref, false );
      }
      else if (fail) {
        signalNotFound( spec.sloppyMsgId, [ ref.location, user ], null );
        // no return!
      }
    }
    if (spec.warn) {
      const msgId = spec.warn( art, user );
      if (msgId)
        warning( msgId, [ ref.location, user ] );
    }
    if (user && (!spec.noDep ||
                 spec.noDep === 'only-entity' && art.kind !== 'entity')) {
      const { location } = ref; // || combinedLocation( head, path[tail.length] );
      // TODO: location of last path item if not main artifact
      if (!art._main || spec.assoc !== 'from') {
        dependsOn( user, art, location );
      }
      else {
        dependsOn( user, art._main, location );
        environment( art, location, user );
      // Without on-demand resolve, we can simply signal 'undefined "x"'
      // instead of 'illegal cycle' in the following case:
      //    element elem: type of elem.x;
      }
    }
    // Warning for CDL TYPE OF references without ':' or shifted ':'
    if (spec.deprecateSmart && typeof ref.scope === 'number' &&
        !(env.$frontend && env.$frontend !== 'cdl'))
      deprecateSmart( ref, art, user );
    // TODO: follow FROM here, see csnRef - fromRef
    return setLink( ref, art );
  }

  // Issue errors for "smart" element-in-artifact references
  // without a colon; and errors for misplaced colons in references.
  // This function likely disappears again in cds-compiler v2.x.
  function deprecateSmart( ref, art, user ) {
    const { path } = ref;
    const scope = path.findIndex( i => i._artifact._main );
    if (ref.scope) {            // provided a ':' in the ref path
      if (scope === ref.scope)  // correctly between main artifact and element
        return;
      const item = path[ref.scope];
      error( 'ref-unexpected-colon', [ item.location, user ], { id: item.id },
             'Replace the colon before $(ID) by a dot' );
      ref.scope = 0;          // correct (otherwise CSN refs are wrong)
    }
    if (scope >= 0) {           // we have a element-in-artifact reference
      const item = path[scope];
      error( 'ref-missing-colon', [ item.location, user ], { id: item.id },
             'Replace the dot before $(ID) by a colon' );
      ref.scope = scope;        // no need to recalculate in to-csn.js
    }
  }

  // Resolve the type arguments provided with a type referenced for artifact or
  // element `artifact`.  This function does nothing if the referred type
  // `typeArtifact` does not have a `parameters` property (currently, only
  // builtin-types have it, see ./builtins.js).
  //
  // For each property name `<prop>` in `typeArtifact.parameters`, we move a number
  // in art.$typeArgs (a vector of numbers with locations) to `artifact.<prop>`.
  // TODO: error if no parameters applicable
  // TODO: also check for number
  function resolveTypeArguments(artifact, typeArtifact, user) {
    const args = artifact.$typeArgs || [];
    const parameters = typeArtifact.parameters || [];
    const parLength = parameters.length;

    for (let i = 0; i < parLength; ++i) {
      let par = parameters[i];
      if (!(par instanceof Object))
        par = { name: par };
      if (!artifact[par.name] && i < args.length)
        artifact[par.name] = args[i];
    }
    if (args.length > parLength) {
      artifact.$typeArgs = artifact.$typeArgs.slice(parLength);
      warning( 'unexpected-type-arg', [ artifact.$typeArgs[0].location, user ],
               { art: typeArtifact }, 'Too many arguments for type $(ART)' );
    }
    else if (artifact.$typeArgs) {
      delete artifact.$typeArgs;
    }
  }

  // Return artifact or element referred by name `head`.  The first environment
  // we search in is `env`.  If `unchecked` is equal to `true`, do not report an error
  // if the artifact does not exist.  Return a "fresh" artifact for
  // non-existing external using references if `unchecked` is truthy.
  function getPathRoot( path, spec, user, env, extDict, msgArt ) {
    if (!spec.envFn && user._pathHead) {
      // TODO: not necessarily for explicit ON condition in expand
      environment( user._pathHead ); // make sure _origin is set
      return user._pathHead._origin;
    }
    const head = path[0];
    if (!head || !head.id || !env)
      return undefined;         // parse error
    // if (head.id === 'k') {console.log(Object.keys(user));throw Error(JSON.stringify(user.name))}
    // if head._artifact is set or is null then it was already computed once
    if ('_artifact' in head)
      return Array.isArray(head._artifact) ? false : head._artifact;
    // console.log(pathName(path), !spec.next && !extDict &&
    //   (spec.useDefinitions || env.$frontend === 'json' || env))
    if (!spec.next && !extDict) {
      // CSN artifact paths are always fully qualified so we use
      // model.definitions for the JSON frontend.
      extDict = (spec.useDefinitions || env.$frontend && env.$frontend !== 'cdl')
        ? model.definitions
        : model.$builtins;
    }
    const nodollar = !spec.dollar && spec.next;
    const nextProp = spec.next || '_block';
    for (let art = env; art; art = art[nextProp]) {
      if (nodollar && !art._main) // $self stored in main.$tableAliases
        break;                    // TODO: probably remove _$next link
      const e = art.artifacts || art.$tableAliases || Object.create(null);
      const r = e[head.id];
      if (r) {
        if (Array.isArray(r)) { // redefinitions
          setLink( head, r );
          return false;
        }
        // if (head.$delimited && r.kind !== '$tableAlias' && r.kind !== 'mixin')
        // TODO: warning for delimited special - or directly in parser
        if (r.kind === '$parameters') {
          if (!head.$delimited && path.length > 1) {
            message( 'ref-obsolete-parameters', [ head.location, user ],
                     { code: `$parameters.${ path[1].id }`, newcode: `:${ path[1].id }` },
                     'Obsolete $(CODE) - replace by $(NEWCODE)' );
            // TODO: replace it in to-csn correspondingly
            return setLink( head, r );
          }
        }
        else if (r.kind === '$self') {
          // TODO: handle $delimited differently
          // TODO: $projection only if not delimited _and_ length > 1
          return setLink( head, r );
        }
        else if (r.kind !== '$tableAlias' || path.length > 1 || user.expand || user.inline) {
          // except "real" table aliases (not $self) with path len 1
          // TODO: $projection only if not delimited _and_ length > 1
          return setLink( head, r );
        }
      }
    }
    if (extDict && (!spec.dollar || head.id[0] !== '$')) {
      const r = extDict[head.id];
      if (Array.isArray(r)) {
        if (r[0].kind === '$navElement') {
          const names = r.filter( e => !e.$duplicates)
            .map( e => `${ e.name.alias }.${ e.name.element }` );
          if (names.length) {
            error( 'ref-ambiguous', [ head.location, user ], { id: head.id, names },
                   'Ambiguous $(ID), replace by $(NAMES)' );
          }
        }
        setLink( head, r );
        return false;
      }
      else if (r) {
        return setLink( head, r );
      }
    }
    if (spec.noMessage || msgArt === true && extDict === model.definitions)
      return null;

    const valid = [];
    for (let art = env; art; art = art[nextProp]) {
      const e = art.artifacts || art.$tableAliases || Object.create(null);
      valid.push( e );
    }
    if (extDict) {
      const e = Object.create(null);
      // the names of the external dictionary are valid, too, except duplicate
      // navigation elements (for which you should use a table alias)
      if (extDict !== model.definitions) {
        for (const name in extDict) {
          const def = extDict[name];
          if (!(Array.isArray(def) && def[0].kind === '$navElement'))
            e[name] = def;
        }
      }
      else {
        for (const name in extDict) {
          if (!name.includes('.') && (spec.nodollar || name[0] !== '$'))
            e[name] = extDict[name];
        }
      }
      valid.push( e );
    }

    if (spec.next) {            // value ref
      // TODO: if not in query, specify where we search for elements and delete env.$msg
      // TODO: also something special if it starts with '$'
      if (msgArt) {
        // TODO: we might mention both the "direct" and the "effective" type and
        // always just mentioned one identifier as not found
        signalNotFound( 'ref-undefined-element', [ head.location, user ], valid,
                        { art: searchName( msgArt, head.id, 'element' ) } );
      }
      else {
        signalNotFound( 'ref-undefined-var', [ head.location, user ], valid, { id: head.id },
                        'Element or variable $(ID) has not been found' );
      }
    }
    else if (env.$frontend && env.$frontend !== 'cdl' || spec.global) {
      // IDE can inspect <model>.definitions - provide null for valid
      signalNotFound( spec.undefinedDef || 'ref-undefined-def', [ head.location, user ],
                      valid, { art: head.id } );
    }
    else {
      signalNotFound( spec.undefinedArt || 'ref-undefined-art', [ head.location, user ],
                      valid, { name: head.id } );
    }
    return setLink( head, null );
  }

  // Return artifact or element referred by path (array of ids) `tail`.  The
  // search environment (for the first path item) is `arg`.  For messages about
  // missing artifacts (as opposed to elements), provide the `head` (first
  // element item in the path)
  function getPathItem( path, spec, user, artItemsCount, headArt ) {
    let art = headArt;
    let nav = spec.assoc !== '$keys' && null; // false for '$keys'
    const last = path[path.length - 1];
    for (const item of path) {
      --artItemsCount;
      if (!item || !item.id)    // incomplete AST due to parse error
        return undefined;
      if (item._artifact) { // should be there on first path element (except with expand)
        art = item._artifact;
        if (Array.isArray(art))
          return false;
        continue;
      }

      const fn = (spec.envFn && artItemsCount >= 0) ? spec.envFn : environment;
      const env = fn( art, item.location, user, spec.assoc );

      // do not check any elements of the path, e.g. $session - but still don't return path-head
      if (art && art.$uncheckedElements) {
        if (env && env[item.id]) // something like $user.id/$user.locale
          return env[item.id];

        // $user.foo - build our own valid path step obj
        // Important: Don't directly modify item!
        const obj = {
          location: item.location,
          kind: 'builtin',
          name: { id: item.id, element: path.map(p => p.id).join('.') },
        };
        setLink(obj, art, '_parent');
        return obj;
      }

      const sub = setLink( item, env && env[item.id] );

      if (!sub)
        return (sub === 0) ? 0 : errorNotFound( item, env );
      else if (Array.isArray(sub)) // redefinitions
        return false;

      if (nav) {              // we have already "pseudo-followed" a managed association
        // We currently rely on the check that targetElement references do
        // not (pseudo-) follow associations, otherwise potential redirection
        // there had to be considered, too.  Also, fk refs to sub elements in
        // combinations with redirections of the target which directly access
        // the potentially renamed sub elements would be really complex.
        // With our restriction, no renaming must be considered for item.id.
        setTargetReferenceKey( item.id, item );
      }
      // Now set an _navigation link for managed assocs in ON condition etc
      else if (art && art.target && nav != null) {
        // Find the original ref for sub and the original foreign key
        // definition.  This way, we do not need the foreign keys with
        // rewritten target element path, which might not be available at
        // this point (rewriteKeys in Resolver Phase 5).  If we want to
        // follow associations in foreign key definitions, rewriteKeys must
        // be moved to the on-demand Resolver Phase 2.
        let orig;             // for the original target element
        for (let o = sub; o; o = o.value && o.value._artifact) // TODO: or use _origin?
          orig = o;
        nav = (orig._effectiveType || orig).$keysNavigation;
        setTargetReferenceKey( orig.name.id, item );
      }
      art = sub;
      if (spec.envFn && (!artItemsCount || item === last) &&
          art && art.$inferred === 'autoexposed' && !user.$inferred) {
        // Depending on the processing sequence, the following could be a
        // simple 'ref-undefined-art'/'ref-undefined-def' - TODO: which we
        // could "change" to this message at the end of compile():
        message( 'ref-autoexposed', [ item.location, user ], { art },
                 // eslint-disable-next-line max-len
                 'An autoexposed entity can\'t be referred to - expose entity $(ART) explicitly' );
      }
    }
    return art;

    function setTargetReferenceKey( id, item ) {
      const node = nav && nav[id];
      nav = null;
      if (node) {
        if (node._artifact) {
          // set the original(!) foreign key for the assoc - the "right" ones
          // after rewriteKeys() is the one with the same name.id
          setLink( item, node._artifact, '_navigation' );
          if (item === last)
            return;
        }
        else if (item !== last) {
          nav = node.$keysNavigation;
          return;
        }
      }
      error( null, [ item.location, user ], {},
             // eslint-disable-next-line max-len
             'You can\'t follow associations other than to elements referred to in a managed association\'s key' );
    }

    function errorNotFound( item, env ) {
      if (!spec.next) {         // artifact ref
        // TODO: better for TYPE OF, FROM e.Assoc (even disallow for other refs)
        const a = searchName( art, item.id, (spec.envFn || art._subArtifacts) && 'absolute' );
        signalNotFound( spec.undefinedDef || 'ref-undefined-def', [ item.location, user ],
                        [ env ], { art: a } );
      }
      else if (art.name.select && art.name.select > 1) {
        // TODO: 'The current query has no element $(MEMBER)' with $self.MEMBER
        // and 'The sub query for alias $(ALIAS) has no element $(MEMBER)'
        // TODO: probably not extra messageId, but text variant
        // TODO: views elements are proxies to query-0 elements, not the same
        // TODO: better message text
        signalNotFound( 'query-undefined-element', [ item.location, user ],
                        [ env ], { id: item.id },
                        'Element $(ID) has not been found in the elements of the query' );
      }
      else if (art.kind === '$parameters') {
        signalNotFound( 'ref-undefined-param', [ item.location, user ],
                        [ env ], { art: searchName( art._main, item.id, 'param' ) },
                        { param: 'Entity $(ART) has no parameter $(MEMBER)' } );
      }
      else {
        signalNotFound( 'ref-undefined-element', [ item.location, user ],
                        [ env ], { art: searchName( art, item.id, 'element' ) } );
      }
      return null;
    }
  }

  /**
   * Make a "not found" error and optionally attach valid names.
   *
   * @param {string} msgId
   * @param {any} location
   * @param {object[]} valid
   * @param  {object} [textParams]
   * @param  {any} [texts]
   */
  function signalNotFound(msgId, location, valid, textParams, texts ) {
    if (location.$notFound)
      return;
    location.$notFound = true;
    /** @type {object} */
    const err = message( msgId, location, textParams, texts );
    if (valid)
      attachAndEmitValidNames(err, ...valid.reverse());
  }

  /**
   * Attaches a dictionary of valid names to the given compiler message.
   * In test mode, an info message is emitted with a list of valid names.
   *
   * @param {CSN.Message} msg CDS Compiler message
   * @param  {...object} validDicts One ore more artifact dictionaries such as in `_block`.
   */
  function attachAndEmitValidNames(msg, ...validDicts) {
    if (!options.testMode && !options.attachValidNames)
      return;

    const valid = Object.assign( Object.create( null ), ...validDicts );
    msg.validNames = Object.create( null );
    for (const name of Object.keys( valid )) {
      // ignore internal types such as cds.Association
      if (valid[name].internal || valid[name].deprecated)
        continue;
      msg.validNames[name] = valid[name];
    }

    if (options.testMode) {
      // no semantic location => either first of [loc, semantic loc] pair or just location.
      const loc = msg.location[0] || msg.location;
      const names = Object.keys(msg.validNames);
      info( null, loc,
            { '#': !names.length ? 'zero' : 'std' },
            { std: `Valid: ${ names.sort().join(', ') }`, zero: 'No valid names' });
    }
  }

  // Resolve all annotation assignments for the node `art`.  Set `art.@` to all
  // flattened assignments.  This function might issue error message for
  // duplicate assignments.
  // TODOs:
  // * do something for extensions by CSN or Properties parsers
  // * make sure that we do not issue repeated warnings due to flattening if an
  //   annotation definition is missing
  function defineAnnotations( construct, art, block, priority = 'define' ) {
    if (!options.parseCdl && construct.kind === 'annotate') {
      // Namespaces cannot be annotated in CSN but because they exist as XSN artifacts
      // they can still be applied. Namespace annotations are extracted in to-csn.js
      // In parseCdl mode USINGs and other unknown references are generated as
      // namespaces which would lead to false positives.
      // TODO: should this really be different to annotate-unknown?
      if (art.kind === 'namespace') {
        info( 'anno-namespace', [ construct.name.location, construct ], {},
              'Namespaces can\'t be annotated' );
      }
      // Builtin annotations would also get lost. Same as for namespaces:
      // extracted in to-csn.js
      else if (art.builtin === true) {
        info( 'anno-builtin', [ construct.name.location, construct ], {},
              'Builtin types should not be annotated. Use custom type instead' );
      }
    }
    // TODO: block should be construct._block
    if (construct.$annotations && construct.$annotations.doc )
      art.doc = construct.$annotations.doc;
    if (!construct.$annotations) {
      if (!block || block.$frontend !== 'json')
        return;                 // namespace, or in CDL source without @annos:
      // CSN input: set _block and $priority, shallow-copy from extension
      for (const annoProp in construct) {
        if (annoProp.charAt(0) === '@') {
          let annos = construct[annoProp];
          if (!(Array.isArray(annos)))
            annos = [ annos ];
          for (const a of annos) {
            setProp( a, '_block', block );
            a.$priority = priority;
            if (construct !== art)
              dictAddArray( art, annoProp, a );
          }
        }
      }
      return;
    }
    for (const anno of construct.$annotations) {
      const ref = anno.name;
      const name = resolveUncheckedPath( ref, 'annotation', { _block: block } );
      const annoProp = (anno.name.variant)
        ? `@${ name }#${ anno.name.variant.id }`
        : `@${ name }`;
      flatten( ref.path, annoProp, anno.value || {}, anno.name.variant, anno.name.location );
    }
    return;

    function flatten( path, annoProp, value, iHaveVariant, location ) {
      // Be robust if struct value has duplicate element names
      if (Array.isArray(value)) // TODO: do that differently in CDL parser
        return;                 // discard duplicates in flattened form

      if (value.literal === 'struct') {
        for (const item of value._struct || []) {
          let prop = pathName(item.name.path);
          if (item.name.variant) {
            if (iHaveVariant) {
              error( 'anno-duplicate-variant', [ item.name.variant.location, construct ],
                     {},      // TODO: params
                     'Annotation variant has been already provided' );
            }
            prop = `${ prop }#${ item.name.variant.id }`; // TODO: check for double variants
          }
          flatten( [ ...path, ...item.name.path ], `${ annoProp }.${ prop }`, item, iHaveVariant || item.name.variant);
        }
        for (const prop in value.struct) {
          const item = value.struct[prop];
          flatten( [ ...path, item.name ], `${ annoProp }.${ prop }`, item, iHaveVariant );
        }
        return;
      }
      const anno = Object.assign( {}, value ); // shallow copy
      anno.name = {
        path,
        location: location ||
          value.name && value.name.location ||
          value.path && value.path.location,
      };
      setProp( anno, '_block', block );
      // TODO: _parent, _main is set later (if we have ElementRef), or do we
      // set _artifact?
      anno.$priority = priority;
      dictAddArray( art, annoProp, anno );
    }
  }
}

// Return string 'A.B.C' for parsed source `A.B.C` (is vector of ids with
// locations):
function pathName(path) {
  return (path.broken) ? '' : path.map( id => id.id ).join('.');
}

// The link (_artifact,_effectiveType,...) usually has the artifact as value.
// Falsy values are:
// - undefined: not computed yet, parse error, no ref
// - null: no valid reference, param:true if that is not allowed
// - false (only complete ref): multiple definitions, rejected
// - 0 (for _effectiveType only): circular reference
function setLink( obj, value = null, prop = '_artifact' ) {
  Object.defineProperty( obj, prop, { value, configurable: true, writable: true } );
  return value;
}

function linkToOrigin( origin, name, parent, prop, location, silentDep ) {
  const elem = {
    name: { location: location || origin.name.location, id: name },
    kind: origin.kind,
    location: location || origin.location,
  };
  if (origin.name.$inferred)
    elem.name.$inferred = origin.name.$inferred;
  if (parent)
    setMemberParent( elem, name, parent, prop ); // TODO: redef in template
  setProp( elem, '_origin', origin );
  // TODO: should we use silent dependencies also for other things, like
  // included elements?  (Currently for $inferred: 'expand-element' only)
  if (silentDep)
    dependsOnSilent( elem, origin );
  else
    dependsOn( elem, origin, location );
  return elem;
}

function setMemberParent( elem, name, parent, prop ) {
  if (prop) {              // extension or structure include
    // TODO: consider nested ARRAY OF and RETURNS, COMPOSITION OF type
    const p = parent.items || parent.targetAspect || parent;
    if (!(prop in p))
      p[prop] = Object.create(null);
    dictAdd( p[prop], name, elem );
  }
  if (parent._outer)
    parent = parent._outer;
  setProp( elem, '_parent', parent );
  setProp( elem, '_main', parent._main || parent );
  elem.name.absolute = elem._main.name.absolute;
  if (name == null)
    return;
  const normalized = kindProperties[elem.kind].normalized || elem.kind;
  [ 'element', 'alias', 'select', 'param', 'action' ].forEach( ( kind ) => {
    if (normalized === kind)
      elem.name[kind] = (parent.name[kind] != null && kind !== 'select' && kind !== 'alias') ? `${ parent.name[kind] }.${ name }` : name;

    else if (parent.name[kind] != null)
      elem.name[kind] = parent.name[kind];

    else
      delete elem.name[kind];
  });
  // try { throw new Error('Foo') } catch (e) { elem.name.stack = e; };
}

/**
 * Adds a dependency user -> art with the given location.
 *
 * @param {XSN.Artifact} user
 * @param {XSN.Artifact} art
 * @param {XSN.Location} location
 */
function dependsOn( user, art, location ) {
  if (!user._deps)
    setProp( user, '_deps', [] );
  user._deps.push( { art, location } );
}

/**
 * Same as "dependsOn" but the dependency from user -> art is silent,
 * i.e. not reported to the user.
 *
 * @param {XSN.Artifact} user
 * @param {XSN.Artifact} art
 */
function dependsOnSilent( user, art ) {
  if (!user._deps)
    setProp( user, '_deps', [] );
  user._deps.push( { art } );
}

function storeExtension( elem, name, prop, parent, block ) {
  if (prop === 'enum')
    prop = 'elements';
  setProp( elem, '_block', block );
  const kind = `_${ elem.kind }`; // _extend or _annotate
  if (!parent[kind])
    setProp( parent, kind, {} );
  // if (name === '' && prop === 'params') {
  //   pushToDict( parent[kind], 'returns', elem ); // not really a dict
  //   return;
  // }
  if (!parent[kind][prop])
    parent[kind][prop] = Object.create(null);
  pushToDict( parent[kind][prop], name, elem );
}

/** @type {(a: any, b: any) => boolean} */
const testFunctionPlaceholder = () => true;

// Return path step if the path navigates along an association whose final type
// satisfies function `test`; "navigates along" = last path item not considered
// without truthy optional argument `alsoTestLast`.
function withAssociation( ref, test = testFunctionPlaceholder, alsoTestLast = false ) {
  for (const item of ref.path || []) {
    const art = item && item._artifact; // item can be null with parse error
    if (art && art._effectiveType && art._effectiveType.target && test( art._effectiveType, item ))
      return (alsoTestLast || item !== ref.path[ref.path.length - 1]) && item;
  }
  return false;
}

module.exports = {
  dictKinds,
  kindProperties,
  fns,
  setLink,
  linkToOrigin,
  dependsOn,
  dependsOnSilent,
  setMemberParent,
  storeExtension,
  withAssociation,
};
