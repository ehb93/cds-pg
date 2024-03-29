'use strict';
const {setDependencies} = require('./csnUtils');

/**
 * @typedef {Object} Layers
 * @property {Array[]} layers - An array of arrays, each subarray encompassing one Layer - L0 being layers[0].
 * @property {CSN.Artifact[]} leftover - Any artifacts not sorted into a layer due to unmet dependencies - points to there being some error.
 */

/**
 * Sort the given CSN into layers. Layer 0 contains artifacts without any dependencies,
 * L1 contains artifacts with dependencies exclusively to artifacts in L0, L2 contains artifacts
 * with dependencies exclusively to artifacts in L0 and L1, LN contains artifacts with dependencies
 * exclusively to LN-1,..,L0
 *
 * @param {CSN.Model} csn CSN to sort
 * @param {Symbol} _dependents Symbol used to attach the dependents
 * @param {Symbol} _dependencies Symbol used to attach the dependencies
 * @returns {Layers}
 */
function sortTopologically(csn, _dependents, _dependencies){
  const layers = [];
  let { zero, nonZero } = calculateDepth(Object.entries(csn.definitions));
  while (zero.length !== 0){
    const currentLayer = [];
    zero.forEach(([artifactName, artifact]) => {
      currentLayer.push(artifactName);
      if(artifact[_dependents]) {
        Object.values(artifact[_dependents]).forEach((dependant) => {
          dependant.$pointers = dependant.$pointers - 1;
          dependant[_dependencies].delete(artifact);
        });
      }
    });
    layers.push(currentLayer);
    ({zero, nonZero} = findWithXPointers(nonZero, 0));
  }

  return { layers, leftover: nonZero };

  function calculateDepth(definitionsArray) {
    const zero = [];
    const nonZero = [];

    definitionsArray.forEach(([artifactName, artifact]) => {
      if(artifact[_dependencies]) {
        artifact.$pointers = artifact[_dependencies].size;
        nonZero.push([artifactName, artifact]);
      } else {
        artifact.$pointers = 0;
        zero.push([artifactName, artifact]);
      }
    });
    return {
      zero,
      nonZero
    }
  }

  function findWithXPointers(definitionsArray, x=0){
    const zero = [];
    const nonZero = [];

    definitionsArray.forEach(([artifactName, artifact]) => {
      if(artifact.$pointers !== undefined && artifact.$pointers === x) {
        zero.push([artifactName, artifact]);
      } else {
        nonZero.push([artifactName, artifact]);
      }
    });

    return {
      zero,
      nonZero
    }
  }
}

/**
 * Sort the given sql statements so that they can be deployed sequentially.
 * For ordering, only the FROM clause of views is checked - this requires A2J to
 * be run beforehand to resovle association usages.
 *
 * @param {object} sql Map of <object name>: "CREATE STATEMENT"
 *
 * @returns {{name: string, sql: string}[]} Sorted array of artifact name / "CREATE STATEMENTS" pairs
 *
 */
module.exports = function({sql, csn}){
  const {cleanup, _dependents, _dependencies} = setDependencies(csn);
  const { layers, leftover } = sortTopologically(csn, _dependents, _dependencies);
  cleanup.forEach(fn => fn());
  if(leftover.length > 0)
    throw new Error('Unable to build a correct dependency graph! Are there cycles?');

  const result = [];
  // keep the "artifact name" - needed for to.hdi sorting
  layers.forEach(layer => layer.forEach(objName => result.push({name: objName, sql: sql[objName]})));
  return result;
}
