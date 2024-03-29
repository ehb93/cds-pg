'use strict';

const { makeMessageFunction } = require('../base/messages');
const { isDeprecatedEnabled, isBetaEnabled } = require('../base/model');
const transformUtils = require('./transformUtilsNew');
const { getUtils,
        cloneCsn,
        forEachDefinition,
        forEachMemberRecursively,
        forEachRef,
        getArtifactDatabaseNameOf,
        getElementDatabaseNameOf,
        isAspect,
        isBuiltinType,
        getServiceNames,
      } = require('../model/csnUtils');
const { checkCSNVersion } = require('../json/csnVersion');
const validate = require('../checks/validator');
const { isArtifactInSomeService, getServiceOfArtifact, isLocalizedArtifactInService } = require('./odata/utils');
const ReferenceFlattener = require('./odata/referenceFlattener');
const { flattenCSN } = require('./odata/structureFlattener');
const generateForeignKeys = require('./odata/generateForeignKeyElements');
const expandStructKeysInAssociations = require('./odata/expandStructKeysInAssociations');
const expandToFinalBaseType = require('./odata/toFinalBaseType');
const timetrace = require('../utils/timetrace');
const { attachPath } = require('./odata/attachPath');
const enrichUniversalCsn = require('./universalCsnEnricher');

const { addLocalizationViews } = require('./localized');

// Transformation for ODATA. Expects a CSN 'inputModel', processes it for ODATA.
// The result should be suitable for consumption by EDMX processors (annotations and metadata)
// and also as a final CSN output for the ODATA runtime.
// Performs the following:
//   - Validate the input model. (forODataNew Candidate)
//   - Unravel derived types for elements, actions, action parameters, types and
//     annotations (propagating annotations).
//     (EdmPreproc Candidate, don't know if flatten step depends on it)
//   - If we execute in flat mode, flatten:
//        -- structured elements
//        -- all the references in the model
//        -- foreign keys of managed associations (cover also the case when the foreign key is
//           pointing to keys that are themselves managed associations)
//       (long term EdmPreproc Candidate when RTs are able to map to flat)
//   - Generate foreign keys for all the managed associations in the model as siblings to the association
//     where ever the association is located (toplevel in flat or deep structured). (forODataNew Candidate)
//   - Tackle on-conditions in unmanaged associations. In case of flat mode - flatten the
//     on-condition, in structured mode - normalize it. (forODataNew Candidate)
//   - Generate artificial draft fields if requested. (forODataNew Candidate)
//   - Check associations for:
//     TODO: move to validator (Is this really required here?
//                              EdmPreproc cuts off assocs or adds proxies/xrefs)
//        -- exposed associations do not point to non-exposed targets
//        -- structured types must not contain associations for OData V2
//   - Element must not be an 'array of' for OData V2 TODO: move to the validator
//     (Linter Candiate, move as hard error into EdmPreproc on V2 generation)
//   - Perform checks for exposed non-abstract entities and views - check media type and
//        key-ness (requires that containers have been identified) (Linter candidate, scenario check)
//   Annotations related:
//   - Annotate artifacts, elements, foreign keys, parameters etc with their DB names if requested
//     (must remain in CSN => ForODataNewCandidate)
//   - Mark fields with @odata.on.insert/update as @Core.Computed
//     (EdmPreproc candidate, check with RT if @Core.Computed required by them)
//   - Rename shorthand annotations according to a builtin list (EdmPreproc Candidate)
//       e.g. @label -> @Common.Label or @important: [true|false] -> @UI.Importance: [#High|#Low]
//   - If the association target is annotated with @cds.odata.valuelist, annotate the
//        association with @Common.ValueList.viaAssociation (EdmPreproc Candidate)
//   - Check for @Analytics.Measure and @Aggregation.default (Linter check candidate, remove)
//   - Check annotations. If annotation starts with '@sap...' it must have a string or boolean value
//     (Linter check candidate)
module.exports = { transform4odataWithCsn };

function transform4odataWithCsn(inputModel, options) {
  timetrace.start('OData transformation');
  // copy the model as we don't want to change the input model
  let csn = cloneCsn(inputModel, options);

  const { error, warning, info, throwWithError } = makeMessageFunction(csn, options, 'for.odata');
  throwWithError();

  // the new transformer works only with new CSN
  checkCSNVersion(csn, options);

  const transformers = transformUtils.getTransformers(csn, options, '_');
  const {
    addDefaultTypeFacets,
    createForeignKeyElement,
    createAndAddDraftAdminDataProjection, createScalarElement,
    createAssociationElement, createAssociationPathComparison,
    addElement, createAction, assignAction,
    extractValidFromToKeyElement,
    checkAssignment, checkMultipleAssignments,
    recurseElements, setAnnotation, resetAnnotation, renameAnnotation,
    expandStructsInExpression
  } = transformers;

  const csnUtils = getUtils(csn);
  const {
    getCsnDef,
    getFinalType,
    getServiceName,
    hasAnnotationValue,
    isAssocOrComposition,
    isAssociation,
    isStructured,
    inspectRef,
    artifactRef,
    effectiveType,
    getFinalBaseType,
  } = csnUtils;

  // are we working with structured OData or not
  const structuredOData = options.toOdata.odataFormat === 'structured' && options.toOdata.version === 'v4';

  // collect all declared non-abstract services from the model
  // use the array when there is a need to identify if an artifact is in a service or not
  const services = getServiceNames(csn);
  // @ts-ignore
  const externalServices = services.filter(serviceName => csn.definitions[serviceName]['@cds.external']);
  // @ts-ignore
  const isExternalServiceMember = (_art, name) => externalServices.includes(getServiceName(name));

  if (options.csnFlavor === 'universal' && isBetaEnabled(options, 'enableUniversalCsn'))
    enrichUniversalCsn(csn, options);

  const keepLocalizedViews = isDeprecatedEnabled(options, 'createLocalizedViews');

  function acceptLocalizedView(_name, parent) {
    csn.definitions[parent].$localized = true;
    return keepLocalizedViews && !isExternalServiceMember(undefined, parent);
  }

  addLocalizationViews(csn, options, acceptLocalizedView);

  validate.forOdata(csn, {
    error, warning, info, inspectRef, effectiveType, artifactRef, csn, options, csnUtils, services, getFinalBaseType, isAspect, isExternalServiceMember
  });


  // Throw exception in case of errors
  throwWithError();

  // Semantic checks before flattening regarding temporal data
  // TODO: Move in the validator
  forEachDefinition(csn, [
    checkTemporalAnnotationsAssignment,
    (def) => {
      // Convert a projection into a query for internal processing will be re-converted
      // at the end of the OData processing
      // TODO: handle artifact.projection instead of artifact.query correctly in future V2
      if (def.kind === 'entity' && def.projection) {
        def.query = { SELECT: def.projection };
      }
    }],
    { skipArtifact: isExternalServiceMember }
  );

  expandToFinalBaseType(csn, transformers, csnUtils, services, options, isExternalServiceMember);

  // Check if structured elements and managed associations are compared in an expression
  // and expand these structured elements. This tuple expansion allows all other
  // subsequent procession steps (especially a2j) to see plain paths in expressions.
  // If errors are detected, throwWithError() will return from further processing
  expandStructsInExpression(csn, { skipArtifact: isExternalServiceMember, drillRef: true });

  // handles reference flattening
  let referenceFlattener = new ReferenceFlattener();
  referenceFlattener.resolveAllReferences(csn, inspectRef, isStructured);
  attachPath(csn);

  referenceFlattener.applyAliasesInOnCond(csn, inspectRef);

  if (!structuredOData) {
    // flatten structures
    // @ts-ignore
    flattenCSN(csn, csnUtils, options, referenceFlattener, error, isExternalServiceMember);
    // flatten references
    referenceFlattener.flattenAllReferences(csn);
  }

  // structure flattener reports errors, further processing is not safe -> throw exception in case of errors
  throwWithError();

  // Process associations
  // 1. In case we generate flat mode, expand the structured foreign keys.
  // This logic rewrites the 'ref' for such keys with the corresponding flattened
  // elements.
  if (!structuredOData)
    expandStructKeysInAssociations(csn, referenceFlattener, csnUtils, isExternalServiceMember);
  // 2. generate foreign keys for managed associations
  generateForeignKeys(csn, options, referenceFlattener, csnUtils, error, isExternalServiceMember);

  // Apply default type facets as set by options
  // Flatten on-conditions in unmanaged associations
  // This must be done before all the draft logic as all
  // composition targets are annotated with @odata.draft.enabled in this step
  forEachDefinition(csn, [ setDefaultTypeFacets, processOnCond ], { skipArtifact: isExternalServiceMember });

  // Now all artificially generated things are in place
  // - Generate artificial draft fields if requested
  // TODO: should be done by the compiler - Check associations for valid foreign keys
  // TODO: check if needed at all: Remove '$projection' from paths in the element's ON-condition
  // - Check associations for:
  //        - exposed associations do not point to non-exposed targets
  //        - structured types must not contain associations for OData V2
  // - Element must not be an 'array of' for OData V2 TODO: move to the validator
  // - Perform checks for exposed non-abstract entities and views - check media type and key-ness
  let visitedArtifacts = Object.create(null);
  forEachDefinition(csn, (def, defName) => {
    if (def.kind === 'entity' || def.kind === 'view') {
      // Generate artificial draft fields if requested
      if (def['@odata.draft.enabled']) {
        // Ignore if not part of a service
        if (isArtifactInSomeService(defName, services)) {
          generateDraftForOdata(def, defName, def, visitedArtifacts);
        }
      }
    }
    visitedArtifacts[defName] = true;
  }, { skipArtifact: isExternalServiceMember });

  // Deal with all kind of annotations manipulations here
  forEachDefinition(csn, (def, defName) => {
    // Resolve annotation shorthands for entities, types, annotations, ...
    renameShorthandAnnotations(def);

    // Annotate artifacts with their DB names if requested.
    // Skip artifacts that have no DB equivalent anyway
    if (options.toOdata.names && !['service', 'context', 'namespace', 'annotation', 'action', 'function'].includes(def.kind))
      def['@cds.persistence.name'] = getArtifactDatabaseNameOf(defName, options.toOdata.names, csn);

    forEachMemberRecursively(def, (member, memberName, propertyName, path) => {
      // Annotate elements, foreign keys, parameters, etc. with their DB names if requested
      // Only these are actually required and don't annotate virtual elements in entities or types
      // as they have no DB representation (although in views)
      if (options.toOdata.names && typeof member === 'object' && !['action', 'function'].includes(member.kind) && propertyName !== 'enum' && (!member.virtual || def.query)) {
        // If we have a 'preserved dotted name' (i.e. we are a result of flattening), use that for the @cds.persistence.name annotation
        member['@cds.persistence.name'] = getElementDatabaseNameOf(referenceFlattener.getElementNameWithDots(path) || memberName, options.toOdata.names);
      }

      // Mark fields with @odata.on.insert/update as @Core.Computed
      annotateCoreComputed(member);

      // Resolve annotation shorthands for elements, actions, action parameters
      renameShorthandAnnotations(member);

      // - If the association target is annotated with @cds.odata.valuelist, annotate the
      //      association with @Common.ValueList.viaAssociation
      // - Check for @Analytics.Measure and @Aggregation.default
      // @ts-ignore
      if (isArtifactInSomeService(defName, services) || isLocalizedArtifactInService(defName, services)) {
        // If the member is an association and the target is annotated with @cds.odata.valuelist,
        // annotate the association with @Common.ValueList.viaAssociation (but only for service member artifacts
        // to avoid CSN bloating). The propagation of the @Common.ValueList.viaAssociation annotation
        // to the foreign keys is done very late in edmPreprocessor.initializeAssociation()
        addCommonValueListviaAssociation(member, memberName);
      }
    }, ['definitions', defName]);

    // Convert a query back into a projection for CSN compliance as
    // the very last conversion step of the OData transformation
    if (def.kind === 'entity' && def.query && def.query && def.projection) {
      delete def.query;
    }
  }, { skipArtifact: isExternalServiceMember })

  // Throw exception in case of errors
  throwWithError();

  if (options.testMode) csn = cloneCsn(csn, options);   // sort, keep hidden properties
  timetrace.stop();
  return csn;

  // TODO: Move this to checks?
  // @ts-ignore
  function checkTemporalAnnotationsAssignment(artifact, artifactName, propertyName, path) {
    // Gather all element names with @cds.valid.from/to/key
    let validFrom = [], validTo = [], validKey = [];
    recurseElements(artifact, ['definitions', artifactName], (member, path) => {
      let [f, t, k] = extractValidFromToKeyElement(member, path);
      validFrom.push(...f);
      validTo.push(...t);
      validKey.push(...k);
    });
    // Check that @cds.valid.from/to/key is only in valid places
    validFrom.forEach(obj => checkAssignment('@cds.valid.from', obj.element, obj.path, artifact));
    validTo.forEach(obj => checkAssignment('@cds.valid.to', obj.element, obj.path, artifact));
    validKey.forEach(obj => checkAssignment('@cds.valid.key', obj.element, obj.path, artifact));
    checkMultipleAssignments(validFrom, '@cds.valid.from', artifact, artifactName);
    checkMultipleAssignments(validTo, '@cds.valid.to', artifact, artifactName);
    checkMultipleAssignments(validKey, '@cds.valid.key', artifact, artifactName);
    if (validKey.length && !(validFrom.length && validTo.length)) {
      error(null, path, 'Annotation “@cds.valid.key” was used but “@cds.valid.from” and “@cds.valid.to” are missing');
    }
  }

  // Mark elements that are annotated with @odata.on.insert/update with the annotation @Core.Computed.
  function annotateCoreComputed(node) {
    // If @Core.Computed is explicitly set, don't overwrite it!
    if (node['@Core.Computed'] !== undefined) return;

    // For @odata.on.insert/update, also add @Core.Computed
    if (node['@odata.on.insert'] || node['@odata.on.update'])
      node['@Core.Computed'] = true;
  }

  // Rename shorthand annotations within artifact or element 'node' according to a builtin
  // list.
  function renameShorthandAnnotations(node) {
    // FIXME: Verify this list - are they all still required? Do we need any more?
    const mappings = {
      '@label': '@Common.Label',
      '@title': '@Common.Label',
      '@description': '@Core.Description',
      '@ValueList.entity': '@Common.ValueList.entity',
      '@ValueList.type': '@Common.ValueList.type',
      '@Capabilities.Deletable': '@Capabilities.DeleteRestrictions.Deletable',
      '@Capabilities.Insertable': '@Capabilities.InsertRestrictions.Insertable',
      '@Capabilities.Updatable': '@Capabilities.UpdateRestrictions.Updatable',
      '@Capabilities.Readable': '@Capabilities.ReadRestrictions.Readable',
    }

    Object.keys(node).forEach( name => {
      // Rename according to map above
      if (mappings[name] != undefined)
        renameAnnotation(node, name, mappings[name]);

      // Special case: '@important: [true|false]' becomes '@UI.Importance: [#High|#Low]'
      if (name === '@important') {
        renameAnnotation(node, name, '@UI.Importance');
        let annotation = node['@UI.Importance'];
        if (annotation !== null)
          node['@UI.Importance'] = { '#': annotation ? 'High' : 'Low' };
      }

      // Special case: '@readonly' becomes a triplet of capability restrictions for entities,
      // but '@Core.Immutable' for everything else.
      if (!(node['@readonly'] && node['@insertonly'])) {
        if (name === '@readonly' && node[name] !== null) {
          if (node.kind === 'entity' || node.kind === 'view') {
            setAnnotation(node, '@Capabilities.DeleteRestrictions.Deletable', false);
            setAnnotation(node, '@Capabilities.InsertRestrictions.Insertable', false);
            setAnnotation(node, '@Capabilities.UpdateRestrictions.Updatable', false);
          } else {
            renameAnnotation(node, name, '@Core.Computed');
          }
        }
        // @insertonly is effective on entities/queries only
        else if (name === '@insertonly' && node[name] !== null) {
          if (node.kind === 'entity' || node.kind === 'view') {
            setAnnotation(node, '@Capabilities.DeleteRestrictions.Deletable', false);
            setAnnotation(node, '@Capabilities.ReadRestrictions.Readable', false);
            setAnnotation(node, '@Capabilities.UpdateRestrictions.Updatable', false);
          }
        }
      }
      // Only on element level: translate @mandatory
      if (name === '@mandatory' && node[name] !== null &&
        node.kind === undefined && node['@Common.FieldControl'] === undefined) {
        setAnnotation(node, '@Common.FieldControl', { '#': 'Mandatory' });
      }

      if (name === '@assert.format' && node[name] !== null)
        setAnnotation(node, '@Validation.Pattern', node['@assert.format']);

      if (name === '@assert.range' && node[name] !== null) {
        if (Array.isArray(node['@assert.range']) && node['@assert.range'].length === 2) {
          setAnnotation(node, '@Validation.Minimum', node['@assert.range'][0]);
          setAnnotation(node, '@Validation.Maximum', node['@assert.range'][1]);
        }
        // for enums @assert.range changes into a boolean annotation
        else if (node[name] === true) {
          let typeDef = node;
          if(!node.enum && node.type && !isBuiltinType(node.type))
            typeDef = csn.definitions[node.type];
          if(typeDef.enum) {
            let enumValue = Object.keys(typeDef.enum).map(enumSymbol => {
              const enumSymbolDef = typeDef.enum[enumSymbol];
              let result = { '@Core.SymbolicName': enumSymbol };
              if (enumSymbolDef.val !== undefined)
                result.Value = enumSymbolDef.val;
              else if (node.type && node.type === 'cds.String')
              // the symbol is used as value only for type 'cds.String'
                result.Value = enumSymbol;
            // Can't rely that @description has already been renamed to @Core.Description
            // Eval description according to precedence (doc comment must be considered already in Odata transformer
            // as in contrast to the other doc commments as it is used to annotate the @Validation.AllowedValues)
              const desc = enumSymbolDef['@Core.Description'] || enumSymbolDef['@description'] || enumSymbolDef.doc;
              if (desc)
                result['@Core.Description'] = desc;
              return result;
            });
            setAnnotation(node, '@Validation.AllowedValues', enumValue);
          }
        }
      }
    });
  }

  // Apply default type facets to each type definition and every member
  // But do not apply default string length 5000 (as in DB)
  function setDefaultTypeFacets(def) {
    addDefaultTypeFacets(def.items || def, false)
    forEachMemberRecursively(def,  m=>addDefaultTypeFacets(m.items || m, false));
    if(def.returns)
      addDefaultTypeFacets(def.returns.items || def.returns, false);
  }

  // Handles on-conditions in unmanaged associations
  function processOnCond(def) {
    forEachMemberRecursively(def, (member) => {
      // @ts-ignore
      if (member.type && isAssocOrComposition(member.type) && member.on) {
        removeLeadingDollarSelfInOnCondition(member);
      }
    });

    // removes leading $self in on-conditions's references
    function removeLeadingDollarSelfInOnCondition(assoc) {
      if (!assoc.on) return; // nothing to do
      forEachRef(assoc, (ref, node) => {
        // remove leading $self when at the begining of a ref
        if (ref.length > 1 && ref[0] === '$self')
          node.ref.splice(0, 1);
      });
    }
  }

  // Generate all that is required in ODATA for draft enablement of 'artifact' into the artifact,
  // into its transitively reachable composition targets, and into the model.
  // 'rootArtifact' is the root artifact where composition traversal started.

  // Constraints
  // Draft Root: Exactly one PK of type UUID
  // Draft Node: One PK of type UUID + 0..1 PK of another type
  // Draft Node: Must not be reachable from multiple draft roots
  function generateDraftForOdata(artifact, artifactName, rootArtifact, visitedArtifacts) {
    // Sanity check
    // @ts-ignore
    if (!isArtifactInSomeService(artifactName, services)) {
      throw new Error('Expecting artifact to be part of a service: ' + JSON.stringify(artifact));
    }
    // Nothing to do if already draft-enabled (composition traversal may have circles)
    if ((artifact['@Common.DraftRoot.PreparationAction'] || artifact['@Common.DraftNode.PreparationAction'])
      && artifact.actions && artifact.actions.draftPrepare) {
      return;
    }

    // Generate the DraftAdministrativeData projection into the service, unless there is already one
    // @ts-ignore
    let draftAdminDataProjectionName = `${getServiceOfArtifact(artifactName, services)}.DraftAdministrativeData`;
    let draftAdminDataProjection = csn.definitions[draftAdminDataProjectionName];
    if (!draftAdminDataProjection) {
      // @ts-ignore
      draftAdminDataProjection = createAndAddDraftAdminDataProjection(getServiceOfArtifact(artifactName, services));
    }
    // Report an error if it is not an entity or not what we expect
    if (draftAdminDataProjection.kind !== 'entity' || !draftAdminDataProjection.elements['DraftUUID']) {
      error(null, ['definitions', draftAdminDataProjectionName], { name: draftAdminDataProjectionName },
        `Generated entity $(NAME) conflicts with existing artifact`);
    }
    // Generate the annotations describing the draft actions (only draft roots can be activated/edited)
    if (artifact == rootArtifact) {
      resetAnnotation(artifact, '@Common.DraftRoot.ActivationAction', 'draftActivate', info, ['definitions', draftAdminDataProjectionName]);
      resetAnnotation(artifact, '@Common.DraftRoot.EditAction', 'draftEdit', info, ['definitions', draftAdminDataProjectionName]);
      resetAnnotation(artifact, '@Common.DraftRoot.PreparationAction', 'draftPrepare', info, ['definitions', draftAdminDataProjectionName]);
    } else {
      resetAnnotation(artifact, '@Common.DraftNode.PreparationAction', 'draftPrepare', info, ['definitions', draftAdminDataProjectionName]);
    }

    artifact.elements && Object.values(artifact.elements).forEach( elem => {
      // Make all non-key elements nullable
      if (elem.notNull && elem.key !== true) {
        delete elem.notNull;
      }
    });
    // Generate the additional elements into the draft-enabled artifact

    // key IsActiveEntity : Boolean default true
    let isActiveEntity = createScalarElement('IsActiveEntity', 'cds.Boolean', true, true, false);
    isActiveEntity.IsActiveEntity['@UI.Hidden'] = true;
    addElement(isActiveEntity, artifact, artifactName);

    // HasActiveEntity : Boolean default false
    let hasActiveEntity = createScalarElement('HasActiveEntity', 'cds.Boolean', false, false, true);
    hasActiveEntity.HasActiveEntity['@UI.Hidden'] = true;
    addElement(hasActiveEntity, artifact, artifactName);

    // HasDraftEntity : Boolean default false;
    let hasDraftEntity = createScalarElement('HasDraftEntity', 'cds.Boolean', false, false, true);
    hasDraftEntity.HasDraftEntity['@UI.Hidden'] = true;
    addElement(hasDraftEntity, artifact, artifactName);

    // @odata.contained: true
    // DraftAdministrativeData : Association to one DraftAdministrativeData;
    let draftAdministrativeData = createAssociationElement('DraftAdministrativeData', draftAdminDataProjectionName, true);
    draftAdministrativeData.DraftAdministrativeData.cardinality = { max: 1, };
    draftAdministrativeData.DraftAdministrativeData['@odata.contained'] = true;
    draftAdministrativeData.DraftAdministrativeData['@UI.Hidden'] = true;
    addElement(draftAdministrativeData, artifact, artifactName);

    // Note that we need to do the ODATA transformation steps for managed associations
    // (foreign key field generation, generatedFieldName) by hand, because the corresponding
    // transformation steps have already been done on all artifacts when we come here)
    let uuidDraftKey = draftAdministrativeData.DraftAdministrativeData.keys.filter(key => key.ref && key.ref.length === 1 && key.ref[0] === 'DraftUUID');
    if (uuidDraftKey && uuidDraftKey[0]) {
      uuidDraftKey = uuidDraftKey[0]; // filter returns an array, but it has only one element
      let path = ['definitions', artifactName, 'elements', 'DraftAdministrativeData', 'keys', 0];
      createForeignKeyElement(draftAdministrativeData.DraftAdministrativeData, 'DraftAdministrativeData', uuidDraftKey, artifact, artifactName, path);
    }
    // SiblingEntity : Association to one <artifact> on (... IsActiveEntity unequal, all other key fields equal ...)
    let siblingEntity = createAssociationElement('SiblingEntity', artifactName, false);
    siblingEntity.SiblingEntity.cardinality = { max: 1 };
    addElement(siblingEntity, artifact, artifactName);
    // ... on SiblingEntity.IsActiveEntity != IsActiveEntity ...
    siblingEntity.SiblingEntity.on = createAssociationPathComparison('SiblingEntity', 'IsActiveEntity', '!=', 'IsActiveEntity');

    // Iterate elements
    artifact.elements && Object.entries(artifact.elements).forEach( ([elemName, elem]) => {
      if (elemName !== 'IsActiveEntity' && elem.key) {
        // Amend the ON-condition above:
        // ... and SiblingEntity.<keyfield> = <keyfield> ... (for all key fields except 'IsActiveEntity')
        let cond = createAssociationPathComparison('SiblingEntity', elemName, '=', elemName);
        cond.push('and');
        cond.push(...siblingEntity.SiblingEntity.on);
        siblingEntity.SiblingEntity.on = cond;
      }

      // Draft-enable the targets of composition elements (draft nodes), too
      // TODO rewrite
      if (elem.target && elem.type && getFinalType(elem.type) === 'cds.Composition') {
        let draftNode = csn.definitions[elem.target];

        // Ignore if that is our own draft root
        if (draftNode != rootArtifact) {
          // Report error when the draft node has @odata.draft.enabled itself
          if (hasAnnotationValue(draftNode, '@odata.draft.enabled', true)) {
            error(null, ['definitions', artifactName, 'elements', elemName], 'Composition in draft-enabled entity can\'t lead to another entity with “@odata.draft.enabled”');
          }
          // Ignore composition if not part of a service or explicitly draft disabled
          else if (!getServiceName(elem.target) || hasAnnotationValue(draftNode, '@odata.draft.enabled', false)) {
            return;
          }
          else {
            // Generate draft stuff into the target
            generateDraftForOdata(draftNode, elem.target, rootArtifact, visitedArtifacts);
          }
        }
      }
    });

    // Generate the actions into the draft-enabled artifact (only draft roots can be activated/edited)

    // action draftPrepare (SideEffectsQualifier: String) return <artifact>;
    let draftPrepare = createAction('draftPrepare', artifactName, 'SideEffectsQualifier', 'cds.String');
    assignAction(draftPrepare, artifact);

    if (artifact == rootArtifact) {
      // action draftActivate() return <artifact>;
      let draftActivate = createAction('draftActivate', artifactName);
      assignAction(draftActivate, artifact);

      // action draftEdit (PreserveChanges: Boolean) return <artifact>;
      let draftEdit = createAction('draftEdit', artifactName, 'PreserveChanges', 'cds.Boolean');
      assignAction(draftEdit, artifact);
    }
  }

  // CDXCORE-481
  // (4.5) If the member is an association whose target has @cds.odata.valuelist annotate it
  // with @Common.ValueList.viaAssociation.
  // This must be done before foreign keys are calculated and the annotations are propagated
  // to them. This will make sure that association and all its foreign keys are annotated with
  // Common.ValueList in the final EDM.
  // Do this only if the association is navigable and the enclosing artifact is
  // a service member (don't pollute the CSN with unnecessary annotations).
  // TODO: test???
  function addCommonValueListviaAssociation(member, memberName) {
    let vlAnno = '@Common.ValueList.viaAssociation';
    if (isAssociation(member.type)) {
      let navigable = member['@odata.navigable'] !== false; // navigable disabled only if explicitly set to false
      let targetDef = getCsnDef(member.target);
      if (navigable && targetDef['@cds.odata.valuelist'] && !member[vlAnno]) {
        member[vlAnno] = { '=': memberName };
      }
    }
  }

} // transform4odataWithCsn
