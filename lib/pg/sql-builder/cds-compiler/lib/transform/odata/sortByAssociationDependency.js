'use strict';

/**
 * In the OData transformer, managed associations produce foreign keys.
 * If an association is also a primary key, the additionally created foreign keys become also primary keys in the parent artifact.
 * Associations with partial foreign keys force other non-key elements and associations to become virtual primary keys.
 * Proper FK generation requires specific order of performing that.
 * This module provides functionality to sort managed associations according to their dependencies.
 */

const {
  forEachDefinition,
  forEachMemberRecursively
} = require('../../model/csnUtils');

const {
  isAssociationOrComposition
} = require('./utils');
const { forEach } = require('../../utils/objectUtils.js');

function buildDependenciesFor(csn, referenceFlattener, isExternalServiceMember) {

  let dependencies = {};
  forEachDefinition(csn, (def, definitionName) => {
    /** @type {CSN.Path} */
    let root = ['definitions', definitionName];
    forEachMemberRecursively(def, (element, elementName, structuralNodeName, subpath, parent) => {
      let path = root.concat(subpath);
      // go only through managed associations and compositions
      if (isAssociationOrComposition(element) && element.keys && !element.on) { // check association FKs
        let elementDependencies = []
        element.keys.forEach(iForeignKey => {
          let paths = iForeignKey.$paths;
          if (!paths) return; // invalid references can not be resolved thus no $paths -> test/odataTransformation/negative/ForeignKeys.cds
          let targetElementPath = paths[paths.length - 1];
          if (!targetElementPath) return; // TODO check why
          let targetElement = getElementForPath(csn, targetElementPath);
          if (!targetElement) { // element was moved
            targetElementPath = referenceFlattener.getElementTransition(targetElementPath);
            if (!targetElementPath) return; // TODO check why
            targetElement = getElementForPath(csn, targetElementPath);
          }
          if (targetElement && isAssociationOrComposition(targetElement)) {
            elementDependencies.push(targetElementPath);
          }
        })
        dependencies[path.join("/")] = { structuralNodeName, definitionName, elementName, element, path, parent, dependencies: elementDependencies };
      }
    }) // forEachMemberRecursively
  }, { skipArtifact: isExternalServiceMember }) // forEachDefinition

  let result = []; // final list of sorted association items
  let inResult = {}; // paths of associations which were added in the result
  let maxLoops = Object.keys(dependencies).length;
  let loops = 0;
  let done = false;
  // walk over all dependencies and add to the result if all dependents are already in the result
  while (!done) {
    if (loops > maxLoops) {
      throw Error('Failed to process the association dependencies - max loops reached');
    }
    done = true;
    let toDelete = [];
    forEach(dependencies, (name, item) => {
      let countOfUnprocessedDependents = 0;
      item.dependencies.forEach(path => {
        let spath = path.join('/');
        if (!inResult[spath]) countOfUnprocessedDependents++;
      })
      if (countOfUnprocessedDependents === 0) { // all dependents processed?
        let spath = item.path.join('/');
        if (!inResult[spath]) {
          inResult[spath] = true;
          result.push(item);
        }
        toDelete.push(name); // mark association to be removed from the processing list
      } else {
        done = false;
      }
    })
    // delete already processed associations
    toDelete.forEach(name => {
      delete dependencies[name];
    });
    loops++;
  } // while not done

  // check if all dependencies were processed
  if (Object.keys(dependencies).length !== 0) {
    throw Error('Failed to process the association dependencies - there are more dependencies left');
  }
  return result;

  function getElementForPath(node, path) {
    path.forEach(name => {
      if (!node) return;
      node = node[name];
    })
    return node;
  }

}

module.exports = buildDependenciesFor

