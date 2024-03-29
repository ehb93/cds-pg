// Transform XSN (augmented CSN) into CSN

// The transformation works as follows: we transform a value in the XSN
// according to the following rules:
//
//  - if it is a non-object, return it directly
//  - if it is an array, return it with all items transformed recursively
//  - if it is another object, return it with all property values transformed
//    according to function `transformers.<prop>` or (if it does not exist)
//    recursively to the rule; properties with value `undefined` are deleted

'use strict';

const { locationString } = require('../base/messages');
const { isBetaEnabled, isDeprecatedEnabled } = require('../base/model');

const compilerVersion = require('../../package.json').version;
const creator = `CDS Compiler v${ compilerVersion }`;
const csnVersion = '2.0';

const normalizedKind = {
  param: 'param',
  action: 'action',
  function: 'action',
};

/** @type {boolean|string} */
let gensrcFlavor = true;       // good enough here...
let universalCsn = false;
let strictMode = false;        // whether to dump with unknown properties (in standard)
let parensAsStrings = false;
let projectionAsQuery = false;
let withLocations = false;
let dictionaryPrototype = null;

// IMPORTANT: the order of these properties determine the order of properties
// in the resulting CSN !!!  Also check const `csnPropertyNames`.
const transformers = {
  // early and modifiers (without null / not null) ---------------------------
  kind,
  _outer: ( _, csn, node ) => addOrigin( csn, node ),
  id: n => n,                   // in path item
  doc: value,
  '@': value,
  virtual: value,
  key: value,
  unique: value,
  masked: value,
  params: insertOrderDict,
  // early expression / query properties -------------------------------------
  op: o => ((o.val !== 'SELECT' && o.val !== '$query') ? o.val : undefined),
  from,                         // before elements!
  // join done in from()
  // func   // in expression()
  quantifier: ( q, csn ) => {
    csn[q.val] = true;
  },
  all: ignore,                  // XSN TODO use quantifier
  // type properties (without 'elements') ------------------------------------
  localized: value,
  type,
  length: value,
  precision: value,
  scale: value,
  srid: value,
  cardinality: standard,            // also for pathItem: after 'id', before 'where'
  targetAspect,
  target,
  foreignKeys,
  enum: insertOrderDict,
  items,
  includes: arrayOf( artifactRef ), // also entities
  // late expressions / query properties -------------------------------------
  mixin: insertOrderDict,       // only in queries with special handling
  columns,
  expand: ignore,               // do not list for select items as elements
  inline: ignore,               // do not list for select items as elements
  excludingDict,
  groupBy: arrayOf( expression ),
  where: condition,             // also pathItem after 'cardinality' before 'args'
  having: condition,
  args,                        // also pathItem after 'where', before 'on'/'orderBy'
  suffix: node => [].concat( ...node.suffix.map( xprArg ) ),
  orderBy: arrayOf( orderBy ), // TODO XSN: make `sort` and `nulls` sibling properties
  sort: value,
  nulls: value,
  limit: standard,
  rows: expression,
  offset: expression,
  on: onCondition,
  // definitions, extensions, members ----------------------------------------
  returns: definition,          // storing the return type of actions
  notNull: value,
  default: expression,
  // targetElement: ignore,     // special display of foreign key, renameTo: select
  value: enumValue,             // do not list for select items as elements
  query,
  elements,
  actions,                      // TODO: just normal dictionary
  // special: top-level, cardinality -----------------------------------------
  sources,
  definitions: sortedDict,
  vocabularies: sortedDict,
  extensions,                   // is array
  i18n,
  messages: ignore,
  options: ignore,
  sourceMin: renameTo( 'srcmin', value ),
  sourceMax: renameTo( 'src', value ),
  targetMin: renameTo( 'min', value ),
  targetMax: renameTo( 'max', value ),
  // late protected ----------------------------------------------------------
  name: ignore,             // as is provided extra (for select items, in FROM)
  $syntax: dollarSyntax,
  // location is not renamed to $location as the name is well established in
  // XSN and too many places (also outside the compiler) had to be adapted
  location,                     // non-enumerable $location in CSN
  $a2j: (e, csn) => {           // on artifact level
    Object.assign( csn, e );
  },
  $extra: (e, csn) => {
    Object.assign( csn, e );
  },
  // IGNORED -----------------------------------------------------------------
  artifacts: ignore,             // well-introduced, hence not $artifacts
  blocks: ignore,                // FIXME: make it $blocks
  builtin: ignore,               // XSN: $builtin, check: "cds" namespace exposed by transformers?
  origin: ignore,              // TODO remove (introduce non-enum _origin link)
  // $inferred is not renamed to $generated (likely name of a future CSN
  // property) as too many places (also outside the compiler) had to be adapted
  $: ignore,
  // '_' not here, as non-enumerable properties are not transformed anyway
  expectedKind: ignore, // TODO: may be set in extensions but is unused
};

// Dictionary mapping XSN property names to corresponding CSN property names
// which should appear at that place in order.
const csnPropertyNames = {
  virtual: [ 'abstract' ],      // abstract is compiler v1 CSN property
  kind: [ 'annotate', 'extend', '$origin' ],
  op: [ 'join', 'func', 'xpr' ],    // TODO: 'func','xpr' into 'quantifier'?  TODO: 'global'(scope)?
  quantifier: [
    'some', 'any', 'distinct',  // 'all' explicitly listed
    'ref',
    'param', 'val', 'literal', 'SELECT', 'SET',
  ],
  foreignKeys: [ 'keys' ],
  excludingDict: [ 'excluding' ],
  limit: [ 'rows' ],  // 'offset',
  query: [ 'projection' ],
  elements: [ '$elements' ],    // $elements for --enrich-csn
  sources: [ 'namespace', '$sources' ],
  sourceMin: [ 'srcmin' ],
  sourceMax: [ 'src' ],
  targetMin: [ 'min' ],
  targetMax: [ 'max' ],
  name: [ 'as', 'cast' ],
  location: [ '$env', '$location' ], // --enrich-csn
  expectedKind: [
    '_origin', '_type', '_targetAspect', '_target', '_includes', '_links', '_art', '_scope',
  ],                            // --enrich-csn
};

const propertyOrder = (function orderPositions() {
  const r = {};
  let i = 0;
  for (const n in transformers) {
    r[n] = ++i;
    for (const c of csnPropertyNames[n] || [])
      r[c] = ++i;
  }
  return r;
}());

// sync with definition in from-csn.js:
const typeProperties = [
  'target', 'elements', 'enum', 'items',
  'type', 'length', 'precision', 'scale', 'srid', 'localized',
  'foreignKeys', 'on',      // for explicit ON/keys with REDIRECTED
];

const operators = {
  // standard is: binary infix (and corresponding n-ary), unary prefix
  isNot: [ 'is', 'not' ],       // TODO XSN: 'is not'
  isNull: postfix( [ 'is', 'null' ] ),
  isNotNull: postfix( [ 'is', 'not', 'null' ] ),
  in: binaryRightParen( [ 'in' ] ),
  notIn: binaryRightParen( [ 'not', 'in' ] ),
  between: ternary( [ 'between' ], [ 'and' ] ),
  notBetween: ternary( [ 'not', 'between' ], [ 'and' ] ),
  like: ternary( [ 'like' ], [ 'escape' ] ),
  notLike: ternary( [ 'not', 'like' ], [ 'escape' ] ),
  when: exprs => [ 'when', ...exprs[0], 'then', ...exprs[1] ],
  case: exprs => [ 'case' ].concat( ...exprs, [ 'end' ] ),
  over: exprs => [ 'over', { xpr: [].concat( ...exprs ) } ],
  orderBy: exprs => [
    'order', 'by', ...exprs[0].concat( ...exprs.slice(1).map( e => [ ',', ...e ] ) ),
  ],
  partitionBy: exprs => [
    'partition', 'by', ...exprs[0].concat( ...exprs.slice(1).map( e => [ ',', ...e ] ) ),
  ],
  // xpr: (exprs) => [].concat( ...exprs ), see below - handled extra
};

const csnDictionaries = [
  'args', 'params', 'enum', 'mixin', 'elements', 'actions', 'definitions',
];
const csnDirectValues = [ 'val' ]; // + all starting with '@' - TODO: still relevant

/**
 * Sort property names of CSN according to sequence which is also used by the compactModel function
 * Only returns enumerable properties, except for certain hidden properties
 * if requested (cloneOptions != false): $location, elements.
 *
 * If cloneOptions is false or if either cloneOptions.testMode or cloneOptions.testSortCsn
 * are set, definitions are also sorted.
 *
 * @param {object} csn
 * @param {CSN.Options|false} cloneOptions
 */
function sortCsn( csn, cloneOptions = false ) {
  if (cloneOptions && typeof cloneOptions === 'object')
    initModuleVars( cloneOptions );

  if (Array.isArray(csn))
    return csn.map( v => (!v || typeof v !== 'object' ? v : sortCsn(v, cloneOptions) ) );
  const r = {};
  for (const n of Object.keys(csn).sort( compareProperties ) ) {
    const sortDict = n === 'definitions' &&
                     (!cloneOptions || cloneOptions.testMode || cloneOptions.testSortCsn);
    const val = csn[n];
    if (!val || typeof val !== 'object' || n.charAt(0) === '@' || csnDirectValues.includes(n))
      r[n] = val;

    else if (csnDictionaries.includes(n) && !Array.isArray(val))
      // Array check for property `args` which may either be a dictionary or an array.
      r[n] = csnDictionary( val, sortDict, cloneOptions );

    else
      r[n] = sortCsn(val, cloneOptions);
  }
  if (cloneOptions && typeof csn === 'object') {
    if ({}.hasOwnProperty.call( csn, '$sources' ) && !r.$sources)
      setHidden( r, '$sources', csn.$sources );
    if ({}.hasOwnProperty.call( csn, '$location' ) && !r.$location)
      setHidden( r, '$location', csn.$location );
    if ({}.hasOwnProperty.call( csn, '$path' )) // used in generic reference flattener
      setHidden( r, '$path', csn.$path );
    if ({}.hasOwnProperty.call( csn, '$paths' )) // used in generic reference flattener
      setHidden( r, '$paths', csn.$paths );
    if (hasNonEnumerable( csn, 'elements' ) && !r.elements) // non-enumerable 'elements'
      setHidden( r, 'elements', csnDictionary( csn.elements, false, cloneOptions ) );
    if (hasNonEnumerable( csn, '$tableConstraints' ) && !r.$tableConstraints)
      setHidden( r, '$tableConstraints', csn.$tableConstraints );
  }
  return r;
}

/**
 * Check wether the given object has non enumerable property.
 * Ensure that we don't take it from the prototype, only "directly" - we accidentally
 * cloned elements with a cds.linked input otherwise.
 *
 * @param {object} object
 * @param {string} property
 * @returns
 */
function hasNonEnumerable(object, property) {
  return {}.hasOwnProperty.call( object, property ) &&
    !{}.propertyIsEnumerable.call( object, property );
}

/**
 * @param {object} csn
 * @param {boolean} sort
 * @param {CSN.Options | false} cloneOptions If != false,
 *   cloneOptions.dictionaryPrototype is used and cloneOptions are
 *   passed to sort().
 * @returns {object}
 */
function csnDictionary( csn, sort, cloneOptions = false ) {
  if (!csn || Array.isArray(csn)) // null or strange CSN
    return csn;
  const proto = cloneOptions && (typeof cloneOptions === 'object') &&
                cloneOptions.dictionaryPrototype;
  // eslint-disable-next-line no-nested-ternary
  const dictProto = (typeof proto === 'object') // including null
    ? proto
    : (proto) ? Object.prototype : null;
  const r = Object.create( dictProto );
  for (const n of (sort) ? Object.keys(csn).sort() : Object.keys(csn))
    r[n] = sortCsn( csn[n], cloneOptions );

  return r;
}

/**
 * Compact the given XSN model and transform it into CSN.
 *
 * @param {XSN.Model} model
 * @param {CSN.Options} options
 * @returns {CSN.Model}
 */
function compactModel( model, options = model.options || {} ) {
  initModuleVars( options );
  const csn = {};
  const srcDict = model.sources || Object.create( null ); // not dictionaryPrototype!
  if (options.parseCdl) {                                 // TODO: make it a csnFlavor?
    const using = usings( srcDict );
    if (using.length)
      csn.requires = using;
  }
  // 'namespace' for complete model is 'namespace' of first source
  // (not a really useful property at all, avoids XSN inspection by Umbrella)
  for (const first in srcDict) {
    const { namespace } = srcDict[first];
    if (namespace && namespace.path)
      csn.namespace = namespace.path.map( i => i.id ).join('.');
    break;
  }
  set( 'definitions', csn, model );
  set( 'vocabularies', csn, model );
  const exts = extensions( model.extensions || [], csn, model );
  if (exts && exts.length)
    csn.extensions = exts;
  set( 'i18n', csn, model );
  set( 'sources', csn, model );
  // Set $location, use $extra properties of first source as resulting $extra properties
  for (const first in srcDict) {
    const loc = srcDict[first].location;
    if (loc && loc.file) {
      Object.defineProperty( csn, '$location', {
        value: { file: loc.file }, configurable: true, writable: true, enumerable: withLocations,
      } );
    }
    set( '$extra', csn, srcDict[first] );
    break;
  }

  if (!options.testMode) {
    csn.meta = Object.assign( {}, model.meta, { creator } );
    csn.$version = csnVersion;
  }
  return csn;
}

function renameTo( csnProp, func ) {
  return function renamed( val, csn, node, prop ) {
    const sub = func( val, csn, node, prop );
    if (sub !== undefined)
      csn[csnProp] = sub;
  };
}

function arrayOf( func ) {
  return ( val, ...nodes ) => val.map( v => func( v, ...nodes ) );
}

/**
 * Create a CSN `requires` array of dependencies.
 *
 * @param {object} srcDict Dictionary of source files to their AST/XSN.
 */
function usings( srcDict ) {
  const sourceNames = Object.keys(srcDict);
  if (sourceNames.length === 0)
    return [];

  // Take the first file as parseCdl should only receive one file.
  const source = srcDict[sourceNames[0]];
  const requires = [];
  if (source && source.dependencies)
    source.dependencies.map(dep => dep && requires.push(dep.val));

  // Make unique and sort
  return Array.from(new Set(requires)).sort();
}

/**
 * @param {XSN.Extension[]} node
 * @param {object} csn
 * @param {object} model
 */


function extensions( node, csn, model ) {
  if (model.kind && model.kind !== 'source')
    return undefined;
  const exts = node.map( definition );

  // builtins are non-enumerable for smaller display
  for (const name of Object.getOwnPropertyNames( model.definitions || {} ).sort()) {
    const art = model.definitions[name];

    // For namespaces and builtins: Extract annotations since they cannot be represented
    // in CSN.  For all other artifacts, check whether they may be auto-exposed,
    // $inferred, etc. and extract their annotations.
    // In parseCdl mode extensions were already put into "extensions".
    if (!model.options.parseCdl && (art.kind === 'namespace' || art.builtin)) {
      extractAnnotationsToExtension( art );
    }
    else if (gensrcFlavor) {
      // From definitions (without redefinitions) with potential inferred elements:
      const annotate = { annotate: name };
      if (art.$inferred)
        Object.assign( annotate, annotationsAndDocComment( art, true ) );
      if (art.$expand === 'annotate') {
        if (art.actions)
          attachAnnotations( annotate, 'actions', art.actions, art.$inferred );
        else if (art.params)
          attachAnnotations( annotate, 'params', art.params, art.$inferred );
        const obj = art.returns || art;
        const elems = (obj.items || obj).elements; // no targetAspect here
        if (elems)
          attachAnnotations( annotate, 'elements', elems, art.$inferred, art.returns );
      }
      if (Object.keys( annotate ).length > 1)
        exts.push( annotate );
    }
  }

  return exts.sort(
    (a, b) => (a.annotate || a.extend).localeCompare( b.annotate || b.extend )
  );

  /*
  function attachElementAnnos( annotate, art ) {
    while (art.items)
      art = art.items;
    if (art.elements) {
      const elems = inferred( art.elements, art.$inferred );
      if (Object.keys( elems ).length)
        annotate.elements = elems;
    }
  }

  function attachParamAnnos( annotate, art ) {
    const inferredParent = art.$inferred;
    if (art.params) {
      const ext = Object.create( dictionaryPrototype );
      for (const name in art.params) {
        const par = art.params[name];
        if (!inferredParent && !par.$inferred && par.$expand !== 'annotate')
          continue;
        const render = annotationsAndDocComment( par, true );
        const subElems = par.$expand !== 'origin' && (par.items || par).elements;
        if (subElems) {
          const sub = inferred( subElems, par.$inferred );
          if (Object.keys( sub ).length)
            render.elements = sub;
        }
        if (Object.keys(render).length)
          ext[name] = render;
      }
      if (obj.keys( ext ))
        annotate.params = ext;
    }
    if (art.returns) {
      const par = art.returns;
      if (!inferredParent && !par.$inferred && par.$expand !== 'annotate')
        return;
      const render = annotationsAndDocComment( par, true );
      const subElems = par.$expand !== 'origin' && (par.items || par).elements;
      if (subElems) {
        const sub = inferred( subElems, par.$inferred );
        if (Object.keys( sub ).length)
          render.elements = sub;
      }
      if (Object.keys(render).length)
        const sub = inferred( subElems, par.$inferred );
      if (Object.keys( sub ).length)
        render.elements = sub;
    }
  }
  return ext;
  */

  // extract namespace/builtin annotations
  function extractAnnotationsToExtension( art ) {
    const name = art.name.absolute;
    // 'true' because annotations on namespaces and builtins can only
    // happen through extensions.
    const annos = annotationsAndDocComment( art, true );
    const annotate = Object.assign( { annotate: name }, annos );
    if (Object.keys( annotate ).length > 1) {
      const loc = locationForAnnotationExtension();
      if (loc)
        location( loc, annotate, art );
      exts.push( annotate );
    }

    // Either the artifact's name's location or (for builtin types) the location
    // of its first annotation.
    function locationForAnnotationExtension() {
      if (art.location)
        return art.location;
      for (const key in art) {
        if (key.charAt(0) === '@' && art[key].name)
          return art[key].name.location;
      }
      return null;
    }
  }
}

/**
 * @param {XSN.i18n} i18nNode
 * @returns {CSN.i18n}
 */
function i18n( i18nNode ) {
  const csn = Object.create( dictionaryPrototype );
  for (const langKey in i18nNode) {
    const langDict = i18nNode[langKey];
    if (!csn[langKey])
      csn[langKey] = Object.create( dictionaryPrototype );
    for (const textKey in langDict)
      csn[langKey][textKey] = langDict[textKey].val;
  }
  return csn;
}

function sources( srcDict, csn ) {
  const names = Object.keys( srcDict );
  const $sources = names.length && srcDict[names[0]].$sources;
  if ($sources) {
    setHidden( csn, '$sources', $sources );
    return undefined;
  }
  // TODO: sort according to some layering order, see #6368
  setHidden( csn, '$sources', (!strictMode) ? names : names.map( relativeName ) );
  return undefined;

  function relativeName( name ) {
    const loc = srcDict[name].location;
    return loc && loc.file || name;
  }
}

function attachAnnotations( annotate, prop, dict, inferred, returns = false ) {
  const annoDict = Object.create( dictionaryPrototype );
  for (const name in dict) {
    const elem = dict[name];
    const inf = inferred || elem.$inferred; // is probably always inferred if parent was
    const sub = (inf) ? annotationsAndDocComment( elem, true ) : {};
    if (elem.$expand === 'annotate') {
      if (elem.params)
        attachAnnotations( sub, 'params', elem.params, inf );
      const obj = elem.returns || elem;
      const elems = (obj.items || obj.targetAspect || obj).elements;
      if (elems)
        attachAnnotations( sub, 'elements', elems, inf, elem.returns );
    }
    if (Object.keys( sub ).length)
      annoDict[name] = sub;
  }
  if (Object.keys( annoDict ).length) {
    if (returns)
      annotate.returns = { elements: annoDict };
    else
      annotate[prop] = annoDict;
  }
}

function standard( node ) {
  if (node.$inferred && gensrcFlavor)
    return undefined;
  if (Array.isArray(node))
    return node.map( standard );
  const csn = {};
  // To avoid another object copy, we sort according to the prop names in the
  // XSN input node, not the CSN result node.  Not really an issue...
  const keys = Object.keys( node ).sort( compareProperties );
  for (const prop of keys) {
    const transformer = transformers[prop] || transformers[prop.charAt(0)] || unexpected;
    const sub = transformer( node[prop], csn, node, prop );
    if (sub !== undefined)
      csn[prop] = sub;
  }
  return csn;
}

function unexpected( val, csn, node, prop ) {
  if (strictMode) {
    const loc = val && val.location || node.location;
    throw new Error( `Unexpected property ${ prop } in ${ locationString(loc) }` );
  }
  // otherwise, just ignore the unexpected property
}

function set( prop, csn, node ) {
  const val = node[prop];
  if (val === undefined)
    return;
  const sub = transformers[prop]( node[prop], csn, node, prop );
  if (sub !== undefined)
    csn[prop] = sub;
}

function targetAspect( val, csn, node ) {
  const ta = (val.elements)
    ? addLocation( val.location, standard( val ) )
    : artifactRef( val, true );
  if (!gensrcFlavor || node.target && !node.target.$inferred)
    return ta;
  // For compatibility, put aspect in 'target' with parse.cdl and csn flavor 'gensrc'
  csn.target = ta;
  return undefined;
}

function target( val, _csn, node ) {
  if (gensrcFlavor && node._origin && node._origin.$inferred === 'REDIRECTED')
    val = node._origin.target;
  if (val.elements)
    return standard( val );       // elements in target (parse-cdl)
  if (!universalCsn || node.on)
    return artifactRef( val, true );
  const tref = artifactRef( val, true );
  const proto = node.type && !node.type.$inferred ? node.type._artifact : node._origin;
  return (proto && proto.target && artifactRef( proto.target, true ) === tref)
    ? undefined
    : tref;
}

function items( obj, csn, node ) {
  if (!keepElements( node ))
    return undefined;
  return standard( obj );   // no 'elements' with inferred elements with gensrc
}

function elements( dict, csn, node ) {
  if (node.from ||              // do not directly show query elements here
      gensrcFlavor && (node.query || node.type) ||
      !keepElements( node ))
    // no 'elements' with SELECT or inferred elements with gensrc;
    // hidden or visible 'elements' will be set in query()
    return undefined;
  return insertOrderDict( dict );
}

function enumerableQueryElements( select ) {
  if (!universalCsn || select === select._main._leadingQuery)
    return false;
  if (select.orderBy || select.$orderBy)
    return true;
  const alias = select._parent;
  return alias.query && (alias.query._leadingQuery || alias.query) === select;
}

// Should we render the elements?  (and items?)
function keepElements( node ) {
  if (universalCsn)
    // $expand = null/undefined: not elements not via expansion
    // $expand = 'target'/'annotate': with redirections / individual annotations
    return node.$expand !== 'origin';
  if (!node.type || node.kind === 'type')
    return true;
  // even if expanded elements have no new target or direct annotation,
  // they might have got one via propagation – any new target/annos during their
  // way from the original structure type definition to the current usage
  while (node) {
    if (node.$expand !== 'origin')
      return true;
    node = node._origin;
  }
  // all in _origin chain only have expanded elements with 'origin':
  return false;                 // no need to render elements
}

// for gensrcFlavor and namespace/builtin annotation extraction:
// return annotations from definition (annotated==false)
// or annotations (annotated==true)
function annotationsAndDocComment( node, annotated ) {
  const csn = {};
  const transformer = transformers['@'];
  const keys = Object.keys( node ).filter( a => a.charAt(0) === '@' ).sort();
  for (const prop of keys) {
    const val = node[prop];
    // val.$priority isn't set for computed annotations like @Core.Computed
    // and @odata.containment.ignore
    if (val.$priority && (val.$priority !== 'define') === annotated) {
      // transformer (= value) takes care to exclude $inferred annotation assignments
      const sub = transformer( val );
      // As value() just has one value, so we do not provide ( val, csn, node, prop )
      // which would be more robust, but makes some JS checks unhappy
      if (sub !== undefined)
        csn[prop] = sub;
    }
  }
  if (node.doc)
    csn.doc = transformers.doc(node.doc);
  return csn;
}

const specialDollarValues = {
  ':': undefined,
  udf: 'udf',
  calcview: 'calcview',
};

function dollarSyntax( node, csn ) {
  // eslint-disable-next-line no-prototype-builtins
  if (specialDollarValues.hasOwnProperty( node ))
    return specialDollarValues[node];
  if (projectionAsQuery)
    return node;
  setHidden( csn, '$syntax', node );
  return undefined;
}

function ignore() { /* no-op: ignore property */ }

function location( loc, csn, xsn ) {
  if (xsn.kind && xsn.kind.charAt(0) !== '$' && xsn.kind !== 'select' &&
      (!xsn.$inferred || !xsn._main)) { // TODO: also for 'select'
    // Also include $location for elements in queries (if not via '*')
    addLocation( xsn.name && xsn.name.location || loc, csn );
  }
}

/**
 * Adds the given location to the CSN.
 *
 * @param {CSN.Location} loc
 * @param {object} csn
 */
function addLocation( loc, csn ) {
  if (loc) {
    // Remove endLine/endCol:
    // Reasoning: $location is mostly attached to definitions/members but the name
    // is often not the reason for an error or warning.  So we gain little benefit for
    // two more properties.
    const val = { file: loc.file, line: loc.line, col: loc.col };
    Object.defineProperty( csn, '$location', {
      value: val, configurable: true, writable: true, enumerable: withLocations,
    } );
  }
  return csn;
}

function insertOrderDict( dict ) {
  const keys = Object.keys( dict );
  return dictionary( dict, keys );
}

function sortedDict( dict ) {
  const keys = Object.keys( dict );
  if (strictMode)
    keys.sort();
  return dictionary( dict, keys );
}

function actions( dict ) {
  const keys = Object.keys( dict );
  return (keys.length)
    ? dictionary( dict, keys, 'actions' )
    : undefined;
}

function dictionary( dict, keys, prop ) {
  const csn = Object.create( dictionaryPrototype );
  for (const name of keys) {
    const def = definition( dict[name], null, null, prop );
    if (def !== undefined)
      csn[name] = def;
  }
  return csn;
}

function foreignKeys( dict, csn, node ) {
  if (universalCsn && !target( node.target, csn, node ))
    return;
  if (gensrcFlavor && node._origin && node._origin.$inferred === 'REDIRECTED')
    dict = node._origin.foreignKeys;
  const keys = [];
  for (const n in dict) {
    const d = definition( dict[n] );
    if (d !== undefined)
      keys.push( d );
    else
      return;
  }
  csn.keys = keys;
}

function definition( art, _csn, _node, prop ) {
  if (!art || typeof art !== 'object')
    return undefined;           // TODO: complain with strict
  // Do not include namespace definitions or inferred construct (in gensrc):
  if (art.kind === 'namespace' || art.$inferred && gensrcFlavor)
    return undefined;
  if (art.kind === 'key') {      // foreignkey
    const key = addExplicitAs( { ref: art.targetElement.path.map( pathItem ) },
                               art.name, neqPath( art.targetElement ) );
    addLocation( art.targetElement.location, key );
    return extra( key, art );
  }
  const c = standard( art );
  // The XSN of actions in extensions do not contain a returns yet - TODO?
  const elems = c.elements;
  if (elems && (prop === 'actions' || art.$syntax === 'returns')) {
    delete c.elements;
    c.returns = { elements: elems };
  }
  return c;
}

function addOrigin( csn, xsn ) {
  if (!universalCsn)
    return csn;
  if (xsn._from) {
    csn.$origin = originRef( xsn._from[0]._origin );
  }
  else if (xsn.includes && xsn.includes.length > 1) {
    csn.$origin = { $origin: originRef( xsn.includes[0]._artifact ) };
  }
  else if (xsn._origin && !hasExplicitProp( xsn.type ) && xsn._origin.kind !== 'builtin') {
    let origin = xsn._origin;
    while (origin._parent && origin._parent.$expand === 'origin')
      origin = origin._origin || origin.type._artifact;
    csn.$origin = originRef( origin );
  }
  return csn;
}

function hasExplicitProp( ref ) {
  return ref && !ref.$inferred;
}

function originRef( art ) {
  const r = [];
  // do not use name.element, as we allow `.`s in name
  let main = art;
  while (main._main && main.kind !== 'select') {
    const nkind = normalizedKind[main.kind];
    if (main.name.id || !r.length) // { param: "" } only for return, not elements inside
      r.push( nkind ? { [nkind]: main.name.id } : main.name.id );
    main = main._parent;
  }
  if (main._main)    // well, an element of an query in FROM
    return definition( art );   // use $origin: {}
  // for sub query in FROM in sub query in FROM, we could condense the info
  r.push( art.name.absolute );
  r.reverse();
  return r;
}

function kind( k, csn, node ) {
  if (k === 'annotate' || k === 'extend') {
    // We just use `name.absolute` because it is very likely a "constructed"
    // extensions.  The CSN parser must produce name.path like for other refs.
    if (!node._main)
      csn[k] = node.name.absolute || artifactRef( node.name, true );
    else if (k === 'extend')
      csn.kind = k;
  }
  else {
    if (![
      'element', 'key', 'param', 'enum', 'select', '$join',
      '$tableAlias', 'annotation', 'mixin',
    ].includes(k))
      csn.kind = k;
    addOrigin( csn, node );
  }
}

function type( node, csn, xsn ) {
  if (universalCsn && node.$inferred && xsn._origin)
    return undefined;
  return artifactRef( node, !node.$extra );
}

function artifactRef( node, terse ) {
  // When called as transformer function, a CSN node is provided as argument
  // for `terse`, i.e. it is usually truthy, except for FROM
  if (node.$inferred && gensrcFlavor)
    return undefined;
  // Works also on XSN directly coming from parser and with XSN from CDL->CSN transformation
  const { path } = node;
  if (terse && node._artifact && !node._artifact._main)
    return node._artifact.name.absolute;
  if (!path)
    return undefined;           // TODO: complain with strict
  else if (!path.length)
    return [];

  const link = path[0]._artifact; // XSN TODO: store double definitions differently
  const root = Array.isArray(link) ? link[0] : link;
  if (!root) {                  // XSN directly coming from the parser
    if (strictMode && node.scope === 'typeOf')
      throw new Error( `Unexpected TYPE OF in ${ locationString(node.location) }`);
    return renderArtifactPath( node, path, terse, node.scope );
  }
  const { absolute } = root.name;
  if (node.scope !== 'typeOf' && typeof node.scope !== 'number') {
    // CSN input or generated in compiler (XSN TODO: remove scope:'global')
    if (absolute === path[0].id) // normal case (no localization view)
      return renderArtifactPath( node, path, terse );
    // scope:param is not valid (and would be lost)
    const head = Object.assign( {}, path[0], { id: absolute } );
    return renderArtifactPath( node, [ head, ...path.slice(1) ], terse );
  }
  if (node.scope === 'typeOf') { // TYPE OF without ':' in path
    // Root _artifact which is either element or main artifact for paths starting with $self.
    // To make the CDL->CSN transformation simpler, the _artifact for first item could be
    // a fake element with just a correct absolute name and  _parent/_main links.
    if (!root._main || root.kind === 'select') { // $self/$projection
      // in query, only correct for leading query ->
      // TODO: forbid TYPE OF elem / TYPE OF $self.elem in queries
      return renderArtifactPath( node, [ { id: absolute }, ...path.slice(1) ], terse );
    }
    const parent = root._parent;
    const structs = parent.name.element ? parent.name.element.split('.') : [];
    return extra( { ref: [ absolute, ...structs, ...path.map( pathItem ) ] }, node );
  }
  let { scope } = node;
  if (!scope) {                 // no ':' in CDL path - try to be nice and guess it via links
    const { length } = path;
    for (; scope < length; ++scope) {
      const art = path[scope]._artifact;
      if (!art) {
        scope = 0;              // unsuccessful, not all path items have links
        break;
      }
      if (art._main)
        break;                  // successful, found first element
    }
  }
  const head = Object.assign( {}, path[0], { id: absolute } );
  return renderArtifactPath( node, [ head, ...path.slice(1) ], terse, scope );
}

function renderArtifactPath( node, path, terse, scope ) {
  if (scope === 0) {
    // try to find ':' position syntactically for FROM
    scope = !terse && path.findIndex( i => i.where || i.args || i.cardinality) + 1 ||
            path.length;
  }
  if (typeof scope === 'number' && scope > 1) {
    const item = path[scope - 1];
    const name = item._artifact && item._artifact.name;
    // In localization views, the _artifact link of `item` is important
    const id = name && name.absolute ||
               path.slice( 0, scope ).map( i => i.id ).join('.');
    path = [ Object.assign( {}, item, { id } ), ...path.slice( scope ) ];
  }
  const ref = path.map( pathItem );
  return (!terse || ref.length !== 1 || typeof ref[0] !== 'string')
    ? extra( { ref }, node )
    : ref[0];
}

function pathItem( item ) {
  if (!item.args &&
      !item.where &&
      !item.cardinality &&
      !item.$extra &&
      !item.$syntax)
    return item.id;
  return standard( item );
}

function args( node ) {
  if (Array.isArray(node))
    return node.map( expression );
  const dict = Object.create( dictionaryPrototype );
  for (const param in node)
    dict[param] = expression( node[param], true );
  return dict;
}

function value( node ) {
// "Short" value form, e.g. for annotation assignments
  if (!node)
    return true;                // `@aBool` short for `@aBool: true`
  if (universalCsn && node.$inferred === 'prop') // via propagator.js
    return undefined;
  if (node.$inferred && gensrcFlavor)
    return undefined;
  if (node.path) {
    const ref = node.path.map( id => id.id ).join('.');
    return extra( { '=': node.variant ? `${ ref }#${ node.variant.id }` : ref }, node );
  }
  if (node.literal === 'enum')
    return extra( { '#': node.sym.id }, node );
  if (node.literal === 'array')
    return node.val.map( value );
  if (node.literal === 'token' && node.val === '...')
    return extra( { '...': true } );
  if (node.literal !== 'struct')
    // no val (undefined) as true only for annotation values (and struct elem values)
    return node.name && !('val' in node) || node.val;
  const r = Object.create( dictionaryPrototype );
  for (const prop in node.struct)
    r[prop] = value( node.struct[prop] );
  return r;
}

function enumValue( v, csn, node ) {
  // Enums can have values but if enums are extended, their kind is 'element',
  // so we check whether the node is inside an extension.
  if (node.kind === 'enum' || node._parent && node._parent.kind === 'extend')
    Object.assign( csn, expression( v, true ) );
}


function onCondition( cond, csn, node ) {
  if (gensrcFlavor) {
    if (node._origin && node._origin.$inferred === 'REDIRECTED')
      cond = node._origin.on;
    else if (cond.$inferred)
      return undefined;
  }
  return condition( cond );
}

function condition( node ) {
  const expr = expression( node );
  // we do not set a hidden $parens on array - we could still do it if requested
  return !expr.cast && !expr.func && expr.xpr || [ expr ];
}

function expression( node, dollarExtra ) {
  const dollarExtraNode = dollarExtra !== 'ignoreExtra' && node;
  if (typeof node === 'string')
    return node;
  if (!node)                    // make to-csn robst
    return {};
  if (node.scope === 'param') {
    if (node.path)
      return extra( { ref: node.path.map( pathItem ), param: true }, dollarExtraNode );
    return { ref: [ node.param.val ], param: true }; // CDL rule for runtimes
  }
  if (node.path) {
    // we would need to consider node.global here if we introduce that
    return extra( { ref: node.path.map( pathItem ) }, dollarExtraNode );
  }
  if (node.literal) {
    if (typeof node.val === node.literal || node.val === null)
      return extra( { val: node.val }, dollarExtraNode );
    else if (node.literal === 'enum')
      return extra( { '#': node.sym.id }, dollarExtraNode );
    else if (node.literal === 'token')
      return node.val;          // * in COUNT(*)
    return extra( { val: node.val, literal: node.literal }, dollarExtraNode );
  }
  if (node.func) {              // TODO XSN: remove op: 'call', func is no path
    const call = { func: node.func.path[0].id };
    if (node.args) {       // no args from CSN input for CURRENT_DATE etc
      call.args = args( node.args );
      const arg0 = call.args[0];
      const { quantifier } = node.func.path[0];
      if (arg0 && quantifier) {
        if (typeof arg0 !== 'object' || !arg0.xpr)
          call.args[0] = { xpr: [ quantifier.val, arg0 ] };
        else
          arg0.xpr.unshift( quantifier.val );
      }
    }
    if (node.suffix)
      call.xpr = [].concat( ...node.suffix.map( xprArg ) );
    return extra( call, dollarExtraNode );
  }
  if (node.query)
    return query( node.query, null, null, null, 1 );
  if (!node.op)                 // parse error
    return { xpr: [] };
  else if (node.op.val === 'xpr')
    // do not use xpr() for xpr, as it would flatten inner xpr's
    return extra({ xpr: node.args.map( expression ) }, dollarExtraNode, 1 );
  else if (node.op.val === 'cast')
    return cast( expression( node.args[0] ), dollarExtraNode );
  // from here on: CDL input (no $extra possible - but $parens)
  else if (node.op.val !== ',')
    return extra( { xpr: xpr( node ) }, dollarExtraNode, (dollarExtra === 'sub-xpr' ? 1 : 0) );
  return (parensAsStrings)
    ? { xpr: [ '(', ...xpr( node ), ')' ] }
    // the inner parens belong to the tuple construct, i.e. won't count as parens
    : extra( { list: node.args.map( expression ) }, dollarExtraNode, 0 );
}

function xpr( node ) {
  // if (!node.op) console.log(node)
  const op = operators[node.op.val] || node.op.val.split(' ');
  const exprs = node.args.map( xprArg );
  if (op instanceof Function)
    return op( exprs );
  if (node.quantifier)
    op.push( node.quantifier.val );
  if (exprs.length < 2)
    return [ ...op, ...exprs[0] || [] ];
  return exprs[0].concat( ...exprs.slice(1).map( a => [ ...op, ...a ] ) );
}

function xprArg( sub ) {
  const realXpr = sub.op && sub.op.val === 'xpr';
  const expr = expression( sub, 'sub-xpr' );
  // `sort`/`nulls` will be attached to arguments of orderBy
  // which might be either `path`s or `xpr`s
  const sortAndNulls = [];
  if (sub.sort)
    sortAndNulls.push( sub.sort.val );
  if (sub.nulls)
    sortAndNulls.push( ...[ 'nulls', sub.nulls.val ] );
  // return !sub.$parens && !expr.cast && !expr.func && expr.xpr || [ expr ];
  // if parensAsStrings is gone
  if (realXpr || expr.cast || expr.func || !expr.xpr || sub.$parens && !parensAsStrings)
    return [ expr, ...sortAndNulls ];
  else if (sub.$parens && sub.op.val !== ',')
    return [ '(', ...expr.xpr, ')' ];

  expr.xpr.push( ...sortAndNulls );
  return expr.xpr;
}

function ternary( op1, op2 ) {
  return function ternaryOp( exprs ) {
    return (exprs[2])
      ? [ ...exprs[0], ...op1, ...exprs[1], ...op2, ...exprs[2] ]
      : [ ...exprs[0], ...op1, ...exprs[1] ];
  };
}

function postfix( op ) {
  return function postfixOp( exprs ) {
    return [ ...exprs[0], ...op ];
  };
}

function binaryRightParen( op ) {
  return ( exprs ) => {
    const right = exprs[1].length === 1 ? exprs[1][0] : {};
    return (right.xpr || right.list || !right.$parens)
      ? [ ...exprs[0], ...op, ...exprs[1] ]
      : [ ...exprs[0], ...op, { xpr: exprs[1] } ];
  };
}

function query( node, csn, xsn, _prop, expectedParens = 0 ) {
  if (node.op.val === 'SELECT') {
    if (xsn && xsn.query === node && xsn.$syntax === 'projection' &&
       node.from && node.from.path && !projectionAsQuery) {
      csn.projection = standard( node );
      return undefined;
    }
    const select = { SELECT: extra( standard( node ), node, expectedParens ) };
    // one paren pair is not put into XSN - TODO: change that?
    const elems = node.elements;
    if (elems && node._main && node !== node._main._leadingQuery && gensrcFlavor !== true) {
      // Set hidden 'elements' for csnRefs.js.  In select-item subqueries,
      // gensrcFlavor might have been set to 'column' and must be set to the
      // original value 'false' - otherwise no element appears.
      const gensrcSaved = gensrcFlavor;
      try {
        gensrcFlavor = false;
        if (enumerableQueryElements( node ))
          select.SELECT.elements = insertOrderDict( elems );
        else
          setHidden( select.SELECT, 'elements', insertOrderDict( elems ) );
      }
      finally {
        gensrcFlavor = gensrcSaved;
      }
    }
    return addLocation( node.location, select );
  }
  const union = {};
  // for UNION, ... ----------------------------------------------------------
  set( 'op', union, node );
  set( 'quantifier', union, node );
  // set( 'args', union, node ):
  union.args = node.args.map( query );
  set( 'orderBy', union, node );
  set( 'limit', union, node );
  set( '$extra', union, node );
  return addLocation( node.location, { SET: union } );
}

function columns( xsnColumns, csn, xsn ) {
  const csnColumns = [];
  if (xsnColumns) {
    for (const col of xsnColumns) {
      if (col.val === '*')
        csnColumns.push( '*' );
      else
        addElementAsColumn( col, csnColumns );
    }
  }
  else {                        // null = use elements
    for (const name in xsn.elements)
      addElementAsColumn( xsn.elements[name], csnColumns );
  }
  return csnColumns;
}

function excludingDict( xsnDict, csn, xsn ) {
  if (xsn.kind !== 'element')
    csn.excluding = Object.keys( xsnDict );
}

function from( node ) {
  // TODO: can we use the normal standard(), at least with JOIN?
  if (node.join) {
    const join = { join: node.join.val };
    set( 'cardinality', join, node );
    join.args = node.args.map( from );
    set( 'on', join, node );
    return extra( join, node );
  }
  else if (node.query) {
    return addExplicitAs( query( node.query, null, null, null, 1 ), node.name );
  }
  else if (!node._artifact || node._artifact._main) { // CQL or follow assoc
    return extra( addExplicitAs( artifactRef( node, false ), node.name ), node );
  }
  return extra( addExplicitAs( artifactRef( node, false ), node.name, (id) => {
    const name = node._artifact.name.absolute;
    const dot = name.lastIndexOf('.');
    return name.substring( dot + 1 ) !== id;
  }), node );
}

function addElementAsColumn( elem, cols ) {
  if (elem.$inferred === '*')
    return;
  // only list annotations here which are provided directly with definition
  const col = (gensrcFlavor) ? annotationsAndDocComment( elem, false ) : {};
  // with `client` flavor, assignments are available at the element
  const gensrcSaved = gensrcFlavor;

  try {
    gensrcFlavor = gensrcFlavor || 'column';
    set( 'virtual', col, elem );
    set( 'key', col, elem );
    const expr = expression( elem.value, true );
    Object.assign( col, (expr.cast ? { xpr: [ expr ] } : expr) );
    gensrcFlavor = gensrcSaved; // for not having annotations in inline etc
    if (elem.expand)
      col.expand = columns( elem.expand );
    if (elem.inline)
      col.inline = columns( elem.inline );
    gensrcFlavor = gensrcFlavor || 'column';
    if (elem.excludingDict)
      col.excluding = Object.keys( elem.excludingDict );
    // yes, the AS comes after the EXPAND
    addExplicitAs( col, elem.name, neqPath( elem.value ) );
    // elements of sub queries (in expr) are hidden (not set via Object.assign):
    if (!expr.cast && expr.elements)
      setHidden( col, 'elements', expr.elements );
    if (elem.type && !elem.type.$inferred || elem.target && !elem.target.$inferred)
      cast( col, elem );
  }
  finally {
    gensrcFlavor = gensrcSaved;
  }
  if (elem.value && !elem.$inferred) {
    const parens = elem.value.$parens;
    if (parens)
      setHidden( col, '$parens', parens.length );
    addLocation( (parens ? parens[parens.length - 1] : elem.value.location), col );
  }
  cols.push( extra( col, elem ) );
}

function orderBy( node ) {
  const expr = expression( node, 'ignoreExtra' );
  if (node.sort)
    expr.sort = node.sort.val;
  if (node.nulls)
    expr.nulls = node.nulls.val;
  return extra( expr, node );   // extra properties after sort/nulls
}

function extra( csn, node, expectedParens = 0 ) {
  if (node) {
    if (node.$extra)
      Object.assign( csn, node.$extra );
    const parens = (node.$parens ? node.$parens.length : 0);
    if (parens !== expectedParens)
      setHidden( csn, '$parens', parens );
  }
  return csn;
}

function cast( csn, node ) {
  let r = csn;
  if (csn.cast)
    r = { xpr: [ csn ], cast: {} };
  else
    r.cast = {};                // TODO: what about $extra in cast?
  for (const prop of typeProperties)
    set( prop, r.cast, node );
  return r;
}

function setHidden( obj, prop, val ) {
  Object.defineProperty( obj, prop, {
    value: val, configurable: true, writable: true, enumerable: false,
  } );
}

function addExplicitAs( node, name, implicit ) {
  if (name && name.id &&
      (!name.$inferred || !node.ref && !node.func || implicit && implicit(name.id) ))
    node.as = name.id;
  return node;
}

function neqPath( ref ) {
  const path = ref && (ref.path || !ref.args && ref.func && ref.func.path);
  return function test( id ) {
    const last = path && path[path.length - 1];
    return !last || last.id !== id;
  };
}

const annoOrder = propertyOrder['@'];

// Usually sort according to the "natural" property order; sort annotations
// alphabetically with --test-mode and "as set" (fragile, node >=12) without.
function compareProperties( a, b ) {
  if (a === b)
    return 0;
  const oa = propertyOrder[a] || propertyOrder[a.charAt(0)] || 9999;
  const ob = propertyOrder[b] || propertyOrder[b.charAt(0)] || 9999;
  return oa - ob || (strictMode || oa !== annoOrder || 0) && (a < b ? -1 : 1);
}

function compactQuery( q ) {    // TODO: options
  initModuleVars();
  return q && query( q );
}

function compactExpr( e ) {     // TODO: options
  initModuleVars();
  return e && expression( e, true );
}

function initModuleVars( options = { csnFlavor: 'gensrc' } ) {
  gensrcFlavor = options.parseCdl || options.csnFlavor === 'gensrc' ||
                 options.toCsn && options.toCsn.flavor === 'gensrc';
  universalCsn = (options.csnFlavor === 'universal' ||
                  options.toCsn && options.toCsn.flavor === 'universal' ) &&
    isBetaEnabled( options, 'enableUniversalCsn' ) && !options.parseCdl;
  strictMode = options.testMode;
  const proto = options.dictionaryPrototype;
  // eslint-disable-next-line no-nested-ternary
  dictionaryPrototype = (typeof proto === 'object') // including null
    ? proto
    : (proto) ? Object.prototype : null;
  withLocations = options.withLocations;
  parensAsStrings = isDeprecatedEnabled( options, 'parensAsStrings' );
  projectionAsQuery = isDeprecatedEnabled( options, 'projectionAsQuery' );
}

module.exports = {
  cloneCsnDictionary: (csn, options) => csnDictionary(csn, false, options),
  compactModel,
  compactQuery,
  compactExpr,
  sortCsn,
  csnDictionaries,
  csnDirectValues,
};
