'use strict';

/**
 * In this module resides all the logic related to exposure of types as part of the OData backend
 * The exposure is run only for definitions which reside in a service.
 * @module typesExposure
 */

const { setProp } = require('../../base/model');
const { defNameWithoutServiceOrContextName, isArtifactInService } = require('./utils');
const { cloneCsn, isBuiltinType, forEachDefinition, forEachMember, cloneCsnDictionary } = require('../../model/csnUtils');
const { copyAnnotations } = require('../../model/csnUtils');

/**
 * @param {CSN.Model} csn
 * @param {function} whatsMyServiceName
 * @param {CSN.Options} options
 * @param {*} csnUtils
 * @param {object} message message object with { error } function
 */
function typesExposure(csn, whatsMyServiceName, options, csnUtils, message) {
  const { error } = message;
  // are we working with OData proxies or cross-service refs
  const isMultiSchema = options.toOdata.version === 'v4' && (options.toOdata.odataProxies || options.toOdata.odataXServiceRefs);
  // collect in this variable all the newly exposed types
  const exposedStructTypes = [];
  const schemas = Object.create(null);
  // walk through the definitions of the given CSN and expose types where needed
  forEachDefinition(csn, (def, defName, propertyName, path) => {
    // we do expose types only for definition from inside services
    const serviceName = whatsMyServiceName(defName, false);
    if (serviceName) {
      if (['type', 'entity', 'view'].includes(def.kind)) {
        forEachMember(def, (element, elementName, propertyName, path) => {
          if (['elements', 'params'].includes(propertyName)) {
            const artificialtName = `${isMultiSchema ?
              defNameWithoutServiceOrContextName(defName, serviceName)
              : defNameWithoutServiceOrContextName(defName, serviceName).replace(/\./g, '_')}_${elementName}`;
            exposeTypeOf(element, element.key || propertyName === 'params', elementName, defName, serviceName, artificialtName, path);
          }
        }, path);
      }

      // For exposed actions and functions that use non-exposed or anonymous structured types, create
      // artificial exposing types.
      // unbound actions
      if (def.kind === 'action' || def.kind === 'function') {
        exposeTypesOfAction(def, defName, defName, serviceName, path);
      }
      // bound actions
      def.actions && Object.entries(def.actions).forEach(([actionName, action]) => {
        exposeTypesOfAction(action, `${defName}_${actionName}`, defName, serviceName, path.concat(['actions', actionName]));
      });
    }
  });

  return schemas;
  /**
   * General function used for exposing  a type of given element
   * @param {object} node
   * @param {string} memberName
   * @param {string} service
   * @param {string} artificialName
   * @param {CSN.Path} path
   */
  function exposeTypeOf(node, isKey, memberName, defName, service, artificialName, path) {
    if (isArrayed(node))
      exposeArrayOfTypeOf(node, isKey, memberName, defName, service, artificialName, path);
    else if (csnUtils.isStructured(node))
      exposeStructTypeOf(node, isKey, memberName, defName, service, artificialName, path);
  }

  /**
   * Check if a node is arrayed
   * @param {object} node
   */
  function isArrayed(node) {
    return node.items || (node.type && csnUtils.getFinalTypeDef(node.type).items);
  }

  /**
   * If an 'action' uses structured types as parameters or return values that are not exposed in 'service'
   * (because the types are anonymous or have a definition outside of 'service'),
   * create equivalent types in 'service' and make 'action' use them instead,
   * @param {Object} action
   * @param {String} actionName
   * @param {String} service
   */
  function exposeTypesOfAction(action, actionName, defName, service, path) {
    if (action.returns) {
      const artificialName = `return_${actionName.replace(/\./g, '_')}`;
      exposeTypeOf(action.returns, false, actionName, defName, service, artificialName, path.concat(['returns']));
    }

    action.params && Object.entries(action.params).forEach(([paramName, param]) => {
      const artificialName = `param_${actionName.replace(/\./g, '_')}_${paramName}`;
      exposeTypeOf(param, false, actionName, defName, service, artificialName, path.concat(['params', paramName]));
    });
  }

  /**
   * If 'node' exists and has a structured type that is not exposed in 'service', (because the type is anonymous or
   * has a definition outside of 'service'), create an equivalent type in 'service' and assign the new type
   * for a value of the 'node.type' property.
   * @param {Object} node
   * @param {String} memberName
   * @param {String} service
   * @param {String} artificialName
   */
  function exposeStructTypeOf(node, isKey, memberName, defName, service, artificialName, path, parentName) {
    if (node.items) exposeStructTypeOf(node.items, isKey, memberName, defName, service, artificialName, path);

    // start conservative, assume we're in a named type
    let isAnonymous = false;

    if (isExposableStructure(node)) {
      let typeDef = node.type ? csnUtils.getCsnDef(node.type) : /* structure|anonymous type */ node;
      let newTypeId = node.type ? `${isMultiSchema ? node.type : node.type.replace(/\./g, '_')}` : artificialName;
      let newTypeFullName =
        isMultiSchema
          ? node.type ? getTypeNameInMultiSchema(node.type, service) : getAnonymousTypeNameInMultiSchema(artificialName, parentName || defName)
          : `${service}.${newTypeId}`;

      // With the redirection of sub elements, the element which is of named type with an association is now expanded and contains the association
      // and the new target. Consequently, we now have both type and elements properties in this case, and the elements should be taken as a priority
      // as the correct target is there and no longer in the type definition
      let newTypeElements = (node.type && node.elements) ? node.elements : typeDef.elements;
      // if node and typeDef are identical, we're anonymous
      isAnonymous = node === typeDef;
      // if we've left the anonymous world, we're no longer in a key def
      if (!isAnonymous)
        isKey = false;

      let newType = exposeStructType(newTypeFullName, newTypeElements, memberName, path);
      if (!newType) {
        // Error already reported
        return;
      }

      if (node.$location) setProp(newType, '$location', node.$location);
      setProp(newType, '$exposedBy', 'typeExposure');

      // Recurse into elements of 'type' (if any) and expose them as well (is needed)
      newType.elements && Object.entries(newType.elements).forEach(([elemName, newElem]) => {
        if (node.elements && node.elements[elemName].$location) setProp(newElem, '$location', node.elements[elemName].$location);
        exposeStructTypeOf(newElem,
          isKey,
          memberName,
          typeDef.kind === 'type' ? node.type : defName,
          service,
          isMultiSchema ? `${newTypeFullName}_${elemName}` : `${newTypeId}_${elemName}`,
          path,
          newTypeFullName);
      });
      typeDef.kind === 'type' ? copyAnnotations(typeDef, newType) : copyAnnotations(node, newType);
      delete node.elements;
      node.type = newTypeFullName;
    }

    /**
     * Returns whether the 'node' is for exposing the in service.
     * There are 2 cases when we would like to expose a type is the service:
     *  1. If the node is of user-defined type which is not part of the service
     *  2. When we have structured element (the object has property 'elements')
     * @param {Object} node
     */
    function isExposableStructure(node) {
      let finalNodeType = node.type ? csnUtils.getFinalType(node.type) : undefined;
      return finalNodeType && isArtifactInService(finalNodeType, service)
        ? false
        : csnUtils.isStructured(node);
    }

    /**
     * Calculate the new type name that will be exposed in multi schema,
     * in case that the element has a named type.
     *
     * @param {string} typeName type of the element
     * @param {string} service current service name
     */
    function getTypeNameInMultiSchema(typeName, service) {
      const typeService = whatsMyServiceName(typeName);
      if (typeService) {
        // new type name without any prefixes
        const typePlainName = defNameWithoutServiceOrContextName(typeName, typeService);
        const newSchemaName = `${service}.${typeService}`;
        createSchema(newSchemaName);
        // return the new type name
        return `${newSchemaName}.${typePlainName.replace(/\./g, '_')}`;
      } else {
        const typeContext = csnUtils.getContextOfArtifact(typeName);
        const typeNamespace = csnUtils.getNamespaceOfArtifact(typeName);
        const newSchemaName = `${service}.${typeContext || typeNamespace || 'root'}`;
        // new type name without any prefixes
        const typePlainName = typeContext ? defNameWithoutServiceOrContextName(typeName, typeContext)
          : typeName.replace(`${typeNamespace}.`, '');
        createSchema(newSchemaName);
        // return the new type name
        return `${newSchemaName}.${typePlainName.replace(/\./g, '_')}`;
      }
    }

    /**
     * Calculate the new type name that will be exposed in multi schema,
     * in case that the element has an anonymous type.
     *
     * @param {string} typeName type of the element
     * @param {string} parentName name of the parent def holding the element
     */
    function getAnonymousTypeNameInMultiSchema(typeName, parentName) {
      let currPrefix = parentName.substring(0, parentName.lastIndexOf('.'));
      const newSchemaName = currPrefix || 'root';
      // new type name without any prefixes
      const typePlainName = defNameWithoutServiceOrContextName(typeName, newSchemaName);

      createSchema(newSchemaName);
      return `${newSchemaName}.${typePlainName.replace(/\./g, '_')}`;
    }

    /**
     * Tf does not exists, create a context with the given name in the CSN
     * @param {string} name
     */
    function createSchema(name) {
      schemas[`${name}`] = { kind: 'schema', name };
    }

    /**
     * Expose a new type definition in the 'definitions' of the CSN and return that type(reusing such a type
     * if it already exists).
     * The new type has name 'typeName', elements which are 'elements'.
     * 'parentName' is used for error reporting.x
     * @param {String} typeName
     * @param {Object} elements
     * @param {String} parentName
     */
    function exposeStructType(typeName, elements, parentName, path) {
      // If type already exists, reuse it (complain if not created here)
      let type = csn.definitions[typeName];
      if (type) {
        if (!exposedStructTypes.includes(typeName)) {
          error(null, path, `Cannot create artificial type "${typeName}" for "${parentName}" because the name is already used`);
          return null;
        }
        return type;
      }

      // Create a type with empty elements
      type = {
        kind: 'type',
        elements: Object.create(null),
      };

      // Duplicate the type's elements
      Object.entries(elements).forEach(([elemName, element]) => {
        if (type.elements[elemName]) {
          const path = ['definitions', typeName, 'elements', elemName];
          error(null, path, `"${elemName}": Element name conflicts with existing element`);
        }
        let cloned = cloneCsn(element, options);
        // if this was an anonymous sub element of a key, mark it as not nullable
        if(isAnonymous && isKey && !cloned.key && cloned.notNull === undefined)
          cloned.notNull = true;
        type.elements[elemName] = cloned;
      });

      // add to the CSN
      csn.definitions[typeName] = type;
      // store typeName in set of exposed struct types
      exposedStructTypes.push(typeName);
      return type;
    }
  }


  // If a member is of type "array of <named type|anonymous type>", we expose the arrayed type,
  // like we expose structures in structured mode
  function exposeArrayOfTypeOf(node, isKey, memberName, defName, service, artificialName, path) {
    // if anonymously defined in place -> we always expose the type
    // this would be definition like 'elem: array of { ... }'
    // and we use the artificial name for the new type name
    if (node.items && !node.type) {
      exposeStructTypeOf(node.items, isKey, memberName, defName, service, artificialName, path.concat('items'));
    }
    // we can have both of the 'type' and 'items' in the cases:
    // 1. 'elem: Foo' and 'type Foo: array of Baz' and 'type Baz: { ... }'
    // or 2. 'elem: Foo' and type Foo: array of Integer|String|...'
    else if (node.type) {
      let finalType = csnUtils.getFinalTypeDef(node.type);
      if (finalType.items) {
        if (!isArtifactInService(node.type, service)) {
          let typeId = `${service}.${node.type.replace(/\./g, '_')}`;
          let newType = exposeArrayedType(node.items || finalType.items, typeId);
          // When we have in the model something like:
          // type Foo: array of Bar; type Bar: { qux: Integer };
          // In the type Foo we expand the first level of elements of the items like we have in CDL this:
          // type Foo: array of { qux: Integer };
          expandFirstLevelOfArrayed(newType);
          node.type = typeId;
        }
        // case 1. - as we keep the type property, the items property is removed
        if (node.items) delete node.items;
      }
    }

    function exposeArrayedType(items, typeId) {
      let newType = csn.definitions[typeId];
      if (newType) {
        if (!exposedStructTypes.includes(typeId)) {
          error(null, newType.$path, `Cannot create artificial type "${typeId}" because the name is already used`);
        }
        return newType;
      }
      // create empty type
      newType = {
        kind: 'type',
        items: Object.create(null),
      }

      // copy over the items
      newType.items = cloneCsn(items, options);
      csn.definitions[typeId] = newType;
      exposedStructTypes.push(typeId);
      return newType;
    }
  }

  // In case we have in the model something like:
  // type Foo: array of Bar; type Bar: { qux: Integer };
  // In the type Foo we expand the first level of elements of the items like we have in CDL this:
  // type Foo: array of { qux: Integer };
  function expandFirstLevelOfArrayed(def) {
    if (def.items.type && !isBuiltinType(def.items.type)) {
      let finalType = csnUtils.getFinalTypeDef(def.items.type);
      if (csnUtils.isStructured(finalType)) {
        if (!def.items.elements) def.items.elements = cloneCsnDictionary(finalType.elements, options);
        delete def.items.type;
      }
    }
  }
}

module.exports = typesExposure;
