'use strict'

const commons = require('../../odata-commons')
const HeaderNames = commons.http.HttpHeader.HeaderNames
const PreferenceNames = commons.http.Preferences.Names
const MetaProperties = commons.format.JsonFormat.MetaProperties
const ValueValidator = commons.validator.ValueValidator
const Components = require('../core/ComponentManager').Components
const UriHelper = require('../utils/UriHelper')

const valueValidator = new ValueValidator()

/**
 * The ResponseHeaderSetter sets mandatory headers like the odata-version header,
 * content-type header, etc., in the response object.
 */
class ResponseHeaderSetter {
  /**
   * Creates an instance of ResponseHeaderSetter.
   * @param {OdataRequest} request the current OData request
   * @param {OdataResponse} response the current OData response
   * @param {string} version the supported OData version
   * @param {LoggerFacade} logger the logger
   */
  constructor (request, response, version, logger) {
    this._request = request
    this._response = response
    this._version = version
    this._logger = logger
  }

  /**
   * Sets mandatory headers like odata-version or content-type header in the response.
   * This method is a facade for several internal other methods to set the values.
   *
   * The following headers are set:
   *  - odata-version response header
   *  - content-type response header
   *
   * @param {boolean} [overwrite] If true all values will be overwritten regardless if they
   *          are set before, defaults to false
   * @returns {ResponseHeaderSetter} This instance of ResponseHeaderSetter
   */
  setHeaders (overwrite = false) {
    this.setOdataVersionHeader(overwrite)
    this.setContentTypeHeader(overwrite)
    return this
  }

  /**
   * Sets the odata-version header in the response.
   * This is only done if the header value is not already set,
   * except for overwrite=true then the setting of the value is forced.
   *
   * @param {boolean} [overwrite] If true all values will be overwritten regardless if they
   *          are set before, defaults to false
   * @returns { ResponseHeaderSetter} This instance of ResponseHeaderSetter
   */
  setOdataVersionHeader (overwrite = false) {
    this.setHeader(HeaderNames.ODATA_VERSION, this._version, overwrite)
    return this
  }

  /**
   * Set the content-type response header.
   * This is only done if the header value is not already set,
   * except for overwrite=true then the setting of the value is forced.
   *
   * @param {boolean} [overwrite] If true the Content-Type header value will be overwritten regardless if it is
   *           set before, defaults to false
   * @returns { ResponseHeaderSetter} This instance of ResponseHeaderSetter
   */
  setContentTypeHeader (overwrite = false) {
    const contract = this._response.getContract()
    if (contract.getContentTypeInfo()) {
      const headervalue = contract.getContentTypeInfo().toString()
      this.setHeader(HeaderNames.CONTENT_TYPE, headervalue, overwrite)
    }
    return this
  }

  /**
   * Set the location response header if the request has been an entity-create request.
   * This is only done if the header value is not already set.
   * If overwrite=true the setting of the value is forced.
   *
   * @param {boolean} [overwrite] If true all values will be overwritten regardless if they
   *          are set before, defaults to false
   * @returns {ResponseHeaderSetter} this instance of ResponseHeaderSetter
   */
  setLocationHeader (overwrite = false) {
    const uriInfo = this._request.getUriInfo()
    const data = this._response.getBody()
    const primitiveValueEncoder = this._request
      .getService()
      .getComponentManager()
      .getComponent(Components.PRIMITIVE_VALUE_ENCODER)
    const location = UriHelper.buildCanonicalUrl(
      uriInfo.getPathSegments(),
      UriHelper.buildEntityKeys(uriInfo.getFinalEdmType(), data.value, primitiveValueEncoder)
    )

    this.setHeader(HeaderNames.LOCATION, location, overwrite)
    return this
  }

  /**
   * Set the OData-EntityID response header.
   * This is only done if the header value is not already set.
   * If overwrite=true the setting of the value is forced.
   *
   * @param {boolean} [overwrite] If true all values will be overwritten regardless if they
   *          are set before, defaults to false
   * @returns {ResponseHeaderSetter} this instance of ResponseHeaderSetter
   */
  setOdataEntityIdHeader (overwrite = false) {
    const uriInfo = this._request.getUriInfo()
    const data = this._response.getBody()
    const primitiveValueEncoder = this._request
      .getService()
      .getComponentManager()
      .getComponent(Components.PRIMITIVE_VALUE_ENCODER)
    const id = UriHelper.buildCanonicalUrl(
      uriInfo.getPathSegments(),
      UriHelper.buildEntityKeys(uriInfo.getFinalEdmType(), data.value, primitiveValueEncoder)
    )

    this.setHeader(HeaderNames.ODATA_ENTITYID, id, overwrite)
    return this
  }

  /**
   * Set the etag response header.
   * This is only done if the header value is not already set.
   * If overwrite=true the setting of the value is forced.
   *
   * @param {boolean} [overwrite] If true the ETag header value will be overwritten regardless if it is
   *           set before, defaults to false
   * @returns {ResponseHeaderSetter} this instance of ResponseHeaderSetter
   */
  setEtagHeader (overwrite = false) {
    const data = this._response.getBody()
    const etag = (data && data[MetaProperties.ETAG]) || (data && data.value && data.value[MetaProperties.ETAG])
    if (etag !== null && etag !== undefined) {
      valueValidator.validateEtagValue(etag)
      this.setHeader(HeaderNames.ETAG, `W/"${etag}"`, overwrite)
    }

    return this
  }

  /**
   * Set the Preference-Applied header.
   * This is only done if the header value is not already set.
   * If overwrite=true the setting of the value is forced.
   *
   * @param {boolean} [overwrite] If true the Preference-Applied header value will be overwritten regardless
   *                              if it is set before, defaults to false
   * @returns {ResponseHeaderSetter} this instance of ResponseHeaderSetter
   */
  setPreferenceAppliedHeader (overwrite = false) {
    const preferencesApplied = this._response.getPreferencesApplied()
    const appliedPreferences = []

    if (preferencesApplied.getOdataAllowEntityReferencesApplied()) {
      appliedPreferences.push(PreferenceNames.ALLOW_ENTITYREFERENCES)
    }

    if (preferencesApplied.getOdataCallbackApplied()) {
      appliedPreferences.push(PreferenceNames.CALLBACK)
    }

    if (preferencesApplied.getOdataContinueOnErrorApplied()) {
      appliedPreferences.push(PreferenceNames.CONTINUE_ON_ERROR)
    }

    if (preferencesApplied.getOdataIncludeAnnotationsApplied()) {
      appliedPreferences.push(PreferenceNames.INCLUDE_ANNOTATIONS)
    }

    if (preferencesApplied.getOdataMaxPageSizeApplied()) {
      appliedPreferences.push(`${PreferenceNames.MAXPAGESIZE}=${preferencesApplied.getOdataMaxPageSizeApplied()}`)
    }

    if (preferencesApplied.getRespondAsyncApplied()) {
      appliedPreferences.push(PreferenceNames.RESPOND_ASYNC)
    }

    if (preferencesApplied.getReturnApplied()) {
      appliedPreferences.push(`${PreferenceNames.RETURN}=${preferencesApplied.getReturnApplied()}`)
    }

    if (preferencesApplied.getOdataTrackChangesApplied()) {
      appliedPreferences.push(PreferenceNames.TRACK_CHANGES)
    }

    if (preferencesApplied.getWaitApplied()) {
      appliedPreferences.push(`${PreferenceNames.WAIT}=${preferencesApplied.getWaitApplied()}`)
    }

    for (const preference of preferencesApplied.getCustomPreferencesApplied()) {
      const preferenceName = preference[0]
      let preferenceValue = preference[1]

      if (preferenceValue === true) {
        // No value was set
        appliedPreferences.push(preferenceName)
      } else appliedPreferences.push(preferenceName + '=' + preferenceValue) // A specific value was set
    }

    if (appliedPreferences.length > 0) {
      this.setHeader(HeaderNames.PREFERENCE_APPLIED, appliedPreferences.join(','), overwrite)
    }

    return this
  }

  /**
   * Set the response header found by header name to the provided header value.
   * This is only done if the header value is not already set.
   * If overwrite=true the setting of the value is forced.
   *
   * @param {string} headerName Header name
   * @param {string} headerValue Header value
   * @param {boolean} [overwrite] If true the value will be overwritten regardless if it is
   *                              set before, defaults to false
   * @returns {ResponseHeaderSetter} this instance of ResponseHeaderSetter
   */
  setHeader (headerName, headerValue, overwrite = false) {
    if (!this._response.getHeader(headerName) || overwrite) {
      this._logger.debug('Set header in response:', headerName, '=', headerValue, ', Overwrite:', overwrite)
      this._response.setHeader(headerName, headerValue)
    }
    return this
  }
}

module.exports = ResponseHeaderSetter
