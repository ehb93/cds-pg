'use strict'

const cds = require('../../../../../../cds')

const commons = require('../../odata-commons')
const PrimitiveValueDecoder = commons.utils.PrimitiveValueDecoder
const JsonContentTypeInfo = commons.format.JsonContentTypeInfo
const JsonAnnotations = commons.format.JsonFormat.Annotations
const EdmTypeKind = commons.edm.EdmType.TypeKind
const EdmPrimitiveTypeKind = commons.edm.EdmPrimitiveTypeKind
const UriResource = commons.uri.UriResource
const ExpandItem = commons.uri.ExpandItem
const UriParser = commons.uri.UriParser
const UriInfo = commons.uri.UriInfo
const FullQualifiedName = commons.FullQualifiedName
const DeserializationError = require('../errors/DeserializationError')

const odataAnnotations = new Map().set(JsonAnnotations.CONTEXT)

/**
 * This class deserializes and converts a provided payload into an OData object payload.
 * All primitive values are converted into the corresponding OData values; e.g.,
 * a binary property will be converted into a Buffer instance.
 */
class ResourceJsonDeserializer {
  /**
   * Creates an instance of ResourceJsonDeserializer.
   * @param {Edm} edm the current EDM instance
   * @param {JsonContentTypeInfo} [formatParams] JSON format parameters
   */
  constructor (edm, formatParams = new JsonContentTypeInfo()) {
    this._edm = edm
    this._decoder = new PrimitiveValueDecoder().setJsonFormatParameters(formatParams)
  }

  /**
   * Deserializes a provided JSON payload string of an entity.
   * @param {EdmType} edmType the EDM type of the entity
   * @param {string} value the JSON data string to deserialize
   * @param {ExpandItem[]} expand the current expand items
   * @param {Object} additionalInformation additional information to be set in the deserializer
   * @returns {Object} the deserialized result
   * @throws {DeserializationError} if provided data can not be deserialized
   */
  deserializeEntity (edmType, value, expand, additionalInformation) {
    try {
      let data = JSON.parse(value)
      this._deserializeStructuralType(edmType, data, null, false, expand, additionalInformation)
      return data
    } catch (e) {
      if (e instanceof DeserializationError) throw e
      throw new DeserializationError('An error occurred during deserialization of the entity.', e)
    }
  }

  /**
   * Deserializes a provided JSON payload string of an entity collection.
   * @param {EdmType} edmType the EDM type of the entity collection
   * @param {string|Object[]} value the JSON data string to deserialize
   * @param {ExpandItem[]} expand the array expand items will be created in
   * @param {Object} additionalInformation additional information to be set in the deserializer
   * @returns {Object[]} the deserialized result
   * @throws {DeserializationError} if provided data can not be deserialized
   */
  deserializeEntityCollection (edmType, value, expand, additionalInformation) {
    let tempData = JSON.parse(value)
    if (typeof tempData !== 'object') {
      throw new DeserializationError('Value for the collection must be an object.')
    }

    const wrongName = Object.keys(tempData).find(name => !odataAnnotations.has(name) && name !== 'value')
    if (wrongName) throw new DeserializationError("'" + wrongName + "' is not allowed in a collection value.")

    tempData = tempData.value
    if (!Array.isArray(tempData)) {
      throw new DeserializationError("Input must be a collection of type '" + edmType.getFullQualifiedName() + "'.")
    }

    try {
      for (let entityValue of tempData) {
        this._deserializeStructuralType(edmType, entityValue, [], false, expand, additionalInformation)
      }
      return tempData
    } catch (e) {
      if (e instanceof DeserializationError) throw e
      throw new DeserializationError('An error occurred during deserialization of the collection.', e)
    }
  }

  /**
   * Deserializes a provided JSON payload string of a complex property.
   * @param {EdmProperty} edmProperty the EDM property of this complex property
   * @param {string} propertyValue the JSON data string to deserialize
   * @returns {Object} the deserialized result
   * @throws {DeserializationError} if provided data can not be deserialized
   */
  deserializeComplexProperty (edmProperty, propertyValue) {
    return this.deserializeEntity(edmProperty.getType(), propertyValue)
  }

  /**
   * Deserializes a provided JSON payload string of a complex property collection.
   * @param {EdmProperty} edmProperty the EDM property of this complex property collection
   * @param {string} propertyValue the JSON data string
   * @returns {Object[]} The deserialized result
   * @throws {DeserializationError} if provided data can not be deserialized
   */
  deserializeComplexPropertyCollection (edmProperty, propertyValue) {
    return this.deserializeEntityCollection(edmProperty.getType(), propertyValue)
  }

  /**
   * Deserializes a provided JSON payload string of a primitive property.
   * @param {EdmProperty} edmProperty the EDM property of this primitive property
   * @param {string} propertyValue the JSON data string to deserialize
   * @returns {?(number|string|boolean|Buffer|Object)} the deserialized result
   * @throws {DeserializationError} if provided data can not be deserialized
   */
  deserializePrimitiveProperty (edmProperty, propertyValue) {
    let tempData = JSON.parse(propertyValue)
    if (typeof tempData !== 'object') {
      throw new DeserializationError('Value for primitive property must be an object.')
    }
    const wrongName = Object.keys(tempData).find(name => !odataAnnotations.has(name) && name !== 'value')
    if (wrongName) throw new DeserializationError(`'${wrongName}' is not allowed in a primitive value.`)

    tempData = tempData.value
    if (tempData === undefined) throw new DeserializationError('Value can not be omitted.')
    try {
      return this._deserializePrimitive(edmProperty, tempData)
    } catch (e) {
      if (e instanceof DeserializationError) throw e
      throw new DeserializationError('An error occurred during deserialization of the property.', e)
    }
  }

  /**
   * Deserializes a provided JSON payload string of a primitive property collection.
   * @param {EdmProperty} edmProperty the EDM property of this primitive property collection
   * @param {string} value the JSON data string to deserialize
   * @returns {number[]|string[]|boolean[]|Buffer[]|Object[]} the deserialized result
   * @throws {DeserializationError} if provided data can not be deserialized
   */
  deserializePrimitivePropertyCollection (edmProperty, value) {
    let tempData = JSON.parse(value)
    if (typeof tempData !== 'object') {
      throw new DeserializationError('Value for primitive collection property must be an object.')
    }
    const wrongName = Object.keys(tempData).find(name => !odataAnnotations.has(name) && name !== 'value')
    if (wrongName) throw new DeserializationError(`'${wrongName}' is not allowed in a primitive-collection value.`)

    tempData = tempData.value
    this._assertPropertyIsCollection(edmProperty, tempData)

    try {
      return this._deserializePrimitive(edmProperty, tempData)
    } catch (e) {
      if (e instanceof DeserializationError) throw e
      throw new DeserializationError('An error occurred during deserialization of the property.', e)
    }
  }

  /**
   * Deserializes a provided JSON payload string of an entity reference.
   * @param {EdmType} edmType the EDM type of the entity
   * @param {string} value the JSON data string to deserialize
   * @returns {UriInfo} the deserialized result
   * @throws {DeserializationError} if provided data can not be deserialized
   */
  deserializeReference (edmType, value) {
    const tempData = JSON.parse(value)
    if (typeof tempData !== 'object') throw new DeserializationError('Value for reference must be an object.')

    try {
      return this._deserializeReference(edmType, tempData)
    } catch (e) {
      if (e instanceof DeserializationError) throw e
      throw new DeserializationError('An error occurred during deserialization of the reference.', e)
    }
  }

  /**
   * Deserializes a provided JSON payload string of action parameters.
   * @param {EdmAction} edmAction the action to deserialize the payload for
   * @param {string} value the JSON data string to deserialize
   * @returns {Object} the deserialized result
   * @throws {DeserializationError} if provided data can not be deserialized
   */
  deserializeActionParameters (edmAction, value) {
    let data
    let result = {}

    let parameters = Array.from(edmAction.getParameters())
    // Skip the first parameter if the action is bound
    // because the first parameter of a bound action is the binding parameter
    // which is not part of the payload data.
    if (edmAction.isBound()) parameters.shift()

    for (const [paramName, edmParam] of parameters) {
      if ((value === null || value === undefined) && !edmParam.isNullable()) {
        throw new DeserializationError(`Parameter '${paramName}' is not nullable but payload is null`)
      } else if (!data) {
        data = JSON.parse(value)
        if (typeof data !== 'object') {
          throw new DeserializationError('Value for action parameters must be an object.')
        }
      }

      let paramValue = data[paramName]
      if (paramValue === undefined) {
        // OData JSON Format Version 4.0 Plus Errata 03 - 17 Action Invocation:
        // "Any parameter values not specified in the JSON object are assumed to have the null value."
        //
        // Set the value to null because further algorithm asserts nullable values already.
        // Therefore the value must be null, not undefined.
        paramValue = null
      }
      this._assertPropertyIsCollection(edmParam, paramValue)

      const edmType = edmParam.getType()
      switch (edmType.getKind()) {
        case EdmTypeKind.PRIMITIVE:
        case EdmTypeKind.ENUM:
        case EdmTypeKind.DEFINITION:
          result[paramName] = this._deserializePrimitive(edmParam, paramValue)
          break
        case EdmTypeKind.COMPLEX:
        case EdmTypeKind.ENTITY: // Both are structured types.
          this._deserializeComplex(edmParam, paramValue, [], [])
          result[paramName] = paramValue
          break
        default:
          throw new DeserializationError(
            `Could not deserialize parameter '${paramName}'. EdmTypeKind '${edmType.getKind()}' is invalid.`
          )
      }
    }

    const names = data ? Object.keys(data) : []
    const wrongParameter = names.find(name => !parameters.some(p => p[0] === name))
    if (wrongParameter) {
      throw new DeserializationError(
        `'${wrongParameter}' is not a non-binding parameter of action '${edmAction.getName()}'.`
      )
    }

    return result
  }

  /**
   * Deserializes a value for a structural type with its properties.
   * @param {EdmEntityType|EdmComplexType} edmType the EDM type of the provided value
   * @param {Object} structureValue the structural object to deserialize
   * @param {?(EdmProperty[])} nesting the complex properties the object is nested in
   * @param {boolean} isDelta whether the structural object is inside a delta annotation
   * @param {ExpandItem[]} expand The current expand items
   * @param {Object} additionalInformation additional information to be set in the deserializer
   * @throws {DeserializationError} if provided data can not be deserialized
   * @private
   */
  _deserializeStructuralType (edmType, structureValue, nesting, isDelta, expand, additionalInformation) {
    if (typeof structureValue !== 'object' || Array.isArray(structureValue)) {
      throw new DeserializationError('Value for structural type must be an object.')
    }

    for (const [name, value] of Object.entries(structureValue)) {
      if (name.includes('@')) {
        this._deserializeAnnotation(
          edmType,
          structureValue,
          name,
          value,
          nesting !== null,
          isDelta,
          additionalInformation
        )
      } else {
        const edmProperty = edmType.getProperty(name)
        this._assertPropertyExists(edmProperty, edmType, name)
        this._assertPropertyIsCollection(edmProperty, value)

        let structValue = structureValue
        const propertyType = edmProperty.getEntityType ? edmProperty.getEntityType() : edmProperty.getType()

        // REVISIT: unofficial!!!
        // !propertyType && cds.env.odata.asProvided -> just use the provided value
        if (!propertyType && cds.env.odata.asProvided) {
          continue
        }

        switch (propertyType.getKind()) {
          case EdmTypeKind.COMPLEX:
            this._deserializeComplex(
              edmProperty,
              value,
              (nesting || []).concat(edmProperty),
              expand,
              additionalInformation
            )
            break
          case EdmTypeKind.ENTITY:
            this._deserializeNavigation(edmProperty, value, nesting || [], expand, additionalInformation)
            break
          default:
            structValue[name] = this._deserializePrimitive(edmProperty, value)
            break
        }
      }
    }
  }

  /**
   * Deserializes an annotation.
   * @param {EdmEntityType|EdmComplexType} edmType the EDM type of the structure the annotation is part of
   * @param {Object} outerValue the structure the annotation is part of
   * @param {string} name the name of the annotation
   * @param {?(string|string[]|Object|Object[])} value the value of the annotation
   * @param {boolean} isNested whether the structural object is nested in another object
   * @param {boolean} isDelta whether the structural object is inside a delta annotation
   * @param {Object} additionalInformation additional information to be set in the deserializer
   * @throws {DeserializationError} if provided data can not be deserialized
   * @private
   */
  _deserializeAnnotation (edmType, outerValue, name, value, isNested, isDelta, additionalInformation) {
    let structureValue = outerValue

    if (name === JsonAnnotations.CONTEXT && !isNested) {
      // Context URL is allowed only in outermost structure.
    } else if (name === JsonAnnotations.ID && edmType.getKind() === EdmTypeKind.ENTITY) {
      if (value !== null) structureValue[name] = this._parseEntityUri(edmType, value)
    } else if (name.endsWith(JsonAnnotations.TYPE)) {
      // Validate that the type specified in the annotation is exactly the type declared in the EDM.
      const propertyName = name.substring(0, name.length - JsonAnnotations.TYPE.length)
      let expectedType = edmType
      let isCollection = false
      if (propertyName) {
        const edmProperty = edmType.getProperty(propertyName)
        this._assertPropertyExists(edmProperty, edmType, propertyName)
        expectedType = edmProperty.getType ? edmProperty.getType() : edmProperty.getEntityType()
        isCollection = edmProperty.isCollection()
      }
      const expectedTypeName =
        expectedType.getKind() === EdmTypeKind.PRIMITIVE ? expectedType.getName() : expectedType.getFullQualifiedName()
      const typeName =
        typeof value === 'string' &&
        value.startsWith(isCollection ? '#Collection(' : '#') &&
        value.endsWith(isCollection ? ')' : '')
          ? value.substring(isCollection ? 12 : 1, value.length - (isCollection ? 1 : 0))
          : null
      // The type name could be an alias-qualified name; for that case we have to do an EDM look-up.
      const fullQualifiedName =
        typeName && typeName.indexOf('.') > 0 && typeName.lastIndexOf('.') < typeName.length - 1
          ? FullQualifiedName.createFromNameSpaceAndName(typeName)
          : null
      if (
        typeName !== expectedTypeName &&
        (!fullQualifiedName ||
          (this._edm.getEntityType(fullQualifiedName) ||
            this._edm.getComplexType(fullQualifiedName) ||
            this._edm.getEnumType(fullQualifiedName) ||
            this._edm.getTypeDefinition(fullQualifiedName)) !== expectedType)
      ) {
        throw new DeserializationError(
          "The value of '" + name + "' must describe correctly the type '" + expectedType.getFullQualifiedName() + "'."
        )
      }
    } else if (name.endsWith(JsonAnnotations.BIND) && !isDelta) {
      const navigationPropertyName = name.substring(0, name.length - JsonAnnotations.BIND.length)
      const edmNavigationProperty = edmType.getNavigationProperty(navigationPropertyName)
      this._assertPropertyExists(edmNavigationProperty, edmType, navigationPropertyName)
      this._assertPropertyIsCollection(edmNavigationProperty, value)
      this._assertPropertyNullable(edmNavigationProperty, value)
      const edmEntityType = edmNavigationProperty.getEntityType()
      structureValue[name] = Array.isArray(value)
        ? value.map(uri => this._parseEntityUri(edmEntityType, uri))
        : this._parseEntityUri(edmEntityType, value)
    } else if (name.endsWith(JsonAnnotations.DELTA)) {
      const navigationPropertyName = name.substring(0, name.length - JsonAnnotations.DELTA.length)
      this._deserializeDelta(edmType, navigationPropertyName, value, additionalInformation)
      additionalInformation.hasDelta = true // eslint-disable-line no-param-reassign
    } else if (name === JsonAnnotations.REMOVED && isDelta) {
      if (
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length > 1 ||
        (Object.keys(value).length === 1 && value.reason !== 'changed' && value.reason !== 'deleted')
      ) {
        throw new DeserializationError(
          "The value of '" +
            JsonAnnotations.REMOVED +
            "' must be an object with an " +
            "optional property 'reason' with value 'changed' or 'deleted'."
        )
      }
      if (
        !structureValue[JsonAnnotations.ID] &&
        !Array.from(edmType.getKeyPropertyRefs().keys()).every(keyName => structureValue[keyName])
      ) {
        throw new DeserializationError("'" + JsonAnnotations.REMOVED + "' must identify an entity.")
      }
    } else {
      throw new DeserializationError("Annotation '" + name + "' is not supported.")
    }
  }

  /**
   * Deserializes a navigation property and fills an expand item for deep inserts.
   * @param {EdmNavigationProperty} edmProperty the EDM navigation property to deserialize
   * @param {Object|Object[]} value the value of the navigation property
   * @param {EdmProperty[]} nesting the complex properties the navigation property is nested in
   * @param {ExpandItem[]} expandArray the current expand items
   * @param {Object} additionalInformation additional information to be set in the deserializer
   * @private
   */
  _deserializeNavigation (edmProperty, value, nesting, expandArray, additionalInformation) {
    this._assertPropertyNullable(edmProperty, value)
    if (value === null) return

    let currentExpandItem = expandArray.find(expandItem => {
      const segments = expandItem.getPathSegments()
      return segments.every((segment, index) =>
        index < segments.length - 1
          ? segment.getProperty() === nesting[index]
          : segment.getNavigationProperty() === edmProperty
      )
    })
    if (!currentExpandItem) {
      currentExpandItem = this._createExpandItem(nesting, edmProperty)
      expandArray.push(currentExpandItem)
    }

    const type = edmProperty.getEntityType()

    let newExpandOptionArray = []
    if (edmProperty.isCollection()) {
      for (let entity of value) {
        this._deserializeStructuralType(type, entity, [], false, newExpandOptionArray, additionalInformation)
      }
    } else {
      this._deserializeStructuralType(type, value, [], false, newExpandOptionArray, additionalInformation)
    }

    let innerExpandItems = currentExpandItem.getOption(UriInfo.QueryOptions.EXPAND) || []
    for (const newExpand of newExpandOptionArray) innerExpandItems.push(newExpand)
    if (innerExpandItems.length) currentExpandItem.setOption(UriInfo.QueryOptions.EXPAND, innerExpandItems)
  }

  /**
   * Deserializes a primitive and primitive collection value.
   * @param {EdmProperty} edmProperty the EDM property of this primitive value
   * @param {?(number|string|boolean|Object|Array)} propertyValue the JSON value
   * @returns {?(number|string|boolean|Buffer|Object|Array)} the deserialized result
   * @throws {DeserializationError} if provided data can not be deserialized
   * @private
   */
  _deserializePrimitive (edmProperty, propertyValue) {
    // OASIS issue 1177: "Streams that are annotated as the application/json media type [...]
    // are represented as native JSON in JSON requests and responses [...]
    // The odata.mediaContentType control information is only necessary if the embedded JSON happens to be a
    // JSON string, in all other cases it can be heuristically determined that the stream value is JSON."
    // TODO: Check that JSON is an acceptable media type for this stream property.
    // TODO: Validate the JSON content against the JSON schema if there is one in the metadata.
    let type = edmProperty.getType()
    if (type.getKind() === EdmTypeKind.DEFINITION) type = type.getUnderlyingType()
    if (type === EdmPrimitiveTypeKind.Stream) return propertyValue
    return edmProperty.isCollection()
      ? propertyValue && propertyValue.map(value => this._decoder.decodeJson(value, edmProperty))
      : this._decoder.decodeJson(propertyValue, edmProperty)
  }

  /**
   * Deserializes a complex and complex collection value.
   * @param {EdmProperty} edmProperty the EDM property of this complex value
   * @param {?(Object|Object[])} propertyValue the JSON value
   * @param {EdmProperty[]} nesting the complex properties the complex value is nested in
   * @param {ExpandItem[]} expand the current expand items
   * @param {Object} additionalInformation additional information to be set in the deserializer
   * @throws {DeserializationError} if provided data can not be deserialized
   * @private
   */
  _deserializeComplex (edmProperty, propertyValue, nesting, expand, additionalInformation) {
    const type = edmProperty.getType()
    if (edmProperty.isCollection()) {
      for (let value of propertyValue) {
        this._assertPropertyNullable(edmProperty, value)
        if (value === null) continue
        this._deserializeStructuralType(type, value, nesting, false, expand, additionalInformation)
      }
    } else {
      this._assertPropertyNullable(edmProperty, propertyValue)
      if (propertyValue === null) return
      this._deserializeStructuralType(type, propertyValue, nesting, false, expand, additionalInformation)
    }
  }

  /**
   * Deserializes a delta annotation for a navigation property.
   * @param {EdmEntityType} edmType the EDM type of the parent entity
   * @param {string} propertyName the name of the navigation property
   * @param {any} value the value of the delta annotation of the navigation property
   * @param {Object} additionalInformation additional information to be set in the deserializer
   * @private
   */
  _deserializeDelta (edmType, propertyName, value, additionalInformation) {
    const edmNavigationProperty = edmType.getNavigationProperty(propertyName)
    this._assertPropertyExists(edmNavigationProperty, edmType, propertyName)
    if (!edmNavigationProperty.isCollection()) {
      throw new DeserializationError("'" + propertyName + "' must not have a delta annotation.")
    }
    if (!Array.isArray(value)) {
      throw new DeserializationError(
        "The value of the delta annotation of '" + propertyName + "' must be a collection."
      )
    }
    const innerEdmType = edmNavigationProperty.getEntityType()
    for (const entity of value) {
      this._deserializeStructuralType(innerEdmType, entity, [], true, [], additionalInformation)
    }
  }

  /**
   * Asserts that the provided property value is a collection if the corresponding EDM property is a collection.
   * @param {EdmProperty|EdmNavigationProperty} edmProperty the EDM property for the corresponding property value
   * @param {*} propertyValue the value of the property
   * @throws {DeserializationError} if the property value is a collection while EDM property is not and vice versa
   * @private
   */
  _assertPropertyIsCollection (edmProperty, propertyValue) {
    if (edmProperty.isCollection() && propertyValue && !Array.isArray(propertyValue)) {
      const type = edmProperty.getType ? edmProperty.getType() : edmProperty.getEntityType()
      throw new DeserializationError(
        `'${edmProperty.getName()}' must be a collection of type '${type.getFullQualifiedName()}'.`
      )
    }
    if (!edmProperty.isCollection() && Array.isArray(propertyValue)) {
      throw new DeserializationError(`'${edmProperty.getName()}' must not be a collection.`)
    }
  }

  /**
   * Asserts that the provided EDM property is defined.
   * @param {EdmProperty|EdmNavigationProperty} edmProperty the EDM property to check
   * @param {EdmType} edmType the EDM type in which the EDM property is defined
   * @param {string} propertyName the name of the property
   * @throws {DeserializationError} if the provided EDM property is not defined
   * @private
   */
  _assertPropertyExists (edmProperty, edmType, propertyName) {
    if (!edmProperty) {
      const fqn = edmType.getFullQualifiedName()
      throw new DeserializationError(`'${propertyName}' does not exist in type '${fqn}'.`)
    }
  }

  /**
   * Asserts that the provided EDM property is nullable if it has a null value.
   * @param {EdmProperty|EdmNavigationProperty} edmProperty the EDM property to check
   * @param {*} propertyValue the value of the property
   * @throws {DeserializationError} if null is not allowed
   * @private
   */
  _assertPropertyNullable (edmProperty, propertyValue) {
    if (propertyValue === null && !edmProperty.isNullable()) {
      throw new DeserializationError(
        `The property '${edmProperty.getName()}' is not nullable and must not have a null value.`
      )
    }
  }

  /**
   * Parses and checks a URI given as reference to an entity.
   * @param {EdmEntityType} edmEntityType the EDM type of the entity
   * @param {string} uri the URI
   * @returns {UriInfo} the parsed URI
   * @private
   */
  _parseEntityUri (edmEntityType, uri) {
    if (uri === null) return null
    if (typeof uri !== 'string') {
      throw new DeserializationError(
        `The reference URI for type '${edmEntityType.getFullQualifiedName()}' must be a string.`
      )
    }
    const uriInfo = new UriParser(this._edm).parseRelativeUri(uri)
    if (
      !uriInfo
        .getPathSegments()
        .every(
          segment =>
            segment.getKind() === UriResource.ResourceKind.ENTITY ||
            (segment.getKind() === UriResource.ResourceKind.NAVIGATION_TO_ONE &&
              segment.getNavigationProperty().containsTarget())
        ) ||
      uriInfo.getFinalEdmType() !== edmEntityType
    ) {
      throw new DeserializationError(
        `The reference URI '${uri}' is not suitable for type '${edmEntityType.getFullQualifiedName()}'.`
      )
    }
    return uriInfo
  }

  /**
   * Deserializes a provided entity-reference object.
   * @param {EdmType} edmType the EDM type of the entity
   * @param {Object} value the reference object to deserialize
   * @returns {UriInfo} the deserialized result
   * @throws {DeserializationError} if provided data can not be deserialized
   * @private
   */
  _deserializeReference (edmType, value) {
    const objectKeys = Object.keys(value)
    if (objectKeys.length === 0) {
      throw new DeserializationError(`Value for type '${edmType.getFullQualifiedName()}' has no properties.`)
    }

    let uriInfo
    for (const propertyName of objectKeys) {
      if (propertyName === JsonAnnotations.ID) {
        uriInfo = this._parseEntityUri(edmType, value[propertyName])
        if (uriInfo === null) {
          throw new DeserializationError(
            `The reference URI for type '${edmType.getFullQualifiedName()}' must be a string.`
          )
        }
      } else if (odataAnnotations.has(propertyName) || propertyName === JsonAnnotations.TYPE) {
        this._deserializeAnnotation(edmType, value, propertyName, value[propertyName])
      } else {
        throw new DeserializationError(`Property or annotation '${propertyName}' is not supported.`)
      }
    }
    return uriInfo
  }

  /**
   * Creates an expand item for a navigation property.
   * @param {EdmProperty[]} nesting the complex properties the navigation property is nested in
   * @param {EdmNavigationProperty} edmNavigationProperty the EDM navigation property
   * @returns {ExpandItem} the expand item
   * @private
   */
  _createExpandItem (nesting, edmNavigationProperty) {
    return new ExpandItem().setPathSegments(
      nesting
        .map(complexProperty =>
          new UriResource().setKind(UriResource.ResourceKind.COMPLEX_PROPERTY).setProperty(complexProperty)
        )
        .concat([
          new UriResource()
            .setKind(
              edmNavigationProperty.isCollection()
                ? UriResource.ResourceKind.NAVIGATION_TO_MANY
                : UriResource.ResourceKind.NAVIGATION_TO_ONE
            )
            .setNavigationProperty(edmNavigationProperty)
            .setIsCollection(edmNavigationProperty.isCollection())
        ])
    )
  }
}

module.exports = ResourceJsonDeserializer
