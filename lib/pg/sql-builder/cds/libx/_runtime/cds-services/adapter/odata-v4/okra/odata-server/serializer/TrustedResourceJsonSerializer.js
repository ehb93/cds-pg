'use strict'

const cds = require('../../../../../../cds')

const commons = require('../../odata-commons')
const contentTypes = commons.format.ContentTypeInfo.ContentTypes
const MetaProperties = commons.format.JsonFormat.MetaProperties
const Annotations = commons.format.JsonFormat.Annotations
const EdmTypeKind = commons.edm.EdmType.TypeKind
const EdmPrimitiveTypeKind = commons.edm.EdmPrimitiveTypeKind
const QueryOptions = commons.uri.UriInfo.QueryOptions
const UriHelper = require('../utils/UriHelper')
const NextLinkSerializer = require('./NextLinkSerializer')
const SerializationError = require('../errors/SerializationError')

/**
 * JSON serializer for trusted OData resources, i.e., there is no validation.
 */
class TrustedResourceJsonSerializer {
  /**
   * @param {JsonContentTypeInfo} formatParams JSON serializing options
   */
  constructor (formatParams) {
    this._formatParams = formatParams
  }

  /**
   * Serializes entity to OData JSON string.
   * @param {EdmEntityType} entityType EDM type of the entity
   * @param {Object} data entity data
   * @param {ExpandItem[]} expandItems expand items from $expand
   * @param {string} odataPath the path from the OData service root to the entity
   * @returns {string} entity, serialized in OData JSON format
   */
  serializeEntity (entityType, data, expandItems, odataPath) {
    try {
      return JSON.stringify(
        this._serializeEntity(
          this._serializeAnnotations({}, data.value, MetaProperties.CONTEXT, MetaProperties.METADATA_ETAG),
          entityType,
          data.value,
          expandItems,
          odataPath
        )
      )
    } catch (error) {
      throw new SerializationError('An error occurred during serialization of the entity.', error)
    }
  }

  /**
   * Serializes entity collection to OData JSON string.
   * @param {EdmEntityType} entityType EDM entity type for the entities in the collection
   * @param {Object} data entity collection data
   * @param {ExpandItem[]} expandItems expand items from $expand
   * @param {string} odataPath the path from the OData service root to the entity collection
   * @returns {string} entity collection, serialized in OData JSON format
   */
  serializeEntityCollection (entityType, data, expandItems, odataPath) {
    try {
      let serializedEntityCollection = this._serializeAnnotations(
        {},
        data,
        MetaProperties.CONTEXT,
        MetaProperties.METADATA_ETAG,
        MetaProperties.COUNT
      )
      this._serializeOperationAdvertisement(serializedEntityCollection, data)

      serializedEntityCollection.value = data.value.map(currentEntity =>
        this._serializeEntity({}, entityType, currentEntity, expandItems, odataPath)
      )
      this._serializeAnnotations(serializedEntityCollection, data, MetaProperties.NEXT_LINK)

      return JSON.stringify(serializedEntityCollection)
    } catch (error) {
      throw new SerializationError('An error occurred during serialization of the entity collection', error)
    }
  }

  /**
   * Serialize a primitive-type value to an OData JSON string.
   * @param {(EdmProperty|EdmReturnType)} propertyOrReturnType EDM property or EDM return type
   * @param {Object} data the data with the value
   * @returns {string} serialized representation in OData JSON format
   */
  serializePrimitive (propertyOrReturnType, data) {
    try {
      let result = this._serializeAnnotations(
        {},
        data,
        MetaProperties.CONTEXT,
        MetaProperties.METADATA_ETAG,
        MetaProperties.ETAG
      )

      result.value =
        data.value === null || data.value === undefined
          ? null
          : this._serializePropertyValue(propertyOrReturnType, data.value)

      return JSON.stringify(result)
    } catch (error) {
      throw new SerializationError('An error occurred during serialization of the primitive value', error)
    }
  }

  /**
   * Serialize a primitive-type collection value to an OData JSON string.
   * @param {(EdmProperty|EdmReturnType)} propertyOrReturnType EDM property or EDM return type
   * @param {Object} data the data with the values
   * @returns {string} serialized representation in OData JSON format
   */
  serializePrimitiveCollection (propertyOrReturnType, data) {
    try {
      let result = this._serializeAnnotations(
        {},
        data,
        MetaProperties.CONTEXT,
        MetaProperties.METADATA_ETAG,
        MetaProperties.COUNT,
        MetaProperties.ETAG
      )

      if (data.value === null || data.value === undefined) {
        result.value = []
      } else {
        result.value = data.value.map(valueItem =>
          valueItem === null ? null : this._serializePropertyValue(propertyOrReturnType, valueItem)
        )
        this._serializeAnnotations(result, data, MetaProperties.NEXT_LINK)
      }
      return JSON.stringify(result)
    } catch (error) {
      throw new SerializationError('An error occurred during serialization of the primitive collection value', error)
    }
  }

  /**
   * Serialize a complex-type value to an OData JSON string.
   * @param {(EdmProperty|EdmReturnType)} propertyOrReturnType EDM property or EDM return type
   * @param {Object} data the data with the value
   * @param {ExpandItem[]} expandItems expand items from $expand
   * @param {string} odataPath the path from the OData service root to the complex-type value
   * @returns {string} serialized representation in OData JSON format
   */
  serializeComplex (propertyOrReturnType, data, expandItems, odataPath) {
    try {
      let result = this._serializeAnnotations(
        {},
        data.value || data,
        MetaProperties.CONTEXT,
        MetaProperties.METADATA_ETAG,
        MetaProperties.ETAG
      )

      if (data.value !== null && data.value !== undefined) {
        this._serializeStructure(result, propertyOrReturnType.getType(), data.value, expandItems, odataPath, [])
      }
      return JSON.stringify(result)
    } catch (error) {
      throw new SerializationError('An error occurred during serialization of the complex value', error)
    }
  }

  /**
   * Serialize a complex-type collection value to an OData JSON string.
   * @param {(EdmProperty|EdmReturnType)} propertyOrReturnType EDM property or EDM return type
   * @param {Object} data the data with the value
   * @param {ExpandItem[]} expandItems expand items from $expand
   * @param {string} odataPath the path from the OData service root to the complex-type collection value
   * @returns {string} serialized representation in OData JSON format
   */
  serializeComplexCollection (propertyOrReturnType, data, expandItems, odataPath) {
    try {
      let result = this._serializeAnnotations(
        {},
        data,
        MetaProperties.CONTEXT,
        MetaProperties.METADATA_ETAG,
        MetaProperties.ETAG,
        MetaProperties.COUNT
      )
      if (data.value === null || data.value === undefined) {
        result.value = []
      } else {
        const type = propertyOrReturnType.getType()
        result.value = data.value.map(valueItem =>
          valueItem === null ? null : this._serializeStructure({}, type, valueItem, expandItems, odataPath, [])
        )
        this._serializeAnnotations(result, data, MetaProperties.NEXT_LINK)
      }
      return JSON.stringify(result)
    } catch (error) {
      throw new SerializationError('An error occurred during serialization of the complex collection value', error)
    }
  }

  /**
   * Serializes entity to OData JSON string.
   * @param {Object} result the result object
   * @param {EdmEntityType} entityType EDM type of the entity
   * @param {Object} data entity data
   * @param {ExpandItem[]} expandItems expand items from $expand
   * @param {string} odataPath the path from the OData service root to the top-level data structure
   * @param {Array.<{ name: string, type: EdmType, isCollection: boolean, data: Object }>} structurePath
   *     path in the data structure to the current entity
   * @returns {Object} plain object, representing the serialized entity
   * @private
   */
  _serializeEntity (result, entityType, data, expandItems, odataPath, structurePath) {
    this._serializeAnnotations(result, data, MetaProperties.ETAG)

    this._serializeStructure(result, entityType, data, expandItems, odataPath, structurePath || [])

    // Add annotation '"@odata.id": null' for an entity of a transient type if some properties have been
    // aggregated away or if not all of the base type's properties have been serialized.
    if (entityType.isReduced) {
      let type = entityType
      while (type.isReduced) type = type.getBaseType()
      if (entityType.isReduced() || Array.from(type.getProperties().keys()).some(name => result[name] === undefined)) {
        result[Annotations.ID] = null // eslint-disable-line no-param-reassign
      }
    }

    return result
  }

  /**
   * Serializes annotations.
   * @param {Object} result the result object
   * @param {Object} sourceData the data
   * @param {string[]} metaProperties meta properties to consider
   * @returns {Object} object containing the serialized annotations
   * @private
   */
  _serializeAnnotations (result, sourceData, ...metaProperties) {
    if (sourceData) {
      for (const metaProperty of metaProperties) {
        const annotation = MetaProperties.getAnnotation(metaProperty)
        // eslint-disable-next-line no-param-reassign
        result[annotation] = this._convertAnnotationValue(annotation, sourceData[metaProperty])
      }
    }
    return result
  }

  /**
   * Converts an OData annotation value.
   * Returns the converted value if it is for a supported OData annotation.
   * A value for an unsupported OData annotation will result in an error.
   * If the annotation is not an OData-defined annotation the value is returned 'as is'.
   *
   * @param {string} annotation the annotation
   * @param {string|number} value the value of the annotation
   * @returns {string|number} the value of the annotation or the converted one if it is an OData annotation
   * @throws {SerializationError} in case there is an error with converting the annotation value
   * @private
   */
  _convertAnnotationValue (annotation, value) {
    if (value === undefined) return value
    if (annotation === Annotations.COUNT) {
      return this._formatParams.getIEEE754Setting() ? String(value) : Number(value)
    } else if (
      annotation === Annotations.ETAG ||
      annotation === Annotations.METADATA_ETAG ||
      annotation === Annotations.MEDIA_ETAG
    ) {
      return 'W/"' + value + '"'
    } else if (
      annotation === Annotations.CONTEXT ||
      annotation === Annotations.NEXT_LINK ||
      annotation === Annotations.MEDIA_CONTENT_TYPE ||
      annotation === Annotations.MEDIA_EDIT_LINK ||
      annotation === Annotations.MEDIA_READ_LINK
    ) {
      return value
    } else if (annotation.startsWith('@odata.')) {
      throw new SerializationError("Unsupported OData annotation '" + annotation + "'")
    } else {
      return value
    }
  }

  /**
   * Serializes properties of a structured type.
   * @param {Object} result the result object
   * @param {EdmEntityType|EdmComplexType} type EDM type for the specified data
   * @param {Object} data structure data, represented as a plain object with property-value pairs
   * @param {ExpandItem[]} expandItems expand items from $expand
   * @param {string} odataPath the path from the OData service root to the top-level data structure
   * @param {Array.<{ name: string, type: EdmType, isCollection: boolean, data: Object }>} structurePath
   *     path in the data structure to the current structure
   * @returns {Object} object containing the serialized properties of the structured type
   * @private
   */
  _serializeStructure (result, type, data, expandItems, odataPath, structurePath) {
    for (const entityProp in data) {
      // draft-enabled entities in odata v2 have own property DraftAdministrativeData_DraftUUID -> preserve if in data
      if (entityProp === 'DraftAdministrativeData_DraftUUID') {
        result[entityProp] = data[entityProp]
        continue
      }

      const [identifier, star, annotation] = this._getPropertyNameAndAnnotation(entityProp)

      if (entityProp.startsWith('#')) {
        // operation advertisement, only to the extent of odata.metadata=minimal
        result[entityProp] = {} // eslint-disable-line no-param-reassign
      } else if (annotation) {
        let newPropertyName = entityProp
        if (star) newPropertyName = newPropertyName.replace('*', '')
        if (newPropertyName.startsWith('@odata.')) continue
        // eslint-disable-next-line no-param-reassign
        result[newPropertyName] =
          annotation === Annotations.NEXT_LINK
            ? new NextLinkSerializer(this._encoder).serializeExpandNextLink(
              odataPath +
                  '/' +
                  this._buildStructurePath(structurePath) +
                  (structurePath.length ? '/' : '') +
                  encodeURIComponent(identifier),
              this._findExpandItem(expandItems, structurePath.concat({ name: identifier })),
              data[entityProp]
            )
            : this._convertAnnotationValue(annotation, data[entityProp])
      } else if (identifier && !star) {
        const propertyValue = data[entityProp]
        const isCollection = Array.isArray(propertyValue)
        const edmProperty = type.getStructuralProperty(entityProp)
        if (edmProperty) {
          let propertyType = edmProperty.getType()

          // REVISIT: unofficial!!!
          // !propertyType && cds.env.odata.asProvided -> just use the provided value
          if (!propertyType && cds.env.odata.asProvided) {
            result[entityProp] = propertyValue
            continue
          }

          if (propertyType.getKind() === EdmTypeKind.DEFINITION) {
            propertyType = propertyType.getUnderlyingType()
          }
          // "The values for stream properties do not appear in the entity payload."
          // Exception for OASIS issue 1177: "Streams that are annotated as the application/json media type
          // (or one of its subtypes, optionally with format parameters) through @mediaContentType instance
          // annotation are represented as native JSON in JSON requests and responses"
          if (propertyType === EdmPrimitiveTypeKind.Stream) {
            const propertyName = edmProperty.getName()
            const mediaType = data[propertyName + MetaProperties.MEDIA_CONTENT_TYPE]
            if (!mediaType || !mediaType.startsWith(contentTypes.JSON)) continue
          }
          // Add the type annotation to a dynamic property.
          if (
            propertyType.getKind() !== EdmTypeKind.COMPLEX &&
            ![EdmPrimitiveTypeKind.Boolean, EdmPrimitiveTypeKind.Double, EdmPrimitiveTypeKind.String].includes(
              propertyType
            ) &&
            edmProperty.constructor.name !== 'EdmProperty'
          ) {
            // eslint-disable-next-line no-param-reassign
            result[entityProp + Annotations.TYPE] = '#' + propertyType.getFullQualifiedName().name
          }
          // Serialize the value.
          // eslint-disable-next-line no-param-reassign
          result[entityProp] = this._serializeProperty(
            edmProperty,
            propertyValue,
            expandItems,
            odataPath,
            structurePath
          )
        } else {
          const edmNavigationProperty = type.getNavigationProperty(entityProp)
          if (edmNavigationProperty && propertyValue === null) {
            // eslint-disable-next-line no-param-reassign
            result[entityProp] = edmNavigationProperty.isCollection() ? [] : null
          } else if (edmNavigationProperty && propertyValue !== undefined) {
            const expandedEntityType = edmNavigationProperty.getEntityType()
            let pathElement = { name: entityProp, type: expandedEntityType, isCollection: isCollection }
            // eslint-disable-next-line no-param-reassign
            result[entityProp] = isCollection
              ? propertyValue.map(currentEntity =>
                this._serializeEntity(
                  {},
                  expandedEntityType,
                  currentEntity,
                  expandItems,
                  odataPath,
                  structurePath.concat(Object.assign({}, pathElement, { data: currentEntity }))
                )
              )
              : this._serializeEntity(
                {},
                expandedEntityType,
                propertyValue,
                expandItems,
                odataPath,
                structurePath.concat(Object.assign(pathElement, { data: propertyValue }))
              )
          }
        }
      }
    }

    return result
  }

  /**
   * Serializes EDM property.
   * @param {EdmProperty} property EDM property, which has to be serialized
   * @param {Array|Object|Buffer|stream.Readable|string|number|boolean|null|undefined} propertyValue property value
   * @param {ExpandItem[]} expandItems expand items from $expand
   * @param {string} odataPath the path from the OData service root to the top-level data structure
   * @param {Array.<{ name: string, type: EdmType, isCollection: boolean, data: Object }>} structurePath
   *     path in the data structure to the current property
   * @returns {Array|Object|stream.Readable|string|number|boolean|null} serialized property value
   * @private
   */
  _serializeProperty (property, propertyValue, expandItems, odataPath, structurePath) {
    const isCollection = property.isCollection()
    if (propertyValue === null || propertyValue === undefined) return isCollection ? [] : null
    let propertyType = property.getType()
    if (propertyType.getKind() === EdmTypeKind.DEFINITION) propertyType = propertyType.getUnderlyingType()
    if (propertyType === EdmPrimitiveTypeKind.Stream) return propertyValue
    let pathElement = { name: property.getName(), type: property.getType(), isCollection: isCollection }
    try {
      return isCollection
        ? propertyValue.map(value =>
          this._serializePropertyValue(
            property,
            value,
            expandItems,
            odataPath,
            structurePath.concat(Object.assign({}, pathElement, { data: value }))
          )
        )
        : this._serializePropertyValue(
          property,
          propertyValue,
          expandItems,
          odataPath,
          structurePath.concat(Object.assign(pathElement, { data: propertyValue }))
        )
    } catch (error) {
      throw new SerializationError("Serialization of the '" + pathElement.name + "' property failed.", error)
    }
  }

  /**
   * Serializes a single value of an EDM property.
   * @param {EdmProperty} property EDM property for which the value has to be serialized
   * @param {Object|Buffer|stream.Readable|string|number|boolean|null} propertyValue property value to be serialized
   * @param {ExpandItem[]} expandItems expand items from $expand
   * @param {string} odataPath the path from the OData service root to the top-level data structure
   * @param {Array.<{ name: string, type: EdmType, isCollection: boolean, data: Object }>} structurePath
   *     path in the data structure to the current property
   * @returns {Object|stream.Readable|string|number|boolean|null} serialized property value
   * @private
   */
  _serializePropertyValue (property, propertyValue, expandItems, odataPath, structurePath) {
    // This is used to serialize null elements inside a collection.
    if (propertyValue === null) return null

    let type = property.getType()
    let result = propertyValue
    switch (type.getKind()) {
      case EdmTypeKind.DEFINITION:
        type = type.getUnderlyingType()
      // eslint-disable-line no-fallthrough
      case EdmTypeKind.PRIMITIVE:
        if (type === EdmPrimitiveTypeKind.Decimal || type === EdmPrimitiveTypeKind.Int64) {
          result = this._formatParams.getIEEE754Setting() ? String(propertyValue) : Number(propertyValue)
        } else if (type === EdmPrimitiveTypeKind.Binary) {
          result = propertyValue
            .toString('base64')
            // Convert the standard base64 encoding to the URL-safe variant.
            .replace(new RegExp('\\+', 'g'), '-')
            .replace(new RegExp('/', 'g'), '_')
        }
        break
      case EdmTypeKind.COMPLEX:
        result = this._serializeStructure({}, type, propertyValue, expandItems, odataPath, structurePath)
        break
      case EdmTypeKind.ENUM:
        if (type.isFlags()) {
          result = []
          let remaining = propertyValue
          for (const [name, member] of type.getMembers()) {
            const memberValue = member.getValue()
            // Use bitwise AND operator to check whether all bits of the member value are set.
            if ((memberValue & remaining) === memberValue) {
              result.push(name)
              // Use bitwise XOR operator to remove the member-value bits from the remaining value.
              remaining ^= memberValue
            }
          }
          result = result.join(',')
        } else {
          result = type
            .getMembers()
            .find(member => member.getValue() === propertyValue)
            .getName()
        }
        break
      default:
        throw new SerializationError('Serialization of properties of type kind ' + type.getKind() + ' is not supported')
    }
    return result
  }

  /**
   * Sets all advertised operations from the passed data in the result.
   * @param {Object} result the result object
   * @param {Object} data entity data
   * @returns {Object} object with every operation advertisement from the passed data
   * @private
   */
  _serializeOperationAdvertisement (result, data) {
    for (const propertyName in data) {
      // eslint-disable-next-line no-param-reassign
      if (propertyName.startsWith('#')) result[propertyName] = {} // only to the extent of odata.metadata=minimal
    }
    return result
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
   * @private
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

  /**
   * Convert a given structure path into a string for a URL.
   * @param {Array.<{ name: string, type: EdmType, isCollection: boolean, data: Object }>} structurePath
   *     path in the data structure to the current structure
   * @returns {string} the structure path as string for a URL
   * @private
   */
  _buildStructurePath (structurePath) {
    return structurePath
      .map(
        element =>
          encodeURIComponent(element.name) +
          (element.isCollection
            ? UriHelper.buildKeyString(
              UriHelper.buildEntityKeys(element.type, element.data, {
                encodeText: (value, property) => String(this._serializePropertyValue(property, value))
              })
            )
            : '')
      )
      .join('/')
  }

  /**
   * Find the expand item for a given structure path.
   * @param {ExpandItem[]} expandItems expand items from $expand
   * @param {Array.<{ name: string, type: EdmType, isCollection: boolean, data: Object }>} structurePath
   *     path in the data structure to the current structure
   * @returns {?ExpandItem} the expand item for the given structure path
   * @private
   */
  _findExpandItem (expandItems, structurePath) {
    for (const item of expandItems) {
      const segments = item.getPathSegments()
      if (
        segments.every((segment, index) => segment.getPathSegmentIdentifier() === structurePath[index].name) &&
        (!item.isAll() ||
          structurePath
            .slice(0, structurePath.length - 1)
            .every(element => element.type.getKind() === EdmTypeKind.COMPLEX))
      ) {
        const found =
          segments.length === structurePath.length || item.isAll()
            ? item
            : this._findExpandItem(item.getOption(QueryOptions.EXPAND), structurePath.slice(segments.length))
        if (found) return found
      }
    }
    return null // should not happen
  }
}

module.exports = TrustedResourceJsonSerializer
