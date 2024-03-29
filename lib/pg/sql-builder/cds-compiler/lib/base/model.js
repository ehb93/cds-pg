'use strict';

const queryOps = {
  query: 'select',                // TODO: rename to SELECT
  union: 'union',
  intersect: 'union',
  except: 'union',
  minus: 'union',
  subquery: 'union',            // for (subquery) with ORDER BY or LIMIT/OFFSET
}

/**
 * Object of all available beta flags that will be enabled/disabled by `--beta-mode`
 * through cdsc.  Only intended for INTERNAL USE.
 * NOT to be used by umbrella, etc.
 *
 * @type {{[flag: string]: boolean}} Indicates whether it is enabled by --beta-mode or not.
 * @private
 */
const availableBetaFlags = {
  // enabled by --beta-mode
  foreignKeyConstraints: true,
  toRename: true,
  addTextsLanguageAssoc: true,
  assocsWithParams: true,
  hanaAssocRealCardinality: true,
  mapAssocToJoinCardinality: true,
  ignoreAssocPublishingInUnion: true,
  nestedProjections: true,
  enableUniversalCsn: true,
  windowFunctions: true,
  // disabled by --beta-mode
  nestedServices: false,
};

/**
 * Test for early-adaptor feature, stored in option `beta`(new-style) / `betaMode`(old-style)
 * With that, the value of `beta` is a dictionary of feature=>Boolean.
 *
 * Beta features cannot be used when options.deprecated is set.
 *
 * A feature always needs to be provided - otherwise false will be returned.
 *
 * Please do not move this function to the "option processor" code.
 *
 * @param {object} options Options
 * @param {string} feature Feature to check for
 * @returns {boolean}
 */
function isBetaEnabled( options, feature ) {
  const beta = options.beta || options.betaMode;
  return beta && typeof beta === 'object' && !options.deprecated && feature && beta[feature];
}

/**
 * Test for deprecated feature, stored in option `deprecated`.
 * With that, the value of `deprecated` is a dictionary of feature=>Boolean.
 *
 * Please do not move this function to the "option processor" code.
 *
 * @param {object} options Options
 * @param {string} feature Feature to check for
 * @returns {boolean}
 */
function isDeprecatedEnabled( options, feature ) {
  const { deprecated } = options;
  return deprecated && typeof deprecated === 'object' && deprecated[feature];
}

// Apply function `callback` to all artifacts in dictionary
// `model.definitions`.  See function `forEachGeneric` for details.
function forEachDefinition( model, callback ) {
  forEachGeneric( model, 'definitions', callback );
}

// Apply function `callback` to all members of object `obj` (main artifact or
// parent member).  Members are considered those in dictionaries `elements`,
// `enum`, `actions` and `params` of `obj`, `elements` and `enums` are also
// searched inside property `items` (array of).  See function `forEachGeneric`
// for details.
function forEachMember( construct, callback, target ) {
  let obj = construct;
  while (obj.items)
    obj = obj.items;
  forEachGeneric( target || obj, 'elements', callback );
  forEachGeneric( obj, 'enum', callback );
  forEachGeneric( obj, 'foreignKeys', callback );
  forEachGeneric( construct, 'actions', callback );
  forEachGeneric( construct, 'params', callback );
  if (construct.returns)
    callback( construct.returns, '', 'params' );

}

// Apply function `callback(member, memberName, prop)` to each member in
// `construct`, recursively (i.e. also for sub-elements of elements).
function forEachMemberRecursively( construct, callback ) {
  forEachMember( construct, ( member, memberName, prop ) => {
    callback( member, memberName, prop );
    // Descend into nested members, too
    forEachMemberRecursively( member, callback );
  });
  // If 'construct' has more than one query, descend into the elements of the remaining ones, too
  if (construct.$queries && construct.$queries.length > 1) {
    construct.$queries.slice(1).forEach(query => forEachMemberRecursively(query, callback));
  }
}

/**
 * Apply function `callback` to all members of object `obj` (main artifact or
 * parent member).  Members are considered those in dictionaries `elements`,
 * `enum`, `actions` and `params` of `obj`, `elements` and `enums` are also
 * searched inside property `items` (array of).  `$queries`, `mixin` and
 * `columns` are also visited in contrast to `forEachMember()`.
 * See function `forEachGeneric()` for details.
 *
 * @param {XSN.Artifact} construct
 * @param {(member: object, memberName: string, prop: string) => any} callback
 * @param {object} [target]
 */
function forEachMemberWithQuery( construct, callback, target ) {
  let obj = construct.returns || construct; // why the extra `returns` for actions?
  obj = obj.items || obj;
  forEachGeneric( target || obj, 'elements', callback );
  forEachGeneric( obj, 'enum', callback );
  forEachGeneric( obj, 'foreignKeys', callback );
  forEachGeneric( construct, 'actions', callback );
  forEachGeneric( construct, 'params', callback );
  // For Queries
  forEachGeneric( construct, '$queries', callback );
  forEachGeneric( construct, 'mixin', callback );
  forEachGeneric( construct, 'columns', callback );
}

/**
 * Apply function `callback(member, memberName, prop)` to each member in
 * `construct`, recursively (i.e. also for sub-elements of elements).
 * In contrast to `forEachMemberRecursively()` this function also traverses
 * queries and mixins.
 *
 * @param {XSN.Artifact} construct
 * @param {(member: object, memberName: string, prop: string) => any} callback
 */
function forEachMemberRecursivelyWithQuery( construct, callback ) {
  forEachMemberWithQuery( construct, ( member, memberName, prop ) => {
    callback( member, memberName, prop );
    // Descend into nested members, too
    forEachMemberRecursivelyWithQuery( member, callback );
  });
}

// Apply function `callback` to all objects in dictionary `dict`, including all
// duplicates (found under the same name).  Function `callback` is called with
// the following arguments: the object, the name, and -if it is a duplicate-
// the array index and the array containing all duplicates.
function forEachGeneric( obj, prop, callback ) {
  let dict = obj[prop];
  for (let name in dict) {
    let obj = dict[name];
    callback( obj, name, prop );
    if (Array.isArray(obj.$duplicates)) // redefinitions
      obj.$duplicates.forEach( o => callback( o, name, prop ) )
  }
}

const forEachInOrder = forEachGeneric;

/**
 * Like `obj.prop = value`, but not contained in JSON / CSN
 * It's important to set enumerable explicitly to false (although 'false' is the default),
 * as else, if the property already exists, it keeps the old setting for enumerable.
 *
 * @param {object} obj
 * @param {string} prop
 * @param {any} value
 */
function setProp (obj, prop, value) {
  let descriptor = { value, configurable: true, writable: true, enumerable: false };
  Object.defineProperty( obj, prop, descriptor );
  return value;
}


module.exports = {
  isBetaEnabled,
  availableBetaFlags,
  isDeprecatedEnabled,
  queryOps,
  forEachDefinition,
  forEachMember,
  forEachMemberRecursively,
  forEachMemberWithQuery,
  forEachMemberRecursivelyWithQuery,
  forEachGeneric,
  forEachInOrder,
  setProp,
};
