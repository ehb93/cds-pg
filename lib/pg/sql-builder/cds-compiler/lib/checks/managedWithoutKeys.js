'use strict';


/**
 * Trigger a recompilation in case of an association without .keys and without .on
 *
 * @param {CSN.Element} member the element to be checked
 * @param {string} memberName the elements name
 * @param {string} prop which kind of member are we looking at -> only prop "elements"
 */
function managedWithoutKeys(member, memberName, prop) {
  if (prop === 'elements' && member.target && !member.keys && !member.on) { // trigger recompilation
    throw new Error('Expected association to have either an on-condition or foreign keys.');
  }
}

module.exports = managedWithoutKeys;
