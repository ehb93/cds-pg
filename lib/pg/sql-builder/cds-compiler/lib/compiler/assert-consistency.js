// Consistency checker on model (XSN = augmented CSN)

// Docs about XSN: internalDoc/IdeasModelChanges.md, internalDoc/Model.md (the
// latter is quite outdated).  The use of the XSN is PACKAGE-INTERNAL!  If you
// want to use it, you MUST contact us.
//
// The consistency check gives the consumer of XSN same safety of what values
// they can expect to see at certain places in the model.  It gives produces
// some safety that they have produced a consistent model.  That being said,
// the consistency check is work-in-progress.
//
// The consistency check is NOT A SYNTAX CHECK: it accepts invalid CDS models,
// it is usually not run in productive use, and its error message contains
// property names the user is not aware of.  It is considered an _internal
// error_ if the consistency check throws an error.

// A value in the model is one of:
//
// - Simple value: String, Boolean, Integer, null, undefined.
// - Dictionary: object without prototype - its property names are _user
//   defined_ and all property values have same "type" (example: elements).
// - Array: all items have same "type" (which is often a "union type").
// - Standard object: object with `Object.prototype` as prototype - its
//   property names are predefined (or at least their first char: `@` for
//   annotation assignments) and the value type depends on the property name.
// - Special object: currently just for the messages.
//
// The CENTRAL CHARACTERISTIC in XSN (as well as plain CSN) is: in ALL standard
// objects, the SAME PROPERTY NAME contains values of the SAME TYPE - we might
// restrict the value space in certain contexts, though.  Example: the value of
// a `type` property looks the same in objects for definitions or in the object
// which is the value of the `items` property.

// The model is described by a schema which specifies the type for all property
// names in standard objects.  Such a type can be a "union type", e.g. can
// allow a simple value or array.  This is done by a assert function in
// property `test` of a properties' specification in the schema.  The test
// function can use other properties in the specification.  If no such function
// is specified, it uses function `standard` which checks for a standard
// objects with:
//
// - Certain required sub properties whose names are listed in the array value
//   of `requires` in the specification.  This can be loosened: by default, no
//   property is required with syntax errors (overwritten by `isRequired`).
// - Optional sub properties are listed in `optional`, which can also be a
//   function returning true if the property is allowed.
//
// The above mentioned restriction of the value space in certain contexts can
// be specified by a property `schema` of the properties' specification in the
// schema.  With it, direct sub properties are checked against that
// specification.  Specifications can also inherit properties from other
// specifications by using the name as value of `inherits` in the
// specification.

// The consistency check also checks the following conventions for names in
// standard objects:
//
// - A property is non-enumerable if and only if its name starts with `_`.
//   This convention can be overwritten by `enumerable` of the properties'
//   specification in the schema.  Such properties should be used for "links"
//   to other nodes in the model.
// - A property must not be produced by a parser if its name starts with `_` or
//   `$`.  This convention can be overwritten by `parser` of the properties'
//   specification in the schema.  Such properties must not be used for links,
//   and should be used for information which does not make it into plain CSN.

'use strict';

const { locationString, hasErrors } = require('../base/messages');


// Properties that can appear where a type can have type arguments.
const typeProperties = [
  'type', '$typeArgs', 'length', 'precision', 'scale', 'srid',
];

function assertConsistency( model, stage ) {
  const stageParser = typeof stage === 'object';
  const options = stageParser && stage || model.options || { testMode: true };
  if (!options.testMode || options.parseOnly && !stageParser)
    return;

  const schema = {
    ':model': {                 // top-level from compiler
      requires: [ 'options', 'definitions', 'sources' ],
      optional: [
        'vocabularies',
        'messages',
        'extensions',
        'i18n',
        'meta',
        '$magicVariables',
        '$builtins',
        '$internal',
        '$compositionTargets',
        '$lateExtensions',
        '_entities', '$entity',
        '$blocks',
        '$newfeatures',
        '$messageFunctions',
      ],
    },
    ':parser': {                // top-level from parser
      requires: [ '$frontend' ],
      optional: [
        'messages', 'options', 'definitions', 'vocabularies',
        'extensions', 'i18n',
        'artifacts', 'artifacts_', 'namespace', 'usings', // CDL parser
        'location', 'dirname',
        'dependencies',         // for USING..FROM
        'kind',                 // TODO: remove from parser
        'meta',
        '@sql_mapping',         // TODO: it is time that a 'header' attribute replaces 'version'
        '$withLocalized',
        '$sources',
      ],
    },
    location: {                 // location req if at least one property:
      isRequired: parent => noSyntaxErrors() || Object.keys( parent ).length,
      kind: true,
      requires: [ 'file' ],     // line is optional in top-level location
      optional: [ 'line', 'col', 'endLine', 'endCol', '$notFound' ],
      schema: {
        line: { test: isNumber },
        col: { test: isNumber },
        endLine: { test: isNumber, also: [ undefined ] },
        endCol: { test: isNumber, also: [ undefined ] },
        $notFound: { test: isBoolean },
      },
    },
    sources: { test: isDictionary( isObject ) },
    file: { test: isString },
    dirname: { test: isString },  // TODO: really necessary?
    realname: { test: isString }, // TODO: really necessary?
    dependencies: {
      test: isArray(),
      requires: [ 'literal', 'location', 'val' ],
    },
    fileDep: { test: TODO },    // in usings
    $frontend: { parser: true, test: isString, enum: [ 'cdl', 'json', 'xml' ] },
    $newfeatures: { test: TODO }, // if new features have been used which break the old backends
    messages: {
      enumerable: () => true,  // does not matter (non-enum std), enum in CSN/XML parser
      test: isArray( TODO ),
    },
    options: { test: TODO },              // TODO: check option object
    definitions: {
      test: isDictionary( definition ),
      requires: [ 'kind', 'location', 'name' ],
      optional: thoseWithKind,
    },
    vocabularies: {
      test: isDictionary( definition ),
      requires: [ 'kind', 'name' ],
      optional: thoseWithKind,
    },
    extensions: {
      kind: [ 'context' ],        // syntax error (as opposed to HANA CDS), but still there
      inherits: 'definitions',
      test: isArray(),
      schema: { name: { inherits: 'name', isRequired: noSyntaxErrors } },
      // name is required in parser, too
    },
    i18n: {
      test: isDictionary( ( val, parent, prop, spec, lang ) => {
        const textValueIsString = (v, p, textProp, s, textKey) => {
          isString(v.val, p, textKey, s);
        };
        const innerDict = isDictionary( textValueIsString );
        return innerDict( val, parent, lang, spec );
      } ),
    },
    _assocSources: { kind: true, test: TODO }, // just null: isArray( inDefinitions ) during resolve
    $magicVariables: {
      // $magicVariables contains "builtin" artifacts that differ from
      // "normal artifacts" and therefore have a custom schema
      requires: [ 'kind', 'artifacts' ],
      schema: {
        kind: { test: isString, enum: [ '$magicVariables' ] },
        artifacts: {
          // Do not use "normal" definitions spec because of these artifacts
          // are missing the location property
          test: isDictionary( definition ),
          requires: [ 'kind', 'name' ],
          optional: [ 'elements', '$autoElement', '$uncheckedElements', '_effectiveType', '_deps' ],
          schema: {
            kind: { test: isString, enum: [ 'builtin' ] },
            name: { test: isObject, requires: [ 'id', 'element' ] },
            $autoElement: { test: isString },
            $uncheckedElements: { test: isBoolean },
            // missing location for normal "elements"
            elements: { test: TODO },
          },
        },
      },
    },
    $builtins: { test: TODO },
    $blocks: { test: TODO },
    builtin: { kind: true, test: builtin },
    $internal: {
      test: standard,
      requires: [ '$frontend' ],
      schema: {
        $frontend: { test: isString, enum: [ '$internal' ] },
      },
    },
    meta: { test: TODO }, // never tested due to --test-mode
    namespace: {
      test: (model.$frontend !== 'json') ? standard : TODO,
      // TODO: the JSON parser should augment 'namespace' correctly or better: hide it
      requires: [ 'location' ],
      optional: [ 'path' ],
    },
    usings: {
      test: isArray(),
      requires: [ 'kind', 'location' ],
      optional: [ 'name', 'extern', 'usings', '$annotations', 'fileDep' ],
      // TODO: get rid of $annotations: []
    },
    extern: {
      requires: [ 'location', 'path' ],
      schema: { path: { inherits: 'path', optional: [ '$delimited' ] } },
    },
    elements: { kind: true, inherits: 'definitions', also: [ 0 ] }, // 0 for cyclic expansions
    // specified elements in query entities (TODO: introduce real "specified elements" instead):
    elements$: { kind: true, enumerable: false, test: TODO },
    actions: { kind: true, inherits: 'definitions' },
    enum: { kind: true, inherits: 'definitions' },
    foreignKeys: { kind: true, inherits: 'definitions' },
    $keysNavigation: { kind: true, test: TODO },
    params: { kind: true, inherits: 'definitions' },
    mixin: { inherits: 'definitions' },
    query: {
      kind: true,
      test: query,              // properties below are "sub specifications"
      union: {
        schema: { args: { inherits: 'query', test: isArray( query ) } },
        requires: [ 'op', 'location', 'args' ],
        optional: [
          'quantifier', 'orderBy', 'limit', '_leadingQuery',
          'name', '$parens', 'kind', '_parent', '_main', '_effectiveType', // in FROM
        ],
      },
      select: {                   // sub query
        requires: [ 'op', 'location', 'from' ],
        optional: [
          'name', '$parens', 'quantifier', 'mixin', 'excludingDict', 'columns', 'elements', '_deps',
          'where', 'groupBy', 'having', 'orderBy', '$orderBy', 'limit',
          '_projections', '_block', '_parent', '_main', '_effectiveType', '$expand',
          '$tableAliases', 'kind', '_$next', '_combined', '$inlines',
        ],
      },
      none: { optional: () => true }, // parse error
    },
    from: {
      test: from,
      join: {                   // join
        schema: { args: { inherits: 'from', test: isArray( from ) } },
        requires: [ 'op', 'location', 'args', 'join' ],
        optional: [
          'on', '$parens', 'cardinality',
          'kind', 'name', '_block', '_parent', '_main',
          '$tableAliases', '_combined', '_joinParent', '$joinArgsIndex',
          '_leadingQuery', '_$next', '_deps',
        ],
      },
      ref: {
        requires: [ 'location', 'path' ],
        optional: [
          'kind', 'name', '$syntax', '_block', '_parent', '_main',
          'elements', '_origin', '_joinParent', '$joinArgsIndex', '$syntax',
          '$parens', '_status', // TODO: only in from
          'scope', '_artifact', '$inferred', 'kind',
          '_effectiveType',         // TODO:check this
          '$duplicates', // In JOIN if both sides are the same.
        ],
      },
      query: {
        requires: [ 'query', 'location' ],
        optional: [
          '$parens',
          'kind', 'name', '_block', '_parent', '_main',
          '_effectiveType', 'elements', '_origin', '_joinParent', '$joinArgsIndex',
          '$duplicates', // duplicate query in FROM clause
        ],
      },
      none: { optional: () => true }, // parse error
    },
    columns: {
      kind: [ 'extend' ],
      test: isArray( column ),
      optional: thoseWithKind,
      enum: [ '*' ],
      requires: [ 'location' ],
      // schema: { kind: { isRequired: () => {} } } // kind not required
    },
    expand: { kind: [ 'element' ], inherits: 'columns' },
    inline: { kind: [ 'element' ], inherits: 'columns' },
    excludingDict: {
      kind: 'element',
      test: isDictionary( definition ), // definition since redef
      requires: [ 'location', 'name' ],
      optional: [ '$annotations' ], // TODO: get rid of annos: []
    },
    orderBy: { inherits: 'value', test: isArray( expression ) },
    sort: { test: locationVal( isString ), enum: [ 'asc', 'desc' ] },
    nulls: { test: locationVal( isString ), enum: [ 'first', 'last' ] },
    $orderBy: { inherits: 'orderBy' },
    groupBy: { inherits: 'value', test: isArray( expression ) },
    limit: { requires: [ 'rows' ], optional: [ 'offset', 'location' ] },
    rows: { inherits: 'value' },
    offset: { inherits: 'value' },
    _combined: { test: TODO },
    $inlines: { test: TODO },
    type: {
      kind: true,
      requires: [ 'location', 'path' ],
      optional: [
        'scope', '_artifact', '$inferred', '$parens',
      ],
    },
    targetAspect: {
      kind: true,
      requires: [ 'location' ],
      optional: [
        'path', 'elements', '_outer',
        'scope', '_artifact', '$inferred', '$expand',
        '_effectiveType',           // by propagation
      ],
    },
    target: {
      kind: true,
      requires: [ 'location' ],
      optional: [
        'path', 'elements', '_outer',
        'scope', '_artifact', '$inferred',
      ],
    },
    path: {
      test: isArray( pathItem ),
      requires: [ 'location', 'id' ], // TODO: it can be `func` instead of `id` later
      optional: [
        '$delimited',               // TODO remove?
        'args', '$syntax',
        'where', 'cardinality',
        '_artifact', '_navigation',
        '$inferred',
      ],
    },
    id: { test: isString },
    $delimited: { parser: true, test: isBoolean },
    scope: { test: isScope },
    func: { test: TODO },
    suffix: { test: TODO },
    kind: {
      isRequired: !stageParser && (() => true),
      // required to be set by Core Compiler even with parse errors
      test: isString,
      enum: [
        'context', 'service', 'entity', 'type', 'aspect', 'const', 'annotation',
        'element', 'enum', 'action', 'function', 'param', 'key', 'event',
        'annotate', 'extend',
        'select', '$join', 'mixin',
        'source', 'namespace', 'using',
        '$tableAlias', '$navElement',
      ],
    },
    // locations of parentheses pairs around expression:
    $parens: { parser: true, test: TODO },
    $syntax: {
      parser: true,
      kind: [ 'entity', 'view', 'type', 'aspect' ],
      test: isString,            // CSN parser should check for 'entity', 'view', 'projection'
    },
    value: {
      optional: [ 'location', '$inferred', 'sort', 'nulls' ],

      kind: true,
      test: expression,         // properties below are "sub specifications"
      ref: {
        requires: [ 'location', 'path' ],
        optional: [ 'scope', 'variant', '_artifact', '$inferred', '$parens', 'sort', 'nulls' ],
      },
      none: { optional: [ 'location', '$parens' ] },
      // TODO: why optional / enough in name?
      // TODO: "yes" instead "none": val: true, optional literal/location
      val: {
        requires: [ 'literal', 'location' ],
        // TODO: rename symbol to sym
        // TODO: struct and variant only for annotation assignments
        optional: [
          'val', 'sym', 'name', '$inferred', '$parens',
          'struct', 'variant', 'sort', 'nulls',
        ],
      },
      op: {
        schema: { args: { inherits: 'args' } },
        requires: [ 'op', 'location' ],
        optional: [
          'args',
          'func',
          'suffix',
          'quantifier',
          '$inferred',
          '$parens',
          '_artifact',          // _artifact with "localized data"s 'coalesce'
          'sort', 'nulls',      // if used in GROUP BY
          ...typeProperties,    // for CAST
        ],
      },
      query: { requires: [ 'query', 'location' ] },
    },
    literal: {                  // TODO: check value against literal
      test: isString,
      enum: [
        'string', 'number', 'boolean', 'x',
        'time', 'date', 'timestamp',
        'struct', 'array', 'enum', 'null', 'token',
      ],
    },
    sym: { requires: [ 'location', 'id' ], optional: [ '$delimited' ] },
    val: {
      test: isVal,              // the following for array/struct value
      requires: [ 'location' ],
      optional: [ 'literal', 'val', 'sym', 'struct', 'variant', 'path', 'name', '$duplicate' ],
      // TODO: restrict path to #simplePath
    },
    struct: { inherits: 'val', test: isDictionary( definition ) }, // def because double @
    args: {
      inherits: 'value',
      optional: [ 'name', '$duplicate', '$expected', 'args', 'suffix' ],
      test: args,
    },
    on: { kind: true, inherits: 'value', test: expression },
    where: { inherits: 'value' },
    having: { inherits: 'value' },
    op: { test: locationVal( isString ) },
    join: { test: locationVal( isString ) },
    quantifier: { test: locationVal( isString ) },
    // preliminary -----------------------------------------------------------
    doc: { kind: true, test: locationVal( isStringOrNull ) }, // doc comment
    '@': {
      kind: true,
      inherits: 'value',
      optional: [ 'name', '_block', '$priority', '$duplicate', '$inferred', '$duplicates' ],
      // TODO: name requires if not in parser?
    },
    $priority: { test: TODO }, // TODO: rename to $priority
    $annotations: { parser: true, kind: true, test: TODO },
    name: {
      isRequired: stageParser && (() => false), // not required in parser
      kind: true,
      schema: {
        select: { test: TODO },
      }, // TODO: rename query prop in name
      requires: [ 'location' ],
      optional: [
        'path', 'id', '$delimited', 'variant', // TODO: req path, opt id for main, req id for member
        '_artifact', '$inferred',
        'absolute', 'select', 'alias', 'element', 'action', 'param',
      ],
    },
    absolute: { test: isString },
    variant: { test: TODO }, // TODO: not set in CDL parser, only in $annotations
    element: { test: TODO }, // TODO: { test: isString },
    action: { test: isString },
    param: { test: isString },
    alias: { test: isString },
    expectedKind: { kind: [ 'extend' ], inherits: 'kind' },
    virtual: { kind: true, test: locationVal() },
    key: { kind: true, test: locationVal(), also: [ null, undefined ] },
    masked: { kind: true, test: locationVal() },
    notNull: { kind: true, test: locationVal() },
    includes: { kind: true, inherits: 'type', test: isArray() },
    returns: {
      kind: [ 'action', 'function' ],
      requires: [ 'kind', 'location' ],
      optional: thoseWithKind,
    },
    items: {
      kind: true,
      requires: [ 'location' ],
      optional: [
        'enum',
        'elements', 'cardinality', 'target', 'on', 'foreignKeys', 'items',
        '_outer', '_effectiveType', 'notNull',
        '_origin', '_block', '$inferred', '$expand', '_deps',
        '$syntax',
        '_status', '_redirected',
        ...typeProperties,
      ],
    }, // yes, also optional 'items'
    targetElement: { kind: true, inherits: 'type' },   // for foreign keys
    artifacts: { kind: true, inherits: 'definitions', test: isDictionary( inDefinitions ) },
    _subArtifacts: { kind: true, inherits: 'definitions', test: isDictionary( inDefinitions ) },
    blocks: { kind: true, test: TODO },    // TODO: make it $blocks ?
    length: { kind: true, inherits: 'value' }, // for number is to be checked in resolver
    precision: { kind: true, inherits: 'value' },
    scale: { kind: true, inherits: 'value' },
    srid: { kind: true, inherits: 'value' },
    localized: { kind: true, test: locationVal() },
    cardinality: {
      kind: true,
      requires: [ 'location' ],
      optional: [ 'sourceMin', 'sourceMax', 'targetMin', 'targetMax' ],
    },
    sourceMin: { test: locationVal( isNumber ) },
    sourceMax: { test: locationVal( isNumber ), also: [ '*' ] },
    targetMin: { test: locationVal( isNumber ) },
    targetMax: { test: locationVal( isNumber ), also: [ '*' ] },
    default: { kind: true, inherits: 'value' },
    $typeArgs: { parser: true, kind: true, test: TODO },
    $tableAliases: { kind: true, test: TODO }, // containing $self outside queries
    _block: { kind: true, test: TODO },
    _parent: { kind: true, test: TODO },
    _service: { kind: true, test: TODO },
    _main: { kind: true, test: TODO },
    _artifact: { test: TODO },
    _base: { test: TODO, kind: true },
    _navigation: { test: TODO },
    _effectiveType: { kind: true, test: TODO },
    _joinParent: { test: TODO },
    $joinArgsIndex: { test: isNumber },
    _outer: { test: TODO },              // for returns/items
    $queries: {
      kind: [ 'entity', 'event' ],
      test: isArray(),
      requires: [
        'kind', 'location', 'name',
        '_parent', '_main', '_$next', '_block',
        // query specific
        'op', 'from', 'elements',
        '_combined',
        '$tableAliases', '$inlines',
      ],
      optional: [
        '_effectiveType', '$parens',
        '_deps', '$expand',
        // query specific
        'where', 'columns', 'mixin', 'quantifier', 'offset',
        'orderBy', '$orderBy', 'groupBy', 'excludingDict', 'having',
        'limit',
      ],
    },
    _leadingQuery: { kind: true, test: TODO },
    $replacement: { kind: true, test: TODO }, // for smart * in queries
    _origin: { kind: [ 'entity' ], test: TODO },
    _pathHead: { kind: [ 'element', undefined ], test: TODO }, // column or * (wildcard)
    _from: { kind: true, test: TODO }, // all table refs necessary to compute elements
    // array of $tableAlias (or includes) for explicit and implicit redirection:
    _redirected: { kind: true, test: TODO },
    // ...array of table aliases for targets from orig to new
    _$next: { kind: true, test: TODO }, // next lexical search environment for values
    _extend: { kind: true, test: TODO }, // for collecting extend/annotate on artifact
    _annotate: { kind: true, test: TODO }, // for collecting extend/annotate on artifact
    _extension: { kind: true, test: TODO }, // on artifact to its "super extend/annotate" statement
    _deps: { kind: true, test: TODO },      // for cyclic calculation
    _scc: { kind: true, test: TODO },       // for cyclic calculation
    _sccCaller: { kind: true, test: TODO }, // for cyclic calculation
    _status: { kind: true, test: TODO },    // TODO: $status
    _projections: { kind: true, test: TODO }, // for mixin definitions
    $entity: { kind: true, test: TODO },
    _entities: { test: TODO },
    $compositionTargets: { test: isDictionary( isBoolean ) },
    $lateExtensions: { test: TODO },
    _upperAspects: { kind: [ 'type', 'entity' ], test: isArray( TODO ) },

    // for implicit redirection - direct and indirect query sources of simple
    // projections/views without @(cds.redirection.target: false):
    _ancestors: { kind: [ 'type', 'entity' ], test: isArray( TODO ) },
    // for implicit redirection - maps service name to simple projections/views
    // in that service which have the current artifact in _ancestors
    // (it can contain the artifact itself with no/failed autoexposure):
    _descendants: { kind: [ 'entity' ], test: isDictionary( isArray( TODO ) ) },

    $duplicates: { parser: true, kind: true, test: TODO }, // array of arts or true
    $extension: { kind: true, test: TODO }, // TODO: introduce $applied instead or $status
    $inferred: { parser: true, kind: true, test: isString },

    // Helper property for the XSN-to-CSN transformation, see function setExpandStatus():
    // client, universal: render expanded elements?  gensrc: produce annotate statements?
    $expand: { kind: true, test: isString }, // TODO: rename it to $elementsExpand ?

    $autoexpose: { kind: [ 'entity' ], test: isBoolean, also: [ null, 'Composition' ] },
    $a2j: { kind: true, enumerable: true, test: TODO },
    $extra: { parser: true, test: TODO },   // for unexpected properties in CSN
    $withLocalized: { test: isBoolean },
    $sources: { parser: true, test: isArray( isString ) },
    $expected: { parser: true, test: isString },
    $messageFunctions: { test: TODO },
  };
  let _noSyntaxErrors = null;
  assertProp( model, null, stageParser ? ':parser' : ':model', null, true );
  return;

  function noSyntaxErrors() {
    if (_noSyntaxErrors == null)
      _noSyntaxErrors = !hasErrors( options.messages ); // TODO: check messageId?
    return _noSyntaxErrors;
  }

  function assertProp( node, parent, prop, extraSpec, noPropertyTest ) {
    let spec = extraSpec || schema[prop] || schema[prop.charAt(0)];
    if (!spec)
      throw new Error( `Property '${ prop }' has not been specified`);
    spec = inheritSpec( spec );

    if (!noPropertyTest) {
      const char = prop.charAt(0);
      const parser = ('parser' in spec) ? spec.parser : char !== '_' && char !== '$';
      if (stageParser && !parser)
        throw new Error( `Non-parser property '${ prop }' set by ${ model.$frontend || '' } parser${ at( [ node, parent ] ) }` );
      const enumerable = ('enumerable' in spec) ? spec.enumerable : char !== '_';
      if (enumerable instanceof Function
          ? !enumerable( parent, prop )
          : {}.propertyIsEnumerable.call( parent, prop ) !== enumerable)
        throw new Error( `Unexpected enumerability ${ !enumerable }${ at( [ node, parent ], prop ) }` );
    }
    (spec.test || standard)( node, parent, prop, spec,
                             typeof noPropertyTest === 'string' && noPropertyTest );
  }

  function definition( node, parent, prop, spec, name ) {
    if (!Array.isArray( node ))
      node = [ node ];
    // TODO: else check that there is a redefinition error
    for (const art of node)
      standard( art, parent, prop, spec, name );
  }

  /**
   * `builtin` property that is set in the definer. Must only be used for `cds`
   * and `localized` namespaces.
   */
  function builtin( node, parent, prop, spec, name ) {
    if (![ 'string', 'boolean' ].includes(typeof node))
      throw new Error(`Property '${ prop }' must be a boolean or string but was '${ typeof node }'${ at( [ node, parent ], prop, name ) }` );

    if (parent.kind !== 'namespace')
      throw new Error(`Property '${ prop }' must be inside artifact that is a namespace but was '${ parent.kind }'${ at( [ node, parent ], prop, name ) }` );

    const parentName = parent.name && parent.name.absolute;
    if (parentName !== 'cds' && parentName !== 'localized')
      throw new Error(`Property '${ prop }' must be inside namespace 'cds' or 'localized' but was '${ parentName }'${ at( [ node, parent ], prop, name ) }` );
  }

  function column( node, ...rest ) {
    if (node.val)
      locationVal( isString )( node, ...rest );
    else if (stageParser)
      standard( node, ...rest );
    else
      isObject( node, ...rest ); // TODO: and inside elements
  }

  function pathItem( node, ...rest ) {
    if (node !== null || noSyntaxErrors())
      standard( node, ...rest );
  }

  function standard( node, parent, prop, spec, name ) {
    isObject( node, parent, prop, spec, name );

    const names = Object.getOwnPropertyNames( node );
    const requires = spec.requires || [];
    // Do not test 'requires' with parse errors:
    for (const p of requires) {
      if (!names.includes(p)) {
        const req = spec.schema && spec.schema[p] && spec.schema[p].isRequired;
        if ((req || schema[p] && schema[p].isRequired || noSyntaxErrors)( node ))
          throw new Error( `Required property '${ p }' missing in object${ at( [ node, parent ], prop, name ) }` );
      }
    }
    const optional = spec.optional || [];
    for (const n of names) {
      const opt = Array.isArray(optional)
        ? optional.includes( n ) || optional.includes( n.charAt(0) )
        : optional( n, spec );
      if (!(opt || requires.includes( n ) || n === '$extra'))
        throw new Error( `Property '${ n }' is not expected${ at( [ node[n], node, parent ], prop, name ) }` );

      assertProp( node[n], node, n, spec.schema && spec.schema[n] );
    }
  }

  function thoseWithKind( prop, spec ) {
    const those = spec.schema && spec.schema[prop] || schema[prop] || schema[prop.charAt(0)];
    return those && those.kind;
  }

  function query( node, parent, prop, spec, idx ) {
    // select from <EOF> produces from: [null]
    if (node !== null || noSyntaxErrors()) {
      isObject( node, parent, prop, spec, idx );

      // eslint-disable-next-line no-nested-ternary
      const choice = (node.from !== undefined || node.columns)
        ? 'select'
        : (node.op) ? 'union' : 'none'; // from: null from parse error
      if (spec[choice])
        assertProp( node, parent, prop, spec[choice], choice );
      else
        throw new Error( `No specification for computed variant '${ choice }'${ at( [ node, parent ], prop, idx ) }` );
    }
  }

  function from( node, parent, prop, spec, idx ) {
    // select from <EOF> produces from: [null]
    if (node !== null || noSyntaxErrors()) {
      isObject( node, parent, prop, spec, idx );

      // eslint-disable-next-line no-nested-ternary
      const choice = (node.path) ? 'ref' : (node.join) ? 'join'
        : (node.query) ? 'query' : 'none';
      if (spec[choice])
        assertProp( node, parent, prop, spec[choice], choice );
      else
        throw new Error( `No specification for computed variant '${ choice }'${ at( [ node, parent ], prop, idx ) }` );
    }
  }

  function inheritSpec( spec ) {
    if (!spec.inherits)
      return spec;
    const chain = [ spec ];
    while (spec.inherits) {
      spec = schema[spec.inherits];
      chain.push( spec );
    }
    chain.reverse();
    return Object.assign( {}, ...chain );
  }

  function expression( node, parent, prop, spec, idx ) {
    // TODO CSN parser?: { val: <token>, literal: 'token' } for keywords
    if (typeof node === 'string')
      return;
    while (Array.isArray(node)) {
      // TODO: also check getOwnPropertyNames(node)
      if (node.length !== 1) {
        node.forEach( n => expression( n, parent, prop, spec ) );
        return;
      }
      [ node ] = node;
    }
    if (node == null && !noSyntaxErrors())
      return;
    isObject( node, parent, prop, spec, idx );

    const s = spec[expressionSpec(node)] || {};
    const sub = Object.assign( {}, s.inherits && schema[s.inherits], s );
    if (spec.requires && sub.requires)
      sub.requires = [ ...sub.requires, ...spec.requires ];
    if (spec.optional && sub.optional)
      sub.optional = [ ...sub.optional, ...spec.optional ];
    // console.log(expressionSpec(node) );
    (sub.test || standard)( node, parent, prop, sub, idx );
  }

  function expressionSpec( node ) {
    if (node.path)
      return 'ref';
    else if (node.literal || node.val)
      return 'val';
    else if (node.query)
      return 'query';
    else if (!node.op)
      return 'none';
    return 'op';
  }

  function args( node, parent, prop, spec ) {
    if (Array.isArray(node)) {
      if (parent.op && parent.op.val === 'xpr') // remove keywords for `xpr` expressions
        node = node.filter( a => typeof a !== 'string');
      node.forEach( (item, idx) => expression( item, parent, prop, spec, idx ) );
    }
    else if (node && typeof node === 'object' && !Object.getPrototypeOf( node )) {
      for (const n in node)
        expression( node[n], parent, prop, spec, n );
    }
    else {
      throw new Error( `Expected array or dictionary${ at( [ null, parent ], prop ) }` );
    }
  }

  function at( nodes, prop, name ) {
    // eslint-disable-next-line no-nested-ternary
    const n = name ? (typeof name === 'number' ? ` for index ${ name }` : ` for "${ name }"`) : '';
    const loc = nodes.find( o => o && typeof o === 'object' && (o.location || o.start) );
    const f = (prop) ? `${ n } in property '${ prop }'` : n;
    const l = locationString( loc && loc.location || loc || model.location );
    return (!l) ? f : `${ f } at ${ l }`;
  }

  function isDictionary( func ) {
    return function dictionary( node, parent, prop, spec ) {
      if (spec.also && spec.also.includes( node ))
        return;
      // if (!node || typeof node !== 'object' || Object.getPrototypeOf( node ))
      //   console.log(node,prop,model.$frontend)
      if (!node || typeof node !== 'object' || Object.getPrototypeOf( node ))
        throw new Error( `Expected dictionary${ at( [ null, parent ], prop ) }` );
      for (const n in node)
        func( node[n], parent, prop, spec, n );
    };
  }

  function isArray( func = standard ) {
    return function vector( node, parent, prop, spec ) {
      if (!Array.isArray(node))
        throw new Error( `Expected array${ at( [ null, parent ], prop ) }` );
      node.forEach( (item, n) => func( item, parent, prop, spec, n ) );
    };
  }

  function locationVal( func = isBoolean ) {
    return function valWithLocation( node, parent, prop, spec, name ) {
      const valSchema = { val: Object.assign( {}, spec, { test: func } ) };
      const requires = [ 'val', 'location' ];
      const optional = [ 'literal', '$inferred', '_pathHead' ];
      standard( node, parent, prop, { schema: valSchema, requires, optional }, name );
    };
  }

  function isBoolean( node, parent, prop, spec ) {
    if ((spec.also) ? spec.also.includes( node ) : (node === null))
      return;
    if (typeof node !== 'boolean')
      throw new Error( `Expected boolean or null${ at( [ node, parent ], prop ) }` );
  }

  function isNumber( node, parent, prop, spec ) {
    if (spec.also && spec.also.includes( node ))
      return;
    if (typeof node !== 'number')
      throw new Error( `Expected number${ at( [ node, parent ], prop ) }` );
  }

  function isStringOrNull( node, parent, prop, spec ) {
    if (node !== null)
      isString(node, parent, prop, spec);
  }

  function isString( node, parent, prop, spec ) {
    if (typeof node !== 'string')
      throw new Error( `Expected string${ at( [ node, parent ], prop ) }` );
      // TODO: also check getOwnPropertyNames(node)
    if (spec.enum && !spec.enum.includes( node ))
      throw new Error( `Unexpected value '${ node }'${ at( [ node, parent ], prop ) }` );
  }

  function isVal( node, parent, prop, spec ) {
    if (Array.isArray(node))
      node.forEach( (item, n) => standard( item, parent, prop, spec, n ) );
    else if (node !== null && ![ 'string', 'number', 'boolean' ].includes( typeof node ))
      throw new Error( `Expected array or simple value${ at( [ null, parent ], prop ) }` );
  }

  function isObject( node, parent, prop, spec, name ) {
    if (!node || typeof node !== 'object' || Object.getPrototypeOf( node ) !== Object.prototype)
      throw new Error( `Expected standard object${ at( [ null, parent ], prop, name ) }` );
  }

  function inDefinitions( art, parent, prop, spec, name ) {
    if (Array.isArray(art))   // do not check with redefinitions
      return;
    isObject( art, parent, prop, spec, name );
    if (stageParser) {
      if (prop === 'artifacts')
        standard( art, parent, prop, spec, name );
    }
    else if (!art.name.absolute ||
             !model.definitions[art.name.absolute] &&
             !(model.vocabularies && model.vocabularies[art.name.absolute])) {
      // TODO: sign ignored artifacts with $inferred = 'IGNORED'
      if (parent.kind === 'source' ||
          art.name.absolute && art.name.absolute.startsWith('localized.'))
        standard( art, parent, prop, spec, name );
      else
        throw new Error( `Expected definition${ at( [ art, parent ], prop, name ) }` );
    }
  }

  function isScope(node, parent, prop) {
    // artifact refs in CDL have scope:0 in XSN
    if (Number.isInteger(node))
      return;
    const validValues = [ 'typeOf', 'global', 'param' ];
    if (!validValues.includes(node))
      throw new Error( `Property '${ prop }' must be either "${ validValues.join('", "') }" or a number but was "${ node }"` );
  }

  function TODO() { /* no-op */ }
}

module.exports = assertConsistency;
