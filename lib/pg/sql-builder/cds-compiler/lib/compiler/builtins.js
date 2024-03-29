// The builtin artifacts of CDS

'use strict';

const { forEachInDict } = require('../base/dictionaries');
const { builtinLocation } = require('../base/location');
const { setProp } = require('../base/model');

const core = {
  String: { parameters: [ 'length' ], category: 'string' },
  LargeString: { category: 'string' },
  Binary: { parameters: [ 'length' ], category: 'binary' },
  LargeBinary: { category: 'binary' },
  Decimal: { parameters: [ 'precision', 'scale' ], category: 'decimal' },
  DecimalFloat: { category: 'decimal', deprecated: true },
  Integer64: { category: 'integer' },
  Integer: { category: 'integer' },
  Double: { category: 'decimal' },
  Date: { category: 'dateTime' },
  Time: { category: 'dateTime' },
  DateTime: { category: 'dateTime' },
  Timestamp: { category: 'dateTime' },
  Boolean: { category: 'boolean' },
  UUID: { category: 'string' },
  Association: { internal: true, category: 'relation' },
  Composition: { internal: true, category: 'relation' },
};

const coreHana = {
  // ALPHANUM: { parameters: [ 'length' ] },
  SMALLINT: { category: 'integer' },
  TINYINT: { category: 'integer' },
  SMALLDECIMAL: { category: 'decimal' },
  REAL: { category: 'decimal' },
  CHAR: { parameters: [ 'length' ], category: 'string' },
  NCHAR: { parameters: [ 'length' ], category: 'string' },
  VARCHAR: { parameters: [ 'length' ], category: 'string' },
  CLOB: { category: 'string' },
  BINARY: { parameters: [ 'length' ], category: 'binary' },
  // TODO: probably remove default for ST_POINT, ST_GEOMETRY (to be done in backend);
  ST_POINT: { parameters: [ { name: 'srid', literal: 'number', val: 0 } ], category: 'geo' },
  ST_GEOMETRY: { parameters: [ { name: 'srid', literal: 'number', val: 0 } ], category: 'geo' },
};

// const hana = {
//   BinaryFloat: {},
//   LocalDate: {},
//   LocalTime: {},
//   UTCDateTime: {},
//   UTCTimestamp: {},
//   WithStructuredPrivilegeCheck: { kind: 'annotation' },
//   hana: { kind: 'context' },
// };

/**
 * Functions without parentheses in CDL (common standard SQL-92 functions)
 * (do not add more - make it part of the SQL renderer to remove parentheses for
 * other funny SQL functions like CURRENT_UTCTIMESTAMP).
 */

const functionsWithoutParens = [
  'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
  'CURRENT_USER', 'SESSION_USER', 'SYSTEM_USER',
];

const specialFunctions = {
  ROUND: [
    null, null, {               // 3rd argument: rounding mode
      ROUND_HALF_UP: 'argFull',
      ROUND_HALF_DOWN: 'argFull',
      ROUND_HALF_EVEN: 'argFull',
      ROUND_UP: 'argFull',
      ROUND_DOWN: 'argFull',
      ROUND_CEILING: 'argFull',
      ROUND_FLOOR: 'argFull',
    },
  ],
};

/**
 * Variables that have special meaning in CDL/CSN.
 */
const magicVariables = {
  $user: {
    elements: { id: {}, locale: {} },
    // Allow $user.<any>
    $uncheckedElements: true,
    // Allow shortcut in CDL: `$user` becomes `$user.id` in CSN.
    $autoElement: 'id',
  },                  // CDS-specific, not part of SQL
  $at: {
    elements: {
      from: {}, to: {},
    },
  },
  $now: {},                   // Dito
  $session: {
    // In ABAP CDS session variables are accessed in a generic way via
    // the pseudo variable $session.
    $uncheckedElements: true,
  },
};

// see lib/render/renderUtil.js for DB-specific magic vars, specified in CAP Cds via function

/** All types belong to one category. */
const typeCategories = {
  string: [],
  integer: [],
  dateTime: [],
  time: [],
  decimal: [],
  binary: [],
  boolean: [],
  relation: [],
  geo: [],
};
// Fill type categories with `cds.*` types
Object.keys(core).forEach((type) => {
  if (core[type].category)
    typeCategories[core[type].category].push(`cds.${ type }`);
});
// Fill type categories with `cds.hana.*` types
Object.keys(coreHana).forEach((type) => {
  if (coreHana[type].category)
    typeCategories[coreHana[type].category].push(`cds.hana.${ type }`);
});

/** @param {string} typeName */
function isIntegerTypeName(typeName) {
  return typeCategories.integer.includes(typeName);
}
/** @param {string} typeName */
function isDecimalTypeName(typeName) {
  return typeCategories.decimal.includes(typeName);
}
/** @param {string} typeName */
function isNumericTypeName(typeName) {
  return isIntegerTypeName(typeName) || isDecimalTypeName(typeName);
}
/** @param {string} typeName */
function isStringTypeName(typeName) {
  return typeCategories.string.includes(typeName);
}
/** @param {string} typeName */
function isDateOrTimeTypeName(typeName) {
  return typeCategories.dateTime.includes(typeName);
}
/** @param {string} typeName */
function isBooleanTypeName(typeName) {
  return typeCategories.boolean.includes(typeName);
}
/** @param {string} typeName */
function isBinaryTypeName(typeName) {
  return typeCategories.binary.includes(typeName);
}
/** @param {string} typeName */
function isGeoTypeName(typeName) {
  return typeCategories.geo.includes(typeName);
}
/**
 * Whether the given type name is a relation, i.e. an association or composition.
 *
 * @param {string} typeName
 */
function isRelationTypeName(typeName) {
  return typeCategories.relation.includes(typeName);
}

/**
 * Add CDS builtins like the `cds` namespace with types like `cds.Integer` to
 * `definitions` of the XSN model as well as to `$builtins`.
 *
 * @param {XSN.Model} model XSN model without CDS builtins
 */
function initBuiltins( model ) {
  setMagicVariables( magicVariables );
  // namespace:"cds" stores the builtins ---
  const cds = createNamespace( 'cds', 'reserved' );
  // setProp( model.definitions, 'cds', cds );
  model.definitions.cds = cds; // not setProp - oData - TODO: still needed?
  // Also add the core artifacts to model.definitions`
  model.$builtins = env( core, 'cds.', cds );
  model.$builtins.cds = cds;
  // namespace:"cds.hana" stores HANA-specific builtins ---
  const hana = createNamespace( 'cds.hana', 'reserved' );
  setProp( model.definitions, 'cds.hana', hana );
  model.$builtins.hana = hana;
  cds._subArtifacts.hana = hana;
  env( coreHana, 'cds.hana.', hana );
  // namespace:"localized" stores localized convenience views ---
  const localized = createNamespace( 'localized', true );
  model.definitions.localized = localized;
  model.$internal = { $frontend: '$internal' };
  return;

  function createNamespace( name, builtin ) {
    const art = {
      kind: 'namespace',
      // builtin namespaces don't have a cds file, so no location available
      name: { absolute: name, location: builtinLocation() },
      blocks: [],
      builtin,
      location: builtinLocation(),
    };
    setProp( art, '_subArtifacts', Object.create(null) );
    return art;
  }

  /**
   * Insert the builtins into the parent's `_subArtifacts` dictionary without the
   * prefix and into the model's `definitions` dictionary prefixed.
   *
   * @param {object} builtins Object containing the builtin types.
   * @param {string} prefix Type prefix, e.g. 'cds.'
   * @param {object} parent
   * @returns {object} Artifacts dictionary with the builtin artifacts without prefixes.
   */
  function env( builtins, prefix, parent ) {
    const artifacts = Object.create(null);
    for (const name of Object.keys( builtins )) {
      const absolute = prefix + name;
      const art = {
        kind: 'type', builtin: true, name: { absolute }, type: { path: [ { id: absolute } ] },
      };
      setProp( art.type, '_artifact', art );
      if (parent)
        parent._subArtifacts[name] = art;
      setProp( art, '_effectiveType', art );
      setProp( art, '_deps', [] );
      Object.assign( art, builtins[name] );
      if (!art.internal)
        artifacts[name] = art;
      setProp( model.definitions, absolute, art );
    }
    return artifacts;
  }

  function setMagicVariables( builtins ) {
    const artifacts = Object.create(null);
    for (const name in builtins) {
      const magic = builtins[name];
      // TODO: rename to $builtinFunction
      const art = { kind: 'builtin', name: { id: name, element: name } };
      artifacts[name] = art;
      if (magic.elements)
        art.elements = forEachInDict( magic.elements, (e, n) => magicElement( e, n, art ));
      if (magic.$autoElement)
        art.$autoElement = magic.$autoElement;
      if (magic.$uncheckedElements)
        art.$uncheckedElements = magic.$uncheckedElements;
      // setProp( art, '_effectiveType', art );
    }
    model.$magicVariables = { kind: '$magicVariables', artifacts };
  }

  function magicElement( spec, name, parent ) {
    const magic = {
      kind: 'builtin',
      name: { id: name, element: `${ parent.name.element }.${ name }` },
    };
    setProp( magic, '_parent', parent );
    // setProp( magic, '_effectiveType', magic );
    return magic;
  }
}

module.exports = {
  functionsWithoutParens,
  specialFunctions,
  initBuiltins,
  isIntegerTypeName,
  isDecimalTypeName,
  isNumericTypeName,
  isStringTypeName,
  isDateOrTimeTypeName,
  isBooleanTypeName,
  isBinaryTypeName,
  isGeoTypeName,
  isRelationTypeName,
};
