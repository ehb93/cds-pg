'use strict';
const { isEdmPropertyRendered, isBuiltinType } = require('../../model/csnUtils');
const edmUtils = require('../edmUtils.js');
const preprocessAnnotations = require('./preprocessAnnotations.js');
const oDataDictionary = require('../../gen/Dictionary.json');
const { forEachDefinition } = require('../../model/csnUtils');


/* Vocabulary overview as of January 2020:

   OASIS: https://github.com/oasis-tcs/odata-vocabularies/tree/master/vocabularies
   Aggregation (published)
   Authorization (published)
   Capabilities (published)
   Core (published)
   Measures (published)
   Repeatability (published)
   Temporal (not published, not yet finalized)
   Validation (published)

   SAP: https://github.com/SAP/odata-vocabularies/tree/master/vocabularies
   Analytics (published)
   CodeList (published)
   Common (pubished)
   Communication (published)
   Graph (published, experimental)
   Hierarchy (not published, still experimental)
   HTML5 (published, experimental)
   ODM (published, experimental)
   PersonalData (published)
   Session (published)
   UI (published)
*/

const vocabularyDefinitions = {
  'Aggregation': {
    'ref': { Uri: 'https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Aggregation.V1.xml' },
    'inc': { Alias: 'Aggregation', Namespace: 'Org.OData.Aggregation.V1' },
    'int': { filename: 'Aggregation.xml' }
  },
  'Analytics': {
    'ref': { Uri: 'https://sap.github.io/odata-vocabularies/vocabularies/Analytics.xml' },
    'inc': { Alias: 'Analytics', Namespace: 'com.sap.vocabularies.Analytics.v1' },
    'int': { filename: 'Analytics.xml' }
  },
  'Authorization': {
    'ref': { Uri: 'https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Authorization.V1.xml' },
    'inc': { Alias: 'Authorization', Namespace: 'Org.OData.Authorization.V1' },
    'int': { filename: 'Authorization.xml' }
  },
  'Capabilities': {
    'ref': { Uri: 'https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Capabilities.V1.xml' },
    'inc': { Alias: 'Capabilities', Namespace: 'Org.OData.Capabilities.V1' },
    'int': { filename: 'Capabilities.xml' }
  },
  'CodeList': {
    'ref': { Uri: 'https://sap.github.io/odata-vocabularies/vocabularies/CodeList.xml' },
    'inc': { Alias: 'CodeList', Namespace: 'com.sap.vocabularies.CodeList.v1' },
    'int': { filename: 'CodeList.xml' }
  },
  'Common': {
    'ref': { Uri: 'https://sap.github.io/odata-vocabularies/vocabularies/Common.xml' },
    'inc': { Alias: 'Common', Namespace: 'com.sap.vocabularies.Common.v1' },
    'int': { filename: 'Common.xml' }
  },
  'Communication': {
    'ref': { Uri: 'https://sap.github.io/odata-vocabularies/vocabularies/Communication.xml' },
    'inc': { Alias: 'Communication', Namespace: 'com.sap.vocabularies.Communication.v1' },
    'int': { filename: 'Communication.xml' }
  },
  'Core': {
    'ref': { Uri: 'https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Core.V1.xml' },
    'inc': { Alias: 'Core', Namespace: 'Org.OData.Core.V1' },
    'int': { filename: 'Core.xml' }
  },
  'Graph': {
    'ref': { Uri: 'https://sap.github.io/odata-vocabularies/vocabularies/Graph.xml' },
    'inc': { Alias: 'Graph', Namespace: 'com.sap.vocabularies.Graph.v1' },
    'int': { filename: 'Graph.xml' }
  },
  'HTML5': {
    'ref': { Uri: 'https://sap.github.io/odata-vocabularies/vocabularies/HTML5.xml' },
    'inc': { Alias: 'HTML5', Namespace: 'com.sap.vocabularies.HTML5.v1' },
    'int': { filename: 'HTML5.xml' }
  },
  'Measures': {
    'ref': { Uri: 'https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Measures.V1.xml' },
    'inc': { Alias: 'Measures', Namespace: 'Org.OData.Measures.V1' },
    'int': { filename: 'Measures.xml' }
  },
  'ODM': {
    'ref': { Uri: 'https://sap.github.io/odata-vocabularies/vocabularies/ODM.xml' },
    'inc': { Alias: 'ODM', Namespace: 'com.sap.vocabularies.ODM.v1' },
    'int': { filename: 'ODM.xml' }
  },
  'PersonalData': {
    'ref': { Uri: 'https://sap.github.io/odata-vocabularies/vocabularies/PersonalData.xml' },
    'inc': { Alias: 'PersonalData', Namespace: 'com.sap.vocabularies.PersonalData.v1' },
    'int': { filename: 'PersonalData.xml' }
  },
  'Repeatability': {
    'ref': { Uri: 'https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Repeatability.V1.xml' },
    'inc': { Alias: 'Repeatability', Namespace: 'Org.OData.Repeatability.V1' },
    'int': { filename: 'Repeatability.xml' }
  },
  'Session': {
    'ref': { Uri: 'https://sap.github.io/odata-vocabularies/vocabularies/Session.xml' },
    'inc': { Alias: 'Session', Namespace: 'com.sap.vocabularies.Session.v1' },
    'int': { filename: 'Session.xml' }
  },
  'UI': {
    'ref': { Uri: 'https://sap.github.io/odata-vocabularies/vocabularies/UI.xml' },
    'inc': { Alias: 'UI', Namespace: 'com.sap.vocabularies.UI.v1' },
    'int': { filename: 'UI.xml' }
  },
  'Validation': {
    'ref': { Uri: 'https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Validation.V1.xml' },
    'inc': { Alias: 'Validation', Namespace: 'Org.OData.Validation.V1' },
    'int': { filename: 'Validation.xml' }
  },
};

const knownVocabularies = Object.keys(vocabularyDefinitions);


/**************************************************************************************************
 * csn2annotationEdm
 *
 * options:
 *   v - array with two boolean entries, first is for v2, second is for v4
 *   dictReplacement: for test purposes, replaces the standard oDataDictionary
 */
function csn2annotationEdm(csn, serviceName, Edm = undefined, options=undefined, messageFunctions=undefined) {

  if(!Edm)
    throw new Error('Please debug me: csn2annotationsEdm must be invoked with Edm');
  if(!options)
    throw new Error('Please debug me: csn2annotationsEdm must be invoked with options');
  if(!messageFunctions)
    throw new Error('Please debug me: csn2annotationsEdm must be invoked with messageFunctions');
  // global variable where we store all the generated annotations
  const g_annosArray = [];

  const { info, warning, error } = messageFunctions;

  // Static dynamic expression dictionary, loaded with Edm creators
  const [ dynamicExpressions, dynamicExpressionNames ] = initEdmJson();

  // annotation preprocessing
  preprocessAnnotations.preprocessAnnotations(csn, serviceName, options);

  // we take note of which vocabularies are actually used in a service in order to avoid
  // producing useless references; reset everything to "unused"
  knownVocabularies.forEach(n => {
    vocabularyDefinitions[n].used = false;
  });

  // provide functions for dictionary lookup
  //   use closure to avoid making "dict" and "experimental" global variables
  let { getDictTerm, getDictType } = function(){
    let dict = options.dictReplacement || oDataDictionary; // tests can set different dictionary via options
    let experimental = {}; // take note of all experimental annos that have been used
    let deprecated = {}; // take note of all deprecated annos that have been used

    return {
      // called to look-up a term in the dictionary
      //   in addition: - note usage of the respective vocabulary
      //                - issue a warning if the term is flagged as "experimental"
      getDictTerm: function(termName, context) {
        const dictTerm = dict.terms[termName]
        // register vocabulary usage if possible
        const vocName = termName.slice(0, termName.indexOf('.'));
        if(vocabularyDefinitions[vocName])
          vocabularyDefinitions[vocName].used = true;

        if (dictTerm) {
          // issue warning for usage of experimental Terms, but only once per Term
          if (dictTerm['$experimental'] && !experimental[termName]) {
            message(warning, context, 'Term "' + termName + '" is experimental and can be changed or removed at any time, do not use productively!');
            experimental[termName] = true;
          }
          if (dictTerm['$deprecated'] && !deprecated[termName]) {
            message(info, context, 'Term "' + termName + '" is deprecated. ' + dictTerm['$deprecationText']);
            deprecated[termName] = true;
          }
        }
        return dictTerm;
      },
      // called to look-up a type in the dictionary
      //   in addition, note usage of the respective vocabulary
      getDictType: function (typeName) {
        let dictType = dict.types[typeName];
        if (dictType) {
          // register usage of vocabulary
          vocabularyDefinitions[typeName.slice(0, typeName.indexOf('.'))].used = true;
        }
        return dictType;
      }
    }
  }();

  const v = options.v;

  // Crawl over the csn and trigger the annotation translation for all kinds
  //   of annotated things.
  // Note: only works for single service
  // Note: we assume that all objects ly flat in the service, i.e. objName always
  //       looks like <service name, can contain dots>.<id>
  forEachDefinition(csn, (object, objName) => {
    if(objName == serviceName || objName.startsWith(serviceName + '.')) {
      if (object.kind === 'action' || object.kind === 'function') {
        handleAction(objName, object, null);
      }
      else { // service, entity, anything else?
        // handle the annotations directly tied to the object
        handleAnnotations(objName, object);
        // handle the annotations of the object's elements
        handleElements(objName, object);
        // handle the annotations of the object's actions
        handleBoundActions(objName, object);
      }
    }
  });

  // filter out empty <Annotations...> elements
  // add references for the used vocabularies
  return {
    annos: g_annosArray, usedVocabularies: Object.values(vocabularyDefinitions).filter(v => v.used)
  };

//-------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------

  // helper to determine the OData version
  // TODO: improve option handling
  function isV2() {
    return v && v[0];
  }

  // this function is called in the translation code to issue an info/warning/error message
  // messages are reported via the severity function
  // context contains "semantic location"
  function message(severity, context, message) {
    let fullMessage = 'In annotation translation: ' + message;
    if (context) {
      let loc = 'target: ' + context.target + ', annotation: ' + context.term;
      if (context.stack.length > 0) {
        loc += context.stack.join('');
      }
      fullMessage += ', ' + loc;
    }
    severity(null, null, `${fullMessage}`);
  }

/*
  Mapping annotated thing in cds/csn => annotated thing in edmx:

  carrier: the annotated thing in cds, can be: service, entity, structured type, element of entity or structured type,
                                               action/function, parameter of action/function
  target: the annotated thing in OData

  In the edmx, all annotations for a OData thing are put into an element
    <Annotations Target="..."> where Target is the full name of the target
  There is one exception (Schema), see below

  carrier = service
    the target is the EntityContainer, unless the annotation has an "AppliesTo" where only Schema is given, but not EntityContainer
    then the <Annotation ...> is directly put into <Schema ...> without an enclosing <Annotations ...>

  carrier = entity (incl. view/projection)
    the target is the corresponding EntityType, unless the annotation has an "AppliesTo" where only EntitySet is given, but not EntityType
    then the target is the corresponding EntitySet

  carrier = structured type
    the target is the corresponding ComplexType

  carrier = element of entity or structured type
    the target is the corresponding Property of the EntityType/ComplexType: Target = <entity/type>/<element>

  carrier = action/function
    v2, unbound:          Target = <service>.EntityContainer/<action/function>
    v2, bound:            Target = <service>.EntityContainer/<entity>_<action/function>
    v4, unbound action:   Target = <service>.<action>()
    v4, bound action:     Target = <service>.<action>(<service>.<entity>)
    v4, unbound function: Target = <service>.<function>(<1st param type>, <2nd param type>, ...)
    v4, bound function:   Target = <service>.<function>(<service>.<entity>, <1st param type>, <2nd param type>, ...)

  carrier = parameter of action/function
    like above, but append "/<parameter" to the Target
*/




  // handle the annotations of the elements of an object
  // in: objname : name of the object
  //     object : the object itself
  function handleElements(objname, object) {
    if (!object.elements) return;
    Object.entries(object.elements).forEach(([elemName, element]) => {
      // determine the name of the target in the resulting edm
      //   for non-assoc element, this simply is "<objectName>/<elementName>"
      let edmTargetName = objname + '/' + elemName;
      handleAnnotations(edmTargetName, element);

      // handle sub elements
      if (element.elements) {
        handleNestedElements(objname, elemName, element.elements);
      }
    });
  }

  // handling annotations at nested elements is not yet supported
  // => issue a warning, but only if there actually are annotations
  function handleNestedElements(objname, baseElemName, elementsObj) {
    if(!elementsObj) return;
    Object.entries(elementsObj).forEach(([elemName, element]) => {
      if (Object.keys(element).filter( x => x.substr(0,1) === '@' ).filter(filterKnownVocabularies).length > 0) {
        message(warning, null, `annotations at nested elements are not yet supported, object ${objname}, element ${baseElemName}.${elemName}`);
      }

      if (element.elements) {
        handleNestedElements(objname, baseElemName + '.' + elemName, element.elements);
      }
    });
  }


  // Annotations for actions and functions (and their parameters)
  // v2, unbound:          Target = <service>.EntityContainer/<action/function>
  // v2, bound:            Target = <service>.EntityContainer/<entity>_<action/function>
  // v4, unbound action:   Target = <service>.<action>()
  // v4, bound action:     Target = <service>.<action>(<service>.<entity>)
  // v4, unbound function: Target = <service>.<function>(<1st param type>, <2nd param type>, ...)
  // v4, bound function:   Target = <service>.<function>(<service>.<entity>, <1st param type>, <2nd param type>, ...)

  // handle the annotations of cObject's (an entity) bound actions/functions and their parameters
  // in: cObjectname : qualified name of the object that holds the actions
  //     cObject     : the object itself
  function handleBoundActions(cObjectname, cObject) {
    if(!cObject.actions) return;
    // get service name: remove last part of the object name
    // only works if all objects ly flat in the service
    let nameParts = cObjectname.split('.')
    let entityName = nameParts.pop();
    let serviceName = nameParts.join('.');

    Object.entries(cObject.actions).forEach(([n, action]) => {
      let actionName = serviceName + '.' + (isV2() ? entityName + '_' : '') + n;
      handleAction(actionName, action, cObjectname);
    });
  }

  // handle the annotations of an action and its parameters
  //   called by handleBoundActions and directly for unbound actions/functions
  // in: cActionName       : qualified name of the action
  //     cAction           : the action object
  //     entityNameIfBound : qualified name of entity if bound action/function
  function handleAction(cActionName, cAction, entityNameIfBound) {
    let actionName = cActionName;
    if (isV2()) { // Replace up to last dot with <serviceName>.EntityContainer
      const lastDotIndex = actionName.lastIndexOf('.');
      if (lastDotIndex > -1)
        actionName = serviceName + '.EntityContainer/' + actionName.substr(lastDotIndex + 1);
    }
    else { // add parameter type list
      actionName += relParList(cAction, entityNameIfBound);
    }

    handleAnnotations(actionName, cAction);
    if(cAction.params) {
      Object.entries(cAction.params).forEach(([n, p]) => {
        let edmTargetName = actionName + '/' + n;
        handleAnnotations(edmTargetName, p);
      });
    }
  }

  function relParList(action, bindingParam) {
    // we rely on the order of params in the csn being the correct one
    let params = [];
    if (bindingParam) {
      params.push(action['@cds.odata.bindingparameter.collection'] ? 'Collection(' + bindingParam + ')' : bindingParam);
    }
    if (action.kind === 'function') {
      let mapType = (p) => (isBuiltinType(p.type)) ?
        edmUtils.mapCdsToEdmType(p, messageFunctions, false /*is only called for v4*/) : p.type;
      if(action.params) {
        action.params && Object.values(action.params).forEach(p => {
          let isArrayType = !p.type && p.items && p.items.type;
          params.push(isArrayType ? 'Collection(' + mapType(p.items) + ')' : mapType(p));
        });
      }
    }
    return '(' + params.join(',') + ')';
  }




  // handle all the annotations for a given cds thing, here called carrier
  //   edmTargetName : string, name of the target in edm
  //   carrier: object, the annotated cds thing, contains all the annotations
  //                    as properties with names starting with @
  function handleAnnotations(edmTargetName, carrier) {
    // collect the names of the carrier's annotation properties
    // keep only those annotations that - start with a known vocabulary name
    //                                  - have a value other than null

    // if the carier is an element that is not rendered or
    // if the carrier is a derived type of a primitive type which is not rendered in V2
    // if the carrier is a media stream element in V2
    // do nothing

    if(!isEdmPropertyRendered(carrier, options) ||
      (isV2() && (edmUtils.isDerivedType(carrier) || carrier['@Core.MediaType']))) {
      return;
    }

    // Filter unknown toplevel annotations
    // Final filtering of all annotations is done in handleTerm
    const annoNames = Object.keys(carrier).filter( x => x.substr(0,1) === '@' );
    const nullWhitelist = [ '@Core.OperationAvailable' ];
    const knownAnnos = annoNames.filter(filterKnownVocabularies).filter(x => carrier[x] !== null || nullWhitelist.includes(x));
    if (knownAnnos.length === 0) return;

    const prefixTree = createPrefixTree();

    // usually, for a given carrier there is one target
    // for some carriers (service, entity), there can be an alternative target (usually the EntitySet)
    //    alternativeEdmTargetName: name of alternative target
    // which one to choose depends on the "AppliesTo" info of the single annotations, so we have
    //   to defer this decision; this is why we here construct a function that can make the decision
    //   later when looking at single annotations

    const [
        stdEdmTargetName,           // either the schema path or the EntityContainer itself
        hasAlternativeCarrier,      // is the alternative annotation target available in the EDM?
        alternativeEdmTargetName,   // EntitySet path name
        testToStandardEdmTarget,    // if true, assign to standard Edm Target
        testToAlternativeEdmTarget, // if true, assign to alternative Edm Target
      ] = initCarrierControlVars();

    // collect produced Edm.Annotation nodes for various carriers
    const serviceAnnotations = [];
    const stdAnnotations = [];
    const alternativeAnnotations = [];

    // now create annotation objects for all the annotations of carrier
    handleAnno2(addAnnotation, edmTargetName /*used for messages*/, prefixTree);

    // Produce Edm.Annotations and attach collected Edm.Annotation(s) to the
    // envelope (or directly to the Schema)
    if(serviceAnnotations.length) {
      g_annosArray.push(...serviceAnnotations.filter(a=>a));
    }
    if(stdAnnotations.length) {
      const annotations = new Edm.Annotations(v, stdEdmTargetName); // used in closure
      annotations.append(...stdAnnotations);
      g_annosArray.push(annotations);
    }
    if(alternativeAnnotations.length) {
      const annotations = new Edm.Annotations(v, alternativeEdmTargetName);
      annotations.append(...alternativeAnnotations);
      g_annosArray.push(annotations);
    }

    // construct a function that is used to add an <Annotation ...> to the
    //   respective collector array
    // this function is specific to the actual carrier, following the mapping rules given above
    function addAnnotation(annotation, appliesTo) {
      let rc=false;
      if (testToAlternativeEdmTarget && appliesTo && testToAlternativeEdmTarget(appliesTo)) {
        if (carrier.kind === 'service') {
          if (isV2()) {
            // there is no enclosing <Annotations ...>, so for v2 the namespace needs to be mentioned here
            annotation.setXml( { xmlns: 'http://docs.oasis-open.org/odata/ns/edm' } );
          }
          serviceAnnotations.push(annotation); // for target Schema: no <Annotations> element
        }
        else if(hasAlternativeCarrier) {
          alternativeAnnotations.push(annotation);
        }
        rc=true;
      }
      if(testToStandardEdmTarget(appliesTo)) {
        stdAnnotations.push(annotation);
        rc=true;
      }
      // Another crazy hack due to this crazy function:
      // If carrier is a managed association (has keys) and rc is false (annotation was not applicable)
      // return true to NOT trigger 'unapplicable' info message
      if(rc === false && carrier.target && carrier.keys && appliesTo.includes('Property'))
        rc = true;
      return rc;
    }

    function initCarrierControlVars() {
    // eslint-disable-next-line no-unused-vars
      let testToStandardEdmTarget = () => true; // if true, assign to standard Edm Target
      let stdEdmTargetName = edmTargetName;
      let alternativeEdmTargetName = null;
      let hasAlternativeCarrier = false; // is the alternative annotation target available in the EDM?
      let testToAlternativeEdmTarget = null; // if true, assign to alternative Edm Target

      if (carrier.kind === 'entity' || carrier.kind === 'view') {
      // If AppliesTo=[EntitySet/Singleton, EntityType], EntitySet/Singleton has precedence
        testToAlternativeEdmTarget = (x => x.includes('EntitySet') || x.includes('Singleton'));
        testToStandardEdmTarget = (x => x ? x.includes('EntityType') : true);
      // if carrier has an alternate 'entitySetName' use this instead of EdmTargetName
      // (see edmPreprocessor.initializeParameterizedEntityOrView(), where parameterized artifacts
      // are split into *Parameter and *Type entities and their respective EntitySets are eventually
      // renamed.
      // (which is the definition key in the CSN and usually the name of the EntityType)
      // Replace up to last dot with <serviceName>.EntityContainer/
        alternativeEdmTargetName = carrier.$entitySetName || edmTargetName
        const lastDotIndex = alternativeEdmTargetName.lastIndexOf('.');
        if (lastDotIndex > -1)
          alternativeEdmTargetName = serviceName + '.EntityContainer/' + alternativeEdmTargetName.substr(lastDotIndex + 1);
        hasAlternativeCarrier = carrier.$hasEntitySet;
      }
      else if (carrier.kind === 'service') {
      // if annotated object is a service, annotation goes to EntityContainer,
      //   except if AppliesTo contains Schema but not EntityContainer, then annotation goes to Schema
        testToAlternativeEdmTarget = (x => x.includes('Schema') && !x.includes('EntityContainer'));
        testToStandardEdmTarget = ( x => x ? (
        // either only AppliesTo=[EntityContainer]
        (!x.includes('Schema') && x.includes('EntityContainer')) ||
        // or AppliesTo=[Schema, EntityContainer]
        (x.includes('Schema') && x.includes('EntityContainer')))
          : true );
        stdEdmTargetName = edmTargetName + '.EntityContainer';
        alternativeEdmTargetName = edmTargetName;
        hasAlternativeCarrier = true; // EntityContainer is always available
      }
    //element => decide if navprop or normal property
      else if(!carrier.kind) {
      // if appliesTo is undefined, return true
        if(carrier.target) {
          testToStandardEdmTarget = (x=> x ? x.includes('NavigationProperty') : true);
        }
        else {
        // this might be more precise if handleAnnotation would know more about the carrier
          testToStandardEdmTarget = (x => x ? ['Parameter', 'Property'].some(y => x.includes(y)): true);
        }
      }
      return [
        stdEdmTargetName,
        hasAlternativeCarrier,
        alternativeEdmTargetName,
        testToStandardEdmTarget,
        testToAlternativeEdmTarget
      ];
      /* all AppliesTo entries:
        "Action",
        "ActionImport",
        "Annotation",
        "Collection",
        "ComplexType",
        "EntityContainer",
        "EntitySet",
        "EntityType",
        "Function",
        "FunctionImport",
        "Include",
        "NavigationProperty",
        "Parameter",
        "Property",
        "PropertyValue",
        "Record",
        "Reference",
        "ReturnType",
        "Schema",
        "Singleton",
        "Term",
        "TypeDefinition"
      */
    }

    function createPrefixTree() {
      // in csn, all annotations are flattened
      // => values can be - primitive values (string, number)
      //                  - pseudo-records with "#" or "="
      //                  - arrays
      // in OData, there are "structured" annotations -> we first need to regroup the cds annotations
      //   by building a "prefix tree" for the annotations attached to the carrier
      //   see example at definition of function mergePathStepsIntoPrefixTree
      const prefixTree = {};
      for (let a of knownAnnos) {
      // remove leading @ and split at "."
      //   stop splitting at ".@" (used for nested annotations)
      // Inline JSON EDM allows to add annotations to record members
      // by prefixing the annotation with the record member 'foo@Common.Label'
      // The splitter should leave such annotations alone, handleEdmJson
      // takes care of assigning these annotations to the record members
        const [ prefix, innerAnnotation ] = a.split('.@');
        const steps = prefix.slice(1).split('.');
        let i = steps.lastIndexOf('$edmJson');
        if(i > -1) {
          i = steps.findIndex(s => s.includes('@'), i+1);
          if(i > -1) {
            steps.splice(i, steps.length-i, steps.slice(i).join('.'));
          }
        }
        if (innerAnnotation) {
        // A voc annotation has two steps (Namespace+Name),
        // any furter steps need to be rendered separately
          const innerAnnoSteps = innerAnnotation.split('.');
          const tailSteps = innerAnnoSteps.splice(2, innerAnnoSteps.length-2);
        // prepend annotation prefix (path) to tail steps
          tailSteps.splice(0, 0, '@' + innerAnnoSteps.join('.'));
          steps.push(...tailSteps);
        }
        mergePathStepsIntoPrefixTree(prefixTree, steps, 0, carrier);
      }
      return prefixTree;

      // tree: object where to put the next level of names
      // path: the parts of the annotation name
      // index: index into that array pointing to the next name to be processed
      //   0  : vocabulary
      //   1  : term
      //   2+ : record properties
      //
      // example:
      //   @v.t1
      //   @v.t2.p1
      //   @v.t2.p2
      //   @v.t3#x.q1
      //   @v.t3#x.q2
      //   @v.t3#y.q1
      //   @v.t3#y.q2
      //
      //   { v : { t1 : ...,
      //           t2 : { p1 : ...,
      //                  p2 : ...   },
      //           t3#x : { q1 : ...,
      //                    q2 : ... }
      //           t3#y : { q1 : ...,
      //                    q2 : ... } } }
      function mergePathStepsIntoPrefixTree(tree, pathSteps, index, carrier) {
      // TODO check nesting level > 3
        let name = pathSteps[index];
        if (index+1 < pathSteps.length ) {
          if (!tree[name]) {
            tree[name] = {};
          }
          mergePathStepsIntoPrefixTree(tree[name], pathSteps, index+1, carrier);
        }
        else {
          tree[name] = carrier['@' + pathSteps.join('.')];
        }
      }
    }
  }


  // handle all the annotations for a given carrier
  // addAnnotationFunc: a function that adds the <Annotation ...> tags created here into the
  //                    correct parent tag (see handleAnnotations())
  // edmTargetName: name of the edmx target, only used for messages
  // prefixTree: the annotations
  function handleAnno2(addAnnotationFunc, edmTargetName, prefixTree) {
    // first level names of prefix tree are the vocabulary names
    // second level names are the term names
    // create an annotation tag <Annotation ...> for each term
    for (let voc of Object.keys(prefixTree)) {
      for (let term of Object.keys(prefixTree[voc])) {
        let fullTermName = voc + '.' + term;

        // context is "semantic" location info used for messages
        let context = { target: edmTargetName,  term: fullTermName, stack: [] };
        // anno is the full <Annotation Term=...>
        let anno = handleTerm(fullTermName, prefixTree[voc][term], context);
        if(anno !== undefined) {
          // addAnnotationFunc needs AppliesTo info from dictionary to decide where to put the anno
          fullTermName = fullTermName.replace(/#(\w+)$/g, ''); // remove qualifier
          let dictTerm = getDictTerm(fullTermName, context); // message for unknown term was already issued in handleTerm
          if(!addAnnotationFunc(anno, dictTerm && dictTerm.AppliesTo)) {
            if(dictTerm && dictTerm.AppliesTo) {
              message(info, context, `Term "${ fullTermName }" is not applied (AppliesTo="${ dictTerm.AppliesTo.join(' ') }")`);
            }
          }
        }
      }
    }
  }


  // annoValue : the annotation value from the csn
  //             if the csn contains flattened out elements of a structured annotation,
  //             they are regrouped here
  // context :   for messages
  // return :    object that represents the annotation in the result edmx
  function handleTerm(termName, annoValue, context) {
    /**
     * create the <Annotation ...> tag
     * @type {object}
     * */
    let newAnno = undefined;
    const nullWhitelist = [ 'Core.OperationAvailable' ];
    const voc = termName.slice(0, termName.indexOf('.'));
    if(vocabularyDefinitions[voc] && annoValue !== null || nullWhitelist.includes(termName)) {
      newAnno = new Edm.Annotation(v, termName);

    // termName may contain a qualifier: @UI.FieldGroup#shippingStatus
    // -> remove qualifier from termName and set Qualifier attribute in newAnno
      let p = termName.split('#');
      let termNameWithoutQualifiers = p[0];
      if (p.length > 1) {
        checkOdataTerm(p[0]);
        if (!edmUtils.isODataSimpleIdentifier(p[1])) {
          message(error, context,
                `OData annotation qualifier "${ p[1] }" must start with a letter or underscore, followed by at most 127 letters, underscores or digits`);
        }
        newAnno.Term = termNameWithoutQualifiers;
        newAnno.Qualifier = p[1];
      }
      if (p.length>2) {
        message(warning, context, `multiple qualifiers (${ p[1] },${ p[2] }${ p.length > 3 ? ',...' : '' })`);
      }

    // get the type of the term from the dictionary
      let termTypeName = null;
      let dictTerm = getDictTerm(termNameWithoutQualifiers, context);
      if (dictTerm) {
        termTypeName = dictTerm.Type;
      }
      else {
        message(info, context, `Unknown term “${ termNameWithoutQualifiers }”`);
      }

    // handle the annotation value and put the result into the <Annotation ...> tag just created above
      handleValue(annoValue, newAnno, termNameWithoutQualifiers, termTypeName, context);
    }
    return newAnno;

    function checkOdataTerm(ns) {
      const simpleIdentifiers = ns.split('.');
      simpleIdentifiers.forEach((identifier) => {
        if(!edmUtils.isODataSimpleIdentifier(identifier)){
          message(error, context,
                  `OData annotation term "${ identifier }" must consist of one or more dot separated simple identifiers (each starting with a letter or underscore, followed by at most 127 letters)`);
        }
      })
    }

  }


  // handle an annotation value
  //   cAnnoValue: the annotation value (c : csn)
  //   oTarget: the result object (o: odata)
  //   oTermName: current term
  //   dTypeName: expected type of cAnnoValue according to dictionary, may be null (d: dictionary)
  function handleValue(cAnnoValue, oTarget, oTermName, dTypeName, context) {
    // this function basically only figures out what kind of annotation value we have
    //   (can be: array, expression, enum, pseudo-record, record, simple value),
    //   then calls a more specific function to deal with it and puts
    //   the result into the oTarget object

    if (Array.isArray(cAnnoValue))
    {
      if (isEnumType(dTypeName))
      {
        // if we find an array although we expect an enum, this may be a "flag enum"
        checkMultiEnumValue(cAnnoValue, dTypeName, context);
        oTarget.setJSON({ 'EnumMember': generateMultiEnumValue(cAnnoValue, dTypeName, false), 'EnumMember@odata.type' : '#'+dTypeName });
        oTarget.setXml( { 'EnumMember': generateMultiEnumValue(cAnnoValue, dTypeName, true) });
      }
      else
      {
        oTarget.append(generateCollection(cAnnoValue, oTermName, dTypeName, context));
      }
    }
    else if (cAnnoValue && typeof cAnnoValue === 'object') {
      if (Object.keys(cAnnoValue).length === 0) {
        message(warning, context, 'empty record');
      }
      else if ('=' in cAnnoValue) {
        // expression
        let res = handleExpression(cAnnoValue['='], dTypeName, context);
        oTarget.setXml( { [res.name] : res.value });
        oTarget.setJSON( { [res.name] : res.value });
      }
      else if (cAnnoValue['#'] !== undefined) {
        // enum
        if (dTypeName) {
          checkEnumValue(cAnnoValue['#'], dTypeName, context);
          oTarget.setXml( { 'EnumMember': dTypeName + '/' + cAnnoValue['#'] });
        }
        else {
          oTarget.setXml( { 'EnumMember': oTermName + 'Type/' + cAnnoValue['#'] });
        }
        oTarget.setJSON({ 'Edm.String': cAnnoValue['#'] });
      }
      else if (cAnnoValue['$value'] !== undefined) {
        // "pseudo-structure" used for annotating scalar annotations
        handleValue(cAnnoValue['$value'], oTarget, oTermName, dTypeName, context);

        let k = Object.keys(cAnnoValue).filter( x => x.charAt(0) === '@');
        if (!k || k.length === 0) {
          message(warning, context, 'pseudo-struct without nested annotation');
        }
        for (let nestedAnnoName of k) {
          let nestedAnno = handleTerm(nestedAnnoName.slice(1), cAnnoValue[nestedAnnoName], context);
          oTarget.append(nestedAnno);
        }
      }
      else if (cAnnoValue['$edmJson']) {
        // "pseudo-structure" used for embedding a piece of JSON that represents "OData CSDL, JSON Representation"
        oTarget.append(handleEdmJson(cAnnoValue['$edmJson'], context));
      }
      else if ( Object.keys(cAnnoValue).filter( x => x.substr(0,1) !== '@' ).length === 0) {
        // object consists only of properties starting with "@"
        message(warning, context, 'nested annotations without corresponding base annotation');
      }
      else {
        // regular record
        oTarget.append(generateRecord(cAnnoValue, oTermName, dTypeName, context));
      }
    }
    else {
      let res = handleSimpleValue(cAnnoValue, dTypeName, context);
      if(oTermName === 'Core.OperationAvailable' && dTypeName === 'Edm.Boolean' && cAnnoValue === null) {
        oTarget.append(new Edm.ValueThing(v, 'Null'));
        oTarget._ignoreChildren = true;
      }
      else {
        oTarget.setXml( { [res.name] : res.value });
      }
      oTarget.setJSON( { [res.jsonName] : res.value });
    }
  }


  // found an enum value ("#"), check whether this fits
  //  the expected type "dTypeName"
  function checkEnumValue(enumValue, dTypeName, context) {
    let expectedType = getDictType(dTypeName);
    if (!expectedType && !isPrimitiveType(dTypeName)) {
      message(warning, context, `internal error: dictionary inconsistency: type '${ dTypeName }' not found`);
    }
    else if (isComplexType(dTypeName)) {
      message(warning, context, `found enum value, but expected complex type ${ dTypeName }`);
    }
    else if (isPrimitiveType(dTypeName) || expectedType['$kind'] !== 'EnumType') {
      message(warning, context, `found enum value, but expected non-enum type ${ dTypeName }`);
    }
    else if (!expectedType['Members'].includes(enumValue)) {
      message(warning, context, `enumeration type ${ dTypeName } has no value ${ enumValue }`);
    }
    return;
  }

  // cAnnoValue: array
  // dTypeName: expected type, already identified as enum type
  //   array is expected to contain enum values
  function checkMultiEnumValue(cAnnoValue, dTypeName, context) {
    // we know that dTypeName is not null
    let type = getDictType(dTypeName);
    if (!type || type['IsFlags'] !== 'true') {
      message(warning, context, `enum type '${ dTypeName }' doesn't allow multiple values`);
    }

    let index = 0;
    for (let e of cAnnoValue) {
      context.stack.push('[' + index++ + ']');
      if (e['#']) {
        checkEnumValue(e['#'], dTypeName, context);
      }
      else {
        // TODO improve message: but found ...
        message(warning, context, 'expected an enum value');
      }
      context.stack.pop();
    }
  }

  function generateMultiEnumValue(cAnnoValue, dTypeName, forXml)
  {
    // remove all invalid entries (warnining message has already been issued)
    // replace short enum name by the full name
    // concatenate all the enums to a string, separated by spaces
    return cAnnoValue.filter( x => x['#'] != undefined ).map( x => (forXml ? dTypeName + '/' : '') + x['#'] ).join(forXml ? ' ' : ',');
  }


  // found an expression value ("=") "expr"
  //   expected type is dTypeName
  // note: expr can also be provided if an enum/complex type/collection is expected
  function handleExpression(expr, dTypeName, context) {
    let typeName = 'Path';
    if( ['Edm.AnnotationPath', 'Edm.ModelElementPath', 'Edm.NavigationPropertyPath', 'Edm.PropertyPath', 'Edm.Path' ].includes(dTypeName) )
      typeName = dTypeName.split('.')[1];

    let val = expr;
    if (!expr) {
      message(warning, context, 'empty expression value');
    }
    else {
      // replace all occurrences of '.' by '/' up to first '@'
      val = expr.split('@').map((o,i) => (i==0 ? o.replace(/\./g, '/') : o)).join('@');
    }

    return {
      name : typeName,
      value : val
    }
  }


  // found a simple value "val"
  //  expected type is dTypeName
  //  mappping rule for values:
  //    if expected type is ... the expression to be generated is ...
  //      floating point type except Edm.Decimal -> Float
  //      Edm.Decimal -> Decimal
  //      integer tpye -> Int
  function handleSimpleValue(val, dTypeName, context) {
    // caller already made sure that val is neither object nor array
    dTypeName = resolveType(dTypeName);

    if(isEnumType(dTypeName)) {
      const type = getDictType(dTypeName);
      message(warning, context, `found non-enum value "${val}", expected ${type.Members.map(m=>`"#${m}"`).join(', ')} for ${dTypeName}`);
    }

    let typeName = 'String';

    if (typeof val === 'string') {
      if (dTypeName === 'Edm.Boolean') {
        typeName = 'Bool';
        if (!['true','false'].includes(val)) {
          message(warning, context, `found String, but expected type ${ dTypeName }`);
        }
      }
      else if (dTypeName === 'Edm.Decimal') {
        typeName = 'Decimal';
        if (isNaN(Number(val)) || isNaN(parseFloat(val))) {
          message(warning, context, `found non-numeric string, but expected type ${ dTypeName }`);
        }
      }
      else if (dTypeName === 'Edm.Double' || dTypeName === 'Edm.Single') {
        typeName = 'Float';
        if (isNaN(Number(val)) || isNaN(parseFloat(val))) {
          message(warning, context, `found non-numeric string, but expected type ${ dTypeName }`);
        }
      }
      else if (isComplexType(dTypeName)) {
        message(warning, context, `found String, but expected complex type ${ dTypeName }`);
      }
      else if (isEnumType(dTypeName)) {
        message(warning, context, `found String, but expected enum type ${ dTypeName }`);
        typeName = 'EnumMember';
      }
      else if (dTypeName && dTypeName.startsWith('Edm.') && dTypeName !== 'Edm.PrimitiveType') {
        // this covers also all paths
        typeName = dTypeName.substring(4);
      }
      else {
        if(dTypeName == undefined || dTypeName === 'Edm.PrimitiveType')
          dTypeName = 'Edm.String';
        // TODO
        //message(warning, context, "type is not yet handled: found String, expected type: " + dTypeName);
      }
    }
    else if (typeof val === 'boolean') {
      if(dTypeName == undefined || dTypeName === 'Edm.Boolean' || dTypeName === 'Edm.PrimitiveType') {
        typeName = 'Bool';
        dTypeName = 'Edm.Boolean';
      }
      if (dTypeName === 'Edm.Boolean') {
        val = val ? 'true' : 'false';
      }
      else if (dTypeName === 'Edm.String') {
        typeName = 'String';
      }
      else {
        message(warning, context, `found Boolean, but expected type ${ dTypeName }`);
      }
    }
    else if (typeof val === 'number') {
      if (isComplexType(dTypeName)) {
        message(warning, context, `found number, but expected complex type ${ dTypeName }`);
      }
      else if (dTypeName === 'Edm.String') {
        typeName = 'String';
      }
      else if (dTypeName === 'Edm.PropertyPath') {
        message(warning, context, `found number, but expected type ${ dTypeName }`);
      }
      else if (dTypeName === 'Edm.Boolean') {
        message(warning, context, `found number, but expected type ${ dTypeName }`);
      }
      else if (dTypeName === 'Edm.Decimal') {
        typeName = 'Decimal';
      }
      else if (dTypeName === 'Edm.Double') {
        typeName = 'Float';
      }
      else {
        //typeName = Number.isInteger(val) ? 'Int' : 'Float';
        if(Number.isInteger(val)) {
          typeName = 'Int';
          if(dTypeName == undefined || dTypeName === 'Edm.PrimitiveType' || !dTypeName.startsWith('Edm.'))
            dTypeName = 'Edm.Int64';
        }
        else {
          typeName = 'Float';
          if(dTypeName == undefined || dTypeName === 'Edm.PrimitiveType'|| !dTypeName.startsWith('Edm.'))
            dTypeName = 'Edm.Double';
        }
      }
    }
    else if (val === null && dTypeName == null && typeName === 'String') {
      dTypeName = 'Edm.String';
    }
    else {
      message(warning, context, `expected simple value, but found value '${ val }' with type '${ typeof val }'`);
    }

    if( ['Edm.AnnotationPath', 'Edm.ModelElementPath', 'Edm.NavigationPropertyPath', 'Edm.PropertyPath', 'Edm.Path' ].includes(dTypeName) )
      dTypeName = dTypeName.split('.')[1];

    return {
      name : typeName,
      jsonName: dTypeName,
      value : val
    };
  }


  // obj: object representing the record
  // dTypeName : name of the expected record type according to vocabulary, may be null
  //
  // can be called for a record directly below a term, or at a deeper level
  function generateRecord(obj, termName, dTypeName, context) {
    /** @type {object} */
    let newRecord = new Edm.Record(v);

    // first determine what is the actual type to be used for the record
    if (dTypeName && !isComplexType(dTypeName)) {
      if (!getDictType(dTypeName) && !isPrimitiveType(dTypeName) && !isCollection(dTypeName))
        message(warning, context, `internal error: dictionary inconsistency: type '${ dTypeName }' not found`);
      else
        message(warning, context, `found complex type, but expected type '${ dTypeName }'`);
      return newRecord;
    }

    let actualTypeName = null;
    if (obj['$Type']) { // type is explicitly specified
      actualTypeName = obj['$Type'];
      if (!getDictType(actualTypeName)) {
        // this type doesn't exist
        message(warning, context, `explicitly specified type '${ actualTypeName }' not found in vocabulary`);
        // explicitly mentioned type, render in XML and JSON
        newRecord.Type = actualTypeName;
      }
      else if (dTypeName && !isDerivedFrom(actualTypeName, dTypeName)) {
        // this type doesn't fit the expected one
        message(warning, context, `explicitly specified type '${ actualTypeName
        }' is not derived from expected type '${ dTypeName }'`);
        actualTypeName = dTypeName;
        // explicitly mentioned type, render in XML and JSON
        newRecord.Type = actualTypeName;
      }
      else if (isAbstractType(actualTypeName)) {
        // this type is abstract
        message(warning, context, `explicitly specified type '${ actualTypeName }' is abstract, specify a concrete type`);
        if(dTypeName)
          actualTypeName = dTypeName;
        // set to definition name and render in XML and JSON
        newRecord.Type = actualTypeName;
      }
      else {
        // ok
        // Dictionary Type, render in XML only for backward compatibility
        newRecord.setXml( { Type: actualTypeName });
      }
    }
    else if (dTypeName) { // there is an expected type name according to dictionary
      // convenience for common situation:
      //   if DataFieldAbstract is expected and no explicit type is provided, automatically choose DataField
      if (dTypeName === 'UI.DataFieldAbstract') {
        actualTypeName = 'UI.DataField';
      }
      else {
        actualTypeName = dTypeName;
      }
      if (isAbstractType(actualTypeName))
        message(warning, context, `type '${ dTypeName }' is abstract, use '$Type' to specify a concrete type`);

      // Dictionary Type, render in XML only for backward compatibility
      newRecord.setXml( { Type: actualTypeName });
    }
    else {
      // no expected type set -> do not set newRecord.Type
    }

    // now the type is clear, so look ath the value
    let dictProperties = getAllProperties(actualTypeName);

    // loop over elements
    for (let i of Object.keys(obj)) {
      context.stack.push('.' + i);

      if (i === '$Type') {
        // ignore, this is an "artificial" property used to indicate the type
      }
      else if (i.charAt(0) === '@') {
        // not a regular property, but a nested annotation
        let newAnno = handleTerm(i.substring(1, i.length), obj[i], context);
        newRecord.append(newAnno);
      }
      else {
        // regular property
        let dictPropertyTypeName = null;
        if (dictProperties) {
          dictPropertyTypeName = dictProperties[i];
          if (!dictPropertyTypeName){
            message(warning, context, `record type '${ actualTypeName }' doesn't have a property '${ i }'`);
          }
        }

        let newPropertyValue = new Edm.PropertyValue(v, i);
        // property value can be anything, so delegate handling to handleValue
        handleValue(obj[i], newPropertyValue, termName, dictPropertyTypeName, context);
        newRecord.append(newPropertyValue);
      }

      context.stack.pop();
    }

    return newRecord;
  }


  // annoValue is an array
  // dTypeName : Collection(...) according to dictionary
  function generateCollection(annoValue, termName, dTypeName, context) {
    let newCollection = new Edm.Collection(v);

    let innerTypeName = null;
    if (dTypeName) {
      var match = dTypeName.match(/^Collection\((.+)\)/);
      if (match) {
        innerTypeName = match[1];
      }
      else {
        message(warning, context, `found collection value, but expected non-collection type ${ dTypeName }`);
      }
    }

    let index = 0;
    for (let value of annoValue) {
      context.stack.push('[' + index++ + ']');

      // for dealing with the single array entries we unfortunately cannot call handleValue(),
      //   as the values inside an array are represented differently from the values
      //   in a record or term
      if (Array.isArray(value)) {
        message(warning, context, 'nested collections are not supported');
      }
      else if (value && typeof value === 'object') {
        if (value['=']) {
          let res = handleExpression(value['='], innerTypeName, context);
          let newPropertyPath = new Edm.ValueThing(v, res.name, res.value );
          newPropertyPath.setJSON( { [res.name] : res.value } );
          newCollection.append(newPropertyPath);
        }
        else if (value['#']) {
          message(warning, context, 'enum inside collection is not yet supported');
        }
        else if(value['$edmJson']) {
          newCollection.append(handleEdmJson(value['$edmJson'], context));
        }
        else {
          newCollection.append(generateRecord(value, termName, innerTypeName, context));
        }
      }
      else {
        let res = handleSimpleValue(value, innerTypeName, context);
        let newThing = (value === null) ?new Edm.ValueThing(v, 'Null') : new Edm.ValueThing(v, res.name, value );
        newThing.setJSON( { [res.jsonName] : res.value });
        newCollection.append(newThing);
      }

      context.stack.pop();
    }

    return newCollection;
  }


  // Not everything that can occur in OData annotations can be expressed with
  // corresponding constructs in cds annotations. For these special cases
  // we have a kind of "inline assembler" mode, i.e. you can in cds provide
  // as annotation value a json snippet that looks like the final edm-json.
  // See example in test/odataAnnotations/smallTests/edmJson_noReverse_ok
  // and test3/ODataBackends/DynExpr

  function handleEdmJson(obj, context, exprDef=undefined) {

    let edmNode = undefined;
    if(obj === undefined)
      return edmNode;

    const dynExprs = edmUtils.intersect(dynamicExpressionNames, Object.keys(obj));

    if(dynExprs.length > 1) {
      message(warning, context, `EDM JSON code contains more than one dynamic expression: ${ dynExprs }`);
      return edmNode;
    }

    if(dynExprs.length === 0) {
      if (typeof obj === 'object' && obj !== null && !Array.isArray(obj) && Object.keys(obj).length==1) {
        const k = Object.keys(obj)[0];
        const val = obj[k];
        edmNode = new Edm.ValueThing(v, k[0] === '$' ? k.slice(1) : k, val );
        edmNode.setJSON( { [edmNode.kind]: val } );
      }
      else {
        // This thing is either a record or a collection or a literal
        if(Array.isArray(obj)) {
          // EDM JSON doesn't mention annotations on collections
          edmNode = new Edm.Collection(v);
          obj.forEach(o => edmNode.append(handleEdmJson(o, context)));
        }
        else if(typeof obj === 'object') {
          edmNode = new Edm.Record(v);
          const annos = Object.create(null);
          const props = Object.create(null);
          Object.entries(obj).forEach(([k, val]) => {
            if(k === '@type') {
              edmNode.Type = val;
            }
            else {
              let child = undefined;
              const [ head, tail ] = k.split('@');
              if(tail) {
                child = handleTerm(tail, val, context);
              }
              else {
                child = new Edm.PropertyValue(v, head);
                child.append(handleEdmJson(val, context));
              }
              if(child) {
                if(tail && head.length) {
                  if(!annos[head])
                    annos[head] = [ child ];
                  else
                    annos[head].push(child);
                }
                else {
                  if(head.length)
                    props[head] = child;
                  edmNode.append(child);
                }
              }
            }
          });
          // add collected annotations to record members
          Object.entries(annos).forEach(([n, val]) => {
            props[n] && props[n].prepend(...val);
          });
        }
        else { // literal
          let escaped = obj;
          if (typeof escaped === 'string') {
            escaped = escaped.replace(/&/g, '&amp;')
          }
          edmNode = new Edm.ValueThing(v,
            exprDef && exprDef.valueThingName || getXmlTypeName(escaped), escaped);
          // typename for static expression rendering
          edmNode.setJSON( { [getJsonTypeName(escaped)]: escaped } );
        }
      }
    }
    else {
      // name of special property determines element kind
      exprDef = dynamicExpressions[dynExprs[0]];
      edmNode = exprDef.create(obj);

      // iterate over each obj.property and translate expression into EDM
      Object.entries(obj).forEach(([name, val]) => {
        if(exprDef) {
          if(exprDef.anno && name[0] === '@') {
            edmNode.append(handleTerm(name.slice(1), val, context));
          }
          else if (exprDef.attr && exprDef.attr.includes(name)) {
            if (name[0] === '$') {
              edmNode[name.slice(1)] = val;
            }
          }
          else if (exprDef.jsonAttr && exprDef.jsonAttr.includes(name)) {
            if (name[0] === '$') {
              edmNode.setJSON( { [name.slice(1)]: val }) ;
            }
          }
          else if(exprDef.children) {
            if (Array.isArray(val)) {
              val.forEach(a => {
                edmNode.append(handleEdmJson(a, context, exprDef));
              });
            }
            else {
              edmNode.append(handleEdmJson(val, context, exprDef));
            }
          }
        }
      });
    }
    return edmNode;

    function getXmlTypeName(val) {
      let typeName = 'String';
      if (typeof val === 'boolean') {
        typeName = 'Bool';
      }
      else if (typeof val === 'number') {
        typeName = Number.isInteger(val) ? 'Int' : 'Decimal';
      }
      return typeName;
    }

    function getJsonTypeName(val) {
      let typeName = getXmlTypeName(val);
      if(typeName === 'Int')
        return 'Edm.Int32'
      else
        return 'Edm.'+typeName;
    }
  }

  function initEdmJson() {
    // Static dynamic expression dictionary, loaded with Edm creators
    const dynamicExpressions = {
      '$And':   { create: () => { return new Edm.Expr(v, 'And') }, anno: true },
      '$Or':    { create: () => { return new Edm.Expr(v, 'Or') }, anno: true },
      '$Not':   { create: () => { return new Edm.Expr(v, 'Not') }, anno: true },
      '$Eq':    { create: () => { return new Edm.Expr(v, 'Eq') }, anno: true },
      '$Ne':    { create: () => { return new Edm.Expr(v, 'Ne') }, anno: true },
      '$Gt':    { create: () => { return new Edm.Expr(v, 'Gt') }, anno: true },
      '$Ge':    { create: () => { return new Edm.Expr(v, 'Ge') }, anno: true },
      '$Lt':    { create: () => { return new Edm.Expr(v, 'Lt') }, anno: true },
      '$Le':    { create: () => { return new Edm.Expr(v, 'Le') }, anno: true },
      //valueThingName: 'EnumMember' Implicit Cast Rule String => Primitive Type is OK
      '$Has':   { create: () => { return new Edm.Expr(v, 'Has') }, anno: true },
      '$In':    { create: () => { return new Edm.Expr(v, 'In') }, anno: true },
      '$Add':   { create: () => { return new Edm.Expr(v, 'Add') }, anno: true },
      '$Sub':   { create: () => { return new Edm.Expr(v, 'Sub') }, anno: true },
      '$Neg':   { create: () => { return new Edm.Expr(v, 'Neg') }, anno: true },
      '$Mul':   { create: () => { return new Edm.Expr(v, 'Mul') }, anno: true },
      '$Div':   { create: () => { return new Edm.Expr(v, 'Div') }, anno: true },
      '$DivBy': { create: () => { return new Edm.Expr(v, 'DivBy') }, anno: true },
      '$Mod':   { create: () => { return new Edm.Expr(v, 'Mod') }, anno: true },
      '$Apply': {
        create: () => { return new Edm.Apply(v) },
        attr: [ '$Function' ],
        anno: true
      },
      '$Cast': {
        create: () => { return new Edm.Cast(v) },
        attr: [ '$Type' ],
        jsonAttr: [ '$Collection' ],
        anno: true
      },
      '$IsOf': {
        create: () => { return new Edm.IsOf(v) },
        attr: [ '$Type' ],
        anno: true
      },
      '$If': { create: () => { return new Edm.If(v) }, anno: true },
      '$LabeledElement': {
        create: () => { return new Edm.LabeledElement(v) },
        attr: [ '$Name' ],
        anno: true
      },
      '$LabeledElementReference': {
        create: (obj) => { return new Edm.LabeledElementReference(v, obj['$LabeledElementReference']); },
      },
      '$UrlRef': { create: () => { return new Edm.UrlRef(v); }, anno: true },
      '$Null': { create: () => { return new Edm.Null(v); }, anno: true, children: false },
    };

    Object.entries(dynamicExpressions).forEach(([k, v]) => {
      if(!v.name)
        v.name = k.slice(1);
      if(v.children === undefined)
        v.children = true;
    });
    return [ dynamicExpressions, Object.keys(dynamicExpressions) ];
  }
  //-------------------------------------------------------------------------------------------------
  //-------------------------------------------------------------------------------------------------
  //-------------------------------------------------------------------------------------------------

  // filter function, assumed to be used for array of string
  //   accepts those strings that start with a known vocabulary name
  function filterKnownVocabularies(name) {
    var match = name.match(/^(@)(\w+)/);
    if (match == null) return false;
    return knownVocabularies.includes(match[2]);  // second match group
  }

  // resolve "derived types"
  // -> if dTypeName is a TypeDefinition, replace by
  //    underlying type
  function resolveType(dTypeName) {
    let type = getDictType(dTypeName);
    if (type && type.UnderlyingType && type['$kind'] === 'TypeDefinition') {
      return type.UnderlyingType;
    }
    return dTypeName;
  }

  function isPrimitiveType(typeName) {
    return typeName.split('.')[0] === 'Edm';
  }

  function isCollection(typeName) {
    return typeName.match(/^Collection\((.+)\)/) !== null;
  }

  function isEnumType(dTypeName) {
    let type = getDictType(dTypeName);
    return type && type['$kind'] === 'EnumType';
  }

  function isComplexType(dTypeName) {
    let type = getDictType(dTypeName);
    return dTypeName === 'Edm.ComplexType' || type && type['$kind'] === 'ComplexType';
  }

  function isAbstractType(dTypeName) {
    let type = getDictType(dTypeName);
    return type && type['Abstract'] === 'true';
  }

  // return true if derived has baseCandidate as direct or indirect base type
  function isDerivedFrom(derived, baseCandidate) {
    while (derived) {
      if (derived == baseCandidate) return true;
      derived = getDictType(derived).BaseType;
    }
    return false;
  }

  // return dictionary of all properties of typeName, including those of base types
  function getAllProperties(typeName) {
    if (!typeName || !getDictType(typeName)) return null;
    return getDictType(typeName).Properties;
  }

}

//-------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------

module.exports = { knownVocabularies, vocabularyDefinitions, csn2annotationEdm };
