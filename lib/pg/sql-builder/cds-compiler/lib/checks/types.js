'use strict';

const { getUtils, isBuiltinType, hasAnnotationValue } = require('../model/csnUtils');

// Only to be used with validator.js - a correct this value needs to be provided!

/**
 * Scale must not be 'variable' or 'floating'
 *
 * scale property is always propagated
 *
 * @param {CSN.Element} member the element to be checked
 * @param {string} memberName the elements name
 * @param {string} prop which kind of member are we looking at -> only prop "elements"
 * @param {CSN.Path} path the path to the member
 */
function checkDecimalScale(member, memberName, prop, path) {
  if (hasAnnotationValue(this.artifact, '@cds.persistence.exists') ||
     // skip is already filtered in validator, here for completeness
     hasAnnotationValue(this.artifact, '@cds.persistence.skip'))
    return;
  if (member.scale && [ 'variable', 'floating' ].includes(member.scale))
    this.error(null, path, { name: member.scale }, 'Unexpected scale $(NAME)');
}

/**
 * View parameter for hana must be of scalar type
 *
 * @param {CSN.Element} member the element to be checked
 * @param {string} memberName the elements name
 * @param {string} prop which kind of member are we looking at -> only prop "elements"
 * @param {CSN.Path} path the path to the member
 */
function checkTypeIsScalar(member, memberName, prop, path) {
  if ( prop === 'params' && this.csnUtils.isStructured(member))
    this.error(null, path, 'View parameter type must be scalar');
}

/**
 * Check that the `type of` information in the given element
 * has proper type information or issue an error otherwise. The element's final type is checked.
 *
 * @param {CSN.Element} member the element to be checked
 * @param {string} memberName the elements name
 * @param {string} prop which kind of member are we looking at -> only prop "elements"
 * @param {CSN.Path} path the path to the member
 */
function checkElementTypeDefinitionHasType(member, memberName, prop, path) {
  // Computed elements, e.g. "1+1 as foo" in a view don't have a valid type and
  // are skipped here.
  // Elements in projections are not tested as well
  const parent = this.csn.definitions[path[1]];
  if (parent.projection || parent.query || prop !== 'elements')
    return;

  // should only happen with csn input, not in cdl
  if (!hasArtifactTypeInformation(member)) {
    warnAboutMissingType(this.error, path, memberName, true);
    return;
  }

  // Check for `type of`
  if (member.type) {
    if (member.type.ref) {
      const isSelfReference = path[1] === member.type.ref[0];
      checkTypeOfHasProperType(
        member, memberName, this.csn, this.error, path, isSelfReference ? member.type.ref[1] : null
      );
    }
    else if (member._type) {
      if ( this.isAspect(member._type) || member._type.kind === 'type' && member._type.$syntax === 'aspect')
        this.error('ref-sloppy-type', path, 'A type or an element is expected here');
    }
    return;
  }

  // many
  const { items } = member;
  if (items)
    checkTypeOfHasProperType(items, memberName, this.csn, this.error, path );
}

/**
 * If the given artifact is a type definition then check whether it is
 * properly defined and has valid type information, e.g. information about
 * its elements or references another valid type.
 *
 * @param {CSN.Artifact} artifact the artifact which is to be checked
 * @param {string} artifactName the artifacts name
 * @param {string} prop which kind of artifact we are looking at
 * @param {CSN.Path} path the path to the artifact
 */
function checkTypeDefinitionHasType(artifact, artifactName, prop, path) {
  if (artifact.kind !== 'type')
    return;

  // should only happen with csn input, not in cdl
  if (!hasArtifactTypeInformation(artifact)) {
    warnAboutMissingType(this.error, path, artifactName);
    return;
  }

  // Check for `type of`
  if (artifact.type) {
    checkTypeOfHasProperType(artifact, artifactName, this.csn, this.error, path);
    return;
  }

  // many
  const { items } = artifact;
  if (items)
    checkTypeOfHasProperType(items, artifactName, this.csn, this.error, path );
}


/**
 * Check that the `type of` information in the given artifact (i.e. `type` property)
 * has proper type information or issue an error otherwise. The artifact's final type is checked.
 *
 * @param {object} artOrElement can either be an element or a type definition
 * @param {string} name the name of the element or of the artifact
 * @param {CSN.Model} model the csn model in which the element/artifact resides
 * @param {Function} error the error function
 * @param {CSN.Path} path the path to the element or the artifact
 * @param {string} derivedTypeName if the type reference is another type/element e.g. type derivedType : MaliciousType; we want to
 *                                 point at the "MaliciousType" reference, that's why we need to remember the name when drilling down.
 */
function checkTypeOfHasProperType(artOrElement, name, model, error, path, derivedTypeName = null) {
  if (!artOrElement.type)
    return;

  const { getFinalBaseType } = getUtils(model);
  const typeOfType = getFinalBaseType(artOrElement.type, path);

  if (typeOfType === null) {
    if (artOrElement.type.ref) {
      const typeOfArt = artOrElement.type.ref[0];
      const typeOfElt = artOrElement.type.ref[1];
      // TODO: using error() must be consistent to central messages!
      error('check-proper-type-of', path, { art: derivedTypeName || typeOfArt, name: typeOfElt, '#': derivedTypeName ? 'derived' : 'std' }, {
        std: 'Referred element $(NAME) of $(ART) does not contain proper type information',
        derived: 'Referred type of $(ART) does not contain proper type information',
      });
    }
  }
  else if (typeOfType && typeOfType.items) {
    derivedTypeName = typeof artOrElement.type === 'string' ? artOrElement.type : artOrElement.type.ref[artOrElement.type.ref.length - 1];
    checkTypeOfHasProperType(typeOfType.items, name, model, error, path, derivedTypeName);
  }
}


/**
 * Can happen in CSN, e.g. `{ a: { kind: "type" } }` but should not happen in CDL.
 *
 * @param {Function} error the error function
 * @param {CSN.Path} path the path to the element or the artifact
 * @param {string} name of the element or the artifact which is dubious
 * @param {boolean} isElement indicates whether we are dealing with an element or an artifact
 */
function warnAboutMissingType(error, path, name, isElement = false) {
  error('check-proper-type', path, { art: name, '#': isElement ? 'elm' : 'std' }, {
    std: 'Dubious type $(ART) without type information',
    elm: 'Dubious element $(ART) without type information',
  });
}

/**
 * Check whether the given artifact has type information.  An artifact has type
 * information when it is either a builtin, a struct, an enum, an array, an
 * association OR if it references another type, i.e. typeOf.  For the latter
 * case an artifact's final type must be checked.
 *
 * @param {CSN.Artifact} artifact the artifact to check
 * @returns {boolean} indicates whether the artifact has type information
 */
function hasArtifactTypeInformation(artifact) {
  // When is what property set?
  return isBuiltinType(artifact.type) || // => `Integer`
    artifact.elements ||  // => `type A {}`
    artifact.items ||     // => `type A : array of Integer`
    artifact.enum ||      // => `type A : Integer enum {}`, `type` also set
    artifact.target ||    // => `type A : Association to B;`
    artifact.type;     // => `type A : [type of] Integer`
}

module.exports = {
  checkTypeDefinitionHasType,
  checkElementTypeDefinitionHasType,
  checkTypeIsScalar,
  checkDecimalScale,
};
