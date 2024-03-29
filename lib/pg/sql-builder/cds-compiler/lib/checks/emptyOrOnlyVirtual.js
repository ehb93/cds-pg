'use strict';

const { isPersistedOnDatabase } = require('../model/csnUtils.js');
// Only to be used with validator.js - a correct this value needs to be provided!
// not relevant for odata - entities need to be checked at the end of the transformation
/**
 * Ensure that empty/only virtual entities do not reach the db.
 *
 * @param {CSN.Artifact} artifact Artifact to validate
 * @param {string} artifactName Name of the artifact
 * @param {string} prop Property being looped over
 * @param {CSN.Path} path Path to the artifact
 */
function validateEmptyOrOnlyVirtual(artifact, artifactName, prop, path) {
  if (artifact.kind === 'entity' && !artifact.query && isPersistedOnDatabase(artifact)) {
    if (!artifact.elements || !hasRealElements(artifact.elements))
      this.error(null, path, "Artifacts containing only virtual or empty elements can't be deployed");
  }
}

/**
 * Check if the provided elements contain elements that will be created on the db.
 *
 * @param {CSN.Elements} elements Elements to look through
 * @returns {boolean} True if something would be created on the db from these elements.
 */
function hasRealElements(elements) {
  for (const element of Object.values(elements)) {
    if (!element.virtual) {
      if (element.elements) {
        if (hasRealElements(element.elements))
          return true;
      }
      else {
        return true;
      }
    }
  }

  return false;
}


module.exports = validateEmptyOrOnlyVirtual;
