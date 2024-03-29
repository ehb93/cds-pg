'use strict'

const commons = require('../../odata-commons')
const validateThat = commons.validator.ParameterValidator.validateThat
const ValueValidator = commons.validator.ValueValidator
const contentTypes = commons.format.ContentTypeInfo.ContentTypes
const JsonContentTypeInfo = commons.format.JsonContentTypeInfo
const ExpandItem = commons.uri.ExpandItem
const QueryOptions = commons.uri.UriInfo.QueryOptions
const ResourceKind = commons.uri.UriResource.ResourceKind
const JsonAnnotations = commons.format.JsonFormat.Annotations
const MetaProperties = commons.format.JsonFormat.MetaProperties
const Annotations = commons.format.JsonFormat.Annotations
const EdmTypeKind = commons.edm.EdmType.TypeKind
const EdmPrimitiveTypeKind = commons.edm.EdmPrimitiveTypeKind
const UriHelper = require('../utils/UriHelper')
const NextLinkSerializer = require('./NextLinkSerializer')
const SerializationError = require('../errors/SerializationError')

/**
 * JSON serializer for OData resources such as entity, entity collection, complex property, etc.
 *
 * More information about the usage of the serializer as well as some examples can be found
 * in the JSDoc for the corresponding methods.
 */
class ResourceJsonSerializer {
  /**
   * @param {PrimitiveValueEncoder} primitiveValueEncoder the encoder for primitive values
   * @param {JsonContentTypeInfo} formatParams JSON serializing options
   */
  constructor (primitiveValueEncoder, formatParams = new JsonContentTypeInfo()) {
    validateThat('primitiveValueEncoder', primitiveValueEncoder)
      .truthy()
      .instanceOf(Object)
    validateThat('formatParams', formatParams)
      .truthy()
      .instanceOf(Object)

    this._valueValidator = new ValueValidator()
    this._encoder = primitiveValueEncoder.setJsonFormatParameters(formatParams)
  }

  /**
   * Serializes entity to OData JSON string.
   * The entity data must be represented as a plain object with property-value pairs.
   * The names and the number of the properties must correspond to the ones in the entity type.
   * Property names must be specified as strings.
   * Property values must correspond to the EDM types of the corresponding entity type properties.
   * Value for a complex property must be specified as an object.
   * Value for a collection property must be specified as an array.
   * @param {EdmEntityType|EdmEntitySet|EdmSingleton} entityTypeOrSet type or entity set or singleton of the entity
   * @param {Object} data entity data
   * @param {SelectItem[]} selectItems select items from $select
   * @param {ExpandItem[]} expandItems expand items from $expand
   * @param {boolean} eTagRequired true if an ETag is required
   * @param {string} odataPath the path from the OData service root
   * @returns {string} entity, serialized in OData JSON format
   */
  serializeEntity (entityTypeOrSet, data, selectItems, expandItems, eTagRequired, odataPath) {
    validateThat('entityTypeOrSet', entityTypeOrSet)
      .truthy()
      .instanceOf(Object)
    validateThat('data', data)
      .truthy()
      .typeOf('object')

    try {
      let serializedAnnotations = this._serializeAnnotations(
        [MetaProperties.CONTEXT],
        data.value,
        MetaProperties.CONTEXT,
        MetaProperties.METADATA_ETAG
      )

      const selectedPaths = this._getSelectedPaths(selectItems, expandItems)
      const serializedEntity = this._serializeEntity(
        entityTypeOrSet,
        data.value,
        selectedPaths,
        expandItems,
        eTagRequired,
        true,
        odataPath
      )

      return JSON.stringify(Object.assign(serializedAnnotations, serializedEntity))
    } catch (error) {
      throw this._createError('An error occurred during serialization of the entity.', error)
    }
  }

  /**
   * Serializes entity collection to OData JSON string.
   * @param {EdmEntityType|EdmEntitySet} entityTypeOrSet - entity type or set for the entities in the collection
   * @param {Array} data - entity collection data, represented by an array of objects. The structure of the objects
   * in the array must correspond to the one, required by the serializeEntity() method.
   * @param {SelectItem[]} selectItems - select items from $select
   * @param {ExpandItem[]} expandItems - expand items from $expand
   * @param {boolean} eTagRequired true if an ETag is required
   * @param {string} odataPath the path from the OData service root
   * @returns {string} entity collection, serialized in OData JSON format
   */
  serializeEntityCollection (entityTypeOrSet, data, selectItems, expandItems, eTagRequired, odataPath) {
    validateThat('entityTypeOrSet', entityTypeOrSet)
      .truthy()
      .instanceOf(Object)
    validateThat('data', data)
      .truthy()
      .typeOf('object')
    validateThat('data.value', data.value)
      .truthy()
      .array()

    try {
      const selectedPaths = this._getSelectedPaths(selectItems, expandItems)

      let serializedEntityCollection = Object.assign(
        this._serializeAnnotations(
          [MetaProperties.CONTEXT],
          data,
          MetaProperties.CONTEXT,
          MetaProperties.METADATA_ETAG,
          MetaProperties.COUNT
        ),
        this._serializeOperationAdvertisement(data)
      )

      serializedEntityCollection.value = this._serializeCollectionEntities(
        entityTypeOrSet,
        data.value,
        selectedPaths,
        expandItems,
        eTagRequired,
        entityTypeOrSet.isReduced === undefined,
        odataPath
      )
      serializedEntityCollection = Object.assign(
        serializedEntityCollection,
        this._serializeAnnotations([], data, MetaProperties.NEXT_LINK)
      )

      return JSON.stringify(serializedEntityCollection)
    } catch (error) {
      throw this._createError('An error occurred during serialization of the entity collection.', error)
    }
  }

  /**
   * Serialize a primitive-type value to an OData JSON string.
   * @param {(EdmProperty|EdmReturnType)} propertyOrReturnType EDM property or EDM return type
   * @param {?(Object|string|number|boolean)} data the value
   * @param {boolean} eTagRequired true if an ETag is required
   * @returns {string} serialized representation in OData JSON format
   */
  serializePrimitive (propertyOrReturnType, data, eTagRequired) {
    validateThat('propertyOrReturnType', propertyOrReturnType)
      .truthy()
      .instanceOf(Object)
    validateThat('data', data).truthy()

    try {
      let serializedAnnotations = this._serializeAnnotations(
        [MetaProperties.CONTEXT],
        data,
        MetaProperties.CONTEXT,
        MetaProperties.METADATA_ETAG
      )
      if (eTagRequired) {
        serializedAnnotations = Object.assign(
          serializedAnnotations,
          this._serializeAnnotations([MetaProperties.ETAG], data, MetaProperties.ETAG)
        )
      }

      serializedAnnotations.value =
        data.value === null || data.value === undefined
          ? this._serializeNullValue(propertyOrReturnType)
          : this._encoder.encodeJson(data.value, propertyOrReturnType)

      return JSON.stringify(serializedAnnotations)
    } catch (error) {
      throw this._createError('An error occurred during serialization of the primitive value.', error)
    }
  }

  /**
   * Serialize a primitive-type collection value to an OData JSON string.
   * @param {(EdmProperty|EdmReturnType)} propertyOrReturnType EDM property or EDM return type
   * @param {?Array} data the collection value as Array
   * @param {boolean} eTagRequired true if an ETag is required
   * @returns {string} serialized representation in OData JSON format
   */
  serializePrimitiveCollection (propertyOrReturnType, data, eTagRequired) {
    validateThat('propertyOrReturnType', propertyOrReturnType)
      .truthy()
      .instanceOf(Object)
    validateThat('data', data)
      .truthy()
      .typeOf('object')

    try {
      let result = this._serializeAnnotations(
        [MetaProperties.CONTEXT],
        data,
        MetaProperties.CONTEXT,
        MetaProperties.METADATA_ETAG,
        MetaProperties.COUNT
      )
      if (eTagRequired) {
        result = Object.assign(result, this._serializeAnnotations([MetaProperties.ETAG], data, MetaProperties.ETAG))
      }

      result.value = []
      if (data.value !== null && data.value !== undefined) {
        validateThat('data.value', data.value).array()
        result.value = data.value.map(valueItem => {
          if (valueItem === undefined) throw new SerializationError('Missing primitive value')
          return valueItem === null
            ? this._serializeNullValue(propertyOrReturnType)
            : this._encoder.encodeJson(valueItem, propertyOrReturnType)
        })
      }
      return JSON.stringify(Object.assign(result, this._serializeAnnotations([], data, MetaProperties.NEXT_LINK)))
    } catch (error) {
      throw this._createError('An error occurred during serialization of the primitive collection value.', error)
    }
  }

  /**
   * Serialize a complex-type value to an OData JSON string.
   * @param {(EdmProperty|EdmReturnType)} propertyOrReturnType EDM property or EDM return type
   * @param {?Object} data the value
   * @param {SelectItem[]} selectItems select items from $select
   * @param {ExpandItem[]} expandItems expand items from $expand
   * @param {boolean} eTagRequired true if an ETag is required
   * @param {string} odataPath the path from the OData service root
   * @param {UriResource[]} complexPropertyPath final path segments with complex properties plus the one before
   * @returns {string} serialized representation in OData JSON format
   */
  serializeComplex (
    propertyOrReturnType,
    data,
    selectItems,
    expandItems,
    eTagRequired,
    odataPath,
    complexPropertyPath
  ) {
    validateThat('propertyOrReturnType', propertyOrReturnType)
      .truthy()
      .instanceOf(Object)
    validateThat('data', data).truthy()

    const value = data.value

    try {
      let result = this._serializeAnnotations(
        [MetaProperties.CONTEXT],
        value || data,
        MetaProperties.CONTEXT,
        MetaProperties.METADATA_ETAG
      )
      if (eTagRequired) {
        result = Object.assign(
          result,
          this._serializeAnnotations([MetaProperties.ETAG], value || data, MetaProperties.ETAG)
        )
      }

      if (value === null || value === undefined) {
        this._serializeNullValue(propertyOrReturnType)
      } else {
        const type = propertyOrReturnType.getType()
        const entitySetOrSingleton =
          complexPropertyPath[0].getEntitySet() ||
          complexPropertyPath[0].getSingleton() ||
          complexPropertyPath[0].getTarget()
        const complexPath = complexPropertyPath.slice(1).map(segment => segment.getPathSegmentIdentifier())
        const newExpandItems = expandItems.map(item => {
          let newItem = new ExpandItem().setPathSegments(item.getPathSegments()).setAll(item.isAll())
          for (const option of Object.values(QueryOptions)) newItem.setOption(option, item.getOption(option))
          newItem.setOption('_complexPath', complexPath)
          return newItem
        })
        Object.assign(
          result,
          this._serializeStructuralProperties(
            type,
            entitySetOrSingleton,
            value,
            odataPath,
            this._getSelectedPaths(selectItems, expandItems),
            newExpandItems,
            true
          ),
          this._serializeNavigationProperties(type, entitySetOrSingleton, value, odataPath, newExpandItems, true)
        )
      }
      return JSON.stringify(result)
    } catch (error) {
      throw this._createError('An error occurred during serialization of the complex value.', error)
    }
  }

  /**
   * Serialize a complex-type collection value to an OData JSON string.
   * @param {(EdmProperty|EdmReturnType)} propertyOrReturnType EDM property or EDM return type
   * @param {?Array} data the collection value as Array
   * @param {SelectItem[]} selectItems select items from $select
   * @param {ExpandItem[]} expandItems expand items from $expand
   * @param {boolean} eTagRequired true if an ETag is required
   * @param {string} odataPath the path from the OData service root
   * @param {UriResource[]} complexPropertyPath final path segments with complex properties plus the one before
   * @returns {string} serialized representation in OData JSON format
   */
  serializeComplexCollection (
    propertyOrReturnType,
    data,
    selectItems,
    expandItems,
    eTagRequired,
    odataPath,
    complexPropertyPath
  ) {
    validateThat('propertyOrReturnType', propertyOrReturnType)
      .truthy()
      .instanceOf(Object)
    validateThat('data', data).truthy()

    const value = data.value

    try {
      let result = this._serializeAnnotations(
        [MetaProperties.CONTEXT],
        data,
        MetaProperties.CONTEXT,
        MetaProperties.METADATA_ETAG,
        MetaProperties.COUNT
      )
      if (eTagRequired) {
        result = Object.assign(
          result,
          this._serializeAnnotations([MetaProperties.ETAG], value || data, MetaProperties.ETAG)
        )
      }

      result.value = []
      if (value !== null && value !== undefined) {
        validateThat('data.value', value).array()
        const type = propertyOrReturnType.getType()
        const entitySetOrSingleton =
          complexPropertyPath[0].getEntitySet() ||
          complexPropertyPath[0].getSingleton() ||
          complexPropertyPath[0].getTarget()
        const complexPath = complexPropertyPath.slice(1).map(segment => segment.getPathSegmentIdentifier())
        const selectedPaths = this._getSelectedPaths(selectItems, expandItems)
        const newExpandItems = expandItems.map(item => {
          let newItem = new ExpandItem().setPathSegments(item.getPathSegments()).setAll(item.isAll())
          for (const option of Object.values(QueryOptions)) newItem.setOption(option, item.getOption(option))
          newItem.setOption('_complexPath', complexPath)
          return newItem
        })
        result.value = value.map(valueItem => {
          if (valueItem === undefined) throw new SerializationError('Missing complex value')
          return valueItem === null
            ? this._serializeNullValue(propertyOrReturnType)
            : Object.assign(
              {},
              this._serializeStructuralProperties(
                type,
                entitySetOrSingleton,
                valueItem,
                odataPath,
                selectedPaths,
                newExpandItems,
                true
              ),
              this._serializeNavigationProperties(
                type,
                entitySetOrSingleton,
                valueItem,
                odataPath,
                newExpandItems,
                true
              )
            )
        })
      }
      return JSON.stringify(Object.assign(result, this._serializeAnnotations([], data, MetaProperties.NEXT_LINK)))
    } catch (error) {
      throw this._createError('An error occurred during serialization of the complex collection value.', error)
    }
  }

  /**
   * Serializes entity collection references.
   * @param {UriResource[]} pathSegments path segments of the URI of the entity
   * @param {?Array} data the collection value as Array
   * @returns {string} serialized representation in OData JSON format
   */
  serializeReferenceCollection (pathSegments, data) {
    validateThat('pathSegments', pathSegments).array()
    validateThat('data', data)
      .truthy()
      .typeOf('object')

    try {
      return JSON.stringify(
        Object.assign(
          this._serializeAnnotations(
            [MetaProperties.CONTEXT],
            data,
            MetaProperties.CONTEXT,
            MetaProperties.METADATA_ETAG,
            MetaProperties.COUNT
          ),
          { value: data.value.map(entity => this._serializeEntityReference(pathSegments, entity)) },
          this._serializeAnnotations([], data, MetaProperties.NEXT_LINK)
        )
      )
    } catch (error) {
      throw this._createError('An error occurred during serialization of the reference collection.', error)
    }
  }

  /**
   * Serializes entity reference.
   * @param {UriResource[]} pathSegments path segments of the URI of the entity
   * @param {Object} data - the collection value as Array
   * @returns {string} serialized representation in OData JSON format
   */
  serializeReference (pathSegments, data) {
    validateThat('pathSegments', pathSegments).array()
    validateThat('data', data)
      .truthy()
      .typeOf('object')

    try {
      return JSON.stringify(
        Object.assign(
          this._serializeAnnotations(
            [MetaProperties.CONTEXT],
            data.value || data,
            MetaProperties.CONTEXT,
            MetaProperties.METADATA_ETAG
          ),
          this._serializeEntityReference(pathSegments, data.value)
        )
      )
    } catch (error) {
      throw this._createError('An error occurred during serialization of the reference.', error)
    }
  }

  /**
   * Serializes entity reference.
   * @param {UriResource[]} pathSegments path segments of the URI of the entity
   * @param {Object} entity the entity the reference will be serialized for
   * @returns {Object} serialized entity reference with correct annotations
   * @private
   */
  _serializeEntityReference (pathSegments, entity) {
    // Retrieve the entity type from the segment before the last segment (the last segment is $ref).
    const entityType = pathSegments[pathSegments.length - 2].getEdmType()
    return {
      [JsonAnnotations.ID]: UriHelper.buildCanonicalUrl(
        pathSegments,
        UriHelper.buildEntityKeys(entityType, entity, this._encoder)
      )
    }
  }

  /**
   * Serializes entity collections.
   * @param {EdmEntityType|EdmEntitySet} entityTypeOrSet - entity type for the entities
   * @param {Array} entities - entities, which have to be serialized
   * @param {Array.<string[]>} selectedPaths - selected properties' paths from $select
   * @param {ExpandItem[]} expandItems - expand items from $expand
   * @param {boolean} eTagRequired true if an ETag is required
   * @param {boolean} isKeyRequired whether all key properties have to be serialized
   * @param {string} odataPath the path from the OData service root
   * @returns {Array} objects representing the serialized entities
   * @private
   */
  _serializeCollectionEntities (
    entityTypeOrSet,
    entities,
    selectedPaths,
    expandItems,
    eTagRequired,
    isKeyRequired,
    odataPath
  ) {
    const entityType = entityTypeOrSet.getEntityType ? entityTypeOrSet.getEntityType() : entityTypeOrSet
    return entities.map((currentEntity, index) => {
      try {
        return this._serializeEntity(
          entityTypeOrSet,
          currentEntity,
          selectedPaths,
          expandItems,
          eTagRequired,
          isKeyRequired,
          entityType.isReduced
            ? '' // The OData path is only used for next links which cannot appear for transient entities.
            : odataPath + UriHelper.buildKeyString(UriHelper.buildEntityKeys(entityType, currentEntity, this._encoder))
        )
      } catch (error) {
        throw new SerializationError(
          this._getErrorMsgForCollectionEntity(currentEntity, entityType.getKeyPropertyRefs().keys(), index),
          error
        )
      }
    })
  }

  /**
   * Serializes entity to OData JSON string.
   * The entity data must be represented as a plain object with property-value pairs.
   * The names and the number of the properties must correspond to the ones in the entity type.
   * Property names must be specified as strings.
   * Property values must correspond to the EDM types of the corresponding entity-type properties.
   * @param {EdmEntitySet|EdmSingleton|EdmEntityType} entityTypeOrSet entity set or singleton or type of the entity
   * @param {Object} data entity data
   * @param {Array.<string[]>} selectedPaths selected properties' paths from $select
   * @param {ExpandItem[]} expandItems expand items from $expand
   * @param {boolean} eTagRequired true, if an ETag is required
   * @param {boolean} isKeyRequired whether all key properties have to be serialized
   * @param {string} odataPath the path from the OData service root
   * @returns {Object} plain object, representing the serialized entity
   * @private
   */
  _serializeEntity (entityTypeOrSet, data, selectedPaths, expandItems, eTagRequired, isKeyRequired, odataPath) {
    const entityType = entityTypeOrSet.getEntityType ? entityTypeOrSet.getEntityType() : entityTypeOrSet
    const entitySet = entityTypeOrSet.getEntityType ? entityTypeOrSet : null

    const serializedStructProps = this._serializeStructuralProperties(
      entityType,
      entitySet,
      data,
      odataPath,
      selectedPaths,
      expandItems,
      isKeyRequired
    )
    const serializedNavProps = this._serializeNavigationProperties(
      entityType,
      entitySet,
      data,
      odataPath,
      expandItems,
      isKeyRequired
    )

    // An entity is considered transient if its entity type has been created just for this request,
    // for example from $apply, and if either some properties have been aggregated away
    // or not all of its base type's properties have been serialized.
    let isTransient = false
    if (entityType.isReduced) {
      let type = entityType
      while (type.isReduced) type = type.getBaseType()
      isTransient =
        entityType.isReduced() ||
        Array.from(type.getProperties().keys()).some(name => serializedStructProps[name] === undefined)
    }

    let serializedAnnotations =
      (eTagRequired || (entitySet && entitySet.isConcurrent())) && !isTransient
        ? this._serializeAnnotations([MetaProperties.ETAG], data, MetaProperties.ETAG)
        : {}
    // Add annotation '"@odata.id": null' for a transient entity.
    if (isTransient) serializedAnnotations[JsonAnnotations.ID] = null

    return Object.assign(
      serializedAnnotations,
      this._serializeOperationAdvertisement(data),
      serializedStructProps,
      serializedNavProps
    )
  }

  /**
   * Serializes entity annotations.
   * @param {string[]} requiredAnnotations required annotations
   * @param {Object} sourceData the data
   * @param {string[]} metaProperties meta properties to consider
   * @returns {Object} object containing the serialized annotations
   * @private
   */
  _serializeAnnotations (requiredAnnotations, sourceData, ...metaProperties) {
    let result = {}
    if (sourceData) {
      for (const metaProperty of metaProperties) {
        if (requiredAnnotations.includes(metaProperty)) this._assertAnnotationExist(metaProperty, sourceData)
        const annotation = MetaProperties.getAnnotation(metaProperty)
        result[annotation] = this._validateAnnotationValue(annotation, sourceData[metaProperty])
      }
    }
    return result
  }

  /**
   * Asserts that an annotation exists.
   * @param {string} annotation the annotation name
   * @param {Object} sourceData The data object on which the annotation should exist
   * @returns {boolean} True if annotation exists
   * @private
   */
  _assertAnnotationExist (annotation, sourceData) {
    if (sourceData && sourceData[annotation] !== undefined) return true
    throw new SerializationError(`Missing Annotation '${annotation}' in ${JSON.stringify(sourceData)}`)
  }

  /**
   * Validates and converts an OData annotation value.
   * Validates and returns the validated/converted value if it is for a supported OData annotation.
   * A value for an unsupported OData annotation will result in an error.
   * If the annotation is not an OData-defined annotation the value is returned 'as is'.
   *
   * @param {string} annotation The annotation
   * @param {*} value The value of the annotation
   * @returns {*} The value of the annotation or the converted one if it is an OData annotation
   * @throws {SerializationError} In case there is an error with converting the annotation value
   * @private
   */
  _validateAnnotationValue (annotation, value) {
    if (value === undefined) return value
    if (annotation === Annotations.COUNT) {
      // @odata.count
      try {
        const countValue = this._encoder.encodeJson(value, { getType: () => EdmPrimitiveTypeKind.Int64 })
        if (countValue >= 0) return countValue
        throw new SerializationError('The value of ' + MetaProperties.COUNT + ' must be a non-negative number')
      } catch (error) {
        throw new SerializationError(`An error occurred during serialization of '${annotation}' annotation.`, error)
      }
    } else if (
      annotation === Annotations.ETAG ||
      annotation === Annotations.METADATA_ETAG ||
      annotation === Annotations.MEDIA_ETAG
    ) {
      // @odata.etag or @odata.metadataEtag or @odata.mediaEtag
      try {
        this._valueValidator.validateEtagValue(value)
        return `W/"${value}"`
      } catch (error) {
        throw new SerializationError(`An error occurred during serialization of '${annotation}' annotation.`, error)
      }
    } else if (
      annotation === Annotations.CONTEXT ||
      annotation === Annotations.NEXT_LINK ||
      annotation === Annotations.MEDIA_CONTENT_TYPE ||
      annotation === Annotations.MEDIA_EDIT_LINK ||
      annotation === Annotations.MEDIA_READ_LINK
    ) {
      if (typeof value === 'string') return value
      throw new SerializationError(`The annotation '${annotation}' has the wrong value '${value}'.`)
    } else if (annotation.startsWith('@odata.')) {
      throw new SerializationError(`Unsupported OData annotation '${annotation}'`)
    } else {
      // TODO: Validate and convert foreign annotations.
      return value
    }
  }

  /**
   * Get selected paths from select items plus paths from expanded navigation properties in complex properties.
   * @param {SelectItem[]} selectItems select items from $select
   * @param {ExpandItem[]} expandItems expand items
   * @returns {Array.<string[]>} selected properties' paths from $select
   * @private
   */
  _getSelectedPaths (selectItems, expandItems) {
    return selectItems && selectItems.length > 0 && !selectItems.some(item => item.isAll())
      ? selectItems
        .map(item => item.getPathSegments().map(segment => segment.getPathSegmentIdentifier()))
        .concat(
          expandItems
            ? expandItems
              .filter(item => item.getPathSegments().length && !item.getPathSegments()[0].getNavigationProperty())
              .map(item =>
                item
                  .getPathSegments()
                  .map(segment => segment.getPathSegmentIdentifier())
                // Append a dummy path element to avoid selecting all properties from a complex property
                // only needed for expand.
                  .concat('*')
              )
            : []
        )
      : []
  }

  /**
   * Reduce selected paths to those paths following a specified complex-property name.
   * @param {Array.<string[]>} paths - selected properties' paths
   * @param {string} name - property name
   * @returns {Array.<string[]>} properties' paths following the specified complex-property name
   * @private
   */
  _reduceSelectedPaths (paths, name) {
    // If the complex property is selected without following sub-components,
    // return an empty paths array to signal that all sub-components are selected.
    if (paths.some(path => path[0] === name && path.length === 1)) return []
    // Return all paths starting with the name of the complex property, but not including its name itself.
    return paths.filter(path => path[0] === name && path.length > 1).map(path => path.slice(1))
  }

  /**
   * Reduce expand items to those with paths following a specified complex-property name and those with isAll().
   * @param {ExpandItem[]} expandItems expand items
   * @param {string} name complex-property name
   * @returns {ExpandItem[]} expand items following the specified complex-property name
   * @private
   */
  _reduceExpandItems (expandItems, name) {
    return (
      expandItems &&
      // Only expand items with isAll() and no path segments
      // or with paths starting with the complex-property name are interesting.
      expandItems
        .filter(
          item =>
            (item.isAll() && !item.getPathSegments().length) ||
            (item.getPathSegments().length > (item.isAll() ? 0 : 1) &&
              item.getPathSegments()[0].getPathSegmentIdentifier() === name)
        )
        // Remove the name of the complex property from the paths and remember it in pseudo options.
        .map(item => {
          let newItem = new ExpandItem().setPathSegments(item.getPathSegments().slice(1)).setAll(item.isAll())
          for (const option of Object.values(QueryOptions)) newItem.setOption(option, item.getOption(option))
          newItem.setOption('_complexPath', (item.getOption('_complexPath') || []).concat(name))
          return newItem
        })
    )
  }

  /**
   * Serializes structural properties of a structured type.
   * @param {EdmEntityType|EdmComplexType} type EDM type for the specified data
   * @param {?(EdmEntitySet|EdmSingleton)} entitySetOrSingleton EDM entityset or singleton for the specified data
   * @param {Object} data structure data, represented as a plain object with property-value pairs
   * @param {string} odataPath the path from the OData service root
   * @param {Array.<string[]>} selectedPaths selected properties' paths from $select
   * @param {ExpandItem[]} expandItems expand items from $expand
   * @param {boolean} isKeyRequired whether all key properties have to be serialized
   * @param {Object} entityData the data of the entity this structure is part of
   * @returns {Object} JSON object containing the serialized structural properties of the entity
   * @private
   */
  _serializeStructuralProperties (
    type,
    entitySetOrSingleton,
    data,
    odataPath,
    selectedPaths,
    expandItems,
    isKeyRequired
  ) {
    validateThat('data', data)
      .truthy()
      .typeOf('object')
    if (Array.isArray(data)) {
      throw new SerializationError('Value of a structured property must be an object, not an Array')
    }

    let serializedStructuralProps = this._getAssertAdditionalProperties(data, type, selectedPaths)

    for (const [propertyName, property] of type.getProperties()) {
      if (
        selectedPaths.length === 0 ||
        selectedPaths.find(path => path[0] === propertyName) ||
        (isKeyRequired && type.getKind() === EdmTypeKind.ENTITY && type.getKeyPropertyRef(propertyName))
      ) {
        let propertyType = property.getType()
        if (propertyType.getKind() === EdmTypeKind.DEFINITION) propertyType = propertyType.getUnderlyingType()
        // "The values for stream properties do not appear in the entity payload."
        // Exception for OASIS issue 1177: "Streams that are annotated as the application/json media type
        // (or one of its subtypes, optionally with format parameters) through @mediaContentType instance
        // annotation are represented as native JSON in JSON requests and responses"
        if (propertyType === EdmPrimitiveTypeKind.Stream) {
          const mediaType = data[propertyName + MetaProperties.MEDIA_CONTENT_TYPE]
          if (!mediaType || !mediaType.startsWith(contentTypes.JSON)) continue
        }
        const isComplex = propertyType.getKind() === EdmTypeKind.COMPLEX
        const propertyValue = data[propertyName]
        // Don't serialize optional property if the value is absent.
        if (
          (propertyValue === null || propertyValue === undefined) &&
          type.getOptionalProperty &&
          type.getOptionalProperty(propertyName)
        ) {
          continue
        }
        // Add the type annotation to a dynamic property.
        if (
          !isComplex &&
          ![EdmPrimitiveTypeKind.Boolean, EdmPrimitiveTypeKind.Double, EdmPrimitiveTypeKind.String].includes(
            propertyType
          ) &&
          property.constructor.name !== 'EdmProperty'
        ) {
          serializedStructuralProps[propertyName + JsonAnnotations.TYPE] =
            '#' + propertyType.getFullQualifiedName().name
        }
        // Serialize the value and write it to the result structure.
        const paths = isComplex ? this._reduceSelectedPaths(selectedPaths, propertyName) : []
        const reducedExpandItems = isComplex ? this._reduceExpandItems(expandItems, propertyName) : []
        serializedStructuralProps[propertyName] = this._serializeProperty(
          property,
          entitySetOrSingleton,
          propertyValue,
          odataPath + '/' + encodeURIComponent(propertyName),
          paths,
          reducedExpandItems,
          isKeyRequired
        )
      }
    }
    return serializedStructuralProps
  }

  /**
   * Serialize navigation properties.
   * @param {EdmEntityType|EdmComplexType} type - EDM type for the specified data
   * @param {?(EdmEntitySet|EdmSingleton)} entitySetOrSingleton - EDM entityset or singleton for the specified data
   * @param {Object} data the data
   * @param {string} odataPath the path from the OData service root
   * @param {ExpandItem[]} expandItems - expand items from $expand
   * @param {boolean} isKeyRequired whether all key properties have to be serialized
   * @returns {Object} the serialized navigation properties
   * @private
   */
  _serializeNavigationProperties (
    type,
    entitySetOrSingleton,
    data,
    odataPath,
    expandItems,
    isKeyRequired
  ) {
    let serializedNavProps = {}
    if (!expandItems || expandItems.length === 0) return serializedNavProps

    validateThat('data', data)
      .truthy()
      .typeOf('object')

    const allExpandItem = expandItems.find(item => item.isAll() && !item.getPathSegments().length)

    for (const [navPropertyName, navProperty] of type.getNavigationProperties()) {
      const expandItem =
        allExpandItem ||
        expandItems.find(
          expItem =>
            expItem.getPathSegments()[0].getNavigationProperty() &&
            expItem
              .getPathSegments()[0]
              .getNavigationProperty()
              .getName() === navPropertyName
        )

      if (expandItem) {
        const expandedEntityType = navProperty.getEntityType()
        // Get the related entity set or singleton.
        // We could be in a complex property, so we have to take the path from the source entity set
        // into account, which has been stored in a pseudo option by the method _reduceExpandItems(...).
        const targetPath = (expandItem.getOption('_complexPath') || []).concat(navPropertyName)
        const expandedEntitySet = entitySetOrSingleton
          ? entitySetOrSingleton.getRelatedBindingTarget(targetPath.join('/'))
          : null
        const navPropertyValue = data[navPropertyName]
        const optionsExpandItems = expandItem.getOption(QueryOptions.EXPAND)
        const optionsSelectedPaths = this._getSelectedPaths(
          expandItem.getOption(QueryOptions.SELECT),
          optionsExpandItems
        )
        const expandItemPathSegments = expandItem.getPathSegments()
        const isOnlyCount =
          expandItemPathSegments.length > 0 &&
          expandItemPathSegments[expandItemPathSegments.length - 1].getKind() === ResourceKind.COUNT

        if (isOnlyCount || expandItem.getOption(QueryOptions.COUNT)) {
          this._assertAnnotationExist(navPropertyName + MetaProperties.COUNT, data)
          serializedNavProps[navPropertyName + Annotations.COUNT] = this._validateAnnotationValue(
            Annotations.COUNT,
            data[navPropertyName + MetaProperties.COUNT]
          )
        }

        if (isOnlyCount) {
          // The count has already been added above.
        } else if (navPropertyValue === null || navPropertyValue === undefined) {
          serializedNavProps[navPropertyName] = navProperty.isCollection() ? [] : this._serializeNullValue(navProperty)
        } else if (Array.isArray(navPropertyValue) && navProperty.isCollection()) {
          serializedNavProps[navPropertyName] = this._serializeCollectionEntities(
            expandedEntitySet || expandedEntityType,
            navPropertyValue,
            optionsSelectedPaths,
            optionsExpandItems,
            undefined, // eTagRequired is determined from expandedEntitySet
            isKeyRequired,
            odataPath + '/' + encodeURIComponent(navPropertyName)
          )
        } else if (!Array.isArray(navPropertyValue) && !navProperty.isCollection()) {
          serializedNavProps[navPropertyName] = this._serializeEntity(
            expandedEntitySet || expandedEntityType,
            navPropertyValue,
            optionsSelectedPaths,
            optionsExpandItems,
            undefined, // eTagRequired is determined from expandedEntitySet
            isKeyRequired,
            odataPath + '/' + encodeURIComponent(navPropertyName)
          )
        } else {
          throw new SerializationError(
            'The provided data does not fit the type of the navigation property: ' + navPropertyName
          )
        }

        const skiptoken = data[navPropertyName + MetaProperties.NEXT_LINK]
        if (skiptoken) {
          if (isOnlyCount || !navProperty.isCollection() || !serializedNavProps[navPropertyName].length) {
            throw new SerializationError('Next links are only supported for collections of entities or of references.')
          }
          serializedNavProps[navPropertyName + Annotations.NEXT_LINK] = new NextLinkSerializer(
            this._encoder
          ).serializeExpandNextLink(odataPath + '/' + encodeURIComponent(navPropertyName), expandItem, skiptoken)
        }
      }
    }
    return serializedNavProps
  }

  /**
   * Checks whether the entity contains properties that belong neither to the structural nor to the navigation
   * properties of the specified type. Returns any additional annotations.
   *
   * @param {Object} data - entity data, represented as a plain object with property-value pairs.
   * @param {EdmEntityType|EdmComplexType} type - EDM type for the specified entity data
   * @param {Array.<string[]>} selectedPaths - selected properties' paths from $select
   * @returns {Object} an object with all additional properties found
   * @throws {SerializationError} if there is any unexpected property
   * @private
   */
  _getAssertAdditionalProperties (data, type, selectedPaths) {
    let extraProperties = {}

    for (const entityProp in data) {
      const [identifier, star, annotation] = this._getPropertyNameAndAnnotation(entityProp)

      if (identifier && !type.getProperty(identifier)) {
        throw new SerializationError(
          "The entity contains data for '" +
            entityProp +
            "' which does not belong " +
            "to the structural or navigation properties of the type '" +
            type.getName() +
            "'."
        )
      }

      if (annotation && !type.getNavigationProperty(identifier)) {
        let newPropertyName = entityProp
        if (star) newPropertyName = newPropertyName.replace('*', '')
        if (newPropertyName.startsWith('@odata.')) continue
        if (
          !identifier ||
          selectedPaths.length === 0 ||
          selectedPaths.find(path => path[0] === identifier) ||
          (type.getKind() === EdmTypeKind.ENTITY && type.getKeyPropertyRef(identifier))
        ) {
          extraProperties[newPropertyName] = this._validateAnnotationValue(annotation, data[entityProp])
        }
      }
    }

    return extraProperties
  }

  /**
   * Serializes EDM property.
   * @param {EdmProperty} property - EDM property, which has to be serialized
   * @param {?(EdmEntitySet|EdmSingleton)} entitySetOrSingleton EDM entityset or singleton the property is part of
   * @param {Array|Object|Buffer|stream.Readable|string|number|boolean|null|undefined} propertyValue property value
   * @param {string} odataPath the path from the OData service root
   * @param {Array.<string[]>} selectedPaths - selected properties' paths from $select
   * @param {ExpandItem[]} expandItems - expand items from $expand
   * @param {boolean} isKeyRequired whether all key properties have to be serialized
   * @returns {Array|Object|stream.Readable|string|number|boolean|null} serialized property value
   * @private
   */
  _serializeProperty (
    property,
    entitySetOrSingleton,
    propertyValue,
    odataPath,
    selectedPaths,
    expandItems,
    isKeyRequired
  ) {
    if (propertyValue === null || propertyValue === undefined) {
      return property.isCollection() ? [] : this._serializeNullValue(property)
    }
    if (property.isCollection() && !Array.isArray(propertyValue)) {
      throw new SerializationError(`Value of collection property '${property.getName()}' must be an array`)
    }
    try {
      return property.isCollection()
        ? propertyValue.map(value =>
          this._serializePropertyValue(
            property,
            entitySetOrSingleton,
            value,
            odataPath,
            selectedPaths,
            expandItems,
            isKeyRequired
          )
        )
        : this._serializePropertyValue(
          property,
          entitySetOrSingleton,
          propertyValue,
          odataPath,
          selectedPaths,
          expandItems,
          isKeyRequired
        )
    } catch (error) {
      throw new SerializationError(`Serialization of the '${property.getName()}' property failed.`, error)
    }
  }

  /**
   * Serializes null value for the EDM (navigation) property or EDM return type.
   * @param {(EdmProperty|EdmNavigationProperty|EdmReturnType)} propertyOrReturnType EDM primitive or navigation property or EDM return type
   * @returns {null} null value, if nullable
   * @throws {SerializationError} if the property is not nullable
   * @private
   */
  _serializeNullValue (propertyOrReturnType) {
    const nullable = propertyOrReturnType.isNullable()
    if (nullable === undefined || nullable) return null
    throw new SerializationError(
      'Not nullable value ' +
        (propertyOrReturnType.getName ? "for '" + propertyOrReturnType.getName() + "' " : '') +
        'must not be null'
    )
  }

  /**
   * Serializes a single value of an EDM property.
   * @param {EdmProperty} property - EDM property for which the value has to be serialized
   * @param {?(EdmEntitySet|EdmSingleton)} entitySetOrSingleton EDM entityset or singleton the property is part of
   * @param {Object|Buffer|stream.Readable|string|number|boolean|null} propertyValue property value to be serialized
   * @param {string} odataPath the path from the OData service root
   * @param {Array.<string[]>} selectedPaths - selected properties' paths from $select
   * @param {ExpandItem[]} expandItems - expand items from $expand
   * @param {boolean} isKeyRequired whether all key properties have to be serialized
   * @returns {Object|stream.Readable|string|number|boolean|null} serialized property value
   * @private
   */
  _serializePropertyValue (
    property,
    entitySetOrSingleton,
    propertyValue,
    odataPath,
    selectedPaths,
    expandItems,
    isKeyRequired
  ) {
    // This is used to serialize null elements inside a collection.
    if (propertyValue === undefined) {
      throw new SerializationError("Missing value for property '" + property.getName() + "'")
    }
    if (propertyValue === null) return this._serializeNullValue(property)

    const propertyType = property.getType()
    switch (propertyType.getKind()) {
      case EdmTypeKind.PRIMITIVE:
      case EdmTypeKind.ENUM:
        if (propertyType === EdmPrimitiveTypeKind.Stream) return propertyValue
        return this._encoder.encodeJson(propertyValue, property)
      case EdmTypeKind.DEFINITION:
        if (propertyType.getUnderlyingType() === EdmPrimitiveTypeKind.Stream) return propertyValue
        return this._encoder.encodeJson(propertyValue, property)
      case EdmTypeKind.COMPLEX:
        return Object.assign(
          this._serializeStructuralProperties(
            propertyType,
            entitySetOrSingleton,
            propertyValue,
            odataPath,
            selectedPaths,
            expandItems,
            isKeyRequired
          ),
          this._serializeNavigationProperties(
            propertyType,
            entitySetOrSingleton,
            propertyValue,
            odataPath,
            expandItems,
            isKeyRequired
          )
        )
      default:
        throw new SerializationError(
          'Serialization of properties of ' + propertyType.getKind() + ' type kind is not supported'
        )
    }
  }

  /**
   * Returns all advertised operations in the passed data as object.
   * @param {Object} data entity data
   * @returns {Object} object with every operation advertisement from the passed data
   * @private
   */
  _serializeOperationAdvertisement (data) {
    let operationAdvertisements = {}
    // TODO: validate anything? Namespace? Is the operation actually bound to the EntitySet?
    for (const propertyName in data) {
      if (propertyName.startsWith('#')) operationAdvertisements[propertyName] = {} // Only odata.metadata=minimal
    }
    return operationAdvertisements
  }

  /**
   * Returns error message, which will be used for the error, thrown during the serialization of an entity in scope of
   * the entity collection.
   *
   * @param {Object} entity - entity data
   * @param {string[]} keyNames - names of all the key properties of the entity's entity type
   * @param {number} entityIndex - index of the entity in the entity collection
   * @returns {string} error message
   * @private
   */
  _getErrorMsgForCollectionEntity (entity, keyNames, entityIndex) {
    const keyValues = this._getEntityKeyValues(entity, keyNames)

    // if key/value pairs can be determined, return the error message containing key(s) info
    if (keyValues) {
      return 'An error occurred during serialization of the entity with the following key(s): ' + keyValues
    }

    // if key/value pairs cannot be determined, return the error message, containing the index of the entity in the
    // entity collection
    return `An error occurred during serialization of the entity at index #${entityIndex} in the entity collection`
  }

  /**
   * Returns string, containing values for the key properties in the specified entity.
   * @param {Object} entity - entity data
   * @param {string[]} keyNames - names of the key properties in the entity's entity type
   * @returns {?string} string in the format <key_property_name1>: <value1>, <key_property_name2>: <value2>
   *                    or null if one of the key values is undefined
   * @private
   */
  _getEntityKeyValues (entity, keyNames) {
    let keyValues = []

    for (const keyName of keyNames) {
      const keyValue = entity[keyName]
      // return null to indicate that key values cannot be determined
      if (keyValue === null || keyValue === undefined) return null
      keyValues.push(keyName + ': ' + keyValue)
    }

    return keyValues.join(', ')
  }

  /**
   * Creates an error with a generic message that is extended in special circumstances.
   * @param {string} genericMessage the generic error message
   * @param {Error} error the error
   * @returns {SerializationError} the error with the (potentially extended) generic error message
   * @private
   */
  _createError (genericMessage, error) {
    let text = genericMessage
    let err = error
    while (err) {
      if (err.message.includes('IEEE754Compatible')) {
        text += ' Consider requesting JSON content type with parameter IEEE754Compatible=true.'
        break
      }
      err = typeof err.getRootCause === 'function' ? err.getRootCause() : undefined
    }
    return new SerializationError(text, error)
  }

  /**
   * Returns the property name and the annotation name for a name.
   * If the name starts with an '@' like '@odata.etag' the property name is empty
   * and '@odata.etag' is the annotation.
   * If the name is 'Property@any.annotation' then the property name would be 'Property'
   * and the annotation would be '@any.annotation'.
   * The information about an optional star character in names like 'Property*@annotation' is also returned.
   * @param {string} name the name
   * @returns {Array.<string|boolean|null>} an array with propertyName (string), star (boolean), annotation (?string)
   */
  _getPropertyNameAndAnnotation (name) {
    if (!name.includes('*') && !name.includes('@') && !name.includes('#')) return [name]
    let index = name.indexOf('*')
    const star = index >= 0
    if (index === -1) index = name.indexOf('@')
    if (index === -1) index = name.indexOf('#')
    const propertyName = name.substring(0, index)
    if (star && index < name.length) index++
    const annotation = name[index] === '@' ? name.substring(index) : null
    return [propertyName, star, annotation]
  }
}

module.exports = ResourceJsonSerializer
