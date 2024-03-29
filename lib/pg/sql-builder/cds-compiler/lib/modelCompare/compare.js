'use strict';

const { makeMessageFunction } = require('../base/messages');
const {
  forEachDefinition,
  forEachMember,
  hasAnnotationValue
} = require('../model/csnUtils');

/**
 * Compares two models, in HANA-transformed CSN format, to each other.
 *
 * @param beforeModel the before-model
 * @param afterModel the after-model
 * @param {hdiOptions|false} options
 * @returns {object} the sets of deletions, extensions, and migrations of entities necessary to transform the before-model
 * to the after-model, together with all the definitions of the after-model
 */
function compareModels(beforeModel, afterModel, options) {
  if(!(options && options.testMode)) // no $version with testMode
    validateCsnVersions(beforeModel, afterModel, options);

  const deletedEntities = Object.create(null);
  const elementAdditions = [];
  const migrations = []; // element changes/removals or changes of entity properties

  // There is currently no use in knowing the added entities only. If this changes, hand in `addedEntities` to `getArtifactComparator` below.
  forEachDefinition(afterModel, getArtifactComparator(beforeModel, null, null, elementAdditions, migrations));
  forEachDefinition(beforeModel, getArtifactComparator(afterModel, null, deletedEntities, null, null));

  const returnObj = Object.create(null);
  returnObj.definitions = afterModel.definitions;
  returnObj.deletions = deletedEntities;
  returnObj.extensions = elementAdditions;
  returnObj.migrations = migrations;
  return returnObj;
}

function validateCsnVersions(beforeModel, afterModel, options) {
  const beforeVersion = beforeModel.$version;
  const afterVersion = afterModel.$version;
  let beforeVersionParts = beforeVersion && beforeVersion.split('.');
  let afterVersionParts = afterVersion && afterVersion.split('.');

  if (!beforeVersionParts || beforeVersionParts.length < 2) {
    const { error, throwWithError } = makeMessageFunction(beforeModel, options, 'modelCompare');
    error(null, null, `Invalid CSN version: ${beforeVersion}`);
    throwWithError();
  }
  if (!afterVersionParts || afterVersionParts.length < 2) {
    const { error, throwWithError } = makeMessageFunction(afterModel, options, 'modelCompare');
    error(null, null, `Invalid CSN version: ${afterVersion}`);
    throwWithError();
  }
  if (beforeVersionParts[0] > afterVersionParts[0] && !(options && options.allowCsnDowngrade)) {
    const { error, throwWithError } = makeMessageFunction(afterModel, options, 'modelCompare');
    error(null, null, `Incompatible CSN versions: ${afterVersion} is a major downgrade from ${beforeVersion}. Is @sap/cds-compiler version ${require('../../package.json').version} outdated?`);
    throwWithError();
  }
}

function getArtifactComparator(otherModel, addedEntities, deletedEntities, elementAdditions, migrations) {
  return function compareArtifacts(artifact, name) {
    function addElements() {
      const elements = {};
      forEachMember(artifact, getElementComparator(otherArtifact, elements));
      if (Object.keys(elements).length > 0) {
        elementAdditions.push(addedElements(name, elements));
      }
    }
    function changePropsOrRemoveOrChangeElements() {
      const relevantProperties = ['doc'];
      const changedProperties = {};

      const removedElements = {};
      const changedElements = {};

      const migration = { migrate: name };

      relevantProperties.forEach(prop => {
        if (artifact[prop] !== otherArtifact[prop]) {
          changedProperties[prop] = changedElement(artifact[prop], otherArtifact[prop] || null);
        }
      });
      if (Object.keys(changedProperties).length > 0) {
        migration.properties = changedProperties;
      }

      forEachMember(otherArtifact, getElementComparator(artifact, removedElements));
      if (Object.keys(removedElements).length > 0) {
        migration.remove = removedElements;
      }

      forEachMember(artifact, getElementComparator(otherArtifact, null, changedElements));
      if (Object.keys(changedElements).length > 0) {
        migration.change = changedElements;
      }

      if (migration.properties || migration.remove || migration.change) {
        migrations.push(migration);
      }
    }

    const otherArtifact = otherModel.definitions[name];
    const isPersisted = isPersistedAsTable(artifact);
    const isPersistedOther = otherArtifact && isPersistedAsTable(otherArtifact);

    if (deletedEntities) {
      // Looking for deleted entities only.
      // Arguments are interchanged in this case: `artifact` from beforeModel and `otherArtifact` from afterModel.
      if (isPersisted && !isPersistedOther) {
        deletedEntities[name] = artifact;
      }
      return;
    }

    // Looking for added entities and added/deleted/changed elements.
    // Parameters: `artifact` from afterModel and `otherArtifact` from beforeModel.

    if (!isPersisted) {
      // Artifact not persisted in afterModel.
      return;
    }

    if (!isPersistedOther) {
      if (addedEntities) {
        addedEntities[name] = artifact;
      }
      return;
    }

    // Artifact changed?

    if (elementAdditions) {
      addElements();
    }
    if (migrations) {
      changePropsOrRemoveOrChangeElements();
    }
  };
}

function isPersistedAsTable(artifact) {
  return artifact.kind === 'entity'
      && !artifact._ignore
      && !artifact.abstract
      && (!artifact.query && !artifact.projection || hasAnnotationValue(artifact, '@cds.persistence.table'))
      && !hasAnnotationValue(artifact, '@cds.persistence.skip')
      && !hasAnnotationValue(artifact, '@cds.persistence.exists');
}

function getElementComparator(otherArtifact, addedElements = null, changedElements = null) {
  return function compareElements(element, name) {
    if (element._ignore) {
      return;
    }

    const otherElement = otherArtifact.elements[name];
    if (otherElement && !otherElement._ignore) {
      // Element type changed?
      if (!changedElements) {
        return;
      }
      if (relevantTypeChange(element.type, otherElement.type) || typeParametersChanged(element, otherElement)) {
        // Type or parameters, e.g. association target, changed.
        changedElements[name] = changedElement(element, otherElement);
      }

      return;
    }

    if (addedElements) {
      addedElements[name] = element;
    }
  }
}

function relevantTypeChange(type, otherType) {
  return otherType !== type && ![type, otherType].every(t => ['cds.Association', 'cds.Composition'].includes(t));
}

/**
 * Returns whether two things are deeply equal.
 * Function-type things are compared in terms of identity,
 * object-type things in terms of deep equality of all of their properties,
 * all other things in terms of strict equality (===).
 *
 * @param a {any} first thing
 * @param b {any} second thing
 * @param include {function} function of a key and a depth, returning true if and only if the given key at the given depth is to be included in comparison
 * @param depth {number} the current depth in property hierarchy below each of the original arguments (positive, counting from 0; don't set)
 * @returns {boolean}
 */
function deepEqual(a, b, include = () => true, depth = 0) {
  function isObject(x) {
    return x !== null && typeof x === 'object';
  }
  function samePropertyCount() {
    return Object.keys(a).length === Object.keys(b).length;
  }
  function allPropertiesEqual() {
    return Object.keys(a).reduce((prev, key) => prev && (!include(key, depth) || deepEqual(a[key], b[key], include, depth + 1)), true);
  }

  return isObject(a)
      ? isObject(b)
          ? samePropertyCount() && allPropertiesEqual()
          : false
      : a === b;
}

/**
 * Returns whether any type parameters differ between two given elements. Ignores whether types themselves differ (`type` property).
 * @param element {object} an element
 * @param otherElement {object} another element
 * @returns {boolean}
 */
function typeParametersChanged(element, otherElement) {
  return !deepEqual(element, otherElement, (key, depth) => !(depth === 0 && key === 'type'));
}

function addedElements(entity, elements) {
  return {
    extend: entity,
    elements
  };
}

function changedElement(element, otherElement) {
  return {
    old: otherElement,
    new: element
  };
}

module.exports = {
  compareModels,
  deepEqual
};
