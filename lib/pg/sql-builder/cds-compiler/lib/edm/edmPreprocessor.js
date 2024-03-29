'use strict';
/* eslint max-statements-per-line:off */
const { setProp, isDeprecatedEnabled, isBetaEnabled } = require('../base/model');
const { forEachDefinition, forEachGeneric, forEachMemberRecursively,
  isEdmPropertyRendered, getUtils, cloneCsn, isBuiltinType } = require('../model/csnUtils');
const edmUtils = require('./edmUtils.js');
const typesExposure = require('../transform/odata/typesExposure');
const expandCSNToFinalBaseType = require('../transform/odata/toFinalBaseType');

const {
  intersect,
  validateOptions,
  foreach,
  forAll,
  isAssociationOrComposition,
  isComposition,
  isStructuredArtifact,
  isParameterizedEntity,
  resolveOnConditionAndPrepareConstraints,
  finalizeReferentialConstraints,
  isODataSimpleIdentifier,
  isEntity,
  getSchemaPrefix,
  isActionOrFunction
} = require('./edmUtils.js');

/**
 *  edmPreprocessor warms up the model so that it can be converted into an EDM document and
 *  contains all late & application specific model transformations
 *  that should NOT become persistent in the published CSN model but only
 *  be presented in the resulting EDM files. These late tweaks or mods can
 *  be dependent to EDM version.
 *
 * @param {CSN.Model} csn
 * @param {object}    _options
 */
function initializeModel(csn, _options, messageFunctions)
{
  if (!_options)
    throw Error('Please debug me: initializeModel must be invoked with options');

  const { info, warning, error, throwWithError } = messageFunctions;

  const csnUtils = getUtils(csn);
  const {
      getCsnDef,
      getFinalTypeDef,
      isStructured,
      isAssocOrComposition,
    } = getUtils(csn);


  // make sure options are complete
  let options = validateOptions(_options);

  // Fetch service definitions
  const serviceRoots = Object.keys(csn.definitions).reduce((serviceRoots, artName) => {
    const art = csn.definitions[artName];
    if(art.kind === 'service') {
      serviceRoots[artName] = Object.assign(art, { name: artName });
    }
    return serviceRoots;
  }, Object.create(null) );

  // first of all we need to know about all 'real' user defined services
  const serviceRootNames = Object.keys(serviceRoots).sort((a,b)=>b.length-a.length);
  function whatsMyServiceRootName(n, self=true) {
    return serviceRootNames.reduce((rc, sn) => !rc && n && n.startsWith(sn + '.') || (n === sn && self) ? sn : rc, undefined);
  }

  // Structural CSN inbound QA checks
  inboundQualificationChecks();

  if(isBetaEnabled(options, undefined)) {
    splitDottedDefinitionsIntoSeparateServices();
  }
  else
    /*
      Replace dots with underscores for all definitions below a context
      or a service and rewrite refs and targets. MUST be done before type exposure.
    */
    renameDottedDefinitionsInsideServiceOrContext();

  /*
    In order to cover the scenario when the renderer is called with option V2 directly, there is
    the need to expand to final base type when the CSN was already transformed, bur for V4.
    The logic will run also when the CSN was persisted on a file system and the non-enumerable
    properties are lost. Also, will be execute when called with cdsc.
    At the end of the day, this module must be called only here, in the renderer and removed
    as a step in the OData transformer with the goal to have a protocol agnostic OData CSN.
  */
  if (csn.meta && csn.meta.options && csn.meta.options.odataVersion === 'v4' && options.isV2()) {
    const { toFinalBaseType }= require('../transform/transformUtilsNew').getTransformers(csn, options);
    expandCSNToFinalBaseType(csn, { toFinalBaseType }, csnUtils, serviceRootNames, options);
  }
  /*
    Enrich the CSN by de-anonymizing and exposing of required types that are defined outside services.
    Type exposure will add additional schema contexts and group the exposed types in these contexts.
    contexts either represent another service (if the type to be exposed resides in that
    service), the namespace (including (sub-)contexts) or as last resort (if the type name
     has no prefix path) a 'root' namespace.
  */
  const schemas = typesExposure(csn, whatsMyServiceRootName, options, csnUtils, { error });

  // First attach names to all definitions (and actions/params) in the model
  // elements are done in initializeStruct
  forEachDefinition(csn, attachNameProperty);

  // next, we must get an overview about all schemas (including the services)
  const schemaNames = [...serviceRootNames];
  schemaNames.push(...Object.keys(schemas));
  // sort schemas in reverse order to allow longest match in whatsMySchemaName function
  schemaNames.sort((a,b) => b.length-a.length);
  function whatsMySchemaName(n) {
    return schemaNames.reduce((rc, sn) => !rc && n && n.startsWith(sn + '.') ? sn : rc, undefined);
  }

  if(schemaNames.length) {
    Object.values(serviceRoots).forEach(initializeService);
    // Set myServiceName for later reference and indication of a service member
    // First attach names to all definitions in the model
    // Link association targets and spray @odata.contained over untagged compositions
    forEachDefinition(csn, [ (def, defName) => {
      const mySchemaName = whatsMySchemaName(defName);
      mySchemaName && setProp(def, '$mySchemaName', mySchemaName) }, linkAssociationTarget ]);
    // Create data structures for containments
    forEachDefinition(csn, initializeContainments);
    // Initialize entities with parameters (add Parameter entity)
    forEachDefinition(csn, initializeParameterizedEntityOrView);
    // Initialize structures
    forEachDefinition(csn, initializeStructure);
    // Initialize associations after _parent linking
    forEachDefinition(csn, prepareConstraints);
    // Mute V4 elements depending on constraint preparation
    if(options.isV4())
      forEachDefinition(csn, ignoreProperties);
    // calculate constraints based on ignoreProperties and prepareConstraints
    forEachDefinition(csn, finalizeConstraints);
    // convert exposed types into cross schema references if required
    // must be run before proxy exposure to avoid potential reference collisions
    convertExposedTypesOfOtherServicesIntoCrossReferences();
    // create association target proxies
    // Decide if an entity set needs to be constructed or not
    forEachDefinition(csn, [ exposeTargetsAsProxiesOrSchemaRefs, determineEntitySet ]);
    if(options.isV4())
      forEachDefinition(csn, initializeEdmNavPropBindingTargets);

    // Things that can be done in one pass
    // Create edmKeyRefPaths
    // Create NavigationPropertyBindings, requires determineEntitySet
    // Map /** doc comments */ to @CoreDescription
    // Artifact identifier spec compliance check (should be run last)
    forEachDefinition(csn, [ initializeEdmKeyRefPaths, initializeEdmNavPropBindingPaths,
      initializeEdmTypesAndDescription, checkArtifactIdentifierAndBoundActions ]);
  }
  return [serviceRoots, schemas, whatsMyServiceRootName, options];

  //////////////////////////////////////////////////////////////////////
  //
  // Service initialization starts here
  //

  /*
    Replace dots in sub-service and sub-context definitions with underscores to be
    Odata ID compliant.
    Replace the definitions in csn.definitions (such that linkAssociationTarget works)
    All type refs and assoc targets must also be adjusted to refer to the new names.
  */
  function renameDottedDefinitionsInsideServiceOrContext() {

    // Find the first definition above the current definition or undefined otherwise.
    // Definition can either be a context or a service
    function getRootDef(name) {
      let pos = name.lastIndexOf('.');
      name = pos < 0 ? undefined : name.substring(0, pos);
      while (name && !['service', 'context'].includes(csn.definitions[name] && csn.definitions[name].kind)) {
        pos = name.lastIndexOf('.');
        name = pos < 0 ? undefined : name.substring(0, pos);
      }
      return name;
    }

    const dotEntityNameMap = Object.create(null);
    const dotTypeNameMap = Object.create(null);
    forEachDefinition(csn, (def, defName) => {
      if(['entity', 'view', 'type', 'action', 'function'].includes(def.kind)) {
        const rootDef = getRootDef(defName);
        // if this definition has a root def and the root def is not the service/schema name
        // => service C { type D.E }, replace the prefix dots with underscores
        if(rootDef && defName !== rootDef && rootDef !== getSchemaPrefix(defName)) {
          let newDefName = rootDef + '.' + defName.replace(rootDef + '.', '').replace(/\./g, '_');
          // store renamed types in correlation maps for later renaming
          if(['entity', 'view'].includes(def.kind))
            dotEntityNameMap[defName] = newDefName;
          if(['type'].includes(def.kind))
            dotTypeNameMap[defName] = newDefName;
          // rename in csn.definitions
          const art = csn.definitions[newDefName];
          if(art !== undefined) {
            error(null, [ 'definitions', defName ], { name: newDefName },
            `Artifact name containing dots can't be mapped to an OData compliant name because it conflicts with existing definition $(NAME)`);
          }
          else {
            csn.definitions[newDefName] = def;
            delete csn.definitions[defName];
          }
          // dots are illegal in bound actions/functions, no actions required for them
        }
      }
    });
    // rename type refs to new type names
    forEachDefinition(csn, def => {
      forEachMemberRecursively(def, member => {
        member = member.items || member;
        if(member.type && dotTypeNameMap[member.type]) {
          member.type = dotTypeNameMap[member.type];
        }
        if(member.target && dotEntityNameMap[member.target]) {
          member.target = dotEntityNameMap[member.target];
        }
        if(member.$path && dotEntityNameMap[member.$path[1]]) {
          member.$path[1] = dotEntityNameMap[member.$path[1]]
        }
        _rewriteReferencesInActions(member);
      });
      // handle unbound action/function and params in views
      _rewriteReferencesInActions(def);
    });

    function _rewriteReferencesInActions(act) {
      act.params && Object.values(act.params).forEach(param => {
        param = param.items || param;
        if(param.type && (dotEntityNameMap[param.type] || dotTypeNameMap[param.type]))
          param.type = dotEntityNameMap[param.type] || dotTypeNameMap[param.type];
      });
      if(act.returns){
        const returnsObj = act.returns.items || act.returns;
        if (returnsObj.type && dotEntityNameMap[returnsObj.type] || dotTypeNameMap[returnsObj.type])
          returnsObj.type = dotEntityNameMap[returnsObj.type] || dotTypeNameMap[returnsObj.type];
      }
    }
  }

  /*
    Experimental: Move definitions with dots into separate (sub-)service that has the
    namespace of the definition prefix. As not all such services end up with entity sets,
    schemas should be packed after the preprocessing run in order to minimize the number
    of services.
  */
  function splitDottedDefinitionsIntoSeparateServices() {
    forEachDefinition(csn, (def, defName) => {
      if(![ 'service' ].includes(def.kind)) {
        const myServiceRoot = whatsMyServiceRootName(defName);
        const mySchemaPrefix = getSchemaPrefix(defName);
        if(myServiceRoot && options.isV4() &&
        /*(options.toOdata.odataProxies || options.toOdata.odataXServiceRefs) && options.isStructFormat && */
        defName !== myServiceRoot && myServiceRoot !== mySchemaPrefix) {
          const service = { kind: 'service', name: mySchemaPrefix };
          serviceRoots[mySchemaPrefix] = service;
          serviceRootNames.push(mySchemaPrefix);
        }
      }
    });
    serviceRootNames.sort((a,b) => b.length-a.length);
  }

  function attachNameProperty(def, defName) {
    assignProp (def, 'name', defName);
    // Attach name to bound actions, functions and parameters
    forEachGeneric(def, 'actions', (a, n) => {
      assignProp(a, 'name', n);
      forEachGeneric(a, 'params', (p, n) => {
        assignProp(p, 'name', n);
      });
    });
    // Attach name unbound action parameters
    forEachGeneric(def, 'params', (p,n) => {
      assignProp(p, 'name', n);
    });
  }

  // initialize the service itself
  function initializeService(service) {
    // check service name
    if (service.name.length > 511) {
      error(null, ['definitions', service.name], 'OData namespace must not exceed 511 characters' );
    }
    const simpleIdentifiers = service.name.split('.');
    simpleIdentifiers.forEach((identifier) => {
      if (!isODataSimpleIdentifier(identifier)) {
        signalIllegalIdentifier(identifier, ['definitions', service.name]);
      }
    });
    setSAPSpecificV2AnnotationsToEntityContainer(options, service);
  }

  // link association target to association and add @odata.contained to compositions in V4
  function linkAssociationTarget(struct) {
    forEachMemberRecursively(struct, (element, name, prop, subpath) => {
      if(isAssociationOrComposition(element) && !element._ignore) {
        if(!element._target) {
          let target = csn.definitions[element.target];
          if(target) {
            setProp(element, '_target', target);
          // If target has parameters, xref assoc at target for redirection
            if(isParameterizedEntity(target)) {
              if(!target.$sources) {
                setProp(target, '$sources', Object.create(null));
              }
              target.$sources[struct.name + '.' + name] = element;
            }
          }
          else {
            error(null, subpath, { target: element.target }, "Target $(TARGET) can't be found in the model");
          }
        }
      }
      // in V4 tag all compositions to be containments
      if(options.odataContainment &&
         options.isV4() &&
         isComposition(element) &&
         element['@odata.contained'] === undefined) {
        element['@odata.contained'] = true;
      }
    });
  }

  // Perform checks and add attributes for "contained" sub-entities:
  // - A container is recognized by having an association/composition annotated with '@odata.contained'.
  // - All targets of such associations ("containees") are marked with a property
  //   '_containerEntity: []', having as value an array of container names (i.e. of entities
  //   that have a '@odata.contained' association pointing to the containee). Note that this
  //   may be multiple entities, possibly including the container itself.
  // - All associations in the containee pointing back to the container are marked with
  //   a boolean property '_isToContainer : true', except if the association itself
  //   has the annotation '@odata.contained' (indicating the top-down link in a hierarchy).
  // - Rewrite annotations that would be assigned to the containees entity set for the
  //   non-containment rendering. If containment rendering is active, the containee has no
  //   entity set. Instead try to rewrite the annotation in such a way that it is effective
  //   on the containment navigation property.
  function initializeContainments(container) {
    if(['entity', 'view'].includes(container.kind)) {
      forEachMemberRecursively(container, initContainments,
        [], true, { elementsOnly: true });
    }

    function initContainments(elt, eltName) {
      if(isAssociationOrComposition(elt) && elt['@odata.contained'] && !elt._ignore) {
        // Let the containee know its container
        // (array because the contanee may contained more then once)
        let containee = elt._target;
        if (!containee._containerEntity)
          setProp(containee, '_containerEntity', []);
        // add container only once per containee
        if (!containee._containerEntity.includes(container.name))
          containee._containerEntity.push(container.name);
        // Mark associations in the containee pointing to the container (i.e. to this entity)
        forEachMemberRecursively(containee, markToContainer,
          [], true, { elementsOnly: true });
        rewriteContainmentAnnotations(container, containee, eltName);
      }
      else {
          // try to find elements to drill down further
        while(elt && !(isBuiltinType(elt.type) || elt.elements)) {
          elt = csn.definitions[elt.type];
        }
        if(elt && elt.elements) {
          forEachMemberRecursively(elt, initContainments,
            [], true, { elementsOnly: true });
        }
      }
    }

    function markToContainer(elt) {
      if(elt._target && elt._target.name) {
        // If this is an association that points to the container (but is not by itself contained,
        // which would indicate the top role in a hierarchy) mark it with '_isToContainer'
        if(elt._target.name === container.name && !elt['odata.contained']) {
          setProp(elt, '_isToContainer', true);
        }
      }
      else {
        // try to find elements to drill down further
        while(elt && !(isBuiltinType(elt.type) || elt.elements)) {
          elt = csn.definitions[elt.type];
        }
        if(elt && elt.elements) {
          forEachMemberRecursively(elt, markToContainer,
            [], true, { elementsOnly: true });
        }
      }
    }
  }

  // Split an entity with parameters into two entity types with their entity sets,
  // one named <name>Parameter and one named <name>Type. Parameter contains Type.
  // Containment processing must take place before because it might be that this
  // artifact with parameters is already contained. In such a case the existing
  // containment chain must be propagated and reused. This requires that the
  // containment data structures must be manually added here and rewriteContainmentAnnotations()
  // must be called.
  // As a param entity is a potential proxy candidate, this split must be performed on
  // all definitions
  function initializeParameterizedEntityOrView(entityCsn, entityName) {

    if(!isParameterizedEntity(entityCsn))
      return;

    // Naming rules for aggregated views with parameters
    // Parameters: EntityType <ViewName>Parameters, EntitySet <ViewName>
    //             with NavigationProperty "Results" pointing to the entity set of type <ViewName>Result
    // Result:     EntityType <ViewName>Result, EntitySet <ViewName>Results

    // Naming rules for non aggregated views with parameters
    // Parameters: EntityType <ViewName>Parameters, EntitySet <ViewName>
    //             with NavigationProperty "Set" pointing to the entity set of type <ViewName>Type
    // Result:     EntityType <ViewName>Type, EntitySet <ViewName>Set
    //             Backlink Navigation Property "Parameters" to <ViewName>Parameters

    // this code can be extended for aggregated views
    const parameterEntityName = entityName + 'Parameters';
    const originalEntityName = entityName + 'Type';
    const originalEntitySetName = entityName + 'Set';
    const parameterToOriginalAssocName = 'Set';
    const backlinkAssocName = 'Parameters';
    let hasBacklink = true;

    // Construct the parameter entity
    const parameterCsn = {
      name: parameterEntityName,
      kind: 'entity',
      elements: Object.create(null),
      '@sap.semantics': 'parameters',
    };
    setProp(parameterCsn, '$entitySetName', entityName);

    if(entityCsn.$location){
      assignProp(parameterCsn, '$location', entityCsn.$location);
    }

    /*
      <EntitySet Name="ZRHA_TEST_CDS" EntityType="ZRHA_TEST_CDS_CDS.ZRHA_TEST_CDSParameters" sap:creatable="false" sap:updatable="false"
                 sap:deletable="false" sap:pageable="false" sap:content-version="1"/>
    */

    assignProp(parameterCsn, '_SetAttributes',
      {'@sap.creatable': false, '@sap.updatable': false, '@sap.deletable': false, '@sap.pageable': false });

    setProp(parameterCsn, '$isParamEntity', true);
    setProp(parameterCsn, '$mySchemaName', entityCsn.$mySchemaName);

    // propagate containment information, if containment is recursive, use parameterCsn.name as _containerEntity
    if(entityCsn._containerEntity) {
      setProp(parameterCsn, '_containerEntity', []);
      for(let c of entityCsn._containerEntity) {
        parameterCsn._containerEntity.push((c==entityCsn.name)?parameterCsn.name:c);
      }
    }
    entityCsn._containerEntity = [ parameterCsn ];

    forEachGeneric(entityCsn, 'params', (p,n) => {
      let elt = cloneCsn(p, options);
      elt.name = n;
      delete elt.kind;
      elt.key = true; // params become primary key in parameter entity
      parameterCsn.elements[n] = elt;
    });
    linkAssociationTarget(parameterCsn);
    initializeContainments(parameterCsn);
    // add assoc to result set, FIXME: is the cardinality correct?
    parameterCsn.elements[parameterToOriginalAssocName] = {
      '@odata.contained': true,
      name: parameterToOriginalAssocName,
      target: entityCsn.name,
      type: 'cds.Association',
      cardinality: { src: 1, min: 0, max: '*' }
    };
    setProp(parameterCsn.elements[parameterToOriginalAssocName], '_target', entityCsn);
    setProp(parameterCsn.elements[parameterToOriginalAssocName], '$path',
      [ 'definitions', parameterEntityName, 'elements', parameterToOriginalAssocName ] );

      // rewrite $path
    setProp(parameterCsn, '$path', [ 'definitions', parameterEntityName ]);
    forEachMemberRecursively(parameterCsn, (member) => {
      if(member.$path)
        member.$path[1] = parameterEntityName;
    });


    csn.definitions[parameterCsn.name] = parameterCsn;
    // modify the original parameter entity with backlink and new name
    csn.definitions[originalEntityName] = entityCsn;
    delete csn.definitions[entityCsn.name];
    entityCsn.name = originalEntityName;
    setProp(entityCsn, '$entitySetName', originalEntitySetName);
    // add backlink association
    if(hasBacklink) {
      entityCsn.elements[backlinkAssocName] = {
        name: backlinkAssocName,
        target: parameterCsn.name,
        type: 'cds.Association',
        on: [ { ref: [ 'Parameters', 'Set' ] }, '=', { ref: [ '$self' ] } ]
      };
      setProp(entityCsn.elements[backlinkAssocName], '_selfReferences', []);
      setProp(entityCsn.elements[backlinkAssocName], '_target', parameterCsn);
      setProp(entityCsn.elements[backlinkAssocName], '$path',
        [ 'definitions', originalEntityName, 'elements', backlinkAssocName ] );

      // rewrite $path
      if(entityCsn.$path)
        entityCsn.$path[1] = originalEntityName;
      forEachMemberRecursively(entityCsn, (member) => {
        if(member.$path)
          member.$path[1] = originalEntityName;
      });
    }

/*
  <EntitySet Name="ZRHA_TEST_CDSSet" EntityType="ZRHA_TEST_CDS_CDS.ZRHA_TEST_CDSType" sap:creatable="false" sap:updatable="false"
             sap:deletable="false" sap:addressable="false" sap:content-version="1"/>
*/
    assignProp(entityCsn, '_SetAttributes',
      {'@sap.creatable': false, '@sap.updatable': false, '@sap.deletable': false, '@sap.addressable': false });



    // redirect inbound associations/compositions to the parameter entity
    Object.keys(entityCsn.$sources || {}).forEach(n => {
      // preserve the original target for constraint calculation
      setProp(entityCsn.$sources[n], '_originalTarget', entityCsn.$sources[n]._target);
      entityCsn.$sources[n]._target = parameterCsn;
      entityCsn.$sources[n].target = parameterCsn.name;
    });
    rewriteContainmentAnnotations(parameterCsn, entityCsn, parameterToOriginalAssocName);
  }


  function initElement(element, name, struct) {
    setProp(element, 'name', name)
    setProp(element, '_parent', struct);
  }

  // convert $path to path starting at main artifact
  function $path2path(p) {
    const path = [];
    let env = csn;
    for (let i = 0; p && env && i < p.length; i++) {
      const ps = p[i];
      env = env[ps];
      if (env && env.constructor === Object) {
        path.push(ps);
        if(env.items)
          env = env.items;
        if(env.type && !isBuiltinType(env.type) && !env.elements)
          env = csn.definitions[env.type];
      }
    }
    return path;
  }

  // Initialize a structured artifact
  function initializeStructure(def) {

    // Don't operate on any structured types other than type and entity
    // such as events and aspects
    if(!isStructuredArtifact(def))
      return;

    let keys = Object.create(null);
    let validFrom = [], validKey = [];

    // Iterate all struct elements
    forEachMemberRecursively(def.items || def, (element, elementName, prop, path = [], construct) => {
      if(!['elements'].includes(prop))
        return;

      initElement(element, elementName, construct);

      if(!['event', 'aspect'].includes(def.kind)) {
        if(element._parent && element._parent.$mySchemaName) {
          if(!isODataSimpleIdentifier(elementName)) {
            signalIllegalIdentifier(elementName, ['definitions', def.name].concat(path));
          } else if (options.isV2() && /^(_|[0-9])/.test(elementName) && ['view', 'entity'].includes(element._parent.kind)) {
            // FIXME: Rewrite signalIllegalIdentifier function to be more flexible
            error(null, ['definitions', def.name, 'elements', elementName], { prop: elementName[0] },
            'Element names must not start with $(PROP) for OData V2');
          }
        }
      }
        // collect temporal information
      if(element['@cds.valid.key']) {
        validKey.push(element);
      }
      if(element['@cds.valid.from']) {
        validFrom.push(element);
      }

      // initialize an association
      if(isAssociationOrComposition(element)) {
        // in case this is a forward assoc, store the backlink partners here, _selfReferences.length > 1 => error
        assignProp(element, '_selfReferences', []);
        assignProp(element._target, '$proxies', []);
        // $abspath is used as partner path
        assignProp(element, '$abspath', $path2path(element.$path));

        //forward annotations from managed association element to its foreign keys
        if(element.keys && options.isFlatFormat) {
          const elements = construct.items && construct.items.elements || construct.elements;
          for(let fk of element.keys) {
            forAll(element, (attr, attrName) => {
              if(attrName[0] === '@' && fk.$generatedFieldName && elements && elements[fk.$generatedFieldName]) {
                elements[fk.$generatedFieldName][attrName] = attr;
              }
            });
          }
        }
        // and afterwards eventually remove some :)
        setSAPSpecificV2AnnotationsToAssociation(options, element, def);
      }

      // Collect keys
      if (element.key) {
        keys[elementName] = element;
      }
      applyAppSpecificLateCsnTransformationOnElement(options, element, def, error);
    }, [], true, { elementsOnly: true });

    if(!isDeprecatedEnabled(options, 'v1KeysForTemporal')) {
      // if artifact has a cds.valid.key mention it as @Core.AlternateKey
      if(validKey.length) {
        let altKeys = [{ Key: [] }];
        validKey.forEach(vk => altKeys[0].Key.push( { Name: vk.name, Alias: vk.name } ) );
        assignAnnotation(def, '@Core.AlternateKeys', altKeys);
      }
    }
    else {
      // if artifact has a cds.valid.key make this the only primary key and
      // add all @cds.valid.from + original primary keys as alternate keys
      // @Core.AlternateKeys: [{ Key: [ { Name: 'slID', Alias: 'slID' }, { Name: 'validFrom', Alias: 'validFrom'} ] }]
      if(validKey.length) {
        let altKeys = [{ Key: [] }];
        forAll(keys, (k, kn) => {
          altKeys[0].Key.push( { Name: kn, Alias: kn } );
          delete k.key;
        });
        validFrom.forEach(e => {
          altKeys[0].Key.push( { Name: e.name, Alias: e.name } );
        });
        assignAnnotation(def, '@Core.AlternateKeys', altKeys);
        keys = Object.create(null);
        validKey.forEach(e => {
          e.key = true;
          keys[e.name] = e;
        });
      }
      else {
        validFrom.forEach(e => {
          e.key = true;
          keys[e.name] = e;
        });
      }
    }

    // prepare the structure itself
    if(isEntity(def)) {
      assignProp(def, '_SetAttributes', Object.create(null));
      assignProp(def, '$keys', keys);
      applyAppSpecificLateCsnTransformationOnStructure(options, def, error);
      setSAPSpecificV2AnnotationsToEntitySet(options, def);
    }
  }

  // Prepare the associations for the subsequent steps
  function prepareConstraints(struct) {
    if(!isStructuredArtifact(struct))
      return;

    forEachMemberRecursively(struct.items || struct, (element) => {
      if (isAssociationOrComposition(element) && !element._ignore) {
        // setup the constraints object
        setProp(element, '_constraints', { constraints: Object.create(null), selfs: [], _origins: [], termCount: 0 });
        // and crack the ON condition
        resolveOnConditionAndPrepareConstraints(csn, element, messageFunctions);
      }
    }, [], true, { elementsOnly: true });
  }

  /*
    Do not render (ignore) elements as properties
    In V4:
    1) If this is a foreign key of an association to a container which *is* used
       to establish the containment via composition and $self comparison, then
       do not render this foreign key. The $self comparison can only be evaluated
       after the ON conditions have been parsed in prepareConstraints().
    2) For all other foreign keys let isEdmPropertyRendered() decide.
    3) If an element/association is annotated with @odata.containment.ignore and containment is
       active, assign @cds.api.ignore or @odata.navigable: false
    4) All of this can be revoked with options.renderForeignKeys.
  */
  function ignoreProperties(struct) {
    if(!isStructuredArtifact(struct))
      return;

    forEachMemberRecursively(struct.items || struct, (element) => {
      if(!element.target) {
        if(element['@odata.foreignKey4']) {
          let isContainerAssoc = false;
          let elements = (struct.items || struct).elements;
          let assoc = undefined;
          const paths = element['@odata.foreignKey4'].split('.')
          for(let p of paths) {
            assoc = elements[p];
            if(assoc) // could be that the @odata.foreignKey4 was propagated...
              elements = assoc.elements;
          }

          if(assoc)
            isContainerAssoc = !!(assoc._isToContainer && assoc._selfReferences.length || assoc['@odata.contained']);
            /*
            If this foreign key is NOT a container fk, let isEdmPropertyRendered() decide
            Else, if fk is container fk, omit it if it wasn't requested in structured mode
            */
          if((!isContainerAssoc && !isEdmPropertyRendered(element, options)) ||
               (isContainerAssoc && !options.renderForeignKeys))
            assignAnnotation(element, '@cds.api.ignore', true);
          // Only in containment:
          // If this element is a foreign key and if it is rendered, remove it from the key ref vector
          else if(options.odataContainment && isContainerAssoc && options.renderForeignKeys) {
            delete struct.$keys[element.name];
          }
        }
        // deprecated unmanagedUpInComponent:
        // Only in containment:
        // Ignore this (foreign key) elment if renderForeignKeys is false
        if(options.odataContainment && element['@odata.containment.ignore']) {
          if(!options.renderForeignKeys)
            assignAnnotation(element, '@cds.api.ignore', true);
          else
            // If foreign keys shall be rendered, remove it from key ref vector
            delete struct.$keys[element.name];
        }
      }
        // it's an association
      else if(element['@odata.containment.ignore'] && options.odataContainment && !options.renderForeignKeys) {
          // if this is an explicitly containment ignore tagged association,
          // ignore it if option odataContainment is true and no foreign keys should be rendered
        assignAnnotation(element, '@odata.navigable', false);
      }
    }, [], true, { elementsOnly: true });
  }

  /*
    Calculate the final referential constraints based on the assignments done in mutePropertiesForV4()
    It may be that now a number of properties are not rendered and cannot act as constraints (see isConstraintCandidate())
    in edmUtils
  */
  function finalizeConstraints(struct) {
    if(!isStructuredArtifact(struct))
      return;

    forEachMemberRecursively(struct.items || struct, (element) => {
      if (isAssociationOrComposition(element) && !element._ignore) {
        finalizeReferentialConstraints(csn, element, options, info);

        if(element._constraints._partnerCsn && element.cardinality && element.cardinality.max) {
          // if this is a partnership and this assoc has a set target cardinality, assign it as source cardinality to the partner
          if(element._constraints._partnerCsn.cardinality) {
            // if the forward association has set a src cardinality and it deviates from the backlink target cardinality raise a warning
            // in V2 only, in V4 the source cardinality is rendered implicitly at the Type property
            if(element._constraints._partnerCsn.cardinality.src) {
              let srcMult = (element._constraints._partnerCsn.cardinality.src == 1) ? '0..1' : '*';
              let newMult = (element.cardinality.max > 1) ? '*' : '0..1';
              if(options.isV2() && srcMult != newMult) {
                // Association 'E_toF': Multiplicity of Role='E' defined to '*', conflicting with target multiplicity '0..1' from
                warning(null, null, `Source cardinality "${element._constraints._partnerCsn.cardinality.src}" of "${element._constraints._partnerCsn._parent.name}/${element._constraints._partnerCsn.name}" conflicts with target cardinality "${element.cardinality.max}" of association "${element._parent.name}/${element.name}"`);
              }
            }
            else {
              // .. but only if the original assoc hasn't set src yet
              element._constraints._partnerCsn.cardinality.src = element.cardinality.max;
            }
          }
          else {
            element._constraints._partnerCsn.cardinality = { src: element.cardinality.max };
          }
        }
      }
    }, [], true, { elementsOnly: true });
  }

  /*
    convert sub schemas that represent another service into a service reference object and remove all
    sub artifacts exposed by the initial type exposure
  */
  function convertExposedTypesOfOtherServicesIntoCrossReferences() {
    if(options.toOdata.odataXServiceRefs && options.isV4()) {
      serviceRootNames.forEach(srn => {
        schemaNames.forEach(fqSchemaName => {
          if(fqSchemaName.startsWith(srn + '.')) {
            const targetSchemaName = fqSchemaName.replace(srn + '.', '');
            if(serviceRootNames.includes(targetSchemaName)) {
            // remove all definitions starting with < fqSchemaName >. and add a schema reference
              Object.keys(csn.definitions).forEach(dn => {
                if(dn.startsWith(fqSchemaName)) // this includes the fqSchemaName context
                  delete csn.definitions[dn];
              });
              if(!schemas[fqSchemaName])
                schemaNames.push(fqSchemaName);
              schemas[fqSchemaName] = createSchemaRef(targetSchemaName);
            }
          }
        });
      });
    }
    schemaNames.sort((a,b)=>b.length-a.length);
  }

  /*
      If an association targets an artifact outside the service, expose the target entity type
      as proxy.

      A proxy represents the identity (or primary key tuple) of the target entity.

      All proxies are registered in a sub context representing the schema, in which the proxy
      is to be rendered (see csn2edm for details).

      If the target resides outside any service, the schema is either it's CDS namespace if provided
      or as 'root'.

      If the target resides in another service, either a schema named by the target service is
      created (option: odataProxies), or a reference object is created representing the target
      service (option: odataExtReferences).

      If option odataExtReferences is used, 'root' proxies are still created.

      If an entity type which is a proxy candidate has a managed association as primary key,
      all dependent entity types are exposed (or referenced) as well to keep the navigation
      graph in tact. This effectively will expose the transitive primary key closure of all
      proxies.
  */
  function exposeTargetsAsProxiesOrSchemaRefs(struct) {
    if([ 'context', 'service' ].includes(struct.kind) || struct.$proxy)
      return;

    // globalSchemaPrefix is the prefix for all proxy registrations and must not change
    // the service prefix is checked without '.' because we also want to inspect those
    // definitions which are directly below the root service ($mySchemaName is the root)
    const globalSchemaPrefix = whatsMyServiceRootName(struct.$mySchemaName);
    // if this artifact is a service member check its associations
    if(globalSchemaPrefix) {
      forEachGeneric(struct.items || struct, 'elements', element => {
        if(!isAssociationOrComposition(element) || element._ignore || element['@odata.navigable'] === false)
          return;
        /*
         * Consider everything @cds.autoexpose: falsy to be a proxy candidate for now
         */
        /*
        if(element._target['@cds.autoexpose'] === false) {
          // :TODO: Also _ignore foreign keys to association?
          foreach(struct.elements,
            e =>
              e['@odata.foreignKey4'] === element.name,
            e => e._ignore = true);
          element._ignore = true;
          info(null, ['definitions', struct.name, 'elements', element.name]
            `${element.type.replace('cds.', '')} "${element.name}" excluded,
              target "${element._target.name}" is annotated '@cds.autoexpose: ${element._target['@cds.autoexpose']}'`
            );
          return;
        }
        */
        // Create a proxy if the source schema and the target schema are different
        // That includes that the target doesn't have a schema.
        // If the target is in another schema, check if both the source and the target share the same service name.
        // If they share the same service name, then it is just a cross schema navigation within the same EDM, no
        // proxy required.

        // odataProxies (P) and odataXServiceRefs (X) are evalutated as follows:
        // P | X | Action
        // 0 | 0 | No out bound navigation
        // 0 | 1 | Cross service references are generated
        // 1 | 0 | Proxies for all out bound navigation targets are created
        // 1 | 1 | Cross service references and proxies are generated

        const targetSchemaName = element._target.$mySchemaName;
        if(isProxyRequired(element)) {
          if(options.isV4() && (options.toOdata.odataProxies || options.toOdata.odataXServiceRefs)) {
            // reuse proxy if available
            let proxy = getProxyForTargetOf(element);
            if(!proxy) {
              if(targetSchemaName && options.toOdata.odataXServiceRefs) {
                proxy = createSchemaRefFor(element, targetSchemaName);
              }
              else if(options.toOdata.odataProxies) {
                proxy = createProxyFor(element, targetSchemaName);
              }
              proxy = registerProxy(proxy, element);
            }
            if(proxy) {
            // if a proxy was either already created or could be created and
            // if it's a 'real' proxy, link the _target to it and remove constraints
            // otherwise proxy is a schema reference, then do nothing
              element._constraints.constraints = Object.create(null);
              if(proxy.kind === 'entity') {
                element._target = proxy;
              }
              else {
                // fake the target to be proxy
                setProp(element._target, '$externalRef', true);
              }
            }
            else {
              // no proxy: no navigation
              assignAnnotation(element, '@odata.navigable', false);
              noNavPropMsg(element);
            }
          }
          // ok schema names are different, now check if external wants to link back into its service schema
          else {
            assignAnnotation(element, '@odata.navigable', false);
            noNavPropMsg(element);
            return;
          }
        }
      });
    }

    function noNavPropMsg(elt) {
      warning(null, ['definitions', struct.name, 'elements', elt.name],
            { target: elt._target.name }, 'No OData navigation property generated, target $(TARGET) is outside any service');
    }

    function createSchemaRefFor(assoc, targetSchemaName) {
      let ref = csn.definitions[globalSchemaPrefix + '.' + targetSchemaName];
      if(!ref) {
        ref = createSchemaRef(targetSchemaName);
      }

      return ref;
    }

    function createProxyFor(assoc, targetSchemaName) {
      // If target is outside any service expose it in service of source entity
      // The proxySchemaName is not prepended with the service schema name to allow to share the proxy
      // if it is required in multiple services. The service schema name is prepended upon registration
      const proxySchemaName = targetSchemaName || getSchemaPrefix(assoc._target.name);

        // 1) construct the proxy definition
        // proxyShortName: strip the serviceName and replace '.' with '_'
      const proxyShortName = assoc._target.name.replace(proxySchemaName + '.', '').replace(/\./g, '_');
        // fullName: Prepend serviceName and if in same service add '_proxy'
      const fullName = proxySchemaName + '.' + proxyShortName;
      const proxy = { name: fullName, kind: 'entity', $proxy: true, elements: Object.create(null) };
      setProp(proxy, '$mySchemaName', proxySchemaName);
      setProp(proxy, '$keys', Object.create(null));
      setProp(proxy, '$hasEntitySet', false);
      setProp(proxy, '$exposedTypes', Object.create(null));
      // copy all annotations of the target to the proxy
      Object.entries(assoc._target).forEach(([k, v]) => {
        if(k[0] === '@')
          proxy[k] = v;
      });

      // 2) create the elements and $keys
      populateProxyElements(proxy, assoc._target.$keys);
      // 3) sort the exposed types so that they appear lexicographically ordered in the EDM
      proxy.$exposedTypes = Object.keys(proxy.$exposedTypes).sort().reduce((dict, tn) => {
        dict[tn] = proxy.$exposedTypes[tn];
        return dict
      }, Object.create(null));

      return proxy;

      // copy over the primary keys of the target and trigger the type exposure
      function populateProxyElements(proxy, keys) {
        forAll(keys, e => {
          if (isEdmPropertyRendered(e, options)) {
            let newElt = undefined;
            if(isAssocOrComposition(e.type)) {
              if(!e.on && e.keys) {
                if(options.toOdata.odataNoTransitiveProxies)
                  newElt = convertManagedAssocIntoStruct(e);
                else
                  newElt = createProxyOrSchemaRefForManagedAssoc(e);
              }
              else {
                info(null, ['definitions', struct.name, 'elements', assoc.name],
                { name: fullName, target: assoc._target.name },
                'Unmanaged associations are not supported as primary keys for proxy entity type $(NAME) of unexposed association target $(TARGET)');
              }
            }
            else {
              newElt = cloneCsn(e, options);
            }
            if(newElt) {
              initElement(newElt, e.name, proxy);
              if(isStructured(newElt)) {
                // argument proxySchemaName forces an anonymous type definition for newElt into the
                // proxy schema. If omitted, this exposure defaults to 'root', in case API flavor of the day
                // changes...
                exposeStructTypeForProxyOf(proxy, newElt, proxyShortName + '_' + newElt.name, proxySchemaName);
              // elements of newElt are required for key ref paths
              }
              // all elements must become primary key
              proxy.$keys[e.name] = proxy.elements[newElt.name] = newElt;
            }
          }
        });
      }

      // If 'node' exists and has a structured type that is not exposed in 'service', (because the type is
      // anonymous or has a definition outside of 'service'), create an equivalent type in 'service', either
      // using the type's name or (if anonymous) 'artificialName', and make 'node' use that type instead.
      // Complain if there is an error.
      function exposeStructTypeForProxyOf(proxy, node, artificialName, typeSchemaName='root') {
        const isNotInProtNS = node.type ? !isBuiltinType(node.type) : true;
        // Always expose types referred to by a proxy, never reuse an eventually exisiting type
        // as the nested elements must all be not nullable
        if (isNotInProtNS) {
          let typeDef = node.type ? csn.definitions[node.type] : /* anonymous type */ node;

          if (typeDef) {
            let typeClone;
            // the type clone must be produced for each service as this type may
            // produce references and/or proxies into multiple services
            // (but only once per service, therefore cache it).
            if(typeDef.$proxyTypes && typeDef.$proxyTypes[globalSchemaPrefix]) {
              // if type has been exposed in a schema use this type
              typeClone = typeDef.$proxyTypes[globalSchemaPrefix];
            }
            else {
                // Set the correct name
              let typeId = artificialName; // the artificialName has no namespace, it's the element
              if(node.type) {
                // same as for proxies, use schema or namespace, 'root' is last resort
                typeSchemaName = typeDef.$mySchemaName || getSchemaPrefix(node.type);
                typeId = node.type.replace(typeSchemaName + '.', '').replace(/\./g, '_');
                // strip the service root of that type (if any)
                const myServiceRootName = whatsMyServiceRootName(typeSchemaName);
                if(myServiceRootName)
                  typeSchemaName = typeSchemaName.replace(myServiceRootName + '.', '');
              }

              if(isStructuredArtifact(typeDef)) {
                typeClone = cloneStructTypeForProxy(typeSchemaName, `${typeSchemaName}.${typeId}`, typeDef);
                if(typeClone) {
                  // Recurse into elements of 'type' (if any)
                  typeClone.elements && Object.entries(typeClone.elements).forEach( ([elemName, elem]) => {
                    // if this is a foreign key elment, we must check wether or not the association
                    // has been exposed as proxy. If it has not been exposed, no further structured
                    // types must be exposed as 'Proxy_' types.

                    // TODO: expose types of assoc.keys and don't rely on exposed foreign keys
                    if(!elem['@odata.foreignKey4'] ||
                      (elem['@odata.foreignKey4'] && !typeClone.elements[elem['@odata.foreignKey4']].$exposed))
                      exposeStructTypeForProxyOf(proxy, elem, `${typeId}_${elemName}`, typeSchemaName);
                  });
                  if(!typeDef.$proxyTypes)
                    typeDef.$proxyTypes = Object.create(null);
                  typeDef.$proxyTypes[globalSchemaPrefix] = typeClone;
                }
              }
              else {
                // FUTURE: expose scalar type definition as well
              }
            }
            if(typeClone) {
              // register the type clone at the proxy
              // Reminder: Each proxy receives a full set of type clones, even if the types are shared
              // (no scattered type clone caching). registerProxy() checks if a clone needs to be added to
              // csn.definitions.
              proxy.$exposedTypes[typeClone.name] = typeClone;

              // set the node's new type name
              node.type = typeClone.name;
              // the key path generator must use the type clone directly, because it can't resolve
              // the type clone in the CSN (its name is the final name and not the definition name).
              setProp(node, '_type', typeClone);
              // Hack alert:
              // beta feature 'subElemRedirections' (now the default in v2) adds elements to the node by
              // default, without we must do it to get the primary key tuple calculation correct.
              // Remember: node.type is the service local type name (not prepended by the service name),
              // so it can't be resolved in definitions later on
              if(typeClone.elements)
                node.elements = typeClone.elements;
            }
          }
        }

        function cloneStructTypeForProxy(typeSchemaName, name, typeDef) {
          // Create type with empty elements
          const type = {
            kind: 'type',
            name,
            elements: Object.create(null),
          };
          setProp(type, '$mySchemaName', typeSchemaName);
          setProp(type, '$exposedBy', 'proxyExposure');

          typeDef.elements && Object.entries(typeDef.elements).forEach( ([elemName, elem]) => {
            if(!elem.target) {
              type.elements[elemName] = Object.create(null);
              Object.keys(elem).forEach(prop => type.elements[elemName][prop] = elem[prop])
              type.elements[elemName].notNull = true;
            }
            else {
              type.elements[elemName] = createProxyOrSchemaRefForManagedAssoc(elem);
            }
            setProp(type.elements[elemName], 'name', elem.name);
          });
          return type;
        }
      }

      // Convert a managed association into a structured type and
      // eliminate nested foreign key associations
      function convertManagedAssocIntoStruct(e) {
        let newElt = cloneCsn(e, options);
        newElt.elements = Object.create(null);
                // remove all unwanted garbage
        delete newElt.keys;
        delete newElt.target;
        delete newElt.type;
        // if this association has no keys or if it is a redirected parameterized entity,
        // use the primary keys of the target
        let keys = (!e._target.$isParamEntity && e.keys) ||
          Object.keys(e._target.$keys).map(k => { return { ref: [k] } });
        keys.forEach(k => {
          let art = e._target || getCsnDef(e.target);
          for(let ps of k.ref) {
            art = art.elements[ps];
          }
          // art is in the target side, clone it and remove key property
          let cloneArt = cloneCsn(art, options);
          setProp(cloneArt, 'name', art.name);
          cloneArt.notNull = true;
          delete cloneArt.key;
          newElt.elements[art.name] = cloneArt;
        });
        return newElt;
      }

      // create a new element and wire the proxy as new target.
      // Create a new proxy if:
      // 1) source and target schema names are different (otherwise)
      //    the proxy that is just being created targets back into
      //    its own serice
      // 2) or if no proxy for this source schema has been created yet
      function createProxyOrSchemaRefForManagedAssoc(e) {

        let proxy = e._target;
        let newElt = cloneCsn(e, options);

        if(isProxyRequired(e)) {
          proxy = getProxyForTargetOf(e);
          if(!proxy) {
            // option odataXServiceRefs has precedence over odataProxies
            if(e._target.$mySchemaName && options.toOdata.odataXServiceRefs) {
              proxy = createSchemaRefFor(e, e._target.$mySchemaName);
            }
            else if(options.toOdata.odataProxies) {
              proxy = createProxyFor(e, e._target.$mySchemaName);
            }
            proxy = registerProxy(proxy, e);
          }
        }
        if(proxy === undefined) {
          proxy = e._target;
          // no proxy: no navigation
          assignAnnotation(newElt, '@odata.navigable', false);
        }
        // either the proxy has exposed the type or
        // the assoc doesn't need to be exposed, so don't
        // try to drill further down in this type clone
        setProp(newElt, '$exposed', true);
        // _target must be set with (original) in case
        // a schema ref has been created
        setProp(newElt, '_target', e._target);
        setProp(newElt, '_constraints', e._constraints);
        setProp(newElt, '_selfReferences', []);
        if(proxy.kind === 'entity') {
          newElt.target = proxy.name;
          setProp(newElt, '_target', proxy);
        }
        return newElt;
      }
    }

    /*
      A proxy is required if the source and the target schemas differ.
      However, if two schemas are below the same root/top level service,
      these schemas are always exposed in the same Edm/DataServices. In
      this case no proxy is required. (This is especially true, if we
      decide to allow user defined schemas aka services with contexts)

      Example:

      service S {
        context T {
          entity A { ...; toB: association to S.B; };
        }
        entity B { ...; toA: association to S.T.A; };
      }

      In CSN the entity definitions are named 'S.T.A' and 'S.B', sharing
      the same service name 'S', which implies that they are always exposed
      in the same Edm => no proxy required.
    */
    function isProxyRequired(element) {
      const targetSchemaName = element._target.$mySchemaName;
      // longest match for service name
      return (!element._target.$proxy && globalSchemaPrefix !== targetSchemaName) ?
        ((targetSchemaName &&
          globalSchemaPrefix === whatsMyServiceRootName(targetSchemaName)) ? false : true) : false;
    }

    // read a proxy from the elements target
    function getProxyForTargetOf(element) {
      return element._target.$cachedProxy && element._target.$cachedProxy[globalSchemaPrefix];
    }

    // register the proxy at the elements target
    function registerProxy(proxy, element) {
      if(proxy === undefined)
        return undefined;
      const fqProxyName = globalSchemaPrefix + '.' + proxy.name;
      const fqSchemaName = globalSchemaPrefix + '.' + proxy.$mySchemaName;

      if(!element._target.$cachedProxy)
        assignProp(element._target, '$cachedProxy', Object.create(null));
      if(getProxyForTargetOf(element)) {
        info(null, ['definitions', struct.name, 'elements', element.name],
          { name: fqProxyName }, 'Proxy EDM entity type $(NAME) has already been registered');
      }
      else
        element._target.$cachedProxy[globalSchemaPrefix] = proxy;

      if(proxy.kind === 'entity') {
        // collect all schemas even for newly exposed types
        // (that may reside in another subcontext schema), but only once
        const schemaSet = new Set();
        // start with the schema name for the proxy
        schemaSet.add(fqSchemaName);
        // followed by all namespaces that are potentially exposed by the exposed types
        // don't forget to prepend the global namespace prefix
        // schemas are ordered in csn2edm.js for each service
        Object.keys(proxy.$exposedTypes).forEach(t =>
          schemaSet.add(globalSchemaPrefix + '.' + getSchemaPrefix(t)));
        schemaSet.forEach(schemaName => {
          if(!schemas[schemaName]) {
            schemas[schemaName] = { kind: 'schema', name: schemaName };
            schemaNames.push(schemaName);
          }
        });
        /** @type {object} */
        const alreadyRegistered = csn.definitions[fqProxyName]
        if(!alreadyRegistered) {
          csn.definitions[fqProxyName] = proxy;
          setProp(proxy, '$path', ['definitions', fqProxyName]);
          Object.entries(proxy.$exposedTypes).forEach(([tn, v]) => {
            const fqtn = globalSchemaPrefix + '.' + tn;
            if(csn.definitions[fqtn] === undefined) {
              csn.definitions[fqtn] = v;
              setProp(v, '$path', ['definitions', fqtn]);
            }
          });
          info(null, ['definitions', element._parent.name, 'elements', element.name],
            { name: proxy.name }, 'Created proxy EDM entity type $(NAME)');
        }
        else if(alreadyRegistered && !alreadyRegistered.$proxy &&
          !['entity', 'view'].includes(alreadyRegistered.kind)) {
          warning(null, ['definitions', element._parent.name, 'elements', element.name],
            { name: fqProxyName, kind: alreadyRegistered.kind },
            'No proxy EDM entity type created due to name collision with $(NAME) of kind $(KIND)');
          return undefined;
        }
      }
      else {
        // it's a service reference, just add that reference proxy
        if(!schemas[fqSchemaName]) {
          schemas[fqSchemaName] = proxy;
          schemaNames.push(fqSchemaName);
          info(null, ['definitions', struct.name, 'elements', element.name],
            { name: proxy.name }, 'Created EDM namespace reference $(NAME)');
        }
        // don't error on duplicate schemas, if it's already present then all is good....
      }
      // sort the global schemaNames array
      schemaNames.sort((a,b) => b.length-a.length);
      return proxy;
    }
  }

  /*
    Initialize the key ref paths into the property list
    Iterate over all keys and ignore the non-rendered elements
      * For Flat V2/V4 take all elements except associations/compositions,
        all elements are flat, no need to treat them any further
      * For Structured V4 flatten out all key elements, if the element
        is an association/composition, flatten out the foreign keys as well.
      * In Structured V4 do not render primary key 'parent' associations that
        establish the containment (_isToContainer=tue).
      * If in Structured V4, 'odataForeignKeys' is true, render all @foreignKey4,
        and do not render associations (this will include the foreign keys of
        the _isToContainer association).
  */
  function initializeEdmKeyRefPaths(struct) {
    if(struct.$mySchemaName && struct.$keys) {
      setProp(struct, '$edmKeyPaths', []);
      // for all key elements that shouldn't be ignored produce the paths
      foreach(struct.$keys, k => !k._ignore && !(k._isToContainer && k._selfReferences.length), (k, kn) => {
        if(isEdmPropertyRendered(k, options) &&
         !(options.isV2() && k['@Core.MediaType'])) {
          if(options.isV4() && options.isStructFormat) {
          // This is structured OData ONLY
          // if the foreign keys are explicitly requested, ignore associations and use the flat foreign keys instead
            if(options.renderForeignKeys && !k.target)
              struct.$edmKeyPaths.push([kn]);
          // else produce paths (isEdmPropertyRendered() has filtered @odata.foreignKey4 already)
            else if(!options.renderForeignKeys)
              struct.$edmKeyPaths.push(...produceKeyRefPaths(k, kn));
          }
        // In v2/v4 flat, associations are never rendered
          else if(!k.target) {
            struct.$edmKeyPaths.push([kn]);
          }
          // check toplevel key for spec violations
          checkKeySpecViolations(k, ['definitions', struct.name, 'elements', k.name]);
        }
      });
    }
    /*
      Produce the list of paths for this element
      - If element is not rendered in EDM, return empty array.
      - If element is structured type, do structure flattening and then check for each
        leaf element if it is a managed association and flatten further recursively.
      - If element is a managed association, use the FK path as prefix and flatten out
        all foreign keys (eventually recursively). This filters the association itself
        to become an entry in the path array which is correct as OData doesn't allow
        navprops to be key ref.
      If element is of scalar type, return it as an array.
    */
    function produceKeyRefPaths(eltCsn, prefix) {
      const keyPaths = [];
      if(!isEdmPropertyRendered(eltCsn, options)) {
        // let annos = Object.keys(eltCsn).filter(a=>a[0]==='@').join(', ');
        // warning(null, ['definitions', struct.name, 'elements', eltCsn.name ],
        //    `${struct.name}: OData V4 primary key path: "${prefix}" is unexposed by one of these annotations "${annos}"` );
        return keyPaths;
      }
      // OData requires all elements along the path to be nullable: false (that is either key or notNull)

      const finalType = getFinalTypeDef(eltCsn.items && eltCsn.items.type || eltCsn.type);
      const elements = eltCsn.elements || eltCsn.items && eltCsn.items.elements || 
      (finalType && (finalType.elements || finalType.items && finalType.items.elements));
      if(elements) {
        Object.entries(elements).forEach(([eltName, elt]) => {
          const newRefs = produceKeyRefPaths(elt, prefix + options.pathDelimiter + eltName);
          if(newRefs.length) {
            keyPaths.push(...newRefs);
            // check path step key for spec violations
            const pathSegment = `${prefix}/${eltName}`;
            // we want to point to the element in the entity which is the first path step
            const location = struct.$path.concat(['elements']).concat(pathSegment.split('/')[0]);
            checkKeySpecViolations(elt, location, pathSegment);
          }
        });
      }
      /* If element is a managed association (can't be anything else),
         flatten foreign keys and use foreign key path as new starting prefix
         This also implies that the association itself is never added into the
         list of primary key refs
      */
      else if(eltCsn.target && !eltCsn.on) {
        // if this association has no keys or if it is a redirected parameterized entity,
        // use the primary keys of the target
        let keys = (!eltCsn._target.$isParamEntity && eltCsn.keys) ||
          Object.keys(eltCsn._target.$keys).map(k => { return { ref: [k] } });
        keys.forEach(k => {
          let art = eltCsn._target || getCsnDef(eltCsn.target);
          for(let ps of k.ref) {
            art = art.elements[ps];
            if(art.type && !isBuiltinType(art.type)) {
              art = art._type || getCsnDef(art.type);
            }
          }
          keyPaths.push(...produceKeyRefPaths(art, prefix + options.pathDelimiter + k.ref.join(options.pathDelimiter)));
        });
      }
      else {
        keyPaths.push([prefix]);
      }
      return keyPaths;
    }

    function checkKeySpecViolations(elt, location, pathSegment) {
      // Nullability
      if((!elt.key && (elt.notNull === undefined || elt.notNull === false)) ||
           elt.key && (elt.notNull !== undefined && elt.notNull === false)) {
        error('odata-spec-violation-key-null', location,
          {name: pathSegment, '#': pathSegment ? 'std' : 'scalar'});
      }
      // many
      let type = elt.items || elt.type && !isBuiltinType(elt.type) && getFinalTypeDef(elt.type).items;
      if(type) {
        error('odata-spec-violation-key-array', location,
          {name: pathSegment, '#': pathSegment ? 'std' : 'scalar'});
      }
      // type
      if(!elt.elements) {
        if(!type)
          type = isBuiltinType(elt.type) ? elt : csn.definitions[elt.type];

        // check for legal scalar types, proxy exposed structured types are not resolvable in CSN
        // V2 allows any Edm.PrimitiveType (even Double and Binary), V4 is more specific:
        if(options.isV4() && type && !isAssociationOrComposition(type) && isBuiltinType(type.type)) {
          const edmType = edmUtils.mapCdsToEdmType(type);
          const legalEdmTypes = [
            'Edm.Boolean', 'Edm.Byte', 'Edm.Date', 'Edm.DateTimeOffset', 'Edm.Decimal', 'Edm.Duration', 
            'Edm.Guid', 'Edm.Int16', 'Edm.Int32', 'Edm.Int64', 'Edm.SByte', 'Edm.String', 'Edm.TimeOfDay' ];
          if(!legalEdmTypes.includes(edmType)) {
            warning('odata-spec-violation-key-type', location,
          {name: pathSegment, type: type.type, id: edmType, '#': pathSegment ? 'std' : 'scalar'});
          }
        }
      }
    }
  }

  /*
    Calculate all reachable entity set paths for a given navigation start point

    Rule: First non-containment association terminates Path, if association is
    containment enabling assoc, Target is own Struct/ plus the path down to the
    n-2nd path segment (which is the path to the n-1st implicit entity set).

    Example:
    entity Header {
      items: composition of many {
        toF: association to F;
        subitems: composition of many {
          toG: association to G;
          subitems: composition of many {
            toG: association to G;
          };
        }
      }
    }
    Must produce:
    Path="items/up_" Target="Header"/>
    Path="items/toF" Target="F"/>
    Path="items/subitems/up_" Target="Header/items"/>
    Path="items/subitems/toG" Target="G"/>
    Path="items/subitems/subitems/up_" Target="Header/items/subitems"/>
    Path="items/subitems/subitems/toG" Target="G"/>
  */
  function initializeEdmNavPropBindingTargets(struct) {
    if(options.isV4() && struct.$mySchemaName && struct.$hasEntitySet) {
      forEachGeneric(struct.items || struct, 'elements', (element) => {
        produceTargetPath([edmUtils.getBaseName(struct.name)], element, struct);
      });
    }

    function produceTargetPath(prefix, elt, curDef) {
      const newPrefix = [...prefix, elt.name];
      if(isEdmPropertyRendered(elt, options)) {
        // Assoc can never be a derived TypeDefinition, no need to
        // unroll derived type chains for assocs
        if(isAssociationOrComposition(elt) && !elt.$touched) {
          if(!elt._target.$edmTgtPaths)
            setProp(elt._target, '$edmTgtPaths', []);
          if(!elt._target.$hasEntitySet && !elt._isToContainer && curDef !== elt._target) {
            // follow elements in the target but avoid cycles
            setProp(elt, '$touched', true);
            elt._target.$edmTgtPaths.push(newPrefix);
            Object.values(elt._target.elements).forEach(e => produceTargetPath(newPrefix, e, elt._target));
            delete elt.$touched;
          }
        }
        else {
          // try to find elements to drill down further
          while(elt && !(isBuiltinType(elt.type) || elt.elements)) {
            elt = csn.definitions[elt.type];
          }
          elt && elt.elements && Object.values(elt.elements).forEach(e => produceTargetPath(newPrefix, e, curDef));
        }
      }
    }
  }

  function initializeEdmNavPropBindingPaths(struct) {
    if(options.isV4() && struct.$mySchemaName && struct.$hasEntitySet) {
      let npbs = [];
      forEachGeneric(struct.items || struct, 'elements', (element) => {
        npbs = npbs.concat(produceNavigationPath(element, struct));
      });
      setProp(struct, '$edmNPBs', npbs);
    }

    // collect all paths originating from this element that end up in an entity set
    function produceNavigationPath(elt, curDef) {
      let npbs = [];
      const prefix = elt.name;
      if(isEdmPropertyRendered(elt, options)) {
        // Assoc can never be a derived TypeDefinition, no need to
        // unroll derived type chains for assocs
        if(isAssociationOrComposition(elt) && !elt.$touched) {
          // drill into target only if
          // 1) target has no entity set and this assoc is not going to the container
          // 2) current definition and target are the same (cycle)
          if(!elt._target.$hasEntitySet && !elt._isToContainer && curDef !== elt._target) {
            // follow elements in the target but avoid cycles
            setProp(elt, '$touched', true);
            Object.values(elt._target.elements).forEach(e => npbs = npbs.concat(produceNavigationPath(e, elt._target)));
            delete elt.$touched;
          }
          else if(!(options.odataContainment && options.isV4() && elt['@odata.contained'])) {
            // end point reached but must not be an external reference nor a proxy nor a composition itself
            // last assoc step must not be to-n and target a singleton
            let p = undefined;
            if (!elt._target.$externalRef && 
              !(edmUtils.isToMany(elt) && edmUtils.isSingleton(elt._target, options.isV4()))) {
              if(elt._target.$edmTgtPaths && elt._target.$edmTgtPaths.length) {
                p = elt._target.$edmTgtPaths.find(p => p[0] === edmUtils.getBaseName(struct.name)) || elt._target.$edmTgtPaths[0];
              }
              else if(elt._target.$hasEntitySet) {
                const baseName = edmUtils.getBaseName(elt._target.$entitySetName || elt._target.name);
                // if own struct and target have a set they either are in the same $mySchemaName or not
                // if target is in another schema, target the full qualified entity set
                p = (elt._target.$mySchemaName === struct.$mySchemaName) ? 
                  [ baseName ] : [elt._target.$mySchemaName + '.EntityContainer', baseName];
              }
              if(p) {
                // if own struct and target have a set they either are in the same $mySchemaName or not
                // if target is in another schema, target the full qualified entity set
                const npb = {
                  Path: elt.name,
                  Target: p.join('/')
                };
                npbs.push( npb );
              }
            }
            // Do not prepend prefix here!
            return npbs;
          }
        }
        else {
          // try to find elements to drill down further
          while(elt && !(isBuiltinType(elt.type) || elt.elements)) {
            elt = csn.definitions[elt.type];
          }
          elt && elt.elements && Object.values(elt.elements).forEach(e => npbs = npbs.concat(produceNavigationPath(e, curDef)));
        }
      }
      npbs.forEach(p => p.Path = prefix + '/' + p.Path );
      return npbs;
    }
  }

  function determineEntitySet(struct) {
    // if this is an entity or a view, determine if an entity set is required or not
    // 1) must not be a proxy and not a containee in V4
    // No annos are rendered for non-existing EntitySet targets.
    if(struct.$mySchemaName && struct.$hasEntitySet === undefined) {
      const hasEntitySet = isEntity(struct) && !(options.isV4() && edmUtils.isContainee(struct)) && !struct.$proxy;
      setProp(struct, '$hasEntitySet', hasEntitySet);
    }
  }

  function initializeEdmTypesAndDescription(artifact) {
    // 1. let all doc props become @Core.Descriptions
    // 2. mark a member that will become a collection
    // 3. assign the edm primitive type to elements, to be used in the rendering later
    assignAnnotation(artifact, '@Core.Description', artifact.doc);
    markCollection(artifact);
    mapCdsToEdmProp(artifact);
    if (artifact.returns)  {
      markCollection(artifact.returns);
      mapCdsToEdmProp(artifact.returns);
    }
    forEachMemberRecursively(artifact,member => {
      assignAnnotation(member, '@Core.Description', member.doc);
      markCollection(member);
      mapCdsToEdmProp(member);
      ComputedDefaultValue(member);
      if (member.returns) {
        markCollection(member.returns);
        mapCdsToEdmProp(member.returns);
      }
    });

    // mark members that need to be rendered as collections
    function markCollection(obj) {
      const items = obj.items || csn.definitions[obj.type] && csn.definitions[obj.type].items;
      if (items) {
        assignProp(obj, '_NotNullCollection', items.notNull !== undefined ? items.notNull : true);
        assignProp(obj, '_isCollection', true);
      }
    }
  }


  //////////////////////////////////////////////////////////////////////
  //
  // Checks section starts here
  //

  function inboundQualificationChecks() {
    forEachDefinition(csn, [ checkChainedArray ]);
    checkNestedContextsAndServices();
    throwWithError();

    // NOTE: This is a copy of ./libs/checks/arrayOfs.js//checkChainedArray
    //       as long as validators cannot operate on OData processed CSN.
    // TODO: Remove this code.
    //       Not possible at the moment, because running this at the beginning of
    //       the renderer does not work because the enricher can't handle certain
    //       OData specifics.
    function checkChainedArray(def, defName) {
      if (!whatsMyServiceRootName(defName))
        return;
      let currPath = ['definitions', defName];
      checkIfItemsOfItems(def, undefined, undefined, currPath);
      forEachMemberRecursively(def, checkIfItemsOfItems, currPath);

      function checkIfItemsOfItems(construct, _constructName, _prop, path) {
        const constructType = csnUtils.effectiveType(construct);
        if (constructType.items) {
          if (constructType.items.items) {
            error('chained-array-of', path, '"Array of"/"many" must not be chained with another "array of"/"many" inside a service');
            return;
          }

          const itemsType = csnUtils.effectiveType(constructType.items);
          if (itemsType.items)
            error('chained-array-of', path, '"Array of"/"many" must not be chained with another "array of"/"many" inside a service');
        }
      }
    }

    function checkNestedContextsAndServices() {
      !isBetaEnabled(options, 'nestedServices') && serviceRootNames.forEach(sn => {
        const parent = whatsMyServiceRootName(sn, false);
        if(parent && parent !== sn) {
          error( 'service-nested-service', [ 'definitions', sn ], { art: parent },
               'A service can\'t be nested within a service $(ART)' );
        }
      });

      Object.entries(csn.definitions).forEach(([fqName, art]) => {
        if(art.kind === 'context') {
          const parent = whatsMyServiceRootName(fqName);
          if(parent) {
            error( 'service-nested-context', [ 'definitions', fqName ], { art: parent },
               'A context can\'t be nested within a service $(ART)' );
          }
        }
      });
    }
  }

  /**
   *
   * @param {String} identifier the illegal identifier
   * @param {CSN.Path} path
   */
  function signalIllegalIdentifier(identifier, path) {
    error(null, path, { id: identifier },
      'OData identifier $(ID) must start with a letter or underscore, followed by at most 127 letters, underscores or digits'
    );
  }


  // { '#': this.csnUtils.isComposition(member.type) ? 'cmp' : 'std' },
  //                    {
  //                      std: 'An association can\'t have cardinality "to many" without an ON-condition',
  //                      cmp: 'A composition can\'t have cardinality "to many" without an ON-condition',
  //                    }

  // Check the artifact identifier for compliance with the odata specification
  function checkArtifactIdentifierAndBoundActions(artifact) {
    if(artifact.$mySchemaName) {
      const artifactName = artifact.name.replace(`${artifact.$mySchemaName  }.`, '');
      // if the artifact has bound actions, check the action identifiers and their param identifiers to be OData compliant
      if(artifact.actions) {
        Object.keys(artifact.actions).forEach(identifier => checkActionOrFunctionIdentifier(artifact.actions[identifier], identifier))
      }

      // if the artifact is an unbound function check it's identifer
      if(isActionOrFunction(artifact)){
        checkActionOrFunctionIdentifier(artifact, artifactName);
      } else if(![ 'service', 'context', 'event', 'aspect' ].includes(artifact.kind) && !isODataSimpleIdentifier(artifactName)) {
        signalIllegalIdentifier(artifactName, ['definitions', artifact.name]);
      }
    }

    function checkActionOrFunctionIdentifier(actionOrFunction, actionOrFunctionName) {
      if(!isODataSimpleIdentifier(actionOrFunctionName)){
        signalIllegalIdentifier(actionOrFunctionName, actionOrFunction.$path);
      }
      if(actionOrFunction.params) {
        forEachGeneric(actionOrFunction, 'params', (param) => {
          if(!isODataSimpleIdentifier(param.name)){
            signalIllegalIdentifier(param.name, param.$path);
          }
        });
      }
    }
  }
  //
  // Checks Secition ends here
  //
  //////////////////////////////////////////////////////////////////////




  //////////////////////////////////////////////////////////////////////
  //
  // Helper section starts here
  //

  //
  // create Cross Schema Reference object
  //
  function createSchemaRef(targetSchemaName) {
    // prepend as many path ups '..' as there are path steps in the service ref
    let serviceRef = path4(serviceRoots[targetSchemaName]).split('/').filter(c=>c.length);
    serviceRef.splice(0, 0, ...Array(serviceRef.length).fill('..'));
    // uncomment this to make $metadata absolute
    // if(serviceRef.length===0)
    //   serviceRef.push('');
    if(serviceRef[serviceRef.length-1] !== '$metadata')
      serviceRef.push('$metadata');
    return { kind: 'reference',
      name: targetSchemaName,
      ref: { Uri: serviceRef.join('/') },
      inc: { Namespace: targetSchemaName },
      $mySchemaName: targetSchemaName,
    };

    /**
     * Resolve a service endpoint path to mount it to as follows...
     * Use _path or def[@path] if given (and remove leading '/')
     * Otherwise, use the service definition name with stripped 'Service'
     */
    function path4 (def, _path = def['@path']) {
      if (_path)
        return _path.replace(/^\//, "");
      else
        return ( // generate one from the service's name
          /[^.]+$/.exec(def.name)[0]  //> my.very.CatalogService --> CatalogService
          .replace(/Service$/,'')     //> CatalogService --> Catalog
          .replace(/([a-z0-9])([A-Z])/g, (_,c,C) => c+'-'+C.toLowerCase())  //> ODataFooBarX9 --> odata-foo-bar-x9
          .replace(/_/g,'-')  //> foo_bar_baz --> foo-bar-baz
          .toLowerCase()      //> FOO --> foo
        )
    }
  }


  // If containment in V4 is active, annotations that would be assigned to the containees
  // entity set are not renderable anymore. In such a case try to reassign the annotations to
  // the containment navigation property.
  // Today only Capabilities.*Restrictions are known to be remapped as there exists a CDS
  // short cut annotation @readonly that gets expanded and can be safely remapped.
  function rewriteContainmentAnnotations(container, containee, assocName) {
    // rectify Restrictions to NavigationRestrictions
    if(options.isV4()) {
      let navPropEntry;
      let hasEntry = false;
      let newEntry = false;
      const anno = '@Capabilities.NavigationRestrictions.RestrictedProperties';
      let resProps = container[anno];
      // merge into existing anno, if available
      if(resProps) {
        navPropEntry = resProps.find(p => p.NavigationProperty && p.NavigationProperty['='] === assocName);
        hasEntry = !!navPropEntry;
      }
      if(!navPropEntry) {
        navPropEntry =  { NavigationProperty: { '=': assocName } };
      }

      const props = Object.entries(containee);

      const merge = (prefix) => {
        const prop = prefix.split('.')[1];
        // don't overwrite existing restrictions
        if(!navPropEntry[prop]) {
          // Filter properties with prefix and reduce them into a new dictionary
          const o = props.filter(p => p[0].startsWith(prefix+'.')).reduce((a,c) => {
            a[c[0].replace(prefix+'.', '')] = c[1]; 
            return a; 
          }, { });
          // if dictionary has entries, add them to navPropEnty
          if(Object.keys(o).length) {
            navPropEntry[prop] = o;
            newEntry = true;
          }
        }
      }
      merge('@Capabilities.DeleteRestrictions');
      merge('@Capabilities.InsertRestrictions');
      merge('@Capabilities.UpdateRestrictions');
      merge('@Capabilities.ReadRestrictions');

      if(newEntry) {
        if(!hasEntry) {
          if(!resProps)
            resProps = container[anno] = [ ];
          resProps.push(navPropEntry);
        }
      }
    }
  }

  function mapCdsToEdmProp(obj) {
    if (obj.type && isBuiltinType(obj.type) && !isAssociationOrComposition(obj) && !obj.targetAspect) {
      let edmType = edmUtils.mapCdsToEdmType(obj, messageFunctions, _options.toOdata.version === 'v2', obj['@Core.MediaType']);
      assignProp(obj, '_edmType', edmType);
    } else if (obj._isCollection && (obj.items && isBuiltinType(getFinalTypeDef(obj.items.type)))) {
      let edmType = edmUtils.mapCdsToEdmType(obj.items, messageFunctions, _options.toOdata.version === 'v2', obj['@Core.MediaType']);
      assignProp(obj, '_edmType', edmType);
    }
    // This is the special case when we have array of array, but will not be supported in the future
    else if (obj._isCollection && obj.items && obj.items.type && obj.items.items && isBuiltinType(getFinalTypeDef(obj.items.items.type))) {
      let edmType = edmUtils.mapCdsToEdmType(obj.items.items, messageFunctions, _options.toOdata.version === 'v2', obj['@Core.MediaType']);
      assignProp(obj, '_edmType', edmType);
    }

    // check against the value of the @odata.Type annotation
    if (obj['@odata.Type'] && !['Edm.Int16', 'Edm.Int32', 'Edm.Int64', 'Edm.String'].includes(obj['@odata.Type']))
      info(null, obj.$location, { type: obj['@odata.Type'] }, "@odata.Type: $(TYPE) is ignored, only Edm.String and Edm.Int[16,32,64] are allowed");
  }

  function ComputedDefaultValue(member) {
    if (member.default && !csn['@Core.ComputedDefaultValue']) {
      let def = member.default;
      let noTailExpr = false;
      if(def.xpr) {
        let i = 0;
        // consume all unary signs
        while(def.xpr[i] === '-' || def.xpr[i] === '+') i++;
        // noTailExpr is true if there is nothing behind the next token in the stream
        noTailExpr = i < def.xpr.length-1;
        def = def.xpr[i];
      }
      // it is a computed value if it is not a simple value or an annotation
      if(!((def.val !== undefined && !noTailExpr) || def['#'])) {
        assignAnnotation(member, '@Core.ComputedDefaultValue', true);
      }
    }
  }
}




/*
 * Late application specific transformations
 *  At present there are two transformation targets: Structure and Element
 *  These transformations are available today:
 *
 *  Analytical Scenario:
 *    If a structure is annotated with @Aggregation.ApplySupported.PropertyRestrictions
 *    then a number of annotation rewrites are done to this structure and to the
 *    elements of this structure
 *    Also the key properties of all structure elements are removed and a new
 *    artificial key element 'key _ID : String' is inserted at first position of
 *    the elements dictionary
 *
 * PDM (Personal Data Management)
 *    Planned but not yet implemented annotation rewriting (pending to finalization)
 * /

/* eslint max-statements-per-line:off */

function mapAnnotationAssignment(artifact, parent, mappingDictionary)
{
  let props = intersect(Object.keys(mappingDictionary), Object.keys(artifact));
  // now start the substitution
  props.forEach(prop => {
    let [ mapping, value, remove_original ] = mappingDictionary[prop];
    if(mapping instanceof Function)
    {
      mapping(artifact, parent, prop);
    }
    else
    {
      assignAnnotation(artifact, mapping, value || artifact[prop]['='] || artifact[prop]);
    }

    if(remove_original)
      delete artifact[prop];
  });
}

function applyAppSpecificLateCsnTransformationOnElement(options, element, struct, error)
{
  if(options.isV2())
  {
    if(struct['@Aggregation.ApplySupported.PropertyRestrictions'])
    {
      mapAnnotationAssignment(element, struct, AnalyticalAnnotations());
    }
    mapAnnotationAssignment(element, struct, PDMSemantics());
  }

  // etag requires Core.OptimisticConcurrency to be set in V4 (cap/issues#2641)
  // Oliver Heinrich mentions in the issue that the Okra runtime must be set to a
  // concurrent runtime mode by the caller, if the annotation is added this late,
  // it doesn't appear in the forOData processed CSN, meaning that the
  // runtime cannot set that okra flag (alternatively the runtime has to search
  // for @[odata|cds].etag annotations...
  if(options.isV4())
  {
    if(element['@odata.etag'] == true || element['@cds.etag'] == true) {
      // don't put element name into collection as per advice from Ralf Handl, as
      // no runtime is interested in the property itself, it is sufficient to mark
      // the entity set.
      assignAnnotation(struct, '@Core.OptimisticConcurrency',
        (struct['@Core.OptimisticConcurrency'] || [])/*.push(element.name)*/);
    }
  }

  // nested functions begin
  function PDMSemantics()
  {
    let dict = Object.create(null);
    /*
    dict['@PDM.xxx1'] = [ '@sap.pdm-semantics' ];
    dict['@PDM.xxx2'] = [ '@sap.pdm-propery' ];
    dict['@PDM.xxx3'] = [ '@sap.pdm-display-sq-no' ];
    dict['@PDM.xxx4'] = [ '@sap.pdm-record-identifier' ];
    dict['@PDM.xxx5'] = [ '@sap.pdm-field-group' ];
    dict['@PDM.xxx6'] = [ '@sap.pdm-mask-find-pattern' ];
    dict['@PDM.xxx7'] = [ '@sap.pdm-mask-replacement-pattern' ];
    dict['@PDM.xxx8'] = [ '@sap.deletable' ];
    dict['@PDM.xxx8'] = [ '@sap.updatable' ];

    // respect flattened annotation $value
    Object.keys(dict).forEach(k => dict[k+'.$value'] = dict[k]);
    */
    return dict;
  }

  function AnalyticalAnnotations()
  {
    function mapCommonAttributes(element, struct, prop)
    {
      let CommonAttributes = element[prop];
      if(!Array.isArray(CommonAttributes)) {
        error(null, ['definitions', struct.name, 'elements', element.name],
          { anno: '@Common.attribute', code: JSON.stringify(CommonAttributes) },
          `Expect array value for $(ANNOTATION): $(CODE)`);
        return;
      }

      let targets = intersect(CommonAttributes, Object.keys(struct.elements));
      targets.forEach(tgt => {
        assignAnnotation(struct.elements[tgt], '@sap.attribute-for', element.name);
      });
    }

    function mapContextDefiningProperties(element, struct, prop)
    {
      let ContextDefiningProperties = element[prop];
      if(!Array.isArray(ContextDefiningProperties)) {
        error(null, ['definitions', struct.name, 'elements', element.name],
          { anno: '@Aggregation.ContextDefiningProperties', code: JSON.stringify(ContextDefiningProperties) },
          `Expect array value for $(ANNOTATION): $(CODE)`);
        return;
      }
      if(ContextDefiningProperties.length > 0)
        assignAnnotation(element, '@sap.super-ordinate', ContextDefiningProperties[ContextDefiningProperties.length-1]);
    }

    let dict = Object.create(null);
    //analytics term definition unknown, lower case
    dict['@Analytics.Measure'] = [ '@sap.aggregation-role', 'measure' ];
    dict['@Analytics.Dimension'] = [ '@sap.aggregation-role', 'dimension' ];
    dict['@Semantics.currencyCode'] = [ '@sap.semantics', 'currency-code', true ];
    dict['@Semantics.unitOfMeasure'] = [ '@sap.semantics', 'unit-of-measure', true ];

    dict['@Measures.ISOCurrency'] = [ '@sap.unit' ];
    dict['@Measures.Unit'] = [ '@sap.unit' ];

    dict['@Common.Label'] = [ '@sap.label' ];
    dict['@Common.Text'] = [ '@sap.text' ];
    dict['@Aggregation.ContextDefiningProperties'] = [ mapContextDefiningProperties ];
    dict['@Common.Attributes'] = [ mapCommonAttributes ];

    // respect flattened annotation $value
    Object.entries(dict).forEach(([k, v]) => dict[k+'.$value'] = v);
    return dict;
  }
}

function applyAppSpecificLateCsnTransformationOnStructure(options, struct, error)
{
  if(options.isV2())
  {
    if(struct['@Aggregation.ApplySupported.PropertyRestrictions'])
    {
      transformAnalyticalModel(struct);
      mapAnnotationAssignment(struct, undefined, AnalyticalAnnotations());
    }
  }

  // nested functions begin
  function transformAnalyticalModel(struct)
  {
    let keyName = 'ID__';
    if(struct == undefined || struct.elements == undefined || struct.elements[keyName] != undefined)
      return;

    // remove key prop from elements, add new key to elements
    let elements = Object.create(null);
    let key =  { name: keyName, key : true, type : 'cds.String', '@sap.sortable':false, '@sap.filterable':false, '@UI.Hidden': true };
    elements[keyName] = key;
    setProp(struct, '$keys',{ [keyName] : key } );
    forEachGeneric(struct.items || struct, 'elements', (e,n) =>
    {
      if(e.key) delete e.key;
      elements[n] = e;
    });
    struct.elements = elements;
  }

  function AnalyticalAnnotations()
  {
    function mapFilterRestrictions(struct, parent, prop)
    {
      let stringDict = Object.create(null);
      stringDict['SingleValue'] = 'single-value';
      stringDict['MultiValue'] = 'multi-value';
      stringDict['SingleRange'] = 'interval';

      let filterRestrictions = struct[prop];
      if(!Array.isArray(filterRestrictions)) {
        error(null, ['definitions', struct.name ],
          { anno: '@Capabilities.FilterRestrictions.FilterExpressionRestrictions',
            code: JSON.stringify(filterRestrictions) },
          `Expect array value for $(ANNOTATION): $(CODE)`);
        return;
      }
      filterRestrictions.forEach(v => {
        let e = struct.elements[v.Property];
        if(e)
          assignAnnotation(e, '@sap.filter-restriction', stringDict[v.AllowedExpressions]);
      });
    }

    function mapRequiredProperties(struct, parent, prop)
    {
      let requiredProperties = struct[prop];
      if(!Array.isArray(requiredProperties)) {
        error(null, ['definitions', struct.name],
          { anno: '@Capabilities.FilterRestrictions.RequiredProperties',
            code: JSON.stringify(requiredProperties) },
          `Expect array value for $(ANNOTATION): $(CODE)`);
        return;
      }

      let props = intersect(Object.keys(struct.elements), requiredProperties)
      props.forEach(p => {
        assignAnnotation(struct.elements[p], '@sap.required-in-filter', true);
      });
    }

    function mapRequiresFilter(struct, parent, prop)
    {
      let requiresFilter = struct[prop];
      if(requiresFilter)
        assignAnnotation(struct._SetAttributes, '@sap.requires-filter', requiresFilter);
    }

      // Entity Props
    let dict = Object.create(null);
    dict['@Aggregation.ApplySupported.PropertyRestrictions'] = [ '@sap.semantics', 'aggregate' ];
    dict['@Common.Label'] = [ '@sap.label' ];
    dict['@Capabilities.FilterRestrictions.RequiresFilter'] = [ mapRequiresFilter ];
    dict['@Capabilities.FilterRestrictions.RequiredProperties'] = [ mapRequiredProperties ];
    dict['@Capabilities.FilterRestrictions.FilterExpressionRestrictions'] = [ mapFilterRestrictions ];

    // respect flattened annotation $value
    Object.keys(dict).forEach(k => dict[k+'.$value'] = dict[k]);

    return dict;
  }
}

function setSAPSpecificV2AnnotationsToEntityContainer(options, carrier) {
  if(!options.isV2())
    return;
  // documented in https://wiki.scn.sap.com/wiki/display/EmTech/SAP+Annotations+for+OData+Version+2.0#SAPAnnotationsforODataVersion2.0-Elementedm:EntityContainer
  const SetAttributes = {
    // EntityContainer only
    '@sap.supported.formats' : addToSetAttr,
    '@sap.use.batch': addToSetAttr,
    '@sap.message.scope.supported': addToSetAttr,
  };

  Object.entries(carrier).forEach(([p, v]) => {
    (SetAttributes[p] || function() { /* no-op */ })(carrier, p, v);
  });

  function addToSetAttr(carrier, propName, propValue, removeFromType=true) {
    assignProp(carrier, '_SetAttributes', Object.create(null));
    assignAnnotation(carrier._SetAttributes, propName, propValue);
    if(removeFromType) {
      delete carrier[propName];
    }
  }
}

function setSAPSpecificV2AnnotationsToEntitySet(options, carrier) {
  if(!options.isV2())
    return;
  // documented in https://wiki.scn.sap.com/wiki/display/EmTech/SAP+Annotations+for+OData+Version+2.0#SAPAnnotationsforODataVersion2.0-Elementedm:EntitySet
  const SetAttributes = {
    // EntitySet, EntityType
    '@sap.label' : (s,pn, pv) => { addToSetAttr(s, pn, pv, false); },
    '@sap.semantics': checkSemantics,
    // EntitySet only
    '@sap.creatable' : addToSetAttr,
    '@sap.updatable' : addToSetAttr,
    '@sap.deletable': addToSetAttr,
    '@sap.updatable.path': addToSetAttr,
    '@sap.deletable.path': addToSetAttr,
    '@sap.searchable' : addToSetAttr,
    '@sap.pagable': addToSetAttr,
    '@sap.topable': addToSetAttr,
    '@sap.countable': addToSetAttr,
    '@sap.addressable': addToSetAttr,
    '@sap.requires.filter': addToSetAttr,
    '@sap.change.tracking': addToSetAttr,
    '@sap.maxpagesize': addToSetAttr,
    '@sap.delta.link.validity': addToSetAttr,
  };

  Object.entries(carrier).forEach(([p, v]) => {
    (SetAttributes[p] || function() { /* no-op */ })(carrier, p, v);
  });

  function addToSetAttr(carrier, propName, propValue, removeFromType=true) {
    assignProp(carrier, '_SetAttributes', Object.create(null));
    assignAnnotation(carrier._SetAttributes, propName, propValue);
    if(removeFromType) {
      delete carrier[propName];
    }
  }

  function checkSemantics(struct, propName, propValue) {
    if(['timeseries', 'aggregate'].includes(propValue)) {
      // aggregate is forwarded to Set and must remain on Type
      addToSetAttr(struct, propName, propValue, propValue !== 'aggregate');
    }
  }
}

function setSAPSpecificV2AnnotationsToAssociation(options, carrier, struct) {
  if(!options.isV2())
    return;
  // documented in https://wiki.scn.sap.com/wiki/display/EmTech/SAP+Annotations+for+OData+Version+2.0
  const SetAttributes = {
    // Applicable to NavProp and foreign keys, add to AssociationSet
    '@sap.creatable' : (struct, c,pn, pv) => { addToSetAttr(struct, c, pn, pv, false); },
    // Not applicable to NavProp, applicable to foreign keys, add to AssociationSet
    '@sap.updatable' : addToSetAttr,
    // Not applicable to NavProp, not applicable to foreign key, add to AssociationSet
    '@sap.deletable': (struct, c, pn, pv) => {
      addToSetAttr(struct, c, pn, pv);
      removeFromForeignKey(struct, c, pn);
    },
    // applicable to NavProp, not applicable to foreign keys, not applicable to AssociationSet
    '@sap.creatable.path': removeFromForeignKey,
    '@sap.filterable': removeFromForeignKey,
  };

  Object.entries(carrier).forEach(([p, v]) => {
    (SetAttributes[p] || function() {/* no-op */})(struct, carrier, p, v);
  });

  function addToSetAttr(struct, carrier, propName, propValue, removeFromType=true) {
    assignProp(carrier, '_SetAttributes', Object.create(null));
    assignAnnotation(carrier._SetAttributes, propName, propValue);
    if(removeFromType) {
      delete carrier[propName];
    }
  }

  function removeFromForeignKey(struct, carrier, propName) {
    if(carrier.target && carrier.keys) {
      struct.elements && Object.values(struct.elements).forEach(e => {
        if(e['@odata.foreignKey4'] === carrier.name) {
          delete e[propName];
        }
      });
    }
  }
}

// Assign but not overwrite annotation
function assignAnnotation(node, name, value) {
  if(value !== undefined &&
      name !== undefined && name[0] === '@' &&
      (node[name] === undefined ||
      node[name] && node[name] === null)) {
    node[name] = value;
  }
}

// Set non enumerable property if it doesn't exist yet
function assignProp(obj, prop, value) {
  if(obj[prop] === undefined) {
    setProp(obj, prop, value);
  }
}

module.exports = {
  initializeModel,
}
