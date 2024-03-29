'use strict'

const url = require('url')
const commons = require('../../odata-commons')
const HttpStatusCodes = commons.http.HttpStatusCode.StatusCodes
const HttpMethods = commons.http.HttpMethod.Methods
const HeaderNames = commons.http.HttpHeader.HeaderNames
const ResourceKind = commons.uri.UriResource.ResourceKind
const EdmTypeKind = commons.edm.EdmType.TypeKind

const RequestContract = require('./RequestContract')
const UriHelper = require('../utils/UriHelper')
const Preferences = require('../http/Preferences')
const ConditionalRequestValidator = require('../validator/ConditionalRequestValidator')

/**
 * Request object wrapper to carry original request information.
 * @hideconstructor
 */
class OdataRequest {
  /**
   * Creates an instance of OdataRequest.
   * The constructor also splits the URL into service, OData, and query parts.
   *
   * @param {Object} inRequest a request object with {method, url, headers, payload}
   * @param {Function} serviceResolutionFn function to resolve the service root in the request URL;
   *                                       it must return the OData path part of the input URL
   */
  constructor (inRequest, serviceResolutionFn) {
    this._inRequest = inRequest
    this._serviceResolutionFn = serviceResolutionFn

    /**
     * OData request ID, set in case of batch processing from the deserialized OData batch payload
     * @type {?string}
     * @private
     */
    this._odataRequestId = this._inRequest.getOdataRequestId ? this._inRequest.getOdataRequestId() : null
    this._atomicityGroupId = this._inRequest.getAtomicityGroupId ? this._inRequest.getAtomicityGroupId() : null
    this._url = url.parse(this._inRequest.url)

    this._rawODataPath = null
    this._queryOptions = null
    this._uriInfo = null

    /**
     * @type {RequestContract}
     * @private
     */
    this._contract = new RequestContract()

    this._body = null
    this._preferences = null
    this._service = null
    this._logger = null
    this._validateEtagHasBeenCalled = false
    this._isConditional = null
    this._etagValidationOutCome = HttpStatusCodes.OK
    this._concurrentSegment = null
    this._getConcurrentResourceHasBeenCalled = false
    this._applicationData = null

    // Transfer batch information to the batched OdataRequest.
    this._batchContext = this._inRequest.getBatchContext ? this._inRequest.getBatchContext() : null

    this._deepInsertExpand = []
    this._hasDelta = false
    this._inRequestUrl = inRequest.url
  }

  /**
   * Returns the current logger instance.
   * @returns {LoggerFacade} The current logger
   */
  getLogger () {
    return this._logger
  }

  /**
   * Sets the current logger instance.
   * @param {LoggerFacade} logger The current logger
   * @returns {OdataRequest} This OData request instance
   * @package
   */
  setLogger (logger) {
    this._logger = logger
    return this
  }

  /**
   * Returns the resource-path part of the request URL that belongs to OData.
   * @returns {string} undecoded OData path, e.g., "Employees"
   */
  getOdataPath () {
    if (this._rawODataPath === null) this._rawODataPath = this._serviceResolutionFn(this._url.pathname || '')
    return this._rawODataPath
  }

  /**
   * Returns the request method.
   * @returns {string} The request method like GET, PUT, POST, ...
   */
  getMethod () {
    return this._inRequest.method
  }

  /**
   * Returns the header value for a given name.
   * @param {string} name the name of the header
   * @returns {string} The header value or undefined, if not found
   */
  getHeader (name) {
    return this._inRequest.headers[name]
  }

  /**
   * Returns all available headers.
   * @returns {Object} All headers with header:headerValue
   */
  getHeaders () {
    return this._inRequest.headers
  }

  /**
   * Returns the parsed url object parsed with node.js url module.
   * @returns {Object} The parsed url object.
   */
  getUrlObject () {
    return this._url
  }

  /**
   * Returns the current query options. Structure of the object is defined as follows
   * Example:
   *  url: http://server:port/service/?foo=bar1&foo=bar2&bar=foo
   *  result:
   *  {
   *   foo: ['bar1', 'bar2'],
   *   bar: 'foo'
   *  }
   *
   * @returns {Object} the parsed query-options object
   */
  getQueryOptions () {
    if (this._queryOptions === null) this._queryOptions = UriHelper.parseQueryString(this._url.search)
    return this._queryOptions
  }

  /**
   * Sets the UriInfo object. This is done while processing the request.
   * @param {UriInfo} uriInfo The uri info
   * @returns {OdataRequest} this request object
   * @package
   */
  setUriInfo (uriInfo) {
    this._uriInfo = uriInfo
    return this
  }

  /**
   * Returns the URI info object.
   * This object is the result of the URI parsing and will be set
   * while processing the request but before reaching the application handlers.
   *
   * @returns {UriInfo} the URI info object.
   */
  getUriInfo () {
    return this._uriInfo
  }

  /**
   * Returns the current request contract.
   * @returns {RequestContract} The current request contract
   */
  getContract () {
    return this._contract
  }

  /**
   * Sets the request body. The body is set though the parsing of the payload.
   * @param {*} body The request body
   * @returns {OdataRequest} This instance
   * @package
   */
  setBody (body) {
    this._body = body
    return this
  }

  /**
   * Returns the request body created by application. This is the parsed result of the request payload.
   * @returns {*} request body
   */
  getBody () {
    return this._body
  }

  /**
   * Sets the parsed preferences.
   * @param {Preferences} preferences the preferences
   * @returns {OdataRequest} this request object
   * @package
   */
  setPreferences (preferences) {
    this._preferences = preferences
    return this
  }

  /**
   * Returns the preferences parsed from the request header.
   * @returns {Preferences} the preferences
   */
  getPreferences () {
    if (!this._preferences) this._preferences = new Preferences()
    return this._preferences
  }

  /**
   * Returns the original incoming node request message.
   * @returns {IncomingMessage} the original incoming request
   */
  getIncomingRequest () {
    return this._inRequest
  }

  /**
   * Sets the used service instance.
   * @param {Service} service the service instance
   * @returns {OdataRequest} this request object
   * @package
   */
  setService (service) {
    this._service = service
    return this
  }

  /**
   * Returns the used service instance.
   * @returns {Service} the service instance
   */
  getService () {
    return this._service
  }

  /**
   * Returns true if this request is a conditional request.
   * A request is conditional if the HTTP header If-Match or the HTTP header If-None-Match is present
   * and if these headers are not containing only '*' in the case of HTTP PATCH/PUT/DELETE/POST (for PATCH
   * and PUT this is used to control upsert behavior, for DELETE and POST to make careless clients happy).
   * A GET request with an If-Match header value of '*' is also not conditional.
   * Doublequotes around '*' are allowed, although this is not specified in RFC 7232.
   * @returns {boolean} whether this request is conditional
   */
  isConditional () {
    if (this._isConditional === null) {
      const method = this.getMethod()

      let ifMatch = this.getHeader(HeaderNames.IF_MATCH.toLowerCase())
      if (ifMatch) ifMatch = ifMatch.trim()
      if (ifMatch === '"*"') ifMatch = '*'

      let ifNoneMatch = this.getHeader(HeaderNames.IF_NONE_MATCH.toLowerCase())
      if (ifNoneMatch) ifNoneMatch = ifNoneMatch.trim()
      if (ifNoneMatch === '"*"') ifNoneMatch = '*'

      this._isConditional =
        !(method === HttpMethods.GET && ifMatch === '*' && !ifNoneMatch) &&
        !(
          [HttpMethods.PATCH, HttpMethods.PUT, HttpMethods.DELETE, HttpMethods.POST].includes(method) &&
          (ifMatch === '*' || ifNoneMatch === '*')
        ) &&
        Boolean(ifMatch || ifNoneMatch)
    }
    return this._isConditional
  }

  /**
   * Validates a provided resource ETag value against the values of the conditional ETag HTTP headers
   * If-Match and If-None-Match.
   * @param {string} etag the ETag value of the resource
   * @returns {HttpStatusCode.StatusCodes.OK | HttpStatusCode.StatusCodes.NOT_MODIFIED} OK, if validation was ok,
   *      NOT_MODIFIED if etag values are matching indicating that the resource was not modified
   * @throws {PreconditionFailedError} if the validations failed
   */
  validateEtag (etag) {
    this._logger.debug('Provided etag:', etag)

    this._validateEtagHasBeenCalled = true

    const outcome = new ConditionalRequestValidator().validateEtag(
      this.getHeader(HeaderNames.IF_MATCH.toLowerCase()),
      this.getHeader(HeaderNames.IF_NONE_MATCH.toLowerCase()),
      this.getMethod(),
      this._uriInfo.getLastSegment().getKind(),
      etag
    )
    this._etagValidationOutCome = outcome ? HttpStatusCodes.NOT_MODIFIED : HttpStatusCodes.OK
    this._logger.debug('Outcome of conditional request processing ETag validation:', this._etagValidationOutCome)

    return this._etagValidationOutCome
  }

  /**
   * Returns the concurrent UriResource segment if the resource addressed by this URI is concurrent.
   * @returns {?UriResource} the concurrent UriResource segment, if this resource is concurrent, else null
   */
  getConcurrentResource () {
    if (this._getConcurrentResourceHasBeenCalled) return this._concurrentSegment

    const lastSegment = this._uriInfo.getLastSegment()
    const kind = lastSegment.getKind()

    let segment = null
    if (kind === ResourceKind.METADATA || kind === ResourceKind.SERVICE) {
      segment = lastSegment
    } else {
      segment =
        this.getMethod() !== HttpMethods.GET && (kind === ResourceKind.REF || kind === ResourceKind.REF_COLLECTION)
          ? this._uriInfo.getLastSegment(-2)
          : this._uriInfo
            .getPathSegments()
            .reduceRight(
              (result, tempSegment) =>
                (!result &&
                    !tempSegment.getAction() &&
                    tempSegment.getEdmType() &&
                    tempSegment.getEdmType().getKind() === EdmTypeKind.ENTITY &&
                    !(tempSegment.getNavigationProperty() && tempSegment.getNavigationProperty().containsTarget())) ||
                  tempSegment.getFunction()
                  ? tempSegment
                  : result,
              null
            )
      if (
        segment &&
        !(
          (segment.getEntitySet() && segment.getEntitySet().isConcurrent()) ||
          (segment.getSingleton() && segment.getSingleton().isConcurrent()) ||
          (segment.getTarget() && segment.getTarget().isConcurrent())
        )
      ) {
        segment = null
      }
    }
    this._getConcurrentResourceHasBeenCalled = true
    this._concurrentSegment = segment
    return segment
  }

  /**
   * Returns the outcome of the ETag validation process. This can be one of the following outcomes:
   *  - HttpStatusCode.OK = Validation was ok
   *  - HttpStatusCode.NOT_MODIFIED = Validation was ok and outcome is "resource is not modified"
   * Default is HttpStatusCode.OK.
   *
   * @returns {HttpStatusCode.StatusCodes.OK | HttpStatusCode.StatusCodes.NOT_MODIFIED} The status code
   * @package
   */
  getETAGValidationStatus () {
    return this._etagValidationOutCome
  }

  /**
   * Returns true if the ETag validation has been called.
   * @returns {boolean} true if the ETag validation has been called, else false
   * @package
   */
  validateEtagHasBeenCalled () {
    return this._validateEtagHasBeenCalled
  }

  /**
   * Returns OData request ID.
   * @returns {?string} the request ID
   */
  getOdataRequestId () {
    return this._odataRequestId
  }

  /**
   * Returns atomicity group ID.
   * @returns {?string} the group ID
   */
  getAtomicityGroupId () {
    return this._atomicityGroupId
  }

  /**
   * Returns custom application data associated with this request.
   * @returns {Object} data the application data
   */
  getApplicationData () {
    return this._applicationData
  }

  /**
   * Sets custom application data.
   * @param {Object} data the custom application data
   * @returns {OdataRequest} this request object
   */
  setApplicationData (data) {
    this._applicationData = data
    return this
  }

  /**
   * Returns custom application data associated with the batch request containing this request.
   * @returns {Object} the custom application data associated with the batch request
   */
  getBatchApplicationData () {
    return this._batchContext ? this._batchContext.getRequest().getApplicationData() : null
  }

  /**
   * Sets an ExpandItem array; these are the top-level expands from a deep insert.
   * @param {ExpandItem[]} expand the expand items to set
   * @returns {OdataRequest} this instance of OdataRequest
   * @package
   */
  setDeepInsertExpand (expand) {
    this._deepInsertExpand = expand
    return this
  }

  /**
   * Returns the top-level expand items from a deep-insert payload or an empty array if the payload is not nested.
   * @returns {ExpandItem[]} the top-level expand items derived from a deep insert payload;
   *                         can be empty if there is no expand item available but not null
   */
  getDeepInsertExpand () {
    return this._deepInsertExpand
  }

  /**
   * Sets the information that there is a delta annotation in the request.
   * @param {boolean} hasDelta whether there is a delta annotation in the request
   * @returns {OdataRequest} this instance of OdataRequest
   * @package
   */
  setHasDelta (hasDelta) {
    this._hasDelta = hasDelta
    return this
  }

  /**
   * Returns the information whether there is a delta annotation in the request.
   * @returns {boolean} whether there is a delta annotation in the request
   */
  hasDelta () {
    return this._hasDelta
  }
}

module.exports = OdataRequest
