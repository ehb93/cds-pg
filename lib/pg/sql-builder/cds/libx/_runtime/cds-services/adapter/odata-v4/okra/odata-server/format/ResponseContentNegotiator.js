'use strict'

const commons = require('../../odata-commons')
const QueryOptions = commons.uri.UriInfo.QueryOptions
const RepresentationKind = commons.format.RepresentationKind
const RepresentationKinds = RepresentationKind.Kinds
const ContentTypeInfo = commons.format.ContentTypeInfo
const ContentTypes = ContentTypeInfo.ContentTypes
const JsonContentTypeInfo = commons.format.JsonContentTypeInfo
const FormatParameter = JsonContentTypeInfo.FormatParameter
const FormatParameterMetadataValues = JsonContentTypeInfo.FormatParameterMetadataValues
const HttpMethods = commons.http.HttpMethod.Methods
const HeaderNames = commons.http.HttpHeader.HeaderNames
const CharsetInfo = require('./CharsetInfo')
const AcceptTypeInfo = require('./AcceptTypeInfo')
const HttpHeader = require('../http/HttpHeader')
const ResponseContract = require('../core/ResponseContract')
const NotAcceptableError = require('../errors/NotAcceptableError')

class ResponseContentNegotiator {
  /**
   * Sets the logger.
   * @param {LoggerFacade} logger the logger
   * @returns {ResponseContentNegotiator} this instance
   */
  setLogger (logger) {
    this._logger = logger
    return this
  }

  /**
   * Performs the response content negotiation for the HTTP request.
   * The negotiation uses the request information and the representation kind to
   * find the best matching response content type for which a capable serializer has been registered.
   *
   * The accept header used to determine the response content type is calculated as follows:
   * If the <code>uriInfo</code> is provided, the <code>$format</code> query information from this
   * <code>uriInfo</code> is used to build the accept header.
   * If there is no <code>uriInfo</code> but an HTTP request, then the accept header value of this request is used.
   * If there is no request, it is assumed the client has no preference. So no negotiation happens, and the first
   * registered format for the representation kind is used.
   *
   * @param {FormatManager} formatManager Format manager containing the list of supported formats
   * @param {OdataRequest} inRequest Node's inbound HTTP request
   * @param {UriInfo} uriInfo OData URI information
   * @returns {ResponseContract} The contract containing the negotiated information
   */
  negotiate (formatManager, inRequest, uriInfo) {
    let accept
    let acceptCharset
    let acceptFromFormat = false

    if (inRequest) {
      accept = inRequest.getHeader(HeaderNames.ACCEPT)
      acceptCharset = inRequest.getHeader(HeaderNames.ACCEPT_CHARSET)
      const queryOptions = inRequest.getQueryOptions()

      if (queryOptions && queryOptions[QueryOptions.FORMAT]) {
        const format = queryOptions[QueryOptions.FORMAT]
        this._logger.debug('$format query option:', format)
        const formatLowerCase = format.toLowerCase()

        if (formatLowerCase === 'json') {
          accept = ContentTypes.JSON
        } else if (formatLowerCase === 'xml') {
          accept = ContentTypes.XML
        } else {
          accept = format
        }
        acceptFromFormat = true
      }
    }

    let representationKind

    if (uriInfo) {
      const method = inRequest ? inRequest.getMethod() : HttpMethods.GET
      representationKind = RepresentationKind.getResponseRepresentationKind(uriInfo, method)

      switch (representationKind) {
        case RepresentationKinds.NO_CONTENT:
          // Ignore the Accept header (and $format) if the response will not have any content.
          accept = undefined
          break

        case RepresentationKinds.COUNT:
          // According to OData-Spec, Part-1 11.2.9, the path segment $count must skip the
          // content negotiation; i.e., the Accept header is ignored, and $format is rejected
          // earlier at the query options validation.
          accept = ContentTypes.TEXT_PLAIN
          break

        case RepresentationKinds.BATCH:
          // According to HTTP/1.1 Semantics and Content specification (RFC 7231) of June 2014,
          // a request without any Accept header field implies that the user agent will accept any
          // media type in response. However, according to the OData Version 4.01 (Part 1: Protocol
          // 11.7.1 Batch Request Headers) specification, if no Accept header is provided for a
          // batch request, services SHOULD respond with the content type of the request.
          //
          // For interoperability reasons, the following implementation honors the OData version 4.01
          // specification over the HTTP/1.1 specification, as some HTTP clients based on version 4.0
          // of the protocol do not accept JSON responses for batch requests.
          // JSON batch responses weren't even defined until OData V4.01.
          // So, strictly speaking, the JSON format for batch responses isn't valid in a OData 4.0
          // response.
          const contentType = inRequest.getHeader(HeaderNames.CONTENT_TYPE)

          // Caveat: Some HTTP clients, e.g., curl and modern web browsers, automatically set the
          // Accept header to */* (any MIME type) if it is not explicitly provided.
          const acceptHeaderNotProvided = accept === undefined
          const acceptAnyMediaType = accept === '*/*'

          if (acceptHeaderNotProvided || acceptAnyMediaType) {
            // parse the content type string to exclude the boundary parameter assuming that the
            // content type is set to multipart/mixed
            accept = contentType.split(';')[0]
          }

          break

        // no default
      }
    } else {
      representationKind = RepresentationKinds.ERROR
    }

    this._logger.debug('response representation kind:', representationKind)

    const responseContract = this.negotiateContentType(formatManager, representationKind, accept)
    const contentTypeInfo = responseContract.getContentTypeInfo()

    if (contentTypeInfo) {
      this.negotiateCharset(contentTypeInfo, acceptCharset, acceptFromFormat)
    }

    return responseContract
  }

  /**
   * Performs the content negotiation for the content type.
   * From the request the representation kind, the accept header and the $format query parameter are used to perform
   * the negotiation with all registered formats of the representation kind. If the $format parameter is specified it wins.
   * The result of the negotiation is written into an contract object for later use.
   *
   * @param {FormatManager} formatManager Format manager with registered formats
   * @param {RepresentationKind.Kinds} representationKind the representation kind
   * @param {?string} acceptHeader Accept header
   * @returns {ResponseContract} contract
   */
  negotiateContentType (formatManager, representationKind, acceptHeader) {
    const formatDescriptions = formatManager.getAllFormatDescriptions(representationKind)
    let formatDescription
    let contentTypeInfo
    if (acceptHeader) {
      let accept = acceptHeader
      if (accept === 'multipart/mixed') {
        accept = accept + ',application/json' // allow also application/json for the case that an atomicity group becomes replaced by an error
      }
      const acceptTypeInfos = HttpHeader.parseAcceptHeader(accept).sort(AcceptTypeInfo.compare)
      for (const acceptTypeInfo of acceptTypeInfos) {
        const params = acceptTypeInfo.getParameters().filter(ele => !ele.name || !ele.name.match(FormatParameter.ODATA_METADATA))
        for (const formatDesc of formatDescriptions) {
          if (
            acceptTypeInfo.match(formatDesc.getTypeAndSubtype()) &&
            formatDesc.getParameterCheckFunction()(params)
          ) {
            formatDescription = formatDesc
            contentTypeInfo = new ContentTypeInfo().setMimeType(formatDescription.getTypeAndSubtype())
            this._addOdataMetadataParameter(contentTypeInfo, representationKind)
            for (const parameter of acceptTypeInfo.getParameters()) {
              if (parameter.name !== FormatParameter.ODATA_METADATA) {
                contentTypeInfo.addParameter(parameter.name, parameter.value)
              }
            }
            break
          }
        }
        if (formatDescription) break
      }
    }

    /*
     * original okra:
     *   If the accept header and the $format query parameter are both unknown, no negotiation is possible.
     *   In that case the first of the list of content types registered for the representation kind is used.
     * added: if BINARY, use first and check if content type in accept header in read handler
     */
    if (!acceptHeader || (!formatDescription && representationKind === 'BINARY')) {
      formatDescription = formatDescriptions[0]
      contentTypeInfo = formatDescription
        ? new ContentTypeInfo().setMimeType(formatDescription.getTypeAndSubtype())
        : null
      this._addOdataMetadataParameter(contentTypeInfo, representationKind)
    }

    if (!formatDescription) {
      this._logger.warning(
        `No matching content type found for representation kind '${representationKind}'` +
          ` and accept '${acceptHeader}'`
      )
      throw new NotAcceptableError("Missing format for representation kind '" + representationKind + "'")
    }

    return new ResponseContract()
      .setRepresentationKind(representationKind)
      .setSerializerFunction(formatDescription.getSerializerFunction())
      .setContentTypeInfo(representationKind === RepresentationKinds.NO_CONTENT ? null : contentTypeInfo)
  }

  /**
   * Chooses the correct charset, depending on what was specified in the Accept and Accept-Charset header,
   * as well as the $format query option. The basic rules here:
   * $format takes precedence over Accpet & charset in $format takes precedence over AcceptCharset
   * AcceptCharset takes precedence over charset in Accept.
   * Accept-Charset is used, when neither Accept nor $format contains a charset.
   *
   * @param {ContentTypeInfo} contentTypeInfo The resulting contentTypeInfo of the contentNegotiation
   * @param {?string} acceptCharset The value of the AcceptCharset header if present
   * @param {boolean} acceptFromFormat True if $format took precedence over accept, false otherwise
   */
  negotiateCharset (contentTypeInfo, acceptCharset, acceptFromFormat) {
    const acceptCharsetPresent = acceptCharset !== null && acceptCharset !== undefined
    let validCharsetInfo = this._getSupportedCharset(acceptCharset)

    let charsetAlreadySet = false
    for (const parameter of contentTypeInfo.getParameters()) {
      if (parameter.name === 'charset') {
        charsetAlreadySet = true
        const tempCharsetInfoFormat = new CharsetInfo(parameter.value)
        if (acceptFromFormat) {
          if (!tempCharsetInfoFormat.isSupported()) {
            throw new NotAcceptableError(`The charset "${parameter.value}" specified ` + 'in $format is not supported')
          } else if (tempCharsetInfoFormat.isAll()) {
            parameter.value = CharsetInfo.CHARSETS.UTF_8
          }

          // If accept did not come from $format, AcceptCharset takes precedence
          // over a charset format-parameter in accept.
        } else if (acceptCharsetPresent && !validCharsetInfo) {
          throw new NotAcceptableError(`No supported charset found in Accept-Charset "${acceptCharset}"`)
        } else if (validCharsetInfo) {
          parameter.value = validCharsetInfo.isAll() ? CharsetInfo.CHARSETS.UTF_8 : validCharsetInfo.getCharset()
        } else {
          const tempCharsetInfoAccept = new CharsetInfo(parameter.value)
          if (!tempCharsetInfoAccept.isSupported()) {
            throw new NotAcceptableError(
              `The charset "${parameter.value}" specified in the accept header is not supported`
            )
          } else if (tempCharsetInfoAccept.isAll()) {
            parameter.value = CharsetInfo.CHARSETS.UTF_8
          }
        }
        break
      }
    }

    if (!charsetAlreadySet && acceptCharsetPresent) {
      if (!validCharsetInfo) {
        throw new NotAcceptableError(`No supported charset found in Accept-Charset "${acceptCharset}"`)
      } else {
        contentTypeInfo.addParameter(
          'charset',
          validCharsetInfo.isAll() ? CharsetInfo.CHARSETS.UTF_8 : validCharsetInfo.getCharset()
        )
      }
    }
  }

  /**
   * Parses the AcceptCharset Header and checks for a supported charset in it.
   *
   * @param {?string} acceptCharset The value of the AcceptCharset header if present
   * @returns {?CharsetInfo} A valid charset or null, if none found
   * @private
   */
  _getSupportedCharset (acceptCharset) {
    let validCharsetInfo = null
    if (acceptCharset) {
      this._logger.debug('Accept-Charset header:', acceptCharset)
      const charsetInfos = HttpHeader.parseAcceptCharsetHeader(acceptCharset)
      for (const charsetInfo of charsetInfos) {
        if (charsetInfo.isAll()) {
          validCharsetInfo = new CharsetInfo('utf-8')
        } else if (charsetInfo.isSupported()) {
          validCharsetInfo = charsetInfo
        }
      }
    }
    return validCharsetInfo
  }

  /**
   * Adds the odata.metadata=minimal parameter if applicable
   * @param {ContentTypeInfo} contentTypeInfo The ContentTypeInfo the parameter should be added to
   * @param {RepresentationKind.Kinds} representationKind The RepresentationKind
   * @private
   */
  _addOdataMetadataParameter (contentTypeInfo, representationKind) {
    if (
      contentTypeInfo &&
      contentTypeInfo.getMimeType() === ContentTypes.JSON &&
      representationKind !== RepresentationKinds.DEBUG
    ) {
      contentTypeInfo.addParameter(FormatParameter.ODATA_METADATA, FormatParameterMetadataValues.MINIMAL)
    }
  }
}

module.exports = ResponseContentNegotiator
