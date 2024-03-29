'use strict';

/**
 * The module handles the processing of foreign key for managed associations.
 */

const { copyAnnotations } = require('../../model/csnUtils');
const sortByAssociationDependency = require('./sortByAssociationDependency');
const { flattenStructure } = require('./structureFlattener');
const { setProp } = require('../../base/model');
const { implicitAs } = require('../../model/csnRefs');

/**
 *
 * @param {CSN.Model} csn
 * @param {*} options
 * @param {*} referenceFlattener
 * @param {*} csnUtils
 * @param {object} error;
 */
module.exports = function (csn, options, referenceFlattener, csnUtils, error, isExternalServiceMember) {

  const structuredOData = options.toOdata.odataFormat === 'structured' && options.toOdata.version === 'v4';
  const flatKeys = !structuredOData || (structuredOData && options.toOdata.odataForeignKeys);

  // sort all associations by their dependencies
  const sortedAssociations = sortByAssociationDependency(csn, referenceFlattener, isExternalServiceMember);

  // generate foreign keys
  processSortedAssociations(sortedAssociations, flatKeys);


  function processSortedAssociations(sortedAssociations, flatKeys,) {
    // The map will collect all generated foreign key names for the specific path
    let generatedForeignKeyNamesForPath = Object.create(null); // map<path,[key-name]>

    sortedAssociations.forEach(item => {
      const { definitionName, structuralNodeName, elementName, element, parent, path } = item;

      if (csnUtils.isManagedAssociationElement(element) && element.keys) {
        if (flatKeys) // tackling the ref value in assoc.keys
          takeoverForeignKeysOfTargetAssociations(element, path, generatedForeignKeyNamesForPath);
        // TODO: move in separate function
        fixCardinality(element);
      }

      let arrayOfGeneratedForeignKeyNames = generateForeignKeys(definitionName, structuralNodeName, elementName, element, parent, path);
      generatedForeignKeyNamesForPath[item.path.join('/')] = arrayOfGeneratedForeignKeyNames;
    })

  }

  /**
   * if a key is an association and it poins to another association,
   * the foreign keys of the target association become primary keys
   * in the current association
   */
  function takeoverForeignKeysOfTargetAssociations(assoc, path, generatedForeignKeyNamesForPath) {
    let newResult = [];
    assoc.keys.forEach( (key, keyIndex) => {
      let keyPath = path.concat('keys', keyIndex);
      let resolved = csnUtils.inspectRef(keyPath)
      let targetElement = resolved.art;
      if (targetElement) {
        if (csnUtils.isAssociation(targetElement.type)) {
          // association key
          expandAssociationKey(key);
        } else {
          newResult.push(key);
        }
      } else {
        // target element does not exist, warning is already reported, pass the key anyway
        newResult.push(key);
      }
    });

    function expandAssociationKey(key) {
      let paths = key.$paths;
      if (!paths) return;
      let lastPath = paths[paths.length - 1];
      let transitionPath = referenceFlattener.getElementTransition(lastPath)
      if (transitionPath)
        lastPath = transitionPath;
      let generatedKeys = generatedForeignKeyNamesForPath[lastPath.join('/')];
      if (!generatedKeys) return;
      generatedKeys.forEach(fkName => {
        let newFkRef = { ref: [fkName] };
        if (key.as) {
          let alias = fkName.replace(key.ref[0], key.as);
          setProp(newFkRef, 'as', alias);
        }
        newResult.push(newFkRef);
      })
    } // expandAssociationKey

    assoc.keys = newResult;

  }

  function fixCardinality(assoc) {
    if (assoc.notNull) {
      if (!assoc.cardinality) {
        assoc.cardinality = {};
      }
      if (assoc.cardinality.min === undefined) {
        assoc.cardinality.min = 1;
      }
    }
  }

  /**
   * Generates foreign keys and returns their names as an array
   */
  function generateForeignKeys(definitionName, structuralNodeName, assocName, assoc, parent, path) {
    let foreignKeyElements = Object.create(null);

    // First, loop over the keys array of the association and generate the FKs.
    // The result of all the FKs for the given association is accumulated
    // in the 'foreignKeyElements' dictionary
    assoc.keys.forEach( (key, keyIndex) => {
      let keyPath = path.concat('keys', keyIndex);

      let foreignKeyElementsForKey = generateForeignKeysForRef(assoc, assocName, key, keyPath);
      Object.assign(foreignKeyElements, foreignKeyElementsForKey);
    });

    // After that, add the new elements to the definition.
    // At the same time:
    //    -> Check for coliding element's name
    //      &
    //    -> Propagate annotations from the association
    if (parent.items) // proceed to items of such
      parent = parent.items;
    if (parent.returns)
      parent = parent.returns.items || parent.returns;

    const dictionary = parent[structuralNodeName];
    let currElementsNames = Object.keys(parent[structuralNodeName]);
    for (const [foreignKeyName, foreignKey] of Object.entries(foreignKeyElements)) {
      copyAnnotations(assoc, foreignKey, true);
      // Insert artificial element into artifact, with all cross-links
      if (dictionary[foreignKeyName]) {
        if (!(dictionary[foreignKeyName]['@odata.foreignKey4'] || isDeepEqual(dictionary[foreignKeyName], foreignKey))) {
          const path = dictionary[foreignKeyName].$path;
          error(null, path, { name: foreignKeyName, art: assocName }, 'Generated foreign key element $(NAME) for association $(ART) conflicts with existing element');
        }
      }
    }

    // make sure the generated foreign key(s) is added right after the association (that it belongs to) in the elements dictionary
    const assocIndex = currElementsNames.findIndex(elemName => elemName === assocName);
    // if (flatKeys)
    currElementsNames.splice(assocIndex + 1, 0, ...Object.keys(foreignKeyElements));

    parent[structuralNodeName] = currElementsNames.reduce((previous, name) => {
      previous[name] = dictionary[name] || foreignKeyElements[name];
      return previous;
    }, Object.create(null));

    return Object.keys(foreignKeyElements);
  }

  // FIXME: Very similar code to
  // transformUtilsNew::getForeignKeyArtifact & createForeignKeyElement
  // Can this be streamlined?
  function generateForeignKeysForRef(assoc, assocName, foreignKeyRef, pathInKeysArr, foreignKey4 = assocName) {
    // in structured OData, might be more than one generated FKs
    let generatedFks = Object.create(null);
    const fkArtifact = csnUtils.inspectRef(pathInKeysArr).art;
    if(fkArtifact) {
      if (csnUtils.isStructured(fkArtifact)) {
        processStucturedKey(fkArtifact, assocName, foreignKeyRef);
      } else {
      // built-in
        const foreignKeyElementName = `${assocName.replace(/\./g, '_')}_${foreignKeyRef.as || foreignKeyRef.ref.join('_')}`;
        newForeignKey(fkArtifact, foreignKeyElementName);
      }
    }

    return generatedFks;

    function processStucturedKey(fkArtifact, assocName, foreignKeyRef) {
      const subStruct = fkArtifact.elements ? fkArtifact : csnUtils.getFinalBaseType(fkArtifact.type);
      const flatElements = flattenStructure(subStruct.elements, subStruct.$path, csnUtils, options, error, undefined, fkArtifact.$path.slice(-1) || []).newFlatElements;
      for (const [flatElemName, flatElem] of Object.entries(flatElements)) {
        const foreignKeyElementName =
          `${assocName.replace(/\./g, '_')}_${foreignKeyRef.as ? flatElemName.replace(implicitAs(foreignKeyRef.ref), foreignKeyRef.as) : flatElemName}`;
        newForeignKey(flatElem, foreignKeyElementName);
      }
    }

    function newForeignKey(fkArtifact, foreignKeyElementName) {
      if (fkArtifact.type === 'cds.Association' || fkArtifact.type === 'cds.Composition') {
        processAssociationOrComposition(fkArtifact, foreignKeyElementName);
        return;
      }

      // FIXME: better use transformUtlsNew::createRealFK(...);
      let foreignKeyElement = Object.create(null);

      // Transfer selected type properties from target key element
      // FIXME: There is currently no other way but to treat the annotation '@odata.Type' as a type property.
      for (let prop of ['type', 'length', 'scale', 'precision', 'srid', 'default', '@odata.Type']) {
        if (fkArtifact[prop] != undefined) {
          foreignKeyElement[prop] = fkArtifact[prop];
        }
      }
      // If the association is non-fkArtifact resp. key, so should be the foreign key field
      for (let prop of ['notNull', 'key']) {
        if (assoc[prop] != undefined) {
          foreignKeyElement[prop] = assoc[prop];
        }
      }

      foreignKeyElement['@odata.foreignKey4'] = foreignKey4;
      if (flatKeys) foreignKeyRef.$generatedFieldName = foreignKeyElementName;
      setProp(foreignKeyElement, '$path', pathInKeysArr); // attach $path to the newly created element - used for inspectRef in processAssociationOrComposition
      if (assoc.$location) {
        setProp(foreignKeyElement, '$location', assoc.$location);
      }
      generatedFks[foreignKeyElementName] = foreignKeyElement;
    }

    function processAssociationOrComposition(fkArtifact, foreignKeyElementName) {
      fkArtifact.keys.forEach((keyRef,keyId) => {
        const path = fkArtifact.$path.concat('keys').concat(keyId);
        const fksForAssoc = generateForeignKeysForRef(assoc, foreignKeyElementName, keyRef, path, foreignKey4);
        Object.assign(generatedFks, fksForAssoc);
      })
    }
  }
}

/**
 *
 * @param {object} obj
 * @param {*} other
 * @returns {boolean} Whether 'obj' and 'other' are deeply equal. We need the
 * deep comparison because of annotations that have structured values and they
 * are propagated to the generated foreign keys.
 */
function isDeepEqual(obj, other) {
  const objectKeys = Object.keys(obj);
  const otherKeys = Object.keys(other);

  if (objectKeys.length !== otherKeys.length)
    return false;

  for (let key of objectKeys) {
    const areValuesObjects = (obj[key] != null && typeof obj[key] === 'object')
      && (other[key] !== null && typeof other[key] === 'object');

    if (areValuesObjects) {
      if (!isDeepEqual(obj[key], other[key]))
        return false;
    } else if (obj[key] !== other[key]) {
      return false;
    }
  }
  return true;
}
