'use strict';

/**
 * Copy "property" from the source object to the target object.
 * Only if it exists in the source object (using "in" operator).
 *
 * @param {object} sourceObj
 * @param {string} property
 * @param {object} targetObj
 */
function copyPropIfExist(sourceObj, property, targetObj) {
  if (sourceObj && property in sourceObj)
    targetObj[property] = sourceObj[property];
}

/**
 * Takes an object and creates a dictionary out of it.
 * This avoid cases where e.g. properties named "toString" are interpreted
 * as JS internal functions.
 *
 * @param {object} obj Object with prototype.
 * @return {object} Object without prototype, i.e. a dict.
 */
function createDict(obj) {
  const dict = Object.create(null);
  const keys = Object.keys(obj);
  for (const key of keys)
    dict[key] = obj[key];
  return dict;
}

/**
 * Loops over all elements in an object and calls the specified callback(key,obj)
 *
 * @param {object} obj
 * @param {(string, object) => void} callback
 */
function forEach(obj, callback) {
  for (const key in obj) {
    if (Object.hasOwnProperty.call(obj, key))
      callback(key, obj[key]);
  }
}

module.exports = {
  copyPropIfExist,
  createDict,
  forEach,
};
