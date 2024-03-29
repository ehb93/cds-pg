'use strict';

const { forEachGeneric } = require('../model/csnUtils');

// Only to be used with validator.js - a correct this value needs to be provided!

/**
 * Validate select items of a query.
 *
 * @param {CSN.Query} query query object
 */
function validateSelectItems(query) {
  const { SELECT } = query;
  if (!SELECT)
    return;

  forEachGeneric(SELECT, 'columns', (selectItem) => {
    if (selectItem.ref && (selectItem.ref[0] === '$self' || selectItem.ref[0] === '$projection')) {
      const pathStepWithTarget = selectItem._links.slice(1).find(link => link.art.target);
      if (pathStepWithTarget) {
        this.error(null, selectItem.$path,
                   { name: selectItem.ref[0], type: pathStepWithTarget.art.type },
                   'Select items starting with $(NAME) must not contain path steps of type $(TYPE)');
      }
    }
  });
  // .call() with 'this' to ensure we have access to the options
  rejectManagedAssociationsAndStructuresForHdbcsNames.call(this, SELECT, SELECT.$path);
}


/**
 * For the to.hdbcds transformation with naming mode 'hdbcds', structures and managed associations are not flattened/resolved.
 * It is therefore not possible to publish such elements in a view.
 * This function iterates over all published elements of a query artifact and asserts that no such elements are published.
 *
 * @param {CSN.Artifact} queryArtifact the query artifact which should be checked
 * @param {CSN.Path} artifactPath the path to that artifact
 */
function rejectManagedAssociationsAndStructuresForHdbcsNames(queryArtifact, artifactPath) {
  if (this.options.transformation === 'hdbcds' && this.options.sqlMapping === 'hdbcds') {
    forEachGeneric(queryArtifact, 'elements', (selectItem, elemName, prop, elementPath) => {
      if (this.csnUtils.isManagedAssociationElement(selectItem))
        this.error('query-unexpected-assoc-hdbcds', elementPath);
      if (this.csnUtils.isStructured(selectItem))
        this.error('query-unexpected-structure-hdbcds', elementPath);
    }, artifactPath);
  }
}

module.exports = { validateSelectItems, rejectManagedAssociationsAndStructuresForHdbcsNames };
