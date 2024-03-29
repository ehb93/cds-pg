'use strict';

// A "tools" collection of various transformation functions that might be helpful for
// different backends.
// The sibling of model/transform/TransformUtil.js which works with compacted new CSN.

const { hasErrors, makeMessageFunction } = require('../base/messages');
const { setProp } = require('../base/model');
const { csnRefs } = require('../model/csnRefs');

const { copyAnnotations, applyTransformations } = require('../model/csnUtils');
const { cloneCsn, getUtils, isBuiltinType } = require('../model/csnUtils');

// Return the public functions of this module, with 'model' captured in a closure (for definitions, options etc).
// Use 'pathDelimiter' for flattened names (e.g. of struct elements or foreign key elements).
// 'model' is compacted new style CSN
// TODO: Error and warnings handling with compacted CSN? - currently just throw new Error for everything
// TODO: check the situation with assocs with values. In compacted CSN such elements have only "@Core.Computed": true
function getTransformers(model, options, pathDelimiter = '_') {
  const { error, warning, info } = makeMessageFunction(model, options);
  const {
    getCsnDef,
    getFinalBaseType,
    hasAnnotationValue,
    inspectRef,
    isStructured,
  } = getUtils(model);

  const {
    effectiveType,
  } = csnRefs(model);


  return {
    resolvePath,
    flattenPath,
    addDefaultTypeFacets,
    createForeignKeyElement,
    getForeignKeyArtifact,
    flattenStructuredElement,
    flattenStructStepsInRef,
    toFinalBaseType,
    copyTypeProperties,
    isAssociationOperand,
    isDollarSelfOrProjectionOperand,
    getFinalBaseType,
    createExposingProjection,
    createAndAddDraftAdminDataProjection,
    createScalarElement,
    createAssociationElement,
    createAssociationPathComparison,
    createForeignKey,
    addForeignKey,
    addElement,
    copyAndAddElement,
    createAction,
    assignAction,
    extractValidFromToKeyElement,
    checkMultipleAssignments,
    checkAssignment,
    recurseElements,
    renameAnnotation,
    setAnnotation,
    resetAnnotation,
    expandStructsInExpression,
  };

  // Try to apply length, precision, scale from options if no type facet is set on the primitive types 'cds.String' or 'cds.Decimal'.
  // If 'obj' has primitive type 'cds.String' and no length try to apply length from options if available or set to default 5000.
  // if 'obj' has primitive type 'cds.Decimal' try to apply precision, scale from options if available.
  function addDefaultTypeFacets(element, defStrLen5k=true) {
    if (!element || !element.type)
      return;

    if (element.type === 'cds.String' && element.length === undefined) {
      if(options.defaultStringLength) {
        element.length = options.defaultStringLength;
        setProp(element, '$default', true);
      }
      else if(defStrLen5k)
        element.length = 5000;
    }
  /*
    if (element.type === 'cds.Decimal' && element.precision === undefined && options.precision) {
      element.precision = options.precision;
    }
    if (element.type === 'cds.Decimal' && element.scale === undefined && options.scale) {
      element.scale = options.scale;
    }
  */
  }

  // createRealFK 'really' creates the new foreign key element and is used by the two
  // main FK generators getForeignKeyArtifact & createForeignKeyElement
  //      and (not yet) generateForeignKeyElements.js::generateForeignKeysForRef()
  // TODO/FIXME: Can they be combined?
  function createRealFK(fkArtifact, assoc, assocName, foreignKey, path, foreignKeyElementName) {
    const foreignKeyElement = Object.create(null);

    // Transfer selected type properties from target key element
    // FIXME: There is currently no other way but to treat the annotation '@odata.Type' as a type property.
    for (const prop of ['type', 'length', 'scale', 'precision', 'srid', 'default', '@odata.Type']) {
      if (fkArtifact[prop] != undefined) {
        foreignKeyElement[prop] = fkArtifact[prop];
      }
    }

    if (!options.forHana)
      copyAnnotations(assoc, foreignKeyElement, true);

    // If the association is non-fkArtifact resp. key, so should be the foreign key field
    for (const prop of ['notNull', 'key']) {
      if (assoc[prop] != undefined) {
        foreignKeyElement[prop] = assoc[prop];
      }
    }

    // Establish the relationship between generated field and association:
    // - generated field has annotation '@odata.foreignKey4'.
    // - foreign key info has 'generatedFieldName'
    foreignKeyElement['@odata.foreignKey4'] = assocName;
    foreignKey.$generatedFieldName = foreignKeyElementName;
    // attach $path to the newly created element - used for inspectRef in processAssociationOrComposition
    setProp(foreignKeyElement, '$path', path);
    if (assoc.$location) {
      setProp(foreignKeyElement, '$location', assoc.$location);
    }
    return foreignKeyElement;
  }

  function getForeignKeyArtifact(assoc, assocName, foreignKey, path) {
    const fkArtifact = inspectRef(path).art;
    // FIXME: Duplicate code
    // Assemble foreign key element name from assoc name, '_' and foreign key name/alias
    const foreignKeyElementName = `${assocName.replace(/\./g, pathDelimiter)}${pathDelimiter}${foreignKey.as || foreignKey.ref.join(pathDelimiter)}`;


    // In case of compiler errors the foreign key might be missing
    if (!fkArtifact && hasErrors(options.messages)) {
      return null;
    }
    return [ foreignKeyElementName, createRealFK(fkArtifact, assoc, assocName, foreignKey, path, foreignKeyElementName) ];
  }

  // (1) Create an artificial foreign key element for association 'assoc' (possibly part
  // of nested struct, i.e. containing dots) in 'artifact', using foreign key info
  // from 'foreignKey'.
  // (2) Inserting it into 'elements' of 'artifact'.
  // (3) Add a property '$generatedFieldName' to the corresponding 'foreignKey' of the assoc.
  //
  // Note that this must happen after struct flattening(flattenStructuredElement) - both fot elements and foreign keys.
  // Return the newly generated foreign key element.
  function createForeignKeyElement(assoc, assocName, foreignKey, artifact, artifactName, path) {
    let result = {};

    // FIXME: Duplicate code (postfix is added herein, can this be optimized?)
    // Assemble foreign key element name from assoc name, '_' and foreign key name/alias
    let foreignKeyElementName = `${assocName.replace(/\./g, pathDelimiter)}${pathDelimiter}${foreignKey.as || foreignKey.ref.join(pathDelimiter)}`;


    let fkArtifact = inspectRef(path).art;

    // In case of compiler errors the foreign key might be missing
    if (!fkArtifact && hasErrors(options.messages)) {
      return null;
    }

    newForeignKey(fkArtifact,foreignKeyElementName);

    function processAssociationOrComposition(fkArtifact,foreignKeyElementName) {
      fkArtifact.keys.forEach(iKey => {
        let iKeyArtifact = inspectRef(iKey.$path).art;

        if (!iKeyArtifact && hasErrors(options.messages)) {
          return;
        }
        if(iKey.ref.length>1)
          throw Error(`createForeignKeyElement(${artifactName},${assocName},${iKey.$path.join('/')}) unexpected reference: `+ iKey.ref)
        newForeignKey(iKeyArtifact,foreignKeyElementName+'_'+iKey.ref[0])
      })
    }

    // compose new foreign key out of 'fkArtifact' named 'foreignKeyElementName'
    function newForeignKey(fkArtifact, foreignKeyElementName) {
      if (fkArtifact.type === 'cds.Association' || fkArtifact.type === 'cds.Composition') {
        processAssociationOrComposition(fkArtifact, foreignKeyElementName)
        return;
      }

      let foreignKeyElement = createRealFK(fkArtifact, assoc, assocName, foreignKey, path, foreignKeyElementName);

      // FIXME: must this code go into createRealFK?
      // Not present in getForeignKeyArtifact
      if (artifact.items) // proceed to items of such
        artifact = artifact.items;

      // Insert artificial element into artifact, with all cross-links
      artifact.elements[foreignKeyElementName] = foreignKeyElement;

      result[foreignKeyElementName] = foreignKeyElement;
    } // function newForeignKey
    return result;
  }

  // For a structured element 'elem', return a dictionary of flattened elements to
  // replace it, flattening names with pathDelimiter's value and propagating all annotations and the
  // type properties 'key', 'notNull', 'virtual', 'masked' to the flattened elements.
  // example input:
  //  { elem: {
  //          key: true,
  //          @foo: true,
  //          elements:
  //            { a: { type: 'cds.Integer' } },
  //            { b: {
  //                 elements:
  //                   { b1: type: 'cds.String', length: 42 } } },
  //  } }
  //
  // result:
  //  { elem_a: {
  //          key: true,
  //          @foo: true,
  //          type: 'cds.Integer' },
  //    elem_b_b1: {
  //          key: true,
  //          @foo: true,
  //          type: 'cds.String',
  //          length: 42 },
  // }
  function flattenStructuredElement(elem, elemName, parentElementPath=[], pathInCsn=[]) {
    let elementPath=parentElementPath.concat(elemName); // elementPath contains only element names without the csn structure node names
    // in case the element is of user defined type => take the definition of the type
    // for type of 'x' -> elem.type is an object, not a string -> use directly
    let elemType;
    if (!elem.elements) // structures do not have final base type
      elemType = getFinalBaseType(elem.type);

    const struct = elemType ? elemType.elements : elem.elements;

    // Collect all child elements (recursively) into 'result'
    let result = Object.create(null);
    const addGeneratedFlattenedElement = (e, eName) => {
      if(result[eName]){
        error(null, pathInCsn, { name: eName },
          'Generated element $(NAME) conflicts with other generated element')
      } else {
        result[eName] = e;
      }
    }
    Object.entries(struct).forEach(([childName, childElem]) => {
      if (isStructured(childElem)) {
        // Descend recursively into structured children
        let grandChildElems = flattenStructuredElement(childElem, childName, elementPath, pathInCsn.concat('elements',childName));
        for (let grandChildName in grandChildElems) {
          let flatElemName = elemName + pathDelimiter + grandChildName;
          let flatElem = grandChildElems[grandChildName];
          addGeneratedFlattenedElement(flatElem, flatElemName);
          // TODO: check with values. In CSN such elements have only "@Core.Computed": true
          // If the original element had a value, construct one for the flattened element
          // if (elem.value) {
          //   createFlattenedValue(flatElem, flatElemName, grandChildName);
          // }
          // Preserve the generated element name as it would have been with 'hdbcds' names
        }
      } else {
        // Primitive child - clone it and restore its cross references
        let flatElemName = elemName + pathDelimiter + childName;
        let flatElem = cloneCsn(childElem, options);
        // Don't take over notNull from leaf elements
        delete flatElem.notNull;
        setProp(flatElem, '_flatElementNameWithDots', elementPath.concat(childName).join('.'));
        addGeneratedFlattenedElement(flatElem, flatElemName);
      }
    });

    // Fix all collected flat elements (names, annotations, properties, origin ..)
    Object.values(result).forEach(flatElem => {
      // Copy annotations from struct (not overwriting, because deep annotations should have precedence)
      copyAnnotations(elem, flatElem, false);
      // Copy selected type properties
      for (let p of ['key', 'virtual', 'masked', 'viaAll']) {
        if (elem[p]) {
          flatElem[p] = elem[p];
        }
      }
    });
    return result;
  }

  /**
   * Return a copy of 'ref' where all path steps resulting from struct traversal are
   * fused together into one step, using '_' (so that the path fits again for flattened
   * structs), e.g.
   *  [ (Entity), (struct1), (struct2), (assoc), (elem) ] should result in
   *  [ (Entity), (struct1_struct2_assoc), (elem) ]
   *
   * @param {string[]} ref 
   * @param {CSN.Path} path CSN path to the ref
   * @param {object[]} [links] Pre-resolved links for the given ref - if not provided, will be calculated JIT
   * @param {string} [scope] Pre-resolved scope for the given ref - if not provided, will be calculated JIT
   * @param {WeakMap} [resolvedLinkTypes=new WeakMap()] A WeakMap with already resolved types for each link-step - safes an `artifactRef` call
   * @returns {string[]}
   */
  function flattenStructStepsInRef(ref, path, links, scope, resolvedLinkTypes=new WeakMap()) {
    // Refs of length 1 cannot contain steps - no need to check
    if (ref.length < 2) {
      return ref;
    }

    return flatten(ref, path);

    function flatten(ref, path) {
      let result = [];
      //let stack = []; // IDs of path steps not yet processed or part of a struct traversal
      if(!links && !scope) { // calculate JIT if not supplied
        const res = inspectRef(path);
        links = res.links;
        scope = res.scope;
      }
      if (scope === '$magic')
        return ref;
      let flattenStep = false;
      links.forEach((value, idx) => {
        if (flattenStep) {
          result[result.length - 1] += pathDelimiter + (ref[idx].id ? ref[idx].id : ref[idx]);
          // if we had a filter or args, we had an assoc so this step is done
          // we then keep along the filter/args by updating the id of the current ref
          if(ref[idx].id) {
            ref[idx].id = result[result.length-1];
            result[result.length-1] = ref[idx];
          }
        }
        else {
          result.push(ref[idx]);
        }

        flattenStep = value.art && !value.art.kind && !value.art.SELECT && !value.art.from && (value.art.elements || effectiveType(value.art).elements || (resolvedLinkTypes.get(value)||{}).elements);
      });

      return result;
    }
  }

  /**
   * Copy properties of the referenced type, but don't resolve to the final base type.
   *
   * @param {any} node Node to copy to
   * @returns {void}
   */
  function copyTypeProperties(node) {
    // Nothing to do if no type (or if array/struct type)
    if (!node || !node.type) return;
    // ..  or if it is a ref
    if (node.type && node.type.ref) return;
    // ..  or builtin already
    if (node.type && isBuiltinType(node.type)) return;

    // The type might already be a full fledged type def (array of)
    const typeDef = typeof node.type === 'string' ? getCsnDef(node.type) : node.type;
    // Nothing to do if type is an array or a struct type
    if (typeDef.items || typeDef.elements) return;
    // if the declared element is an enum, these values are with priority
    if (!node.enum && typeDef.enum)
      Object.assign(node, { enum: typeDef.enum });
    if (!node.length && typeDef.length && !typeDef.$default)
      Object.assign(node, { length: typeDef.length });
    if (!node.precision && typeDef.precision)
      Object.assign(node, { precision: typeDef.precision });
    if (!node.scale && typeDef.scale)
      Object.assign(node, { scale: typeDef.scale });
    if (!node.srid && typeDef.srid)
      Object.assign(node, { srid: typeDef.srid });
  }

  /**
   * Replace the type of 'node' with its final base type (in contrast to the compiler,
   * also unravel derived enum types, i.e. take the final base type of the enum's base type.
   * Similar with associations and compositions (we probably need a _baseType link)
   *
   * @param {CSN.Artifact} node 
   * @param {WeakMap} [resolved] WeakMap containing already resolved refs
   * @param {boolean} [keepLocalized=false] Wether to clone .localized from a type def
   * @returns {void}
   */
  function toFinalBaseType(node, resolved, keepLocalized=false) {
    // Nothing to do if no type (or if array/struct type)
    if (!node || !node.type) return;
    // In case of a ref -> Follow the ref
    if (node.type && node.type.ref) {
      const finalBaseType = getFinalBaseType(node.type, undefined, resolved);
      if(finalBaseType === null)
        throw Error('Failed to obtain final base type for reference : ' + node.type.ref.join('/'));
      if(finalBaseType.elements) {
          // This changes the order - to be discussed!
        node.elements = cloneCsn(finalBaseType, options).elements; // copy elements
        delete node.type; // delete the type reference as edm processing does not expect it
      } else if(finalBaseType.items) {
          // This changes the order - to be discussed!
        node.items = cloneCsn(finalBaseType, options).items; // copy items
        delete node.type;
      } else {
        node.type=finalBaseType;
      }
      return;
    }
    // ..  or builtin already
    if (node.type && isBuiltinType(node.type)) return;

    // The type might already be a full fledged type def (array of)
    let typeDef = typeof node.type === 'string' ? getCsnDef(node.type) : node.type;
    // Nothing to do if type is an array or a struct type
    if (typeDef.items || typeDef.elements) {
      if(!(options.transformation === 'hdbcds' || options.toSql))
        return;

      // cloneCsn only works correctly if we start "from the top"
      const clone = cloneCsn({definitions: {'TypeDef': typeDef }}, options);
      // With hdbcds-hdbcds, don't resolve structured types - but propagrate ".items", to turn into LargeString later on.
      if(typeDef.items) {
        delete node.type;
        Object.assign(node, {items: clone.definitions.TypeDef.items});
      }
      if(typeDef.elements && !(options.transformation === 'hdbcds' && options.sqlMapping === 'hdbcds')) {
        if(!typeDef.items)
          delete node.type;
        Object.assign(node, {elements: clone.definitions.TypeDef.elements});
      }


      return;
    }
    // if the declared element is an enum, these values are with priority
    if (!node.enum && typeDef.enum) {
      const clone = cloneCsn({definitions: {'TypeDef': typeDef }}, options).definitions.TypeDef.enum;
      Object.assign(node, { enum: clone });
    }
    if (node.length === undefined && typeDef.length !== undefined)
      Object.assign(node, { length: typeDef.length });
    if (node.precision === undefined && typeDef.precision !== undefined)
      Object.assign(node, { precision: typeDef.precision });
    if (node.scale === undefined && typeDef.scale !== undefined)
      Object.assign(node, { scale: typeDef.scale });
    if (node.srid === undefined && typeDef.srid !== undefined)
      Object.assign(node, { srid: typeDef.srid });
    if (keepLocalized && node.localized === undefined && typeDef.localized !== undefined)
      Object.assign(node, { localized: typeDef.localized });
    node.type = typeDef.type;
    toFinalBaseType(node);
  }

  // Return a full projection 'projectionId' of artifact 'art' for exposure in 'service'.
  // Add the created projection to the model and complain if artifact already exists.
  // Used by Draft generation
  function createExposingProjection(art, artName, projectionId, service) {
    let projectionAbsoluteName = `${service}.${projectionId}`;
    // Create elements matching the artifact's elements
    let elements = Object.create(null);
    art.elements && Object.entries(art.elements).forEach(([elemName, artElem]) => {
      let elem = Object.assign({}, artElem);
      // Transfer xrefs, that are redirected to the projection
      // TODO: shall we remove the transfered elements from the original?
      // if (artElem._xref) {
      //   setProp(elem, '_xref', artElem._xref.filter(xref => xref.user && xref.user._main && xref.user._main._service == service));
      // }
      // FIXME: Remove once the compactor no longer renders 'origin'
      elements[elemName] = elem;
    });

    let query = {
      'SELECT': {
        'from': {
          'ref': [
            artName
          ]
        }
      }
    };
    // Assemble the projection itself and add it into the model
    let projection = {
      'kind': 'entity',
      projection: query.SELECT, // it is important that projetion and query refer to the same object!
      elements
    };
    // copy annotations from art to projection
    for (let a of Object.keys(art).filter(x => x.startsWith('@'))) {
      projection[a] = art[a];
    }
    model.definitions[projectionAbsoluteName] = projection;
    return projection;
  }

  /**
   * Create a 'DraftAdministrativeData' projection on entity 'DRAFT.DraftAdministrativeData'
   * in service 'service' and add it to the model.
   *
   * For forHanaNew, use String(36) instead of UUID and UTCTimestamp instead of Timestamp
   *
   * @param {string} service
   * @param {boolean} [hanaMode=false] Turn UUID into String(36)
   * @returns {CSN.Artifact}
   */
  function createAndAddDraftAdminDataProjection(service, hanaMode=false) {
    // Make sure we have a DRAFT.DraftAdministrativeData entity
    let draftAdminDataEntity = model.definitions['DRAFT.DraftAdministrativeData'];
    if (!draftAdminDataEntity) {
      draftAdminDataEntity = createAndAddDraftAdminDataEntity();
      model.definitions['DRAFT.DraftAdministrativeData'] = draftAdminDataEntity;
    }

    // Create a projection within this service
    return createExposingProjection(draftAdminDataEntity, 'DRAFT.DraftAdministrativeData', 'DraftAdministrativeData', service);

    /**
     * Create the 'DRAFT.DraftAdministrativeData' entity (unless it already exist)
     * Return the 'DRAFT.DraftAdministrativeData' entity.
     */
    function createAndAddDraftAdminDataEntity(artifactName = 'DRAFT.DraftAdministrativeData') {
      // Create the 'DRAFT.DraftAdministrativeData' entity
      const artifact = {
        kind: 'entity',
        elements: Object.create(null),
        '@Common.Label': '{i18n>Draft_DraftAdministrativeData}',
      }

      // key DraftUUID : UUID
      const draftUuid = createScalarElement('DraftUUID', hanaMode ? 'cds.String' : 'cds.UUID', true);
      if(hanaMode)
        draftUuid.DraftUUID.length = 36;

      draftUuid.DraftUUID['@UI.Hidden'] = true;
      draftUuid.DraftUUID['@Common.Label'] = '{i18n>Draft_DraftUUID}';
      addElement(draftUuid, artifact, artifactName);

      // CreationDateTime : Timestamp;
      const creationDateTime = createScalarElement('CreationDateTime', hanaMode ? 'cds.UTCTimestamp' : 'cds.Timestamp');
      creationDateTime.CreationDateTime['@Common.Label'] = '{i18n>Draft_CreationDateTime}';
      addElement(creationDateTime, artifact, artifactName);

      // CreatedByUser : String(256);
      const createdByUser = createScalarElement('CreatedByUser', 'cds.String');
      createdByUser['CreatedByUser'].length = 256;
      createdByUser.CreatedByUser['@Common.Label'] = '{i18n>Draft_CreatedByUser}';
      addElement(createdByUser, artifact, artifactName);

      // DraftIsCreatedByMe : Boolean;
      const draftIsCreatedByMe = createScalarElement('DraftIsCreatedByMe', 'cds.Boolean');
      draftIsCreatedByMe.DraftIsCreatedByMe['@UI.Hidden'] = true;
      draftIsCreatedByMe.DraftIsCreatedByMe['@Common.Label'] = '{i18n>Draft_DraftIsCreatedByMe}';
      addElement(draftIsCreatedByMe, artifact, artifactName);

      // LastChangeDateTime : Timestamp;
      const lastChangeDateTime = createScalarElement('LastChangeDateTime', hanaMode ? 'cds.UTCTimestamp' : 'cds.Timestamp');
      lastChangeDateTime.LastChangeDateTime['@Common.Label'] = '{i18n>Draft_LastChangeDateTime}';
      addElement(lastChangeDateTime, artifact, artifactName);

      // LastChangedByUser : String(256);
      const lastChangedByUser = createScalarElement('LastChangedByUser', 'cds.String');
      lastChangedByUser['LastChangedByUser'].length = 256;
      lastChangedByUser.LastChangedByUser['@Common.Label'] = '{i18n>Draft_LastChangedByUser}';
      addElement(lastChangedByUser, artifact, artifactName);

      // InProcessByUser : String(256);
      const inProcessByUser = createScalarElement('InProcessByUser', 'cds.String');
      inProcessByUser['InProcessByUser'].length = 256;
      inProcessByUser.InProcessByUser['@Common.Label'] = '{i18n>Draft_InProcessByUser}';
      addElement(inProcessByUser, artifact, artifactName);

      // DraftIsProcessedByMe : Boolean;
      const draftIsProcessedByMe = createScalarElement('DraftIsProcessedByMe', 'cds.Boolean');
      draftIsProcessedByMe.DraftIsProcessedByMe['@UI.Hidden'] = true;
      draftIsProcessedByMe.DraftIsProcessedByMe['@Common.Label'] = '{i18n>Draft_DraftIsProcessedByMe}';
      addElement(draftIsProcessedByMe, artifact, artifactName);

      return artifact;
    }
  }

  // Create an artificial scalar element 'elemName' with final type 'typeName'.
  // Make the element a key element if 'isKey' is true.
  // Add a default value 'defaultVal' if supplied
  // example result: { foo: { type: 'cds.Integer', key: true, default: { val: 6 }, notNull: true } }
  //                   ^^^            ^^^^^^^^^       ^^^^                   ^^             ^^
  //                 elemName         typeName        isKey               defaultVal       notNull
  function createScalarElement(elemName, typeName, isKey = false, defaultVal = undefined, notNull=false) {
    if (!isBuiltinType(typeName) && !model.definitions[typeName]) {
      throw new Error('Expecting valid type name: ' + typeName);
    }
    let result = {
      [elemName]: {
        type: typeName
      }
    };
    if (isKey) {
      result[elemName].key = true;
    }
    if (defaultVal !== undefined) {
      result[elemName].default = {
        val: defaultVal,
      }
    }
    if(notNull) {
      result[elemName].notNull = true;
    }
    return result;
  }

  // Return true if 'arg' is an expression argument denoting "$self" || "$projection"
  function isDollarSelfOrProjectionOperand(arg) {
    return arg.ref && arg.ref.length === 1 && (arg.ref[0] === '$self' || arg.ref[0] === '$projection');
  }

  // Return true if 'arg' is an expression argument of type association or composition
  function isAssociationOperand(arg, path) {
    if (!arg.ref) {
      // Not a path, hence not an association (literal, expression, function, whatever ...)
      return false;
    }
    const { art } = inspectRef(path);
    // If it has a target, it is an association or composition
    return art && art.target !== undefined;
  }

  // Create an artificial element 'elemName' of type 'cds.Association',
  // having association target 'target'. If 'isManaged' is true, take all keys
  // of 'target' as foreign keys.
  // e.g. result:
  // { toFoo: {
  //     type: 'cds.Association', target: 'Foo',
  //     keys: [{ ref: ['id'] }]
  // } }
  function createAssociationElement(elemName, target, isManaged = false) {
    let elem = createScalarElement(elemName, 'cds.Association', false, undefined);
    let assoc = elem[elemName];
    assoc.target = target;

    if (isManaged) {
      assoc.keys = [];
      let targetArt = getCsnDef(target);
      targetArt.elements && Object.entries(targetArt.elements).forEach(([keyElemName, keyElem]) => {
        if (keyElem.key) {
          let foreignKey = createForeignKey(keyElemName, keyElem);
          addForeignKey(foreignKey, assoc);
        }
      });
    }
    return elem;
  }

  // Create a comparison operation <assoc>.<foreignElem> <op> <elem>.
  // return an array to be spread in an on-condition
  // e.g. [ { ref: ['SiblingEntity','ID'] }, '=', { ref: ['ID'] } ]
  //                 ^^^^^          ^^^      ^^           ^^^
  //                 assoc      foreignElem  op           elem
  function createAssociationPathComparison(assoc, foreignElem, op, elem) {
    return [
      { ref: [assoc, foreignElem] }, op, { ref: [elem] }
    ]
  }

  // Create an artificial foreign key 'keyElemName' for key element 'keyElem'. Note that this
  // only creates a foreign key, not the generated foreign key element.
  // TODO: check the usage of this function's param 'keyElem' ?
  function createForeignKey(keyElemName, keyElem = undefined) { /* eslint-disable-line no-unused-vars */

    return {
      ref: [keyElemName]
      // TODO: do we need these two?
      // calculated: true,
      // $inferred: 'keys',
    }
  }

  // Add foreign key 'foreignKey' to association element 'elem'.
  function addForeignKey(foreignKey, elem) {
    // Sanity checks
    if (!elem.target || !elem.keys) {
      throw new Error('Expecting managed association element with foreign keys');
    }

    // Add the foreign key
    elem.keys.push(foreignKey);
  }


  /**
   * Add element 'elem' to 'artifact'
   *
   * @param {any} elem is in form: { b: { type: 'cds.String' } }
   * @param {CSN.Artifact} artifact is: { kind: 'entity', elements: { a: { type: 'cds.Integer' } ... } }
   * @param {string} [artifactName] Name of the artifact in `csn.definitions[]`.
   * @returns {void}
   */
  function addElement(elem, artifact, artifactName) {
    // Sanity check
    if (!artifact.elements) {
      throw new Error('Expecting artifact with elements: ' + JSON.stringify(artifact));
    }
    let elemName = Object.keys(elem)[0];
    // Element must not exist
    if (artifact.elements[elemName]) {
      let path = null;
      if (artifactName) {
        path = ['definitions', artifactName, 'elements', elemName];
      }
      error(null, path, { name: elemName }, `Generated element $(NAME) conflicts with existing element`);
      return;
    }

    // Add the element
    Object.assign(artifact.elements, elem);
  }

  /**
   * Make a copy of element 'elem' (e.g. { elem: { type: 'cds.Integer' } })
   * and add it to 'artifact' under the new name 'elemName'.
   * ( e.g. { artifact: { elements: { elemName: { type: 'cds.Integer' } } })
   * Return the newly created element
   * (e.g. { elemName: { type: 'cds.Integer' } })
   *
   * @param {object} elem
   * @param {CSN.Artifact} artifact
   * @param {string} artifactName
   * @param {string} elementName
   */
  function copyAndAddElement(elem, artifact, artifactName, elementName) {
    if (!artifact.elements) {
      throw new Error('Expected structured artifact');
    }
    // Must not already have such an element
    if (artifact.elements[elementName]) {
      const path = ['definitions', artifactName, 'elements', elementName];
      error(null, path, { name: elementName }, 'Generated element $(NAME) conflicts with existing element');
    }

    let result = Object.create(null);
    result[elementName] = {};
    elem && Object.entries(elem).forEach(([prop, value]) => {
      result[elementName][prop] = value;
    });
    Object.assign(artifact.elements, result);
    return result;
  }

  // Create an artificial action 'actionName' with return type artifact 'returnType' optionally with one parameter 'paramName'
  // of type name 'paramTypeName'
  function createAction(actionName, returnTypeName = undefined, paramName = undefined, paramTypeName = undefined) {
    // Assemble the action
    let result = {
      [actionName]: {
        kind: 'action'
      }
    };

    let action = result[actionName];

    if (returnTypeName) {
      if (!isBuiltinType(returnTypeName) && !model.definitions[returnTypeName])
        throw new Error('Expecting valid return type name: ' + returnTypeName);
      action.returns = { type: returnTypeName };
    }

    // Add parameter if provided
    if (paramName && paramTypeName) {
      if (!isBuiltinType(paramTypeName) && !model.definitions[paramTypeName])
        throw new Error('Expecting valid parameter type name: ' + paramTypeName);

      action.params = Object.create(null);
      action.params[paramName] = {
        type: paramTypeName
      }
    }

    return result;
  }

  /**
   * Add action 'action' to 'artifact' but don't overwrite existing action
   *
   * @param {object} action Action that shall be added to the given artifact.
   *                        In form of `{ myAction: { kind: 'action', returns ... } }`
   * @param {CSN.Artifact} artifact Artifact in the form of `{ kind: 'entity', elements: ... }`
   **/
  function assignAction(action, artifact) {
    if (!artifact.actions) {
      artifact.actions = Object.create(null);
    }

    let actionName = Object.keys(action)[0];
    // Element must not exist
    if (!artifact.actions[actionName]) {
      // Add the action
      Object.assign(artifact.actions, action);
    }
  }

  /**
   * If the element has annotation @cds.valid.from or @cds.valid.to, return it.
   *
   * @param {any} element Element to check
   * @param {Array} path path in CSN for error messages
   * @returns {Array[]} Array of arrays, first filed has an array with the element if it has @cds.valid.from,
   *                    second field if it has @cds.valid.to. Default value is [] for each field.
   */
  function extractValidFromToKeyElement(element, path) {
    let validFroms = [], validTos = [], validKeys = [];
    if (hasAnnotationValue(element, '@cds.valid.from')) {
      validFroms.push({ element, path: [...path] });
    }
    if (hasAnnotationValue(element, '@cds.valid.to')) {
      validTos.push({ element, path: [...path] });
    }
    if (hasAnnotationValue(element, '@cds.valid.key')) {
      validKeys.push({ element, path: [...path] });
    }
    return [validFroms, validTos, validKeys];
  }

  /**
   * Check if the element can be annotated with the given annotation.
   * Only runs the check if:
   * - The artifact is not a type
   * - The artifact is not a view
   *
   * Signals an error, if:
   * - The element is structured
   * - Has a target
   * - Has an element as _parent.kind
   *
   * @param {string} annoName Annotation name
   * @param {object} element Element to be checked
   * @param {CSN.Path} path
   * @param {CSN.Artifact} artifact
   * @returns {boolean} True if no errors
   */
  function checkAssignment(annoName, element, path, artifact) {
    if (artifact.kind !== 'type' && !artifact.query) {
      // path.length > 4 to check for structured elements
      if (element.elements || element.target || path.length > 4) {
        error(null, path, { anno: annoName }, 'Element can\'t be annotated with $(ANNO)');
        return false;
      }
    }
    return true;
  }

  /**
   * Signals an error/warning if an annotation has been assigned more than once
   *
   * @param {any} array Array of elements that have the annotation
   * @param {any} annoName Name of the annotation
   * @param {CSN.Artifact} artifact Root artifact containing the elements
   * @param {string} artifactName Name of the root artifact
   * @param {boolean} [err=true] Down-grade to a warning if set to false
   */
  function checkMultipleAssignments(array, annoName, artifact, artifactName, err = true) {
    if (array.length > 1) {
      const loc = ['definitions', artifactName];
      if (err == true) {
        error(null, loc, { anno: annoName }, `Annotation $(ANNO) must be assigned only once`);
      } else {
        warning(null, loc, { anno: annoName },`Annotation $(ANNO) must be assigned only once`);
      }
    }
  }

  /**
   * Calls `callback` for each element in `elements` property of `artifact` recursively.
   *
   * @param {CSN.Artifact} artifact the artifact
   * @param {CSN.Path} path path to get to `artifact` (mainly used for error messages)
   * @param {(art: CSN.Artifact, path: CSN.Path) => any} callback Function called for each element recursively.
   */
  function recurseElements(artifact, path, callback) {
    callback(artifact, path);
    let elements = artifact.elements;
    if (elements) {
      path.push('elements', null);
      Object.entries(elements).forEach(([name, obj]) => {
        path[path.length - 1] = name;
        recurseElements(obj, path, callback);
      });
      // reset path for subsequent usages
      path.length -= 2; // equivalent to 2x pop()
    }
  }

  // Rename annotation 'fromName' in 'node' to 'toName' (both names including '@')
  function renameAnnotation(node, fromName, toName) {
    let annotation = node && node[fromName];
    // Sanity checks
    if (!fromName.startsWith('@')) {
      throw Error('Annotation name should start with "@": ' + fromName);
    }
    if (!toName.startsWith('@')) {
      throw Error('Annotation name should start with "@": ' + toName);
    }
    if (annotation === undefined) {
      throw Error('Annotation ' + fromName + ' not found in ' + JSON.stringify(node));
    }
    if(node[toName] === undefined || node[toName] === null) {
      delete node[fromName];
      node[toName] = annotation;
    }
  }

  /**
   * Assign annotation to a node but do not overwrite already existing annotation assignment
   * that is (assignment is either undefined or has null value)
   *
   * @param {object} node Assignee
   * @param {string} name Annotation name
   * @param {any} value Annotation value
   * @returns {void}
   */
  function setAnnotation(node, name, value) {
    if (!name.startsWith('@')) {
      throw Error('Annotation name should start with "@": ' + name);
    }
    if (value === undefined) {
      throw Error('Annotation value must not be undefined');
    }

    if(node[name] === undefined || node[name] === null)
      node[name] = value;
  }

  /**
   * Assigns unconditionally annotation to a node, which means it overwrites already existing annotation assignment.
   * Overwritting is when the assignment differs from undefined and null, also when differs from the already set value.
   * Setting new assignment results false as return value and overwriting - true.
   *
   * @param {object} node Assignee
   * @param {string} name Annotation name
   * @param {any} value Annotation value
   * @param {function} info function that reports info messages
   * @param {CSN.Path} path location of the warning
   * @returns {boolean} wasOverwritten true when the annotation was overwritten
   */
  function resetAnnotation(node, name, value, info, path) {
    if (!name.startsWith('@')) {
      throw Error('Annotation name should start with "@": ' + name);
    }
    if (value === undefined) {
      throw Error('Annotation value must not be undefined');
    }

    const wasOverwritten = node[name] !== undefined && node[name] !== null && node[name] !== value;
    const oldValue = node[name];
    node[name] = value;
    if(wasOverwritten)
      info(null, path, { anno: name, prop: value, otherprop: oldValue },
      `Value $(OTHERPROP) of annotation $(ANNO) is overwritten with new value $(PROP)`);
    return wasOverwritten;
  }

  /*
    Resolve the type of an artifact
    If art is undefined, stop
    If art has elements or items.elements, stop
    If art has a type and the type is scalar, stop
    If art has a named type or a type ref, resolve it
  */
  function resolveType(art) {
    while(art &&
          !((art.items && art.items.elements) || art.elements) &&
            (art.type &&
              ((!art.type.ref && !isBuiltinType(art.type)) || art.type.ref))) {
      if(art.type.ref)
        art = resolvePath(art.type);
      else
        art = model.definitions[art.type];
    }
    return art;
  }

  /**
   * Path resolution, attach artifact to each path step, if found,
   * Dereference types and follow associations.
   *
   * @param {any} path ref object
   * @param {any} art start environment
   * @returns {any} path with resolved artifacts or artifact
   * (if called with simple ref paths)
   */
  function resolvePath(path, art=undefined) {
    let notFound = false;
    for(let i = 0; i < path.ref.length && !notFound; i++) {
      const ps = path.ref[i];
      const id = ps.id || ps;
      if(art) {
        if(art.target)
          art = model.definitions[art.target].elements[id];
        else if(art.items && art.items.elements || art.elements) {
          art = (art.items && art.items.elements || art.elements)[id];
        }
        else
          art = undefined;
      }
      else {
        art = model.definitions[id];
      }
      art = resolveType(art);

      // if path step has id, store art
      if(ps.id && art)
        ps._art = art;
      notFound = !art;
    }
    // if resolve was called on constraint path, path has id.
    // Store art and return path, if called recursively for model ref paths,
    // return artifact only
    if(path.ref[0].id) {
      if(art)
        path._art = art;
      return path;
    }
    else return art;
  }

  /*
    Flatten structured leaf types and return an array of paths.

    Argument 'path' must be an object of the form
    { _art: <leaf_artifact>, ref: [...] }
    with _art identifying ref[ref.length-1]

    A produced path has the form { _art: <ref>, ref: [ <id> (, <id>)* ] }

    Flattening stops on all non structured elements, if followMgdAssoc=false.

    If fullRef is true, a path step is produced as { id: <id>, _art: <link> }
  */
  function flattenPath(path, fullRef=false, followMgdAssoc=false) {
    let art = path._art;
    if(art) {
      if(art && !((art.items && art.items.elements) || art.elements)) {
        if(followMgdAssoc && art.target && art.keys) {
          let rc = [];
          for(const k of art.keys) {
            const nps = { ref: k.ref.map(p => fullRef ? { id: p } : p ) };
            setProp(nps, '_art', k._art);
            const paths = flattenPath( nps, fullRef, followMgdAssoc );
            // prepend prefix path
            paths.forEach(p=>p.ref.splice(0, 0, ...path.ref));
            rc.push(...paths);
          }
          return rc;
        }
        if(art.type && art.type.ref)
          art = resolvePath(art.type);
        else if(art.type && !isBuiltinType(art.type))
          art = model.definitions[art.type];
      }
      const elements = art.items && art.items.elements || art.elements;
      if(elements) {
        let rc = []
        Object.entries(elements).forEach(([en, elt]) => {
          const nps = { ref: [ (fullRef ? { id: en, _art: elt } : en )] };
          setProp(nps, '_art', elt);
          const paths = flattenPath( nps, fullRef, followMgdAssoc );
          // prepend prefix path
          paths.forEach(p=>p.ref.splice(0, 0, ...path.ref));
          rc.push(...paths);
        });
        return rc;
      }
      else
        setProp(path, '_art', art);
    }
    return [path];
  }

  /**
   * Expand structured expression arguments to flat reference paths.
   * Structured elements are real sub element lists and managed associations.
   * All unmanaged association definitions are rewritten if applicable (elements/mixins).
   * Also, HAVING and WHERE clauses are rewritten. We also check for infix filters and 
   * .xpr in columns.
   *
   * @todo Check if can be skipped for abstract entity  and or cds.persistence.skip ?
   * @param {CSN.Model} csn
   * @param {object} [options={}] "skipArtifact": (artifact, name) => Boolean to skip certain artifacts
   */
  function expandStructsInExpression(csn, options = {}) {
    applyTransformations(csn, {
      'on': (parent, name, on, path) => {
        parent.on = expand(parent.on, path);
      },
      'having': (parent, name, having, path) => {
        parent.having = expand(parent.having, path);
      },
      'where': (parent, name, where, path) => {
        parent.where = expand(parent.where, path);
      },
      'xpr': (parent, name, xpr, path) => {
        parent.xpr = expand(parent.xpr, path);
      }
    }, undefined, undefined, options);

    /*
      flatten structured leaf types and return array of paths
      Flattening stops on all non-structured types.
    */
    function expand(expr, location) {
      let rc = [];
      for(let i = 0; i < expr.length; i++)
      {
        if(Array.isArray(expr[i]))
          rc.push(expr[i].map(expand, location));

        if(i < expr.length-2)
        {
          const [lhs, op, rhs] = expr.slice(i);
          // lhs & rhs must be expandable types (structures or managed associations)
          if(lhs._art && rhs._art &&
             lhs.ref && rhs.ref &&
             isExpandable(lhs._art) && isExpandable(rhs._art) &&
             ['=', '<', '>', '>=', '<=', '!=', '<>'].includes(op) &&
             !(isDollarSelfOrProjectionOperand(lhs) || isDollarSelfOrProjectionOperand(rhs))) {

            // if path is scalar and no assoc or has no type (@Core.Computed) use original expression
            // only do the expansion on (managed) assocs and (items.)elements, array of check in ON cond is done elsewhere
            const lhspaths = /*isScalarOrNoType(lhs._art) ? [ lhs ] : */ flattenPath({ _art: lhs._art, ref: lhs.ref }, false, true );
            const rhspaths = /*isScalarOrNoType(rhs._art) ? [ rhs ] : */ flattenPath({ _art: rhs._art, ref: rhs.ref }, false, true );

            // mapping dict for lhs/rhs for mismatch check
            // strip lhs/rhs prefix from flattened paths to check remaining common trailing path
            // if path is idempotent, it doesn't produce new flattened paths (ends on scalar type)
            // key is then empty string on both sides '' (=> equality)
            // Path matches if lhs/rhs are available
            const xref = lhspaths.reduce((a, v) => {
              a[v.ref.slice(lhs.ref.length).join('.')] = { lhs: v };
              return a;
            }, Object.create(null));

            rhspaths.forEach(v => {
              const k = v.ref.slice(rhs.ref.length).join('.');
              if(xref[k])
                xref[k].rhs = v;
              else
                xref[k] = { rhs: v };
            });

            let cont = true;
            for(const xn in xref) {
              const x = xref[xn];

              // do the paths match?
              if(!(x.lhs && x.rhs)) {
                if(xn.length)
                  error(null, location, `'${lhs.ref.join('.')} ${op} ${rhs.ref.join('.')}': Sub path '${xn}' not found in ${((x.lhs ? rhs : lhs).ref.join('.'))}`)
                else
                  error(null, location, `'${lhs.ref.join('.')} ${op} ${rhs.ref.join('.')}': Path '${((x.lhs ? lhs : rhs).ref.join('.'))}' does not match ${((x.lhs ? rhs : lhs).ref.join('.'))}`)
                cont = false;
              }
              // lhs && rhs are present, consistency checks that affect both ends
              else {
                // is lhs scalar?
                if(!isScalarOrNoType(x.lhs._art)) {
                  error(null, location, `'${lhs.ref.join('.')} ${op} ${rhs.ref.join('.')}': Path '${x.lhs.ref.join('.')}${(xn.length ? '.' + xn : '')}' must end on a scalar type`)
                  cont = false;
                }
                // is rhs scalar?
                if(!isScalarOrNoType(x.rhs._art)) {
                  error(null, location, `'${lhs.ref.join('.')} ${op} ${rhs.ref.join('.')}': Path '${x.rhs.ref.join('.')}${(xn.length ? '.' + xn : '')}' must end on a scalar type`)
                  cont = false;
                }
                // info about type incompatibility if no other errors occured
                if(xn && cont) {
                  const lhst = getType(x.lhs._art);
                  const rhst = getType(x.rhs._art);
                  if(lhst !== rhst) {
                    info(null, location, `'${lhs.ref.join('.')} ${op} ${rhs.ref.join('.')}': Types for sub path '${xn}' don't match`)
                  }
                }
              }
            }
            // don't continue if there are path errors
            if(!cont)
              return expr;

            Object.keys(xref).forEach((k, i) => {
              const x = xref[k];
              if(i>0)
                rc.push('and');
              rc.push(x.lhs);
              rc.push(op);
              rc.push(x.rhs);
            });
            i += 2;
          }
          else
            rc.push(expr[i]);
        }
        else
          rc.push(expr[i]);
      }
      return rc;

      function getType(art) {
        const effart = effectiveType(art);
        return Object.keys(effart).length ? effart : art.type;
      }

      function isExpandable(art) {
        art = effectiveType(art);
        if(art) {
          // items in ON conds are illegal but this should be checked elsewhere
          const elements = art.elements || (art.items && art.items.elements);
          return (elements || art.target && art.keys)
        }
        return false;
      }

      function isScalarOrNoType(art) {
        art = effectiveType(art);
        if(art) {
          const type = art.type || (art.items && art.items.type);
          // items in ON conds are illegal but this should be checked elsewhere
          const elements = art.elements || (art.items && art.items.elements);
          // @Core.Computed has no type
          return(!elements && !type ||
          (type && isBuiltinType(type) &&
           !['cds.Association', 'cds.Composition'].includes(type)))
        }
        return false;
      }
    }
  }

}


/**
 * Modify the given CSN/artifact in-place, applying the given customTransformations.
 * Dictionaries are correctly handled - a "type" transformer will not be called on an entity called "type".
 *
 * A custom transformation function has the following signature:
 * (any, object, string, CSN.Path) => undefined
 *
 * Given that we have a custom transformation for "type" and stumble upon a thing like below:
 *
 * {
 *    type: "cds.String",
 *    anotherProp: 1
 * }
 *
 * The input for the function would be:
 *
 * ("cds.String", { type: <>, anotherProp: <>}, "type", [xy, "type"])
 *
 * @param {CSN.Model} csn
 * @param {object} customTransformations Dictionary of functions to apply - if the property matches a key in this dict, it will be called
 * @param {boolean} [transformNonEnumerableElements=false] Transform non-enumerable elements to work with cds linked...
 * @returns {CSN.Model|CSN.Artifact} Return the CSN/artifact
 */
function transformModel(csn, customTransformations, transformNonEnumerableElements=false){
  const transformers = {
    elements: dictionary,
    definitions: dictionary,
    actions: dictionary,
    params: dictionary,
    enum: dictionary,
    mixin: dictionary,
    args: dictionary
  };

  const csnPath = [];
  if (csn.definitions)
    dictionary( csn, 'definitions', csn.definitions );
  else {
    // fake it till you make it
    const obj = { definitions: Object.create(null)};
    obj.definitions.thing = csn;
    dictionary(obj, 'definitions', obj.definitions);
  }

  return csn;

  function standard( parent, prop, node ) {
    // checking for .kind and .type is safe because annotations with such properties, are already flattened out
    const isAnnotation = () => (typeof prop === 'string' && prop.startsWith('@') && !node.kind && !node.type);
    if (!node || node._ignore || typeof node !== 'object' || !{}.propertyIsEnumerable.call( parent, prop ) || isAnnotation())
      return;

    csnPath.push( prop );

    if (Array.isArray(node)) {
      node.forEach( (n, i) => standard( node, i, n ) );
    }
    else {
      const iterateOver = Object.getOwnPropertyNames( node );
      // cds-linked resolves types and add's them to elements as non-enum - need to be processed
      if(transformNonEnumerableElements && node.elements && !Object.prototype.propertyIsEnumerable.call(node, 'elements')){
        iterateOver.push('elements');
      }
      for (const name of iterateOver) {
        if(customTransformations[name])
          customTransformations[name](node[name], node, name, csnPath.concat(name))

        const trans = transformers[name] || standard;
        trans( node, name, node[name] );
      }
    }
    csnPath.pop();
  }
  function dictionary( node, prop, dict ) {
    csnPath.push( prop );

    if (Array.isArray(dict)) {
      dict.forEach( (n, i) => standard(dict, i, n))
    } else {
      for (const name of Object.getOwnPropertyNames( dict ))
        standard( dict, name, dict[name] );
    }

    csnPath.pop();
  }
}


module.exports = {
  // This function retrieves the actual exports
  getTransformers,
  transformModel
};
