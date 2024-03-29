'use strict';

const {
  hasAnnotationValue, getUtils, getServiceNames, forEachDefinition,
  getResultingName, forEachMemberRecursively,
} = require('../../model/csnUtils');
const { setProp, isDeprecatedEnabled } = require('../../base/model');
const { getTransformers } = require('../transformUtilsNew');
const draftAnnotation = '@odata.draft.enabled';
const booleanBuiltin = 'cds.Boolean';

/**
 * Generate all the different entities/views/fields required for DRAFT.
 *
 * @param {CSN.Model} csn
 * @param {CSN.Options} options
 * @param {string} pathDelimiter
 * @param {object} messageFunctions
 */
function generateDrafts(csn, options, pathDelimiter, messageFunctions) {
  const draftSuffix = isDeprecatedEnabled(options, 'generatedEntityNameWithUnderscore') ? '_drafts' : '.drafts';
  // All services of the model - needed for drafts
  const allServices = getServiceNames(csn);
  const {
    createForeignKeyElement, createAndAddDraftAdminDataProjection, createScalarElement, createAssociationElement,
    addElement, copyAndAddElement, createAssociationPathComparison,
  } = getTransformers(csn, options, pathDelimiter);
  const { getCsnDef, isComposition } = getUtils(csn);
  const { error, warning } = messageFunctions;

  forEachDefinition(csn, generateDraft);

  /**
   * Generate the draft stuff for a given artifact
   *
   * @param {CSN.Artifact} artifact
   * @param {string} artifactName
   */
  function generateDraft(artifact, artifactName) {
    if ((artifact.kind === 'entity' || artifact.kind === 'view') &&
        hasAnnotationValue(artifact, draftAnnotation) &&
        isPartOfService(artifactName)) {
      // Determine the set of target draft nodes belonging to this draft root (the draft root
      // itself plus all its transitively composition-reachable targets)
      const draftNodes = Object.create(null);
      collectDraftNodesInto(artifact, artifactName, artifact, draftNodes);
      // Draft-enable all of them
      for (const name in draftNodes)
        generateDraftForHana(draftNodes[name], name, artifactName);

      // Redirect associations/compositions between draft shadow nodes
      for (const name in draftNodes) {
        const shadowNode = csn.definitions[`${name}${draftSuffix}`];
        // Might not exist because of previous errors
        if (shadowNode)
          redirectDraftTargets(csn.definitions[`${name}${draftSuffix}`], draftNodes);
      }
    }
  }

  /**
   * Collect all artifacts that are transitively reachable via compositions from 'artifact' into 'draftNodes'.
   * Check that no artifact other than the root node has '@odata.draft.enabled'
   *
   * @param {CSN.Artifact} artifact
   * @param {string} artifactName
   * @param {CSN.Artifact} rootArtifact root artifact where composition traversal started.
   * @param {object} draftNodes Dictionary of artifacts
   */
  function collectDraftNodesInto(artifact, artifactName, rootArtifact, draftNodes) {
    // Collect the artifact itself
    draftNodes[artifactName] = artifact;
    // Follow all composition targets in elements of 'artifact'
    for (const elemName in artifact.elements) {
      const elem = artifact.elements[elemName];
      if (elem.target && isComposition(elem.type)) {
        const draftNode = getCsnDef(elem.target);
        const draftNodeName = elem.target;
        // Sanity check
        if (!draftNode)
          throw new Error(`Expecting target to be resolved: ${JSON.stringify(elem, null, 2)}`);

        // Ignore composition if not part of a service
        if (!isPartOfService(draftNodeName)) {
          warning(null, [ 'definitions', artifactName, 'elements', elemName ], { target: draftNodeName },
                  'Ignoring draft node for composition target $(TARGET) because it is not part of a service');
          continue;
        }
        // Barf if a draft node other than the root has @odata.draft.enabled itself
        if (draftNode !== rootArtifact && hasAnnotationValue(draftNode, draftAnnotation)) {
          error(null, [ 'definitions', artifactName, 'elements', elemName ], 'Composition in draft-enabled entity can\'t lead to another entity with “@odata.draft.enabled”');
          delete draftNodes[draftNodeName];
          continue;
        }
        // Recurse unless already known
        if (!hasAnnotationValue(draftNode, draftAnnotation, false) && !draftNodes[draftNodeName])
          collectDraftNodesInto(draftNode, draftNodeName, rootArtifact, draftNodes);
      }
    }
  }

  /**
   * Generate all that is required in HANA CDS for draft enablement of 'artifact'.
   *
   * @param {CSN.Artifact} artifact
   * @param {string} artifactName
   * @param {string} draftRootName
   */
  function generateDraftForHana(artifact, artifactName, draftRootName) {
    // Sanity check
    if (!isPartOfService(artifactName))
      throw new Error(`Expecting artifact to be part of a service: ${JSON.stringify(artifact)}`);


    // The name of the draft shadow entity we should generate
    const draftsArtifactName = `${artifactName}${draftSuffix}`;

    // extract keys for UUID inspection
    const keys = [];
    forEachMemberRecursively(artifact, (elt, name, prop, path) => {
      if (!elt.elements && !elt.type && !elt.virtual) // only check leafs
        error(null, path, 'Expecting element to have a type when used in a draft-enabled artifact');
      if (elt.key && elt.key === true && !elt.virtual)
        keys.push(elt);
    }, [ 'definitions', artifactName ], true, { elementsOnly: true });

    // In contrast to EDM, the DB entity may have more than one technical keys but should have idealy exactly one key of type cds.UUID
    if (keys.length !== 1)
      warning(null, [ 'definitions', artifactName ], 'Entity annotated with “@odata.draft.enabled” should have exactly one key element');

    const uuidCount = keys.reduce((acc, k) => ((k.type === 'cds.String' && k.$renamed === 'cds.UUID' && k.length === 36) ? acc + 1 : acc), 0);
    if (uuidCount === 0)
      warning(null, [ 'definitions', artifactName ], 'Entity annotated with “@odata.draft.enabled” should have one key element of type “cds.UUID”');


    const matchingService = getMatchingService(artifactName);
    // Generate the DraftAdministrativeData projection into the service, unless there is already one
    const draftAdminDataProjectionName = `${matchingService}.DraftAdministrativeData`;
    let draftAdminDataProjection = csn.definitions[draftAdminDataProjectionName];
    if (!draftAdminDataProjection) {
      draftAdminDataProjection = createAndAddDraftAdminDataProjection(matchingService, true);

      if (!draftAdminDataProjection.projection.columns && draftAdminDataProjection.elements.DraftUUID)
        draftAdminDataProjection.projection.columns = Object.keys(draftAdminDataProjection.elements).map(e => (e === 'DraftUUID' ? { key: true, ref: [ 'DraftAdministrativeData', e ] } : { ref: [ 'DraftAdministrativeData', e ] }));
    }

    // Barf if it is not an entity or not what we expect
    if (draftAdminDataProjection.kind !== 'entity' || !draftAdminDataProjection.elements.DraftUUID) {
      // See draftAdminDataProjection which is defined in `csn.definitions`.
      const path = [ 'definitions', draftAdminDataProjectionName ];
      error(null, path, { name: draftAdminDataProjectionName },
            'Generated entity $(NAME) conflicts with existing artifact');
    }

    const persistenceName = getResultingName(csn, options.forHana.names, draftsArtifactName);
    // Duplicate the artifact as a draft shadow entity
    if (csn.definitions[persistenceName]) {
      const definingDraftRoot = csn.definitions[persistenceName].$draftRoot;
      if (!definingDraftRoot) {
        error(null, [ 'definitions', artifactName ], { name: persistenceName },
              'Generated entity name $(NAME) conflicts with existing entity');
      }

      else {
        error(null, [ 'definitions', draftRootName ], { name: persistenceName },
              `Entity $(NAME) already generated by draft root "${definingDraftRoot}"`);
      }

      return;
    }
    const draftsArtifact = {
      kind: 'entity',
      elements: Object.create(null),
    };

    // Add draft shadow entity to the csn
    csn.definitions[draftsArtifactName] = draftsArtifact;

    setProp(draftsArtifact, '$draftRoot', draftRootName);
    if (artifact.$location)
      setProp(draftsArtifact, '$location', artifact.$location);

    // Copy all elements
    for (const elemName in artifact.elements) {
      const origElem = artifact.elements[elemName];
      let elem;
      if ((isDeprecatedEnabled(options, 'renderVirtualElements') && origElem.virtual) || !origElem.virtual)
        elem = copyAndAddElement(origElem, draftsArtifact, draftsArtifactName, elemName)[elemName];
      if (elem) {
        // Remove "virtual" - cap/issues 4956
        if (elem.virtual)
          delete elem.virtual;

        // explicitly set nullable if not key and not unmanaged association
        if (!elem.key && !elem.on)
          elem.notNull = false;
      }
    }

    // Generate the additional elements into the draft-enabled artifact

    // key IsActiveEntity : Boolean default true
    const isActiveEntity = createScalarElement('IsActiveEntity', booleanBuiltin, false);
    // Use artifactName and not draftsArtifactName because otherwise we may point to the generated
    // entity in CSN and won't get a proper location (draftsArtifact has inherited all
    // elements from the original artifact).
    addElement(isActiveEntity, draftsArtifact, artifactName);

    // HasActiveEntity : Boolean default false
    const hasActiveEntity = createScalarElement('HasActiveEntity', booleanBuiltin, false);
    addElement(hasActiveEntity, draftsArtifact, artifactName);

    // HasDraftEntity : Boolean default false;
    const hasDraftEntity = createScalarElement('HasDraftEntity', booleanBuiltin, false);
    addElement(hasDraftEntity, draftsArtifact, artifactName);

    // DraftAdministrativeData : Association to one DraftAdministrativeData not null;
    const draftAdministrativeData = createAssociationElement('DraftAdministrativeData', draftAdminDataProjectionName, true);
    draftAdministrativeData.DraftAdministrativeData.cardinality = {
      max: 1,
    };
    draftAdministrativeData.DraftAdministrativeData.notNull = true;
    addElement(draftAdministrativeData, draftsArtifact, artifactName);
    // Note that we may need to do the HANA transformation steps for managed associations
    // (foreign key field generation, generatedFieldName, creating ON-condition) by hand,
    // because the corresponding transformation steps have already been done on all artifacts
    // when we come here). Only for to.hdbcds with hdbcds names this is not required.
    /**
     * The given association has a key named DraftUUID
     *
     * @param {CSN.Association} association Assoc to check
     * @returns {object}
     */
    function getDraftUUIDKey(association) {
      if (association.keys) {
        const filtered = association.keys.filter(o => (o.ref && !o.as && o.ref.length === 1 && o.ref[0] === 'DraftUUID') || (o.as && o.as === 'DraftUUID'));
        if (filtered.length === 1)
          return filtered[0];

        else if (filtered.length > 1)
          return filtered.filter(o => o.as && o.as === 'DraftUUID');
      }

      return undefined;
    }

    /**
     * Get the resulting name for an obj - explicit or implicit alias
     *
     * @param {object} obj Any object with at least "ref"
     * @returns {string}
     */
    function getNameForRef(obj) {
      if (obj.as)
        return obj.as;

      return obj.ref[obj.ref.length - 1];
    }

    const draftUUIDKey = getDraftUUIDKey(draftAdministrativeData.DraftAdministrativeData);
    if (!(options.transformation === 'hdbcds' && options.sqlMapping === 'hdbcds') && draftUUIDKey) {
      const path = [ 'definitions', draftsArtifactName, 'elements', 'DraftAdministrativeData', 'keys', 0 ];
      createForeignKeyElement(draftAdministrativeData.DraftAdministrativeData, 'DraftAdministrativeData', draftUUIDKey, draftsArtifact, draftsArtifactName, path);
      draftAdministrativeData.DraftAdministrativeData.on = createAssociationPathComparison('DraftAdministrativeData',
                                                                                           getNameForRef(draftUUIDKey),
                                                                                           '=',
                                                                                           `DraftAdministrativeData${pathDelimiter}DraftUUID`);
      // The notNull has been transferred to the foreign key field and must be removed on the association
      delete draftAdministrativeData.DraftAdministrativeData.notNull;

      // The association is now unmanaged, i.e. actually it should no longer have foreign keys
      // at all. But the processing of backlink associations below expects to have them, so
      // we don't delete them (but mark them as implicit so that toCdl does not render them)
      // draftAdministrativeData.DraftAdministrativeData.implicitForeignKeys = true;
    }
  }

  /**
   * Redirect all association/composition targets in 'artifact' that point to targets in
   * the dictionary 'draftNodes' to their corresponding draft shadow artifacts.
   *
   * @param {CSN.Artifact} artifact
   * @param {CSN.Artifact[]} draftNodes
   */
  function redirectDraftTargets(artifact, draftNodes) {
    for (const elemName in artifact.elements) {
      const elem = artifact.elements[elemName];
      if (elem.target) {
        const targetArt = getCsnDef(elem.target);
        // Nothing to do if target is not a draft node
        if (!draftNodes[elem.target])
          continue;

        // Redirect the composition/association in this draft shadow entity to the target draft shadow entity
        // console.error(`Redirecting target of ${elemName} in ${artifact.name.absolute} to ${target.name.absolute + '_drafts'}`);
        const { shadowTarget, shadowTargetName } = getDraftShadowEntityFor(targetArt, elem.target);
        // Might not exist because of previous errors
        if (shadowTarget)
          elem.target = shadowTargetName;
      }
    }

    /**
     * Returns the corresponding draft shadow artifact for draft node 'draftNode'.
     *
     * @param {CSN.Artifact} draftNode
     * @param {string} draftNodeName
     * @returns {object} Object with shadowTarget: definition and shadowTargetName: Name of the definition
     */
    function getDraftShadowEntityFor(draftNode, draftNodeName) {
      // Sanity check
      if (!draftNodes[draftNodeName])
        throw new Error(`Not a draft node: ${draftNodeName}`);

      return { shadowTarget: csn.definitions[`${draftNodeName}${draftSuffix}`], shadowTargetName: `${draftNodeName}${draftSuffix}` };
    }
  }

  /**
   * Check if the given artifact is part of a service.
   *
   * @param {string} artifactName Absolute name of the artifact
   * @returns {boolean}
   */
  function isPartOfService(artifactName) {
    for (const serviceName of allServices) {
      if (artifactName.startsWith(`${serviceName}.`))
        return true;
    }

    return false;
  }

  /**
   * Get the service name containing the artifact.
   *
   * @param {string} artifactName Absolute name of the artifact
   * @returns {boolean|string} Name of the service or false if no match is found.
   */
  function getMatchingService(artifactName) {
    const matches = [];
    for (const serviceName of allServices) {
      if (artifactName.startsWith(`${serviceName}.`))
        matches.push(serviceName);
    }
    if (matches.length === 0)
      return false;
    return matches.sort((a, b) => a.length - b.length)[0];
  }
}


module.exports = generateDrafts;
