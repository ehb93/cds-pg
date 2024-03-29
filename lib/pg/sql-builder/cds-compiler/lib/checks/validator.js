'use strict';

const {
  forEachDefinition, forEachMemberRecursively, forAllQueries,
  forEachMember, getNormalizedQuery, hasAnnotationValue, applyTransformations,
} = require('../model/csnUtils');
const enrich = require('./enricher');

// forHana
const { validateSelectItems } = require('./selectItems');
const { rejectParamDefaultsInHanaCds, warnAboutDefaultOnAssociationForHanaCds } = require('./defaultValues');
const validateCdsPersistenceAnnotation = require('./cdsPersistence');
const checkUsedTypesForAnonymousAspectComposition = require('./managedInType');
const checkForEmptyOrOnlyVirtual = require('./emptyOrOnlyVirtual');
// forOdata
const { validateDefaultValues } = require('./defaultValues');
// const { checkChainedArray } = require('./arrayOfs');
const { checkActionOrFunction } = require('./actionsFunctions');
const {
  checkCoreMediaTypeAllowence, checkForMultipleCoreMediaTypes,
  checkAnalytics, checkAtSapAnnotations, checkReadOnlyAndInsertOnly,
} = require('./annotationsOData');
// both
const { validateOnCondition, validateMixinOnCondition } = require('./onConditions');
const validateForeignKeys = require('./foreignKeys');
const {
  checkTypeDefinitionHasType, checkElementTypeDefinitionHasType,
  checkTypeIsScalar, checkDecimalScale,
} = require('./types');
const { checkPrimaryKey, checkVirtualElement, checkManagedAssoc } = require('./elements');
const checkForInvalidTarget = require('./invalidTarget');
const { validateAssociationsInItems } = require('./arrayOfs');
const checkQueryForNoDBArtifacts = require('./queryNoDbArtifacts');
const checkExplicitlyNullableKeys = require('./nullableKeys');
const nonexpandableStructuredInExpression = require('./nonexpandableStructured');
const unknownMagic = require('./unknownMagic');
const managedWithoutKeys = require('./managedWithoutKeys');

const forHanaMemberValidators
= [
  // For HANA CDS specifically, reject any default parameter values, as these are not supported.
  rejectParamDefaultsInHanaCds,
  checkTypeIsScalar,
  checkDecimalScale,
  checkExplicitlyNullableKeys,
  managedWithoutKeys,
  warnAboutDefaultOnAssociationForHanaCds,
];

const forHanaArtifactValidators
= [
  // @cds.persistence has no impact on odata
  validateCdsPersistenceAnnotation,
  // virtual items are not persisted on the db
  checkForEmptyOrOnlyVirtual,
];

const forHanaCsnValidators = [ nonexpandableStructuredInExpression, unknownMagic ];
/**
 * @type {Array<(query: CSN.Query, path: CSN.Path) => void>}
 */
const forHanaQueryValidators = [
  // TODO reason why this is forHana exclusive
  validateSelectItems,
  checkQueryForNoDBArtifacts,
];

const forOdataMemberValidators
= [
  // OData allows only simple values, no expressions or functions
  validateDefaultValues,
  managedWithoutKeys,
];

const forOdataArtifactValidators
= [
  // actions and functions are not of interest for the database
  checkActionOrFunction,
  // arrays are just CLOBs/LargeString for the database,
  // no inner for the array structure is of interest for the database
  // NOTE: moved to the renderer for a while
  // TODO: Re-enable this code and remove the duplicated code from the renderer.
  //       Not possible at the moment, because running this at the beginning of
  //       the renderer does not work because the enricher can't handle certain
  //       OData specifics.
  // checkChainedArray,
  checkForMultipleCoreMediaTypes,
  checkReadOnlyAndInsertOnly,
];

const forOdataCsnValidators = [ nonexpandableStructuredInExpression ];

const forOdataQueryValidators = [];

const commonMemberValidators
= [ validateOnCondition, validateForeignKeys,
  validateAssociationsInItems, checkForInvalidTarget,
  checkVirtualElement, checkElementTypeDefinitionHasType ];

const commonArtifactValidators = [ checkTypeDefinitionHasType, checkPrimaryKey, checkManagedAssoc ];

const commonQueryValidators = [ validateMixinOnCondition ];

/**
 * Run the given validations for each artifact and for each member recursively
 *
 * @param {CSN.Model} csn CSN to check
 * @param {object} that Will be provided to the validators via "this"
 * @param {object[]} [csnValidators=[]] Validations on whole CSN using applyTransformations
 * @param {Function[]} [memberValidators=[]] Validations on member-level
 * @param {Function[]} [artifactValidators=[]] Validations on artifact-level
 * @param {Function[]} [queryValidators=[]] Validations on query-level
 * @param {object} iterateOptions can be used to skip certain kinds from being iterated e.g. 'action' and 'function' for hana
 * @returns {Function} Function taking no parameters, that cleans up the attached helpers
 */
function _validate(csn, that,
                   csnValidators = [],
                   memberValidators = [],
                   artifactValidators = [],
                   queryValidators = [],
                   iterateOptions = {}) {
  const { cleanup } = enrich(csn);

  applyTransformations(csn, mergeCsnValidators(csnValidators, that), [], true, { drillRef: true });

  forEachDefinition(csn, (artifact, artifactName, prop, path) => {
    artifactValidators.forEach((artifactValidator) => {
      artifactValidator.bind(that)(artifact, artifactName, prop, path);
    });
    that.artifact = artifact;
    if (memberValidators.length) {
      forEachMemberRecursively( artifact,
                                memberValidators.map(v => v.bind(that)),
                                path,
                                true,
                                iterateOptions );
    }

    if (queryValidators.length && getNormalizedQuery(artifact).query)
      forAllQueries(getNormalizedQuery(artifact).query, queryValidators.map(v => v.bind(that)), path.concat([ artifact.projection ? 'projection' : 'query' ]));
  }, iterateOptions);

  return cleanup;
}

/**
 * Ensure the CSN validators adhere to the applyTransformation format - also, supply correct this value for each subfunction
 *
 * @param {object[]} csnValidators Validators
 * @param {object} that Value for this
 * @returns {object} Remapped validators.
 */
function mergeCsnValidators(csnValidators, that) {
  const remapped = {};
  for (const validator of csnValidators) {
    for (const [ n, fns ] of Object.entries(validator)) {
      if (!remapped[n])
        remapped[n] = [];

      if (Array.isArray(fns)) {
        remapped[n].push((parent, name, prop, path) => fns.forEach(
          fn => fn.bind(that)(parent, name, prop, path)
        ));
      }
      else {
        remapped[n].push((parent, name, prop, path) => fns.bind(that)(parent, name, prop, path));
      }
    }
  }

  for (const [ n, fns ] of Object.entries(remapped))
    remapped[n] = (parent, name, prop, path) => fns.forEach(fn => fn.bind(that)(parent, name, prop, path));


  return remapped;
}

/**
 * @param {CSN.Model} csn CSN to check
 * @param {object} that Will be provided to the validators via "this"
 * @returns {Function} the validator function with the respective checks for the HANA backend
 */
function forHana(csn, that) {
  return _validate(csn, that,
                   forHanaCsnValidators,
                   forHanaMemberValidators.concat(commonMemberValidators),
                   forHanaArtifactValidators.concat(commonArtifactValidators).concat(
                     // why is this hana exclusive
                     (artifact) => {
                       /*  the validation itself performs a recursive check on structured elements.
                        That is why it is not run along with the memberValidators, as it would result in
                        duplicate messages due to the forEachMemberRecursively.
                        TODO: check if this recursion can be factored out of the validator */
                       forEachMember(artifact, checkUsedTypesForAnonymousAspectComposition.bind(that));
                     }
                   ),
                   forHanaQueryValidators.concat(commonQueryValidators),
                   {
                     skipArtifact: artifact => artifact.abstract || hasAnnotationValue(artifact, '@cds.persistence.skip'),
                     skip: [
                       'action',
                       'function',
                       'event',
                     ],
                   });
}

/**
 * @param {CSN.Model} csn CSN to check
 * @param {object} that Will be provided to the validators via "this"
 * @returns {Function} the validator function with the respective checks for the OData backend
 */
function forOdata(csn, that) {
  return _validate(csn, that,
                   forOdataCsnValidators,
                   forOdataMemberValidators.concat(commonMemberValidators),
                   forOdataArtifactValidators.concat(commonArtifactValidators).concat(
                     (artifact, artifactName) => {
                       if (that.csnUtils.getServiceName(artifactName)) {
                         checkAtSapAnnotations.bind(that)(artifact);
                         forEachMemberRecursively(artifact, [
                           checkCoreMediaTypeAllowence.bind(that),
                           checkAnalytics.bind(that),
                           checkAtSapAnnotations.bind(that),
                         ]);
                       }
                     }
                   ),
                   forOdataQueryValidators.concat(commonQueryValidators),
                   {
                     skipArtifact: this.isExternalServiceMember,
                   });
}

module.exports = { forHana, forOdata };
