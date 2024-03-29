// CSN frontend - transform CSN into XSN


// TODO: re-check extensions handling - set kind early!, ...
// TODO: restrict 'actions' etc better in annotate statements - also/only consider parent property!
// TODO: extend E { extend elem { extend sub } }

'use strict';

/**
 * Overview of properties in schema specifications (values in 'schema' dictionary):
 *
 * @typedef {object} SchemaSpec
 * @property {TransformerFunction}   [type] Transformation and test function (i.e. type). The first
 *                                          four arguments are the same for all functions. Further
 *                                          ones may be accepted as well.
 * @property {string}               [class] A schemaClass. Possible values are keys of the variable
 *                                          "schemaClasses". Essentially all properties of the class
 *                                          are copied.
 * @property {Function}           [arrayOf] Alternative to "type". The property should be an array.
 *                                          Value is passed to arrayOf().
 *                                          Value is ignored if "type" is set. Then it is only used
 *                                          for better error messages.
 * @property {Function}      [dictionaryOf] Alternative to "type". The property should be an object
 *                                          in dictionary form (i.e. Object.<string, type>).
 *                                          Value is passed to dictionaryOf().
 *                                          Value is ignored if "type" is set. Then it is only used
 *                                          for better error messages.
 * @property {Object.<string, SchemaSpec>} [schema] If some sub-properties have a different
 *                                                  semantic in this property than the default then
 *                                                  switch the currently used spec to this value.
 * @property {string}                [prop] Name of the property. compileSchema() sets it to the
 *                                          dictionary key by default.
 * @property {string}             [msgProp] Display name of the property. compileSchema() sets it to
 *                                          the dictionary key (+ optional '[]') by default.
 * @property {string}               [msgId] Use this message id instead of the default one.
 *                                          Allows more precise and detailed error messages.
 * @property {string|string[]|false} [requires] If the value is a string, then the given sub-
 *                                              property is required. If 'undefined', then at
 *                                              least one property is required. If false the no
 *                                              sub-properties are required.
 * @property {boolean}           [noPrefix] Only used for '#' at the moment. Signals that the entry
 *                                          should not be used for keys like '#key'. getSchema(...)
 *                                          normally checks if schema[prop] exists and if not,
 *                                          checks for schema[prop.charAt(0)]. This is intended for
 *                                          annotations and similar (which start with special
 *                                          characters).
 * @property {boolean}             [ignore] Don't issue warnings.
 * @property {string[]}          [optional] Optional sub-properties that may be used. Warnings are
 *                                          issued if unknown properties are set.
 * @property {string}         [defaultKind] Default kind for sub-elements, e.g. objects in
 *                                          "elements".
 * @property {string[]|Function}   [inKind] Specifies in what definition type this property may
 *                                          be used, e.g. "virtual" may only be used for elements.
 *                                          If it is a function then it takes two arguments "kind"
 *                                          and "parentSpec" should return a boolean
 * @property {string[]}        [validKinds] What "kind" values are possible in a definition. The
 *                                          root "definitions" properties allows more kinds than
 *                                          e.g. definitions inside "elements".
 * @property {string|string[]}   [onlyWith] Defines that the property *must* be used with these
 *                                          properties.
 * @property {number}           [minLength] Minimum number of elements that an array must have.
 * @property {boolean}            [inValue] Puts the value into an XSN property "value",
 *                                          e.g. { value: ... }
 * @property {string}            [xorGroup] Corresponding xor group. It references a value of
 *                                          $xorGroups. If set then only one property of of the
 *                                          xorGroup may be set, e.g. if target is set, elements
 *                                          may not.
 * @property {string}               [xsnOp] Defines the operator to be used for XSN. Used for SET
 *                                          and SELECT. See queryTerm().
 * @property {string|false}      [vZeroFor] Marks the property as a CSN 0.1.0 property. It is
 *                                          replaced by this CSN 1.0 property (value of vZeroFor).
 *                                          "false" indicates that the property may be a v0.1 one
 *                                          which is handled specially, e.g. with "type:vZeroValue"
 * @property {string}         [vZeroIgnore] Marks the property as a CSN 0.1.0 property. The
 *                                          property is ignored and a warning may be issues about
 *                                          it.
 */

/**
 * @typedef {Function} TransformerFunction
 * @param {object} obj
 * @param {object} xsn
 * @param {object} csn
 * @param {object} prop
 * @param {...any} any Further arguments.
 * @returns {any} XSN property (e.g. string, object, ...)
 */

const { dictAdd } = require('../base/dictionaries');

let inExtensions = null;

let vocabInDefinitions = null;  // must be reset!

// CSN property names reserved for CAP
const ourpropsRegex = /^[_$]?[a-zA-Z]+[0-9]*$/;

// Sync with definition in to-csn.js:
const typeProperties = [
  // do not include CSN v0.1.0 properties here:
  'target', 'elements', 'enum', 'items',
  'type', 'length', 'precision', 'scale', 'srid', 'localized', 'notNull',
  'keys', 'on',                 // only with 'target'
];
const exprProperties = [
  // do not include CSN v0.1.0 properties here:
  'ref', 'xpr', 'list', 'val', '#', 'func', 'SELECT', 'SET', // Core Compiler checks SELECT/SET
  'param', 'global', 'literal', 'args', 'cast', // only with 'ref'/'ref'/'val'/'func'
];

// Groups of properties which cannot be used together:
const xorGroups = {
  // include CSN v0.1.0 properties here:
  ':type': [ 'target', 'elements', 'enum', 'items' ],
  ':expr': [
    'ref', 'xpr', 'list', 'val', '#', 'func', 'SELECT', 'SET',
    '=', 'path', 'value', 'op', // '='/'path' is CSN v0.1.0 here
  ],
  ':ext': [ 'annotate', 'extend' ], // TODO: better msg for test/negative/UnexpectedProperties.csn
  ':assoc': [ 'on', 'keys', 'foreignKeys', 'onCond' ], // 'foreignKeys'/'onCond' is CSN v0.1.0
  ':join': [ 'join', 'as' ],
  scope: [ 'param', 'global' ],
  quantifier: [ 'some', 'any', 'distinct', 'all' ],
  // quantifiers 'some' and 'any are 'xpr' token strings in CSN v1.0
};

// Functions reading properties which do no count for the message
// 'Object in $(PROP) must have at least one property'
const functionsOfIrrelevantProps = [ ignore, extra, explicitName ];

const schemaClasses = {
  condition: {
    arrayOf: exprOrString,
    type: condition,
    msgId: 'syntax-csn-expected-term',
    // TODO: also specify requires here, and adapt onlyWith()
    optional: exprProperties,
  },
  expression: {
    type: expr,
    optional: exprProperties,
  },
  natnumOrStar: {
    type: natnumOrStar,
    msgId: 'syntax-csn-expected-cardinality',
  },
  columns: {
    arrayOf: selectItem,
    msgId: 'syntax-csn-expected-column',
    defaultKind: '$column',
    validKinds: [], // pseudo kind '$column'
    requires: [ 'ref', 'xpr', 'val', '#', 'func', 'list', 'SELECT', 'SET', 'expand' ],
    schema: {
      xpr: {
        class: 'condition',
        type: xprInValue,
        inKind: [ '$column' ],
        inValue: true,
      },
    },
  },
};

// TODO: also have stricter tests for strings in in xpr/args, join, op, sort, nulls ?

const schema = compileSchema( {
  requires: {
    type: renameTo( 'dependencies', arrayOf( stringVal, val => (val.literal === 'string') ) ),
  },
  i18n: {
    dictionaryOf: i18nLang,
  },
  // definitions: ------------------------------------------------------------
  definitions: {
    dictionaryOf: definition,
    defaultKind: 'type',
    validKinds: [
      'entity', 'type', 'aspect', 'action', 'function', 'context', 'service', 'event', 'annotation',
    ],
    // requires: { entity: ['elements', 'query', 'includes'] } - not, make it work w/o elements
  },
  vocabularies: {
    dictionaryOf: definition,
    defaultKind: 'annotation',
    validKinds: [],
  },
  extensions: {
    arrayOf: definition,
    defaultKind: 'annotate',
    validKinds: [],             // use annotate/extend instead of kind
    requires: [ 'extend', 'annotate' ],
  },
  enum: {
    dictionaryOf: definition,
    defaultKind: 'enum',
    validKinds: [ 'enum' ],
    inKind: [ 'element', 'type', 'param', 'annotation', 'annotate' ],
  },
  elements: {
    dictionaryOf: definition,
    defaultKind: 'element',
    validKinds: [ 'element' ],
    inKind: [
      'element',
      'type',
      'aspect',
      'entity',
      'param',
      'annotation',
      'event',
      'annotate',
      'extend',
    ],
  },
  payload: {                    // keep it for a while, TODO: remove with v2 - at least warning
    dictionaryOf: definition,   // duplicate of line below only for better error message
    type: renameTo( 'elements', dictionaryOf( definition ) ),
    defaultKind: 'element',
    validKinds: [],
    inKind: [ 'event' ],
  },
  actions: {
    dictionaryOf: definition,
    defaultKind: 'action',
    validKinds: [ 'action', 'function' ],
    inKind: [ 'entity', 'annotate', 'extend' ],
  },
  params: {
    dictionaryOf: definition,
    defaultKind: 'param',
    validKinds: [ 'param' ],
    inKind: [ 'entity', 'action', 'function', 'annotate' ], // TODO: 'extend'?
  },
  mixin: {
    dictionaryOf: definition,
    defaultKind: 'mixin',
    validKinds: [],
  },
  columns: {
    class: 'columns',
    inKind: [ 'extend' ], // only valid in extend and SELECT/projection
  },
  expand: {
    class: 'columns',
    inKind: [ '$column' ], // only valid in $column
  },
  inline: {
    class: 'columns',
    inKind: [ '$column' ], // only valid in $column
  },
  keys: {
    arrayOf: definition,
    type: keys,
    defaultKind: 'key',
    validKinds: [],
    requires: 'ref',
    onlyWith: 'target',
    inKind: [ 'element', 'type', 'param' ],
  },
  foreignKeys: {                 // CSN v0.1.0 property -> use 'keys'
    vZeroFor: 'keys',
    inKind: [],
    dictionaryOf: definition,
    defaultKind: 'key',
    validKinds: [],
  },
  // kind and name: ----------------------------------------------------------
  kind: {
    type: validKind,
    inKind: (( kind, parentSpec ) => !inExtensions && parentSpec.validKinds.length),
  },
  annotate: {
    type: kindAndName,
    inKind: [ 'annotate' ],
  },
  extend: {
    type: kindAndName,
    inKind: [ 'extend' ],
  },
  as: {
    // remark: 'as' does not count as "relevant" property in standard check that
    // an object has >0 props, see const functionsOfIrrelevantProps.
    type: explicitName,
    inKind: [ '$column', 'key' ],
  },
  // type properties (except: elements, enum, keys, on): ---------------------
  type: {
    type: artifactRef,
    msgId: 'syntax-csn-expected-reference',
    optional: [ 'ref', 'global' ],
    inKind: [ 'element', 'type', 'param', 'mixin', 'event', 'annotation' ],
  },
  targetAspect: {
    type: artifactRef,
    optional: [ 'elements' ], // 'elements' for ad-hoc aspect compositions
    inKind: [ 'element', 'type' ],
  },
  target: {
    type: artifactRef,
    optional: [ 'elements' ], // 'elements' for ad-hoc COMPOSITION OF (gensrc style CSN)
    inKind: [ 'element', 'type', 'mixin', 'param' ],
  },
  cardinality: {                // there is an extra def for 'from'
    type: object,
    optional: [ 'src', 'min', 'max' ],
    inKind: [ 'element', 'type', 'mixin' ],
    onlyWith: [ 'target', 'targetAspect', 'id' ], // also in 'ref[]'
  },
  items: {
    type: object,
    optional: typeProperties, // TODO: think of items: {}, then requires: false
    inKind: [ 'element', 'type', 'param', 'annotation' ],
  },
  localized: {
    type: boolOrNull,
    inKind: [ 'element', 'type', 'param', 'annotation' ],
  },
  length: {
    type: natnum,
    inKind: [ 'element', 'type', 'param', 'annotation' ],
    // we do not require a 'type', too - could be useful alone in a 'cast'
  },
  precision: {
    type: natnum,
    inKind: [ 'element', 'type', 'param', 'annotation' ],
  },
  scale: {
    type: scalenum,
    inKind: [ 'element', 'type', 'param', 'annotation' ],
  },
  srid: {
    type: natnum,
    inKind: [ 'element', 'type', 'param', 'annotation' ],
  },
  srcmin: {                        // in 'cardinality'
    type: renameTo( 'sourceMin', natnum ),
  },
  src: {                        // in 'cardinality'
    class: 'natnumOrStar',
    type: renameTo( 'sourceMax', natnumOrStar ),
  },
  min: {                        // in 'cardinality'
    type: renameTo( 'targetMin', natnum ),
  },
  max: {                        // in 'cardinality'
    class: 'natnumOrStar',
    type: renameTo( 'targetMax', natnumOrStar ),
  },
  sourceMax: {
    class: 'natnumOrStar',
    vZeroFor: 'src',
  },
  targetMin: {
    vZeroFor: 'min',
    type: natnum,
  },
  targetMax: {
    class: 'natnumOrStar',
    vZeroFor: 'max',
  },
  // expression properties (except: SELECT, SET): ----------------------------
  ref: {
    arrayOf: refItem,
    type: renameTo( 'path', arrayOf( refItem ) ),
    msgId: 'syntax-csn-expected-reference',
    minLength: 1,
    requires: 'id',
    optional: [ 'id', 'args', 'cardinality', 'where' ],
    inKind: [ '$column', 'key' ],
  },
  id: {                         // in 'ref' item
    type: string,
  },
  param: {
    type: asScope,              // is bool, stored as string in XSN property 'scope'
    onlyWith: 'ref',
    inKind: [ '$column' ],
  },
  global: {
    type: asScope,              // is bool, stored as string in XSN property 'scope'
    onlyWith: 'ref',
    inKind: [ '$column' ],
  },
  func: {
    type: func,
    inKind: [ '$column' ],
  },
  args: {
    class: 'condition',
    type: args,
    schema: {                   // named arguments cannot directly have a string
      '-named': {               // '-named' and '-' must not exist top-level
        prop: 'args', dictionaryOf: expr, optional: exprProperties,
      },
    },
    onlyWith: [ 'func', 'id', 'op' ],
    inKind: [ '$column' ],
  },
  xpr: {
    class: 'condition',
    type: xpr,
    // special treatment in $column
  },
  list: {
    class: 'condition',
    type: list,
  },
  val: {
    type: value,
    inKind: [ '$column', 'enum', 'element' ],
  },
  literal: {
    type: literal,
    onlyWith: 'val',
    inKind: [ '$column', 'enum' ],
  },
  '#': {
    noPrefix: true,             // schema spec for '#', not for '#whatever'
    type: symbol,
    // Note: We emit a warning if '#' is used in enums.  Because the compiler
    // can generate CSN like this, we need to be able to parse it.
    // Also, in "extensions", an entity's element of type enum has kind "element".
    inKind: [ '$column', 'enum', 'element' ],
  },
  path: {                     // in CSN v0.1.0 'foreignKeys'
    vZeroFor: 'ref',
    inKind: [],
    inValue: true,
    type: vZeroRef,
  },
  '=': {                        // v0.1.0 { "=": "A.B" } for v1.0 { "ref": ["A", "B"] }
    vZeroFor: 'ref',
    inKind: [],                 // still used in annotation assignments...
    type: vZeroRef,             // ...see property '@' / function annotation()
  },
  // primary query properties: -----------------------------------------------
  query: {
    type: embed,
    optional: [ 'SELECT', 'SET' ],
    inKind: [ 'entity', 'event' ],
  },
  projection: {
    type: queryTerm,
    xsnOp: 'SELECT',
    requires: 'from',
    optional: [
      'from', 'all', 'distinct', 'columns', 'excluding', // no 'mixin'
      'where', 'groupBy', 'having', 'orderBy', 'limit',
    ],
    inKind: [ 'entity', 'event' ],
  },
  SELECT: {
    type: queryTerm,
    xsnOp: 'SELECT',
    requires: 'from',
    optional: [
      'from', 'mixin', 'all', 'distinct', 'columns', 'excluding',
      'where', 'groupBy', 'having', 'orderBy', 'limit', 'elements',
    ],
    inKind: [ '$column' ],
    schema: {
      elements: {
        dictionaryOf: definition,
        type: ( ...a ) => {
          dictionaryOf( definition )( ...a );
        },                      // ignore, but test
        defaultKind: 'element',
        validKinds: [ 'element' ],
      },
    },
  },
  SET: {
    type: queryTerm,
    xsnOp: '$query',            // might be overwritten by 'op'
    requires: 'args',
    optional: [ 'op', 'all', 'distinct', 'args', 'orderBy', 'limit' ],
    schema: {
      args: {
        arrayOf: embed,         // like query
        type: queryArgs,
        minLength: 1,
        optional: [ 'SELECT', 'SET' ],
      },
    },
    inKind: [ '$column' ],
  },
  op: {                                   // used for UNION etc in CSN v1.0
    vZeroFor: 'xpr',
    vZeroIgnore: 'call', // is also used in CSN v0.1.0 for "normal" expressions
    type: setOp,
    onlyWith: 'args',
  },
  join: {
    type: join,                 // string like 'cross' - TODO: test for valid ones?
  },
  from: {
    type: object,
    optional: [ 'ref', 'global', 'join', 'cardinality', 'args', 'on', 'SELECT', 'SET', 'as' ],
    schema: {
      cardinality: {
        type: object,
        optional: [ 'srcmin', 'src', 'min', 'max' ],
        onlyWith: 'join',
      },
      args: {
        arrayOf: object,
        minLength: 2,
        optional: [ 'ref', 'global', 'join', 'cardinality', 'args', 'on', 'SELECT', 'SET', 'as' ],
        onlyWith: 'join',
        schema: {},             // 'args' in 'args' in 'from' is same as 'args' in 'from'
      },
    },
  },
  some: { type: asQuantifier }, // probably just CSN v0.1.0
  any: { type: asQuantifier },  // probably just CSN v0.1.0
  distinct: { type: asQuantifier },
  all: { type: asQuantifier },
  // further query properties: -----------------------------------------------
  excluding: {
    inKind: [ '$column' ],
    arrayOf: string,
    type: excluding,
  },
  on: {
    class: 'condition',
    onlyWith: [ 'target', 'join' ],
    inKind: [ 'element', 'mixin' ],
  },
  onCond: {
    vZeroFor: 'on',
    inKind: [],
    type: renameTo( 'on', expr ),
    optional: exprProperties,
  },
  where: {
    class: 'condition',
  },
  groupBy: {
    arrayOf: expr, optional: exprProperties,
  },
  having: {
    class: 'condition',
  },
  orderBy: {
    arrayOf: expr, optional: [ 'sort', 'nulls', ...exprProperties ],
  },
  sort: {
    type: stringVal,
  },
  nulls: {
    type: stringVal,            // TODO: test for valid ones?
  },
  limit: {
    type: object, requires: 'rows', optional: [ 'rows', 'offset' ],
  },
  rows: {
    class: 'expression',
  },
  offset: {
    class: 'expression',
  },
  // miscellaneous properties in definitions: --------------------------------
  doc: {
    type: stringValOrNull,
    inKind: () => true,         // allowed in all definitions (including columns and extensions)
  },
  '@': {                        // for all properties starting with '@'
    prop: '@<anno>',            // which property name do messages use for annotation assignments?
    type: annotation,
    inKind: () => true,         // allowed in all definitions (including columns and extensions)
  },
  abstract: {                   // v1: with 'abstract', an entity becomes an aspect
    type: ( val, spec ) => boolOrNull( val, spec ) && undefined,
    inKind: [ 'entity', 'aspect' ], // 'aspect' because 'entity' is replaced by 'aspect' early
  },
  key: {
    type: boolOrNull,
    inKind: [ 'element', '$column' ],
  },
  masked: {
    type: boolOrNull,
    inKind: [ 'element' ],
  },
  notNull: {
    type: boolOrNull,
    inKind: [ 'element', 'param' ], // TODO: $column  - or if so: in 'cast'?
  },
  virtual: {
    type: boolOrNull,
    inKind: [ 'element', '$column' ],
  },
  cast: {
    type: embed,
    // cast can be:
    // 1. Inside "columns" => not in value
    // 2. Inside "xpr"     => inside expressions
    // Because of (1) we have to set this property to false.
    inValue: false,
    optional: typeProperties,
    inKind: [ '$column' ],
  },
  default: {
    class: 'expression',
    inKind: [ 'element', 'param', 'type' ],
  },
  includes: {
    arrayOf: stringRef,
    inKind: [ 'entity', 'type', 'aspect', 'event', 'extend' ],
  },
  returns: {
    type: returnsDefinition,
    defaultKind: 'param',
    validKinds: [ 'param' ],
    inKind: [ 'action', 'function', 'annotate' ],
  },
  technicalConfig: {            // treat it like external_property
    type: extra,
    inKind: [ 'entity' ],
  },
  $syntax: {
    type: string,
    ignore: true,
    inKind: [ 'entity', 'type', 'aspect' ],
  },
  origin: {                     // old-style CSN
    type: vZeroDelete, ignore: true,
  },
  source: {                     // CSN v0.1.0 query not supported
    type: ignore,
  },
  value: {
    vZeroFor: false,                // CSN v0.1.0 property, but handled specially
    type: vZeroValue,
    optional: exprProperties,
    inKind: [ '$column', 'enum' ],
  },
  // ignored: ----------------------------------------------------------------
  $location: {                  // special
    ignore: true, type: ignore,
  },
  $generatedFieldName: {
    ignore: true, type: ignore, // TODO: do we need to do something?
  },
  namespace: {
    type: stringRef,
  },
  meta: {                       // meta information
    type: ignore,               // TODO: should we test s/th here?
  },
  version: {                    // deprecated top-level property
    type: ignore,
  },
  messages: {                   // deprecated top-level property
    type: ignore,
  },
  options: {                    // deprecated top-level property
    type: ignore,
  },
  indexNo: {                    // CSN v0.1.0, but ignored without message
    ignore: true, type: ignore,
  },
  // TODO: should we keep $parens ?
  $: { type: ignore, ignore: true }, // including $origin
  _: { type: ignore, ignore: true },
} );

const topLevelSpec = {
  msgProp: '',                  // falsy '' for top-level
  type: object,
  optional: [
    'requires', 'definitions', 'vocabularies', 'extensions', 'i18n',
    'namespace', 'version', 'messages', 'meta', 'options', '@', '$location',
  ],
  requires: false,              // empty object OK
  schema,
};

const validLiteralsExtra = Object.assign( Object.create(null), {
  // TODO: should we use quotedLiteralPatterns from genericAntlrParser?
  number: 'string',
  x: 'string',
  time: 'string',
  date: 'string',
  timestamp: 'string',
} );

// Module variables, schema compilation, and functors ------------------------

/** @type {(id, location, textOrArguments, texts?) => void} */
// eslint-disable-next-line no-unused-vars
let message = (_id, loc, textOrArguments, texts) => undefined;
/** @type {(id, location, textOrArguments, texts?) => void} */
// eslint-disable-next-line no-unused-vars
let error = (id, loc, textOrArguments, texts) => undefined;
/** @type {(id, location, textOrArguments, texts?) => void} */
// eslint-disable-next-line no-unused-vars
let warning = (id, loc, textOrArguments, texts) => undefined;
/** @type {(id, location, textOrArguments, texts?) => void} */
// eslint-disable-next-line no-unused-vars
let info = (id, loc, textOrArguments, texts) => undefined;

let csnVersionZero = false;
let csnFilename = '';
let virtualLine = 1;
/** @type {CSN.Location[]} */
let dollarLocations = [];
let arrayLvlCnt = 0;

/**
 * @param {Object.<string, SchemaSpec>} specs
 * @param {object} [proto]
 * @returns {Object.<string, SchemaSpec>}
 */
function compileSchema( specs, proto = null) {
  // no prototype to protect against evil-CSN properties 'toString' etc.
  const r = Object.assign( Object.create( proto ), specs );
  for (const p of Object.keys( specs )) {
    const s = r[p];
    if (s.class) {
      const scs = schemaClasses[s.class];
      for (const c of Object.keys( scs )) {
        if (s[c] == null)
          s[c] = scs[c];
      }
    }
    if (s.prop == null)
      s.prop = p;
    if (s.msgProp == null)
      s.msgProp = (s.arrayOf || s.dictionaryOf) ? `${ s.prop }[]` : s.prop;
    if (s.schema)
      s.schema = compileSchema( s.schema, r );
    if (!s.type) {
      if (s.arrayOf)
        s.type = arrayOf( s.arrayOf );
      else if (s.dictionaryOf)
        s.type = dictionaryOf( s.dictionaryOf );
      else
        throw new Error( `Missing type specification for property "${ p }"` );
    }
  }
  // Set property 'xorGroup' in main and sub schema:
  for (const group in xorGroups) {
    for (const prop of xorGroups[group]) {
      if (r[prop].xorGroup === undefined)
        r[prop].xorGroup = group;
    }
  }
  if (proto)
    return r;
  for (const prop of exprProperties) {
    if (r[prop].inValue === undefined)
      r[prop].inValue = true;
  }
  return r;
}

function renameTo( xsnProp, fn ) {
  return function renamed( val, spec, xsn, csn ) {
    const r = fn( val, spec, xsn, csn );
    if (r !== undefined)
      xsn[xsnProp] = r;
  };
}

function arrayOf( fn, filter = undefined ) {
  return function arrayMap( val, spec, xsn, csn ) {
    if (!isArray( val, spec ))
      return undefined;
    const r = val.map( (v) => {
      ++virtualLine;
      return fn( v, spec, xsn, csn ) || { location: location() };
    } );
    const minLength = spec.minLength || 0;
    if (minLength > val.length) {
      error( 'syntax-csn-expected-length', location(true),
             { prop: spec.prop, n: minLength, '#': minLength === 1 ? 'one' : 'std' },
             {
               std: 'Expected array in $(PROP) to have at least $(N) items',
               one: 'Expected array in $(PROP) to have at least one item',
             } );
    }
    if (val.length)
      ++virtualLine;          // [] in one JSON line
    if (filter)
      return r.filter(filter);
    return r;
  };
}

// Generic functions, objects (std signature) --------------------------------

function ignore( obj ) {
  if (obj && typeof obj === 'object') {
    const array = (Array.isArray( obj )) ? obj : Object.values( obj );
    if (!array.length)
      return;                   // {}, [] in one JSON line
    virtualLine += 1 + array.length;
    array.forEach( ignore );
  }
}

function embed( obj, spec, xsn ) {
  Object.assign( xsn, object( obj, spec ) ); // TODO: $location?
}

function extra( node, spec, xsn ) {
  if (!xsn.$extra)
    xsn.$extra = Object.create(null);
  xsn.$extra[spec.prop] = node;
}

function eventualCast( obj, spec, xsn ) {
  if (!obj.cast || spec.optional && !spec.optional.includes('cast'))
    return xsn;
  xsn.op = { val: 'cast', location: xsn.location };
  const r = { location: xsn.location };
  xsn.args = [ r ];
  return r;
}

function object( obj, spec ) {
  if (!isObject( obj, spec ))
    return undefined;
  pushLocation( obj );
  const r = { location: location() };
  const xor = {};
  const csnProps = Object.keys( obj );
  const o = eventualCast( obj, spec, r ); // do s/th special for CAST
  let relevantProps = 0;
  if (csnProps.length) {
    ++virtualLine;
    const expected = (p => spec.optional.includes(p));
    for (const p of csnProps) {
      const s = getSpec( spec, obj, p, xor, expected );
      // TODO: count illegal properties with Error msg as relevant to avoid 2nd error
      if (!functionsOfIrrelevantProps.includes( s.type ))
        ++relevantProps;
      const v = (s.inValue) ? o : r;
      const val = s.type( obj[p], s, v, obj, p );
      if (val !== undefined)
        v[p] = val;
      ++virtualLine;
    }
  }
  const { requires } = spec;
  if (requires === undefined || requires === true) {
    // console.log(csnProps,JSON.stringify(spec))
    if (!relevantProps) {
      error( 'syntax-csn-required-subproperty', location(true),
             {
               prop: spec.msgProp,
               '#': (
                 // eslint-disable-next-line no-nested-ternary
                 !csnProps.length ? 'std'
                   : csnProps.length === 1 && csnProps[0] === 'as' ? 'as'
                     : 'relevant'),
             },
             {
               std: 'Object in $(PROP) must have at least one property',
               as: 'Object in $(PROP) must have at least one property other than \'as\'',
               relevant: 'Object in $(PROP) must have at least one relevant property',
             } );
    }
  }
  else if (requires) {
    // console.log(csnProps,JSON.stringify(spec))
    onlyWith( spec, requires, obj, null, xor, () => true );
  }
  popLocation( obj );
  return r;
}

function vZeroDelete( o, spec ) { // for old-CSN property 'origin'
  if (!csnVersionZero) {
    warning( 'syntax-csn-zero-delete', location(true), { prop: spec.msgProp },
             'Delete/inline CSN v0.1.0 property $(PROP)' );
  }
  string( o, spec );
}

// Definitions, dictionaries and arrays of definitions (std signature) -------

function definition( def, spec, xsn, csn, name ) {
  if (!isObject( def, spec )) {
    return {
      kind: (inExtensions ? 'annotate' : spec.defaultKind),
      name: {
        id: '', path: [], absolute: name, location: location(),
      },
      location: location(),
    };
  }
  pushLocation( def );
  const savedInExtensions = inExtensions;
  const kind = calculateKind( def, spec ); // might set inExtensions
  const r = (kind === '$column') ? { location: location() } : { location: location(), kind };
  const xor = {};
  const { prop } = spec;
  const kind0 = (spec.validKinds.length || spec.prop === 'extensions') && kind;
  const csnProps = Object.keys( def );

  if (csnProps.length) {
    const valueName = (prop === 'keys' || prop === 'foreignKeys' ? 'targetElement' : 'value');
    // the next is basically object() + the inValue handling
    ++virtualLine;
    for (const p of csnProps) {
      const s = getSpec( spec, def, p, xor, expected, kind0 );
      const v = !s.inValue && r || r[valueName] || (r[valueName] = { location: location() });
      const val = s.type( def[p], s, v, def, p );
      if (val !== undefined)
        v[p] = val;
      ++virtualLine;
    }
  }
  if (!r.name && name) {
    r.name = { id: name, location: r.location };
    if (prop === 'columns' || prop === 'keys' || prop === 'foreignKeys')
      r.name.$inferred = 'as';
    // TODO the following 'if' (if necessary) should be part of the core compiler
    if (prop === 'definitions' || prop === 'vocabularies') { // as spec property
      // xsn.name.path = name.split('.').map( id => ({ id, location: location() }) );
      r.name = {
        absolute: name,
        id: name.substring( name.lastIndexOf('.') + 1 ),
        path: [ { id: name, location: r.location } ],
        location: r.location,
      };
    }
  }
  if (spec.requires)
    onlyWith( spec, spec.requires, def, null, xor, () => true );

  inExtensions = savedInExtensions;
  popLocation( def );
  if (kind !== 'annotation' || prop === 'vocabularies')
    return r;
  if (!vocabInDefinitions)
    vocabInDefinitions = Object.create(null);
  vocabInDefinitions[name] = r;     // deprecated: anno def in 'definitions'
  return undefined;

  function expected( p, s ) {
    if (!Array.isArray(s.inKind))
      return s.inKind && s.inKind( kind, spec );
    return s.inKind.includes( kind ) &&
      // for an 'annotate', both 'annotate' and the "host" kind must be expected
      (!inExtensions || s.inKind.includes( inExtensions ) ||
       // extending elements in returns can be without 'returns' in CSN
       // TODO: with warning/info?
       inExtensions === 'action' && p === 'elements');
  }
}

// A dictionary is expected. Uses spec.dictionaryOf. If unset, default is "definition".
function dictionaryOf( elementFct ) {
  return function dictionary( dict, spec ) {
    if (!dict || typeof dict !== 'object' || Array.isArray( dict )) {
      error( 'syntax-csn-expected-object', location(true),
             { prop: spec.prop }); // spec.prop, not spec.msgProp!
      return ignore( dict );
    }
    const r = Object.create(null);
    const allNames = Object.keys( dict );
    if (!allNames.length)
      return r;                   // {} in one JSON line
    ++virtualLine;
    for (const name of allNames) {
      if (!name) {
        warning( 'syntax-csn-empty-name', location(true),
                 { prop: spec.prop }, // TODO: Error
                 'Property names in dictionary $(PROP) must not be empty' );
      }
      const val = elementFct( dict[name], spec, r, dict, name );
      if (val !== undefined)
        r[name] = val;
      ++virtualLine;
    }
    return r;
  };
}

function keys( array, spec, xsn ) {
  if (!isArray( array, spec ))
    return;
  const r = Object.create(null);
  ++virtualLine;
  for (const def of array) {
    const id = def.as || implicitName( def.ref );
    const name = (typeof id === 'string') ? id : '';
    // definer will complain about repeated names
    dictAdd( r, name, definition( def, spec, r, array, name ) );
    ++virtualLine;
  }
  xsn.foreignKeys = r;
}

function selectItem( def, spec, xsn, csn ) {
  if (def === '*')              // compile() will complain about repeated '*'s
    return { val: '*', location: location() };

  return definition( def, spec, xsn, csn, null ); // definer sets name
}

function returnsDefinition( def, spec, xsn, csn, name ) {
  // TODO: be stricter in what is allowed inside returns
  if (!inExtensions)
    return definition( def, spec, xsn, csn, name );
  // for the moment, flatten elements in returns in an annotate
  // TODO: bigger Core Compiler changes would have to be done otherwise
  xsn.elements = definition( def, spec, xsn, csn, name ).elements;
  xsn.$syntax = 'returns';
  return undefined;
}

// For v1 CSNs with annotation definitions
function attachVocabInDefinitions( csn ) {
  if (!csn.vocabularies) {
    csn.vocabularies = vocabInDefinitions;
  }
  else {
    for (const name in vocabInDefinitions)
      dictAdd( csn.vocabularies, name, vocabInDefinitions[name] );
  }
}

// Kind, names and references (std signature) --------------------------------

function kindAndName( id, spec, xsn ) {
  const { prop } = spec;
  xsn.kind = prop;              // TODO: set this in definition
  if (!string( id, spec ))
    return;
  xsn.name = { path: [ { id, location: location() } ], location: location() };
}

function explicitName( id, spec, xsn ) {
  if (string( id, spec ))
    xsn.name = { id, location: location() };
}

function validKind( val, spec, xsn ) {
  if (val === xsn.kind)         // has been set in definition - the same = ok!
    return undefined;           // already set in definition
  if (val === 'view' && xsn.kind === 'entity') {
    warning( 'syntax-csn-zero-value', location(true), { prop: spec.msgProp },
             'Replace CSN v0.1.0 value in $(PROP) by something specified' );
  }
  else if ((val === 'entity' || val === 'type') && xsn.kind === 'aspect') {
    info( 'syntax-csn-aspect', location(true), { kind: 'aspect', '#': val },
          {
            std: 'Use the dedicated kind $(KIND) for aspect definitions',
            // eslint-disable-next-line max-len
            entity: 'Abstract entity definitions are deprecated; use aspect definitions (having kind $(KIND)) instead',
          } );
  }
  else {
    error( 'syntax-csn-expected-valid', location(true), { prop: spec.msgProp },
           'Expected valid string for property $(PROP)' );
  }
  return ignore( val );
}

function artifactRef( ref, spec ) {
  if (!ref || typeof ref !== 'string')
    return object( ref, spec );
  if (spec.prop !== 'type' || !csnVersionZero)
    return stringRef( ref, spec );
  // now the CSN v0.1.0 type of: 'Artifact..e1.e2'
  const idx = ref.indexOf('..');
  if (idx < 0)
    return stringRef( ref, spec );
  const r = refSplit( ref.substring( idx + 2 ), spec.msgProp );
  r.path.unshift( { id: ref.substring( 0, idx ), location: location() } );
  return r;
}

function stringRef( ref, spec ) {
  return string( ref, spec ) &&
    { path: [ { id: ref, location: location() } ], location: location() };
}

function refItem( item, spec ) {
  if (typeof item === 'string' && item)
    return { id: item, location: location() };
  return object( item, spec );
}

function asScope( scope, spec, xsn ) {
  if (scope)
    xsn.scope = spec.prop;
  boolOrNull( scope, spec );
}

function vZeroRef( name, spec, xsn ) {
  if (!string( name, spec ))
    return;
  const path = name.split('.');
  if (!path.every( id => id)) {
    warning( 'syntax-csn-expected-name', location(true), { prop: spec.msgProp },
             'Expected correct name for property $(PROP)' );
  }
  xsn.path = path.map( id => ({ id, location: location() }) );
}

// Specific values and annotations (std signature) ---------------------------

function boolOrNull( val, spec ) {
  if ([ true, false, null ].includes( val ))
    return { val, location: location() };
  warning( 'syntax-csn-expected-boolean', location(true), { prop: spec.msgProp },
           'Expected boolean or null for property $(PROP)' );
  ignore( val );
  return { val: !!val, location: location() };
}

function string( val, spec ) {
  if (typeof val === 'string' && val)
    //  XSN TODO: do not require literal
    return val;
  error( 'syntax-csn-expected-string', location(true), { prop: spec.msgProp },
         'Expected non-empty string for property $(PROP)' );
  return ignore( val );
}

function stringVal( val, spec ) {
  if (typeof val === 'string' && val)
    //  XSN TODO: do not require literal
    return { val, literal: 'string', location: location() };
  error( 'syntax-csn-expected-string', location(true), { prop: spec.msgProp },
         'Expected non-empty string for property $(PROP)' );
  return ignore( val );
}

function stringValOrNull( val, spec ) {
  if (val === null)
    return { val, location: location() };

  return stringVal(val, spec);
}

function scalenum( val, spec ) {
  if ([ 'floating', 'variable' ].includes(val))
    return { val, literal: 'string', location: location() };
  return natnum(val, spec );
}

function natnum( val, spec ) {
  if (typeof val === 'number' && val >= 0)
    //  XSN TODO: do not require literal
    return { val, literal: 'number', location: location() };
  error( spec.msgId || 'syntax-csn-expected-natnum', location(true),
         { prop: spec.msgProp } );
  return ignore( val );
}

// Use with spec.msgId !
function natnumOrStar( val, spec ) {
  return (val === '*')
    ? { val, literal: 'string', location: location() }
    : natnum( val, spec );
}

function symbol( id, spec, xsn ) { // for CSN property '#'
  if (!string( id, spec ))
    return;
  xsn.literal = 'enum';         // CSN cannot have both '#' and 'literal'
  xsn.sym = { id, location: location() };
}

function annoValue( val, spec ) {
  if (val == null)              // TODO: reject undefined
    return { val, literal: 'null', location: location() };
  const lit = typeof val;
  if (lit !== 'object')
    return { val, literal: lit, location: location() };
  if (Array.isArray( val )) {
    const ec = val.reduce((c, v) => ((v && v['...'] && Object.keys(v).length === 1) ? ++c : c), 0);
    if (arrayLvlCnt === 0 && ec > 1) {
      error( 'syntax-csn-duplicate-ellipsis', location(true), { code: '...' },
             'Expected no more than one $(CODE)' );
    }
    if (arrayLvlCnt > 0 && ec > 0) {
      error( 'syntax-csn-unexpected-ellipsis', location(true), { code: '...' },
             'Unexpected $(CODE) in nested array' );
    }
    arrayLvlCnt++;
    const retval = {
      location: location(),
      val: arrayOf( annoValue )( val, spec ),
      literal: 'array',
    };
    arrayLvlCnt--;
    return retval;
  }
  if (typeof val['#'] === 'string') {
    if (Object.keys( val ).length === 1) {
      virtualLine += 2;
      return {
        sym: { id: val['#'], location: location() },
        literal: 'enum',
        location: location(),
      };
    }
  }
  else if (typeof val['='] === 'string') {
    if (Object.keys( val ).length === 1) {
      virtualLine += 2;
      return refSplit( val['='], '=' );
    }
  }
  else if (val['...'] && Object.keys(val).length === 1) {
    return {
      val: '...',
      literal: 'token',
      location: location(),
    };
  }
  const struct = Object.create(null);
  ++virtualLine;
  for (const name of Object.keys( val )) {
    struct[name] = annotation( val[name], schema['@'], null, val, name );
    ++virtualLine;
  }
  return { struct, literal: 'struct', location: location() };
}

function annotation( val, spec, xsn, csn, name ) {
  const variantIndex = name.indexOf('#') + 1 || name.length;
  const n = refSplit( name.substring( (xsn ? 1 : 0), variantIndex ), spec.msgProp );
  if (!n)
    return undefined;
  if (variantIndex < name.length)
    n.variant = { id: name.substring( variantIndex ), location: location() };
  const r = annoValue( val, spec );
  r.name = n;
  return r;
}

// Expressions, conditions (std signature) -----------------------------------

function value( val, spec, xsn ) { // for CSN property 'val'
  if ((val == null) ? val === null : typeof val !== 'object') {
    if (!xsn.literal) // might be overwritten; only set if literal type is valid
      xsn.literal = (val === null) ? 'null' : typeof val;
    return val;
  }
  error( 'syntax-csn-expected-scalar', location(true), { prop: spec.msgProp },
         'Only scalar values are supported for property $(PROP)' );
  return ignore( val );
}

function literal( val, spec, xsn, csn ) {
  // TODO: general: requires other property (here: 'val')
  const type = (csn.val == null) ? 'null' : typeof csn.val;
  if (val === type)            // also for 'object' which is an error for 'val'
    return val;
  if (typeof val === 'string' && validLiteralsExtra[val] === type)
    return val;
  error( 'syntax-csn-expected-valid', location(true), { prop: spec.msgProp },
         'Expected valid string for property $(PROP)' );
  return ignore( val );
}

function func( val, spec, xsn ) {
  if (!string( val, spec ))
    return undefined;
  xsn.op = { val: 'call', location: location() };
  return { path: [ { id: val, location: location() } ], location: location() };
}

function xpr( exprs, spec, xsn, csn ) {
  if (csn.func) {
    xsn.suffix = exprArgs( exprs, spec );
  }
  else {
    xsn.op = { val: 'xpr', location: location() };
    xsn.args = exprArgs( exprs, spec, xsn );
  }
}

function list( exprs, spec, xsn ) {
  xsn.op = { val: ',', location: location() };
  xsn.args = arrayOf( exprOrString )( exprs, spec, xsn );
}

function xprInValue( exprs, spec, xsn, csn ) {
  // if the top-level xpr is just for a cast:
  if (exprs.length === 1 && exprs[0].cast) {
    const x = {};
    xpr( exprs, spec, x, csn );
    Object.assign( xsn, x.args[0] );
  }
  else {
    xpr( exprs, spec, xsn, csn );
  }
}

function args( exprs, spec ) {
  if (Array.isArray( exprs )) {
    return arrayOf( exprOrString )( exprs, spec );
  }
  else if (!exprs || typeof exprs !== 'object') {
    error( 'syntax-csn-expected-args', location(true),
           { prop: spec.prop }, // spec.prop, not spec.msgProp!
           'Expected array or object for property $(PROP)' );
    return ignore( exprs );
  }
  const r = Object.create(null);
  ++virtualLine;
  const s = spec.schema['-named'];
  for (const id of Object.keys( exprs )) {
    const a = expr( exprs[id], s );
    if (a) {
      a.name = { id, location: a.location };
      r[id] = a;
    }
    ++virtualLine;
  }
  return r;
}

function expr( e, spec ) {
  if (Array.isArray( e ) && e.length === 1) {
    replaceZeroValue( spec );
    ++virtualLine;
    const r = expr( e[0], spec );
    ++virtualLine;
    return [ r || { location: location() } ];
  }
  else if (e === null || [ 'string', 'number', 'boolean' ].includes( typeof e )) {
    //  && spec.optional.includes( 'val' )) ?
    replaceZeroValue( spec );
    return annoValue( e, spec );
  }
  return object( e, spec );
}

function exprOrString( e, spec ) {
  return (typeof e === 'string' && !csnVersionZero) ? e : expr( e, spec );
}

// mark path argument of 'exits' predicate with $expected:'exists'
function exprArgs( cond, spec, xsn, csn ) {
  const rxsn = arrayOf( exprOrString )( cond, spec, xsn, csn );
  if (Array.isArray( rxsn ) && rxsn.some( x => x === 'exists' )) {
    for (let i = 0; i < rxsn.length - 1; i++) {
      if (rxsn[i] === 'exists' && rxsn[i + 1].path)
        rxsn[++i].$expected = 'exists';
    }
  }
  return rxsn;
}

function condition( cond, spec ) {
  const loc = location();
  const x = {
    op: { val: 'xpr', location: loc },
    args: exprArgs( cond, spec ),
    location: loc,
  };
  return x;
}

function vZeroValue( obj, spec, xsn ) {
  if (xsn.value) {
    // TODO: also "sign" xsn.value created by inValue to complain about both 'value' and 'ref' etc
    warning( 'syntax-csn-unexpected-property', location(true), { prop: spec.msgProp },
             'Unexpected CSN property $(PROP)' );
    return undefined;
  }
  if (!csnVersionZero) {
    warning( 'syntax-csn-zero-delete', location(true), { prop: spec.msgProp },
             'Delete/inline CSN v0.1.0 property $(PROP)' );
  }
  return expr( obj, spec );
}

// Queries (std signature) ---------------------------------------------------

function queryTerm( term, spec, xsn ) { // for CSN properties 'SELECT' and 'SET'
  // TODO: re-check $location: pushLocation( term ) / popLocation( term )
  xsn.query = object( term, spec );
  if (!xsn.query)
    return;
  // XSN TODO: remove op query and subquery?
  if (!xsn.query.op) {
    xsn.query.op = {
      val: (spec.prop !== 'SET' ? 'SELECT' : '$query'),
      location: location(),     // XSN TODO: work without location everywhere
    };
  }
  if (spec.prop !== 'SET' && !xsn.query.from)
    xsn.query.from = null;      // make it clear that SELECT is used with parse error
  if (spec.prop === 'projection')
    xsn.$syntax = 'projection';
}

function asQuantifier( quantifier, spec, xsn ) {
  if (quantifier)
    xsn.quantifier = { val: spec.prop, location: location() };
  boolOrNull( quantifier, spec );
}

function excluding( array, spec, xsn ) {
  if (!isArray( array, spec ))
    return;
  const r = Object.create(null);
  ++virtualLine;
  for (const ex of array) {
    const id = string( ex, spec ) || '';
    dictAdd( r, id, { name: { id, location: location() }, location: location() },
             duplicateExcluding );
    ++virtualLine;
  }
  xsn.excludingDict = r;
}

function duplicateExcluding( name, loc ) {
  error( 'duplicate-excluding', loc, { name, keyword: 'excluding' },
         'Duplicate $(NAME) in the $(KEYWORD) clause' );
}

function setOp( val, spec ) { // UNION, ...
  // similar to string(), but without literal
  return string( val, spec ) && { val, location: location() };
}

function join( val, spec, xsn ) {
  if (!string( val, spec ))
    return undefined;
  const loc = location();
  xsn.op = { val: 'join', location: loc };
  return { val, location: loc };
}

function queryArgs( val, spec, xsn, csn ) {
  if (Array.isArray( val ) && val.length > 1 && !csn.op) {
    warning( 'syntax-csn-expected-property', location(true),
             { prop: 'args', otherprop: 'op' },
             'CSN property $(PROP) expects property $(OTHERPROP) to be specified' );
    xsn.op = { val: 'union', location: location() };
  }
  return arrayOf( object )( val, spec ).map( q => q.query );
}

// i18n ------------------------------

function i18nLang( val, spec, xsn, csn, langKey ) {
  /** @type {SchemaSpec} */
  const keySpec = { dictionaryOf: translations, prop: langKey };
  return dictionaryOf( translations )( val, keySpec );
}

function translations( keyVal, spec, xsn, csn, textKey ) {
  if (typeof keyVal === 'string') // allow empty string
    return { val: keyVal, literal: 'string', location: location() };
  error( 'syntax-csn-expected-translation', location(true),
         { prop: textKey, otherprop: spec.prop },
         'Expected string for text key $(PROP) of language $(OTHERPROP)' );
  return ignore( keyVal );
}

// Helper functions for objects and definitions ------------------------------

function getSpec( parentSpec, csn, prop, xor, expected, kind ) {
  const p0 = schema[prop] ? prop : prop.charAt(0);
  const s = (parentSpec.schema || schema)[p0];
  if (!s || s.noPrefix && prop !== p0 ) {
    if (ourpropsRegex.test( prop )) {
      // TODO v2: Warning only with --sloppy
      warning( 'syntax-csn-unknown-property', location(true), { prop },
               'Unknown CSN property $(PROP)' );
    }
    else {                      // TODO v2: always (i.e. also with message) add to $extra
      return { prop, type: extra };
    }
  }
  else if (!expected( p0, s )) {
    if (s.ignore)
      return { type: ignore };
    if (s.vZeroIgnore && s.vZeroIgnore === csn[prop]) { // for "op": "call"
      warning( 'syntax-csn-zero-delete', location(true), { prop },
               'Delete/inline CSN v0.1.0 property $(PROP)' );
      return { type: ignore };
    }
    const zero = s.vZeroFor;
    if (zero) {                 // (potential) CSN v0.1.0 property
      const group = s.xorGroup;
      if (zero && expected( zero, schema[zero] ) && !(group && xor[group])) {
        replaceZeroProp( prop, zero );
        if (group)
          xor[group] = prop;
        onlyWith( s, s.onlyWith, csn, prop, xor, expected );
        return s;
      }
    }
    // eslint-disable-next-line no-nested-ternary
    const variant = kind && s.inKind
      ? ([ 'extend', 'annotate' ].includes(kind) ? kind : 'def')
      : (parentSpec.msgProp ? 'std' : 'top');
    message( 'syntax-csn-unexpected-property', location(true),
             {
               prop, otherprop: parentSpec.msgProp, kind, '#': variant,
             },
             {
               std: 'CSN property $(PROP) is not expected in $(OTHERPROP)',
               top: 'CSN property $(PROP) is not expected top-level',
               def: 'CSN property $(PROP) is not expected by a definition of kind $(KIND)',
               extend: 'CSN property $(PROP) is not expected by an extend in $(OTHERPROP))',
               annotate: 'CSN property $(PROP) is not expected by an annotate in $(OTHERPROP)',
             } );
    // TODO: or still augment it? (but then also handle xorGroup)
  }
  else if (checkAndSetXorGroup( s.xorGroup, prop, xor )) {
    onlyWith( s, s.onlyWith, csn, prop, xor, expected );
    return s;
  }
  // else ignore
  return { type: ignore };
}

function calculateKind( def, spec ) {
  if (inExtensions) {
    inExtensions = spec.defaultKind;
    return 'annotate';
  }
  if (spec.prop === 'extensions') {
    inExtensions = (def.extend) ? '' : 'annotate';
    return (def.extend) ? 'extend' : 'annotate';
  }
  const kind = (def.kind === 'view') ? 'entity' : def.kind; // 'view' is CSN v0.1.0
  if (kind === 'extend' && inExtensions === '') // valid extend -> keep inExtensions
    return 'extend';
  inExtensions = null;
  if (!spec.validKinds.includes( kind ))
    return spec.defaultKind;
  return (def.abstract || def.$syntax === 'aspect')
    ? 'aspect'           // deprecated abstract entity or kind:type for aspects
    : kind;
}

function onlyWith( spec, need, csn, prop, xor, expected ) {
  if (!need)
    return spec;
  if (typeof need === 'string') {
    if (need in csn)            // TODO: enumerable ?
      return spec;
  }
  else if (need.some( n => n in csn )) {
    return spec;
  }
  else {
    const allowed = need.filter( p => expected( p, spec ));
    // There should be at least one elem, otherwise the spec is wrong;
    // first try to find element which is not excluded
    need = allowed.find( p => !xor[schema[p].xorGroup] ) || allowed[0];
  }
  if (prop) {
    error( 'syntax-csn-dependent-property', location(true),
           { prop, otherprop: need },
           'CSN property $(PROP) can only be used in combination with $(OTHERPROP)');
    xor['no:req'] = prop;
  }
  else if (!xor['no:req']) {
    error( 'syntax-csn-required-property', location(true),
           { prop: need, otherprop: spec.msgProp, '#': spec.prop },
           {  // TODO $(PARENT), TODO: do not use prop===0 hack
             std: 'Object in $(OTHERPROP) must have the property $(PROP)',
             columns: 'Object in $(OTHERPROP) must have an expression property like $(PROP)',
             // eslint-disable-next-line max-len
             extensions: 'Object in $(OTHERPROP) must have the property \'annotate\' or \'extend\'',
           } );
  }
  return spec;
}

function checkAndSetXorGroup( group, prop, xor ) {
  if (!group)
    return true;
  if (!xor[group]) {
    xor[group] = prop;
    return true;
  }
  if (prop === 'func' && xor[group] === 'xpr' ||
      prop === 'xpr' && xor[group] === 'func')
    return true;                // hack for window function: both func and xpr is allowed
  error( 'syntax-csn-excluded-property', location(true),
         { prop, otherprop: xor[group] },
         'CSN property $(PROP) can only be used alternatively to $(OTHERPROP)');
  return false;
}

function implicitName( ref ) {
  // careful, the input CSN might be wrong!
  const item = ref && ref[ref.length - 1];
  return (typeof item === 'object') ? item && item.id : item;
}

function replaceZeroProp( otherprop, prop ) {
  if (csnVersionZero)
    return;
  warning( 'syntax-csn-zero-prop', location(true), { prop, otherprop },
           'Replace CSN v0.1.0 property $(OTHERPROP) by $(PROP)' );
}

// Other helper functions, locations -----------------------------------------

function isArray( array, spec ) {
  if (Array.isArray( array ))
    return array;
  error( 'syntax-csn-expected-array', location(true), { prop: spec.prop },
         'Expected array for property $(PROP)' );
  return ignore( array );
}

function isObject( obj, spec ) {
  if (obj && typeof obj === 'object' && !Array.isArray( obj ))
    return obj;
  error( spec.msgId || 'syntax-csn-expected-object', location(true),
         { prop: spec.msgProp });
  return ignore( obj );
}

function refSplit( name, prop ) {
  const path = name.split('.');
  if (!path.every( id => id)) {
    warning( 'syntax-csn-expected-name', location(true), { prop },
             'Expected correct name for property $(PROP)' );
  }
  return { path: path.map( id => ({ id, location: location() }) ), location: location() };
}

function replaceZeroValue( spec ) {
  if (!csnVersionZero && spec.vZeroFor == null) { // but 0 does not match!
    warning( 'syntax-csn-zero-value', location(true), { prop: spec.msgProp },
             'Replace CSN v0.1.0 value in $(PROP) by something specified' );
  }
}

/**
 * @param {boolean} [enforceJsonPos]
 * @returns {CSN.Location}
 */
function location( enforceJsonPos ) {
  return !enforceJsonPos && dollarLocations.length &&
         dollarLocations[dollarLocations.length - 1] || {
    file: csnFilename,
    line: virtualLine,
    col: 0,
  };
}

function pushLocation( obj ) {
  // TODO: virtualLine is not really correct if $location is enumerable (is usually not)
  const loc = obj.$location;
  if (loc === undefined)
    return;
  if (loc && typeof loc === 'object' && !Array.isArray( loc )) {
    dollarLocations.push( loc.line ? loc : null );
    return;
  }
  else if (!loc || typeof loc !== 'string') {
    if (loc)
      dollarLocations.push( null ); // must match with popLocation()
    error( 'syntax-csn-expected-object', location(true), { prop: '$location' } );
  }
  // hidden feature: string $location
  const m = /:(\d+)(?::(\d+)(?:-[0-9-]+)?)?$/.exec( loc ); // extra - at end for .refloc
  if (!m) {
    dollarLocations.push( null );
  }
  else {
    const line = Number( m[1] );
    const column = m[2] && Number( m[2] ) || 0;
    dollarLocations.push( {
      file: loc.substring( 0, m.index ),
      line,
      col: column,
    } );
  }
}

function popLocation( obj ) {
  if (obj.$location)
    dollarLocations.pop();
}

function resetHeapModuleVars() {
  vocabInDefinitions = null;
  dollarLocations = [];
  message = () => undefined;
  error = () => undefined;
  warning = () => undefined;
  info = () => undefined;
}

// API -----------------------------------------------------------------------

/**
 * Transform the CSN to XSN (augmented CSN)
 *
 * @param {CSN.Model} csn
 * @param {string} filename
 * @param {CSN.Options} options
 * @returns {object} Augmented CSN (a.k.a XSN)
 */
function toXsn( csn, filename, options, messageFunctions ) {
  csnVersionZero = csn.version && csn.version.csn === '0.1.0';
  csnFilename = filename;
  virtualLine = 1;
  dollarLocations = [];
  inExtensions = null;
  vocabInDefinitions = null;
  const xsn = { $frontend: 'json' };

  // eslint-disable-next-line object-curly-newline
  ({ message, error, warning, info } = messageFunctions);

  if (csnVersionZero) {
    warning( 'syntax-csn-zero-version', location(true),
             'Parsing CSN version 0.1.0' );
  }
  const r = object( csn, topLevelSpec );
  if (vocabInDefinitions)
    attachVocabInDefinitions( r );
  if (csn.$sources && Array.isArray( csn.$sources ) &&
      csn.$sources.every( fname => typeof fname === 'string' ))
    // non-enumerable or enumerable, ignore with wrong value
    r.$sources = csn.$sources;
  resetHeapModuleVars();
  return Object.assign( xsn, r );
}


function augment( csn, filename = 'csn.json', options = {}, messageFunctions ) {
  try {
    return toXsn( csn, filename, options, messageFunctions );
  }
  catch ( e ) {
    resetHeapModuleVars();
    throw e;
  }
}

function parse( source, filename = 'csn.json', options = {}, messageFunctions ) {
  try {
    return augment( JSON.parse(source), filename, options, messageFunctions );
  }
  catch ( e ) {
    resetHeapModuleVars();
    if (!(e instanceof SyntaxError))
      throw e;
    const xsn = {};
    const msg = e.message;
    const p = /in JSON at position ([0-9]+)/.exec( msg );
    let line = 1;
    let column = 0;
    if (p) {
      const end = Number( p[1] );
      let eol = 0;
      const nl = /\n/g;
      while (nl.test( source )) {
        if (nl.lastIndex >= end)
          break;
        eol = nl.lastIndex;
        ++line;
      }
      column = end - eol + 1;
    }
    /** @type {CSN.Location} */
    const loc = {
      file: filename,
      line,
      col: column,
    };
    messageFunctions.error( 'syntax-csn-illegal-json', loc, { msg }, 'Illegal JSON: $(MSG)' );
    return xsn;
  }
}

module.exports = { augment, parse };
