'use strict'

const commons = require('../../odata-commons')
const ResourceKind = commons.uri.UriResource.ResourceKind
const QueryOptions = commons.uri.UriInfo.QueryOptions
const HttpMethods = commons.http.HttpMethod.Methods
const HeaderNames = commons.http.HttpHeader.HeaderNames
const EdmTypeKind = commons.edm.EdmType.TypeKind
const EdmPrimitiveTypeKind = commons.edm.EdmPrimitiveTypeKind
const UriSyntaxError = commons.errors.UriSyntaxError
const UriQueryOptionSemanticError = commons.errors.UriQueryOptionSemanticError
const FeatureSupport = commons.FeatureSupport
const VersionValidator = require('./VersionValidator')
const OperationValidator = require('./OperationValidator')
const BadRequestError = require('../errors/BadRequestError')

/**
 * The defined odata query options
 * @type string[]
 * @private
 */
const odataSystemQueryOptions = Object.keys(QueryOptions)
  .filter(name => name !== 'ODATA_DEBUG')
  .map(name => QueryOptions[name])

const queryOptionsBlackList = new Map()
  .set(QueryOptions.DELTATOKEN, FeatureSupport.features.QueryParameterDeltatoken)
  .set(QueryOptions.ID, FeatureSupport.features.QueryParameterId)

/**
 * Internal resource kind to system query options mapping
 * @type Map.<UriResource.ResourceKind, UriInfo.QueryOptions[]>
 * @private
 */
const queryOptionsPerResourceKindWhiteList = new Map()
  .set(ResourceKind.SERVICE, [QueryOptions.FORMAT])
  .set(ResourceKind.ALL, [
    QueryOptions.SEARCH,
    QueryOptions.COUNT,
    QueryOptions.SKIP,
    QueryOptions.SKIPTOKEN,
    QueryOptions.TOP,
    QueryOptions.FORMAT
  ])
  .set(ResourceKind.METADATA, [QueryOptions.FORMAT])
  .set(ResourceKind.CROSSJOIN, [
    QueryOptions.SEARCH,
    QueryOptions.COUNT,
    QueryOptions.SKIP,
    QueryOptions.SKIPTOKEN,
    QueryOptions.TOP,
    QueryOptions.FORMAT,
    QueryOptions.FILTER,
    QueryOptions.APPLY,
    QueryOptions.ORDERBY,
    QueryOptions.EXPAND,
    QueryOptions.SELECT
  ])
  .set(ResourceKind.ENTITY_COLLECTION, [
    QueryOptions.SEARCH,
    QueryOptions.COUNT,
    QueryOptions.SKIP,
    QueryOptions.SKIPTOKEN,
    QueryOptions.TOP,
    QueryOptions.FORMAT,
    QueryOptions.FILTER,
    QueryOptions.APPLY,
    QueryOptions.ORDERBY,
    QueryOptions.EXPAND,
    QueryOptions.SELECT
  ])
  .set(ResourceKind.ENTITY_COLLECTION + '/' + ResourceKind.COUNT, [
    QueryOptions.APPLY,
    QueryOptions.SEARCH,
    QueryOptions.FILTER
  ])
  .set(ResourceKind.ENTITY, [QueryOptions.EXPAND, QueryOptions.SELECT, QueryOptions.FORMAT])
  .set(ResourceKind.ENTITY + '/' + ResourceKind.VALUE, [QueryOptions.FORMAT])
  .set(ResourceKind.SINGLETON, [QueryOptions.EXPAND, QueryOptions.SELECT, QueryOptions.FORMAT])
  .set(ResourceKind.REF, [QueryOptions.FORMAT])
  .set(ResourceKind.REF_COLLECTION, [
    QueryOptions.SEARCH,
    QueryOptions.FILTER,
    QueryOptions.COUNT,
    QueryOptions.ORDERBY,
    QueryOptions.SKIP,
    QueryOptions.SKIPTOKEN,
    QueryOptions.TOP,
    QueryOptions.FORMAT
  ])
  .set(ResourceKind.COMPLEX_PROPERTY, [QueryOptions.EXPAND, QueryOptions.SELECT, QueryOptions.FORMAT])
  .set(ResourceKind.COMPLEX_COLLECTION_PROPERTY, [
    QueryOptions.APPLY,
    QueryOptions.FILTER,
    QueryOptions.COUNT,
    QueryOptions.ORDERBY,
    QueryOptions.SKIP,
    QueryOptions.SKIPTOKEN,
    QueryOptions.TOP,
    QueryOptions.EXPAND,
    QueryOptions.SELECT,
    QueryOptions.FORMAT
  ])
  .set(ResourceKind.COMPLEX_COLLECTION_PROPERTY + '/' + ResourceKind.COUNT, [QueryOptions.APPLY, QueryOptions.FILTER])
  .set(ResourceKind.PRIMITIVE_PROPERTY, [QueryOptions.FORMAT])
  .set(ResourceKind.PRIMITIVE_COLLECTION_PROPERTY, [
    QueryOptions.FILTER,
    QueryOptions.COUNT,
    QueryOptions.ORDERBY,
    QueryOptions.SKIP,
    QueryOptions.SKIPTOKEN,
    QueryOptions.TOP,
    QueryOptions.FORMAT
  ])
  .set(ResourceKind.PRIMITIVE_COLLECTION_PROPERTY + '/' + ResourceKind.COUNT, [QueryOptions.FILTER])
  .set(ResourceKind.PRIMITIVE_PROPERTY + '/' + ResourceKind.VALUE, [QueryOptions.FORMAT])
  .set(ResourceKind.ACTION_IMPORT, []) // used only for actions without return type
  .set(ResourceKind.BOUND_ACTION, []) // used only for actions without return type
  .set(ResourceKind.ENTITY_ID, [QueryOptions.ID])

/**
 * The RequestValidator should validate the incoming requests.
 */
class RequestValidator {
  /**
   * Sets the logger.
   * @param {LoggerFacade} logger the logger
   * @returns {RequestValidator} this instance
   */
  setLogger (logger) {
    this._logger = logger
    return this
  }

  /**
   * Validates if the query options have a debug option and if the debug option is valid.
   * The debug options is valid if the url contains "odata-debug=json|html"
   *
   * @param {Object} queryOptions The query options to validate
   * @throws {UriSyntaxError} Thrown if the debug option is not valid.
   */
  validateDebugOption (queryOptions) {
    if (queryOptions) {
      const debugQueryOption = queryOptions[QueryOptions.ODATA_DEBUG]
      if (debugQueryOption && debugQueryOption !== 'json' && debugQueryOption !== 'html') {
        throw new UriSyntaxError("Only 'json' or 'html' is valid for odata-debug query option")
      }
    }
  }

  /**
   * Validates the provided URL query options against a defined whitelist. If the validation
   * fails, the error thrown will give information which query option was not allowed and which
   * are are allowed for this type of request. If the URI info parameter is undefined or if
   * query options are undefined this method returns immediately.
   *
   * @param {Object} queryOptions The query options as key:value pairs
   * @param {UriInfo} uriInfo the URI info object, the result of the URI parser
   * @throws {UriSyntaxError} thrown if the validation fails
   */
  validateQueryOptions (queryOptions, uriInfo) {
    if (!uriInfo || !queryOptions) {
      return
    }

    const lastSegmentKind = RequestValidator._resolveUriResourceSegmentKind(uriInfo.getLastSegment())
    let key = lastSegmentKind
    // If $count or $value is used the segment before last is the one we must validate for query options.
    // $count and $value also change the available query options for this segment.
    if (key === ResourceKind.COUNT || key === ResourceKind.VALUE) {
      key = RequestValidator._resolveUriResourceSegmentKind(uriInfo.getLastSegment(-1)) + '/' + key
    }

    const whiteList = queryOptionsPerResourceKindWhiteList.get(key)
    for (const queryOptionName in queryOptions) {
      if (odataSystemQueryOptions.includes(queryOptionName) && !whiteList.includes(queryOptionName)) {
        throw new UriSyntaxError(UriSyntaxError.Message.OPTION_NOT_ALLOWED, queryOptionName, whiteList.toString())
      }
    }

    if (queryOptions[QueryOptions.SKIPTOKEN]) {
      // Skiptoken is currently only allowed if the request returns an EntityCollection or ReferenceCollection
      // This check can be removed, as soon as server side paging is supported for all ResourceKinds
      if (lastSegmentKind !== ResourceKind.ENTITY_COLLECTION && lastSegmentKind !== ResourceKind.REF_COLLECTION) {
        FeatureSupport.failUnsupported(FeatureSupport.features.QueryParameterSkipToken)
      }
      const segment = uriInfo.getLastSegment(lastSegmentKind === ResourceKind.REF_COLLECTION ? -1 : 0)

      // Skiptoken is only allowed for EntitySets that have a maxPageSize configured
      if (
        (lastSegmentKind === ResourceKind.ENTITY_COLLECTION || lastSegmentKind === ResourceKind.REF_COLLECTION) &&
        ((segment.getEntitySet() && !segment.getEntitySet().getMaxPageSize()) ||
          (segment.getTarget() && !segment.getTarget().getMaxPageSize()))
      ) {
        throw new UriQueryOptionSemanticError(
          UriQueryOptionSemanticError.Message.OPTION_NOT_ALLOWED,
          QueryOptions.SKIPTOKEN
        )
      }
    }
  }

  /**
   * Resolves the result uri resource segment kind regarding to query option validation.
   * This means, e.g., that an segment with kind <code>ResourceKind.NAVIGATION_TO_ONE</code> resolves to
   * <code>ResourceKind.ENTITY</code>.
   *
   * @param {UriResource} segment The resource segment
   * @returns {string} The corresponding resolved resource kind. Value from UriResource.ResourceKind.
   * @private
   */
  static _resolveUriResourceSegmentKind (segment) {
    const segmentKind = segment.getKind()
    switch (segmentKind) {
      case ResourceKind.NAVIGATION_TO_ONE:
        return ResourceKind.ENTITY

      case ResourceKind.NAVIGATION_TO_MANY:
        return ResourceKind.ENTITY_COLLECTION

      case ResourceKind.ACTION_IMPORT:
      case ResourceKind.BOUND_ACTION:
      case ResourceKind.FUNCTION_IMPORT:
      case ResourceKind.BOUND_FUNCTION: {
        const type = segment.getEdmType()
        if (!type) return segmentKind
        const isCollection = segment.isCollection()
        switch (type.getKind()) {
          case EdmTypeKind.PRIMITIVE:
          case EdmTypeKind.ENUM:
          case EdmTypeKind.DEFINITION:
            return isCollection ? ResourceKind.PRIMITIVE_COLLECTION_PROPERTY : ResourceKind.PRIMITIVE_PROPERTY
          case EdmTypeKind.COMPLEX:
            return isCollection ? ResourceKind.COMPLEX_COLLECTION_PROPERTY : ResourceKind.COMPLEX_PROPERTY
          case EdmTypeKind.ENTITY:
            return isCollection ? ResourceKind.ENTITY_COLLECTION : ResourceKind.ENTITY
          default:
            return segmentKind
        }
      }

      default:
        return segmentKind
    }
  }

  /**
   * Validate that the provided system query options are allowed
   * for the provided HTTP method (not GET) and request URI.
   * @param {Object} queryOptions The query options as key:value pairs
   * @param {HttpMethod.Methods} method the HTTP method
   * @param {UriInfo} uriInfo the uri info object. The result of the UriParser.
   * @throws {UriSyntaxError} thrown if the validation fails
   */
  validateQueryOptionsForNonGetHttpMethod (queryOptions, method, uriInfo) {
    if (!uriInfo || method === HttpMethods.GET) return

    const kind = uriInfo.getLastSegment().getKind()

    if (
      method === HttpMethods.DELETE &&
      kind === ResourceKind.REF_COLLECTION &&
      (!queryOptions || !queryOptions[QueryOptions.ID])
    ) {
      throw new UriSyntaxError(UriSyntaxError.Message.OPTION_EXPECTED, QueryOptions.ID)
    }

    if (!queryOptions) return

    for (const name in queryOptions) {
      if (odataSystemQueryOptions.indexOf(name) === -1) continue

      if (method === HttpMethods.POST) {
        if (kind === ResourceKind.ACTION_IMPORT || kind === ResourceKind.BOUND_ACTION) {
          // The allowed query options for actions depend on their return type.
          this.validateQueryOptions(queryOptions, uriInfo)
          continue
        }
      } else if (method === HttpMethods.DELETE) {
        // Only $id is allowed for DELETE on entity-references collections.
        if (name === QueryOptions.ID && kind === ResourceKind.REF_COLLECTION) continue
      }

      throw new UriSyntaxError(UriSyntaxError.Message.OPTION_NOT_ALLOWED, name, '')
    }
  }

  /**
   * Validates the version headers.
   * @param {string} version the OData version of this service
   * @param {Object} headers headers as object with header:headerValue
   */
  validateVersion (version, headers) {
    const versionValidator = new VersionValidator(version)

    const requestedVersion = headers[HeaderNames.ODATA_VERSION.toLowerCase()]
    if (requestedVersion) versionValidator.validateVersion(requestedVersion)

    const requestedMaxVersion = headers[HeaderNames.ODATA_MAXVERSION.toLowerCase()]
    if (requestedMaxVersion) versionValidator.validateMaxVersion(requestedMaxVersion)
  }

  /**
   * Validates the parsed preferences from Prefer header.
   * @param {Preferences} preferences the preferences
   * @param {HttpMethod.Methods} httpMethod the HTTP method
   * @param {UriResource[]} pathSegments the URI path segments
   * @throws {BadRequestError} if the validation fails
   */
  validatePreferences (preferences, httpMethod, pathSegments) {
    // Only 'return' is relevant here.
    // TODO: 8.2.8.7 Preference return...: any request to a stream property, SHOULD return a 4xx Client Error.
    if (preferences.getReturn()) {
      if (httpMethod === HttpMethods.GET || httpMethod === HttpMethods.DELETE) {
        throw new BadRequestError(`The 'return' preference is not allowed in ${httpMethod} requests`)
      }
      if (pathSegments[pathSegments.length - 1].getKind() === ResourceKind.BATCH) {
        throw new BadRequestError("The 'return' preference is not allowed in batch requests")
      }
      if (pathSegments[pathSegments.length - 1].getEdmType() === EdmPrimitiveTypeKind.Stream) {
        throw new BadRequestError("The 'return' preference is not allowed in requests to stream properties")
      }
    }
  }

  /**
   * Checks that no currently forbidden query options are there.
   * @param {Object} queryOptions the query options as key-value pairs
   */
  checkForForbiddenQueryOptions (queryOptions) {
    if (queryOptions) {
      for (const queryOptionsName in queryOptions) {
        const feature = queryOptionsBlackList.get(queryOptionsName)
        if (feature) FeatureSupport.failUnsupported(feature)
      }
    }
  }

  /**
   * Validates the requested CRUD operation against the given resource kind,
   * using the corresponding operation validator.
   * @param {OdataRequest} request the current request
   */
  validateOperationOnResource (request) {
    const httpMethod = request.getMethod()
    const segments = request.getUriInfo().getPathSegments()

    new OperationValidator(this._logger).validate(httpMethod, segments)
  }
}

module.exports = RequestValidator
