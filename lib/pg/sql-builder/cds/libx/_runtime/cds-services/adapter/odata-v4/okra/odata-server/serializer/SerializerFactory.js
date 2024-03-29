'use strict'

const commons = require('../../odata-commons')
const EdmTypeKind = commons.edm.EdmType.TypeKind
const EdmPrimitiveTypeKind = commons.edm.EdmPrimitiveTypeKind
const JsonContentTypeInfo = commons.format.JsonContentTypeInfo
const ContentTypes = JsonContentTypeInfo.ContentTypes
const MetaProperties = commons.format.JsonFormat.MetaProperties
const ValueValidator = commons.validator.ValueValidator
const QueryOptions = commons.uri.UriInfo.QueryOptions
const ResourceKind = commons.uri.UriResource.ResourceKind
const HeaderNames = commons.http.HttpHeader.HeaderNames
const Components = require('../core/ComponentManager').Components
const ResourceJsonSerializer = require('./ResourceJsonSerializer')
const TrustedResourceJsonSerializer = require('./TrustedResourceJsonSerializer')
const BatchJsonSerializer = require('./BatchJsonSerializer')
const SerializationError = require('../errors/SerializationError')
const ExpandHelper = require('../utils/ExpandHelper')

/**
 * Function interface for serializer functions
 * @callback SerializerFunction
 * @param {Context} context OData context
 * @param {Object} data
 * @param {Object} options
 * @param {Function} next
 */

class SerializerFactory {
  /**
   * Check JSON format parameters.
   * @param {Array.<{ name: string, value: string }>} parameters the format parameters
   * @returns {boolean} whether the parameters are supported
   */
  static checkJsonParameters (parameters) {
    for (const parameter of parameters) {
      const name = parameter.name.toLowerCase()
      const value = parameter.value.toLowerCase()
      switch (name) {
        case JsonContentTypeInfo.FormatParameter.ODATA_METADATA:
          if (value !== JsonContentTypeInfo.FormatParameterMetadataValues.MINIMAL) return false
          break
        case JsonContentTypeInfo.FormatParameter.STREAMING:
          if (value !== 'false') return false
          break
        case JsonContentTypeInfo.FormatParameter.IEEE754.toLowerCase():
          if (value !== 'false' && value !== 'true') return false
          break
        case JsonContentTypeInfo.FormatParameter.EXPONENTIAL_DECIMALS.toLowerCase():
          if (value !== 'false' && value !== 'true') return false
          break
        case JsonContentTypeInfo.FormatParameter.CHARSET.toLowerCase():
          if (!value) return false
          break
        default:
          return false
      }
    }
    return true
  }

  /**
   * Serializes entity-collection resources.
   * @param {Context} context OData context
   * @param {Object} data the data
   * @param {Object} options options
   * @param {Function} next callback function
   */
  static resourceEntityCollection (context, data, options, next) {
    const request = context.getRequest()
    const uriInfo = request.getUriInfo()
    const entityType = uriInfo.getFinalEdmType()
    const jsonContentTypeInfo = new JsonContentTypeInfo(
      context
        .getResponse()
        .getContract()
        .getContentTypeInfo()
    )

    let content
    if (context.getService().isTrusted()) {
      context.getLogger().debug('Using TrustedResourceJsonSerializer')
      content = new TrustedResourceJsonSerializer(jsonContentTypeInfo).serializeEntityCollection(
        entityType,
        data,
        ExpandHelper.getFinalExpand(request),
        request.getOdataPath()
      )
    } else {
      const entitySet = uriInfo.getLastSegment().getEntitySet() || uriInfo.getLastSegment().getTarget()
      // A transient type (recognized through its method getOptionalProperty) has no entity set.
      const entityTypeOrSet = entityType.getOptionalProperty ? entityType : entitySet || entityType
      content = new ResourceJsonSerializer(
        context
          .getService()
          .getComponentManager()
          .getComponent(Components.PRIMITIVE_VALUE_ENCODER),
        jsonContentTypeInfo
      ).serializeEntityCollection(
        entityTypeOrSet,
        data,
        uriInfo.getQueryOption(QueryOptions.SELECT),
        ExpandHelper.getFinalExpand(request),
        !!request.getConcurrentResource() && !uriInfo.getLastSegment().getAction(),
        request.getOdataPath()
      )
    }

    next(null, content)
  }

  /**
   * Serializes entity resources.
   * @param {Context} context OData context
   * @param {Object} data the data
   * @param {Object} options options
   * @param {Function} next callback function
   */
  static resourceEntity (context, data, options, next) {
    let content
    if (data.value) {
      const request = context.getRequest()
      const uriInfo = request.getUriInfo()
      const entityType = uriInfo.getFinalEdmType()
      const entitySetOrSingleton =
        uriInfo.getLastSegment().getEntitySet() ||
        uriInfo.getLastSegment().getSingleton() ||
        uriInfo.getLastSegment().getTarget()
      // A transient type (recognized through its method getOptionalProperty) has no entity set.
      const entityTypeOrSet = entityType.getOptionalProperty ? entityType : entitySetOrSingleton || entityType
      const jsonContentTypeInfo = new JsonContentTypeInfo(
        context
          .getResponse()
          .getContract()
          .getContentTypeInfo()
      )
      if (context.getService().isTrusted()) {
        context.getLogger().debug('Using TrustedResourceJsonSerializer')
        content = new TrustedResourceJsonSerializer(jsonContentTypeInfo).serializeEntity(
          entityType,
          data,
          ExpandHelper.getFinalExpand(request),
          request.getOdataPath()
        )
      } else {
        const primitiveValueEncoder = context
          .getService()
          .getComponentManager()
          .getComponent(Components.PRIMITIVE_VALUE_ENCODER)
        content = new ResourceJsonSerializer(primitiveValueEncoder, jsonContentTypeInfo).serializeEntity(
          entityTypeOrSet,
          data,
          uriInfo.getQueryOption(QueryOptions.SELECT),
          ExpandHelper.getFinalExpand(request),
          !!request.getConcurrentResource() && !uriInfo.getLastSegment().getAction(),
          request.getOdataPath()
        )
      }
    }
    next(null, content)
  }

  /**
   * Serializes primitive resources.
   * @param {Context} context OData context
   * @param {Object} data the data
   * @param {Object} options options
   * @param {Function} next callback function
   */
  static resourcePrimitive (context, data, options, next) {
    let content
    if (data.value !== undefined) {
      const request = context.getRequest()
      const lastSegment = request.getUriInfo().getLastSegment()
      const propertyOrReturnType =
        lastSegment.getProperty() || (lastSegment.getFunction() || lastSegment.getAction()).getReturnType()
      const jsonContentTypeInfo = new JsonContentTypeInfo(
        context
          .getResponse()
          .getContract()
          .getContentTypeInfo()
      )
      if (context.getService().isTrusted()) {
        context.getLogger().debug('Using TrustedResourceJsonSerializer')
        content = new TrustedResourceJsonSerializer(jsonContentTypeInfo).serializePrimitive(propertyOrReturnType, data)
      } else {
        const primitiveValueEncoder = context
          .getService()
          .getComponentManager()
          .getComponent(Components.PRIMITIVE_VALUE_ENCODER)
        const serializer = new ResourceJsonSerializer(primitiveValueEncoder, jsonContentTypeInfo)
        content = serializer.serializePrimitive(
          propertyOrReturnType,
          data,
          !!request.getConcurrentResource() && !lastSegment.getAction()
        )
      }
    }
    next(null, content)
  }

  /**
   * Serializes primitive-collection resources.
   * @param {Context} context OData context
   * @param {Object} data the data
   * @param {Object} options options
   * @param {Function} next callback function
   */
  static resourcePrimitiveCollection (context, data, options, next) {
    const request = context.getRequest()
    const lastSegment = request.getUriInfo().getLastSegment()
    const propertyOrReturnType =
      lastSegment.getProperty() || (lastSegment.getFunction() || lastSegment.getAction()).getReturnType()
    const jsonContentTypeInfo = new JsonContentTypeInfo(
      context
        .getResponse()
        .getContract()
        .getContentTypeInfo()
    )
    let content
    if (context.getService().isTrusted()) {
      context.getLogger().debug('Using TrustedResourceJsonSerializer')
      content = new TrustedResourceJsonSerializer(jsonContentTypeInfo).serializePrimitiveCollection(
        propertyOrReturnType,
        data
      )
    } else {
      const primitiveValueEncoder = context
        .getService()
        .getComponentManager()
        .getComponent(Components.PRIMITIVE_VALUE_ENCODER)
      const serializer = new ResourceJsonSerializer(primitiveValueEncoder, jsonContentTypeInfo)
      content = serializer.serializePrimitiveCollection(
        propertyOrReturnType,
        data,
        !!request.getConcurrentResource() && !lastSegment.getAction()
      )
    }
    next(null, content)
  }

  /**
   * Serializes complex resources.
   * @param {Context} context OData context
   * @param {Object} data the data
   * @param {Object} options options
   * @param {Function} next callback function
   */
  static resourceComplex (context, data, options, next) {
    let content
    if (data.value !== null && data.value !== undefined) {
      const request = context.getRequest()
      const uriInfo = request.getUriInfo()
      const pathSegments = uriInfo.getPathSegments()
      const lastSegment = pathSegments[pathSegments.length - 1]
      const propertyOrReturnType =
        lastSegment.getProperty() || (lastSegment.getFunction() || lastSegment.getAction()).getReturnType()
      // Determine the final complex-property segments plus the segment before.
      let index = pathSegments.length - 1
      while (
        [ResourceKind.COMPLEX_COLLECTION_PROPERTY, ResourceKind.COMPLEX_PROPERTY].includes(
          pathSegments[index].getKind()
        )
      ) {
        index--
      }
      const complexPropertyPath = pathSegments.slice(index)
      const jsonContentTypeInfo = new JsonContentTypeInfo(
        context
          .getResponse()
          .getContract()
          .getContentTypeInfo()
      )
      if (context.getService().isTrusted()) {
        context.getLogger().debug('Using TrustedResourceJsonSerializer')
        content = new TrustedResourceJsonSerializer(jsonContentTypeInfo).serializeComplex(
          propertyOrReturnType,
          data,
          ExpandHelper.getFinalExpand(request),
          request.getOdataPath()
        )
      } else {
        const primitiveValueEncoder = context
          .getService()
          .getComponentManager()
          .getComponent(Components.PRIMITIVE_VALUE_ENCODER)
        const serializer = new ResourceJsonSerializer(primitiveValueEncoder, jsonContentTypeInfo)
        content = serializer.serializeComplex(
          propertyOrReturnType,
          data,
          uriInfo.getQueryOption(QueryOptions.SELECT),
          ExpandHelper.getFinalExpand(request),
          !!request.getConcurrentResource() && !lastSegment.getAction(),
          request.getOdataPath(),
          complexPropertyPath
        )
      }
    }
    next(null, content)
  }

  /**
   * Serializes complex-collection resources.
   * @param {Context} context OData context
   * @param {Object} data the data
   * @param {Object} options options
   * @param {Function} next callback function
   */
  static resourceComplexCollection (context, data, options, next) {
    const request = context.getRequest()
    const uriInfo = request.getUriInfo()
    const pathSegments = uriInfo.getPathSegments()
    const lastSegment = pathSegments[pathSegments.length - 1]
    const propertyOrReturnType =
      lastSegment.getProperty() || (lastSegment.getFunction() || lastSegment.getAction()).getReturnType()
    // Determine the final complex-property segments plus the segment before.
    let index = pathSegments.length - 1
    while (
      [ResourceKind.COMPLEX_COLLECTION_PROPERTY, ResourceKind.COMPLEX_PROPERTY].includes(pathSegments[index].getKind())
    ) {
      index--
    }
    const complexPropertyPath = pathSegments.slice(index)
    const jsonContentTypeInfo = new JsonContentTypeInfo(
      context
        .getResponse()
        .getContract()
        .getContentTypeInfo()
    )
    let content
    if (context.getService().isTrusted()) {
      context.getLogger().debug('Using TrustedResourceJsonSerializer')
      content = new TrustedResourceJsonSerializer(jsonContentTypeInfo).serializeComplexCollection(
        propertyOrReturnType,
        data,
        ExpandHelper.getFinalExpand(request),
        request.getOdataPath()
      )
    } else {
      const primitiveValueEncoder = context
        .getService()
        .getComponentManager()
        .getComponent(Components.PRIMITIVE_VALUE_ENCODER)
      const serializer = new ResourceJsonSerializer(primitiveValueEncoder, jsonContentTypeInfo)
      content = serializer.serializeComplexCollection(
        propertyOrReturnType,
        data,
        uriInfo.getQueryOption(QueryOptions.SELECT),
        ExpandHelper.getFinalExpand(request),
        !!request.getConcurrentResource() && !lastSegment.getAction(),
        request.getOdataPath(),
        complexPropertyPath
      )
    }
    next(null, content)
  }

  /**
   * Serializes reference-collection resources.
   * @param {Context} context OData context
   * @param {Object[]} data the data
   * @param {Object} options options
   * @param {Function} next callback function
   */
  static resourceReferenceCollection (context, data, options, next) {
    const pathSegments = context
      .getRequest()
      .getUriInfo()
      .getPathSegments()
    const serializer = new ResourceJsonSerializer(
      context
        .getService()
        .getComponentManager()
        .getComponent(Components.PRIMITIVE_VALUE_ENCODER),
      new JsonContentTypeInfo(
        context
          .getResponse()
          .getContract()
          .getContentTypeInfo()
      )
    )
    next(null, serializer.serializeReferenceCollection(pathSegments, data))
  }

  /**
   * Serializes reference resources.
   * @param {Context} context OData context
   * @param {Object} data the data
   * @param {Object} options options
   * @param {Function} next callback function
   */
  static resourceReference (context, data, options, next) {
    let content
    if (data && data.value) {
      const pathSegments = context
        .getRequest()
        .getUriInfo()
        .getPathSegments()
      const serializer = new ResourceJsonSerializer(
        context
          .getService()
          .getComponentManager()
          .getComponent(Components.PRIMITIVE_VALUE_ENCODER),
        new JsonContentTypeInfo(
          context
            .getResponse()
            .getContract()
            .getContentTypeInfo()
        )
      )
      content = serializer.serializeReference(pathSegments, data)
    }
    next(null, content)
  }

  /**
   * Serializes primitive-property raw values.
   * @param {Context} context OData context
   * @param {Object} data the data
   * @param {Object} options options
   * @param {Function} next callback function
   */
  static value (context, data, options, next) {
    const response = context.getResponse()
    const uriInfo = context.getRequest().getUriInfo()
    let type = uriInfo.getFinalEdmType()
    if (type.getKind() === EdmTypeKind.DEFINITION) type = type.getUnderlyingType()

    let propertyOrReturnType
    if (uriInfo.getLastSegment()._isStreamByDollarValue) {
      for (const [propertyName, property] of uriInfo.getLastSegment(-1).getEdmType().getOwnProperties()) {
        if (property.getType() === EdmPrimitiveTypeKind.Stream) {
          propertyOrReturnType = property
          break
        }
      }
      type = EdmPrimitiveTypeKind.Stream
    } else {
      const segment = uriInfo.getLastSegment(type === EdmPrimitiveTypeKind.Stream ? 0 : -1)
      propertyOrReturnType = segment.getProperty() || (segment.getFunction() || segment.getAction()).getReturnType()
    }

    let value = data.value

    if (value === null || value === undefined) {
      if (!propertyOrReturnType.isNullable()) throw new SerializationError('Not nullable value must not be null')
    } else if (type === EdmPrimitiveTypeKind.Binary) {
      new ValueValidator().validateBinary(value, propertyOrReturnType.getMaxLength())
      response.setHeader(HeaderNames.CONTENT_TYPE, data[MetaProperties.MEDIA_CONTENT_TYPE] || ContentTypes.BINARY)
    } else if (type === EdmPrimitiveTypeKind.Stream) {
      if (!value.pipe || typeof value.pipe !== 'function') {
        throw new SerializationError(
          'Invalid value: ' + value + '. A stream must be specified for a value of Edm.Stream type.'
        )
      }
      response.setHeader(HeaderNames.CONTENT_TYPE, data[MetaProperties.MEDIA_CONTENT_TYPE] || ContentTypes.BINARY)
    } else {
      value = context
        .getService()
        .getComponentManager()
        .getComponent(Components.PRIMITIVE_VALUE_ENCODER)
        .encodeText(value, propertyOrReturnType)
      response.setHeader(HeaderNames.CONTENT_TYPE, ContentTypes.TEXT_PLAIN)
    }

    next(null, value)
  }

  /**
   * Serializes batch response.
   * @param {Context} context OData context
   * @param {Object} data the data
   * @param {Object} options options
   * @param {Function} next callback function
   */
  static batch (context, data, options, next) {
    next(null, new BatchJsonSerializer().serialize(data.getResponses()))
  }
}

module.exports = SerializerFactory
