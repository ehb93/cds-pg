'use strict'

const commons = require('../../odata-commons')
const ResourceKind = commons.uri.UriResource.ResourceKind
const RepresentationKinds = commons.format.RepresentationKind.Kinds
const HttpMethods = commons.http.HttpMethod.Methods
const HttpStatusCode = commons.http.HttpStatusCode.StatusCodes
const PreferenceNames = commons.http.Preferences.ReturnValues
const Command = require('./Command')
const ResponseHeaderSetter = require('../core/ResponseHeaderSetter')

/**
 * Executes the setting of response headers.
 * @extends Command
 */
class SetResponseHeadersCommand extends Command {
  /**
   * Creates an instance of SetResponseHeadersCommand.
   * @param {OdataRequest} request the current OData request
   * @param {OdataResponse} response the current OData response
   * @param {FormatManager} formatManager the format manager
   * @param {LoggerFacade} logger the logger
   */
  constructor (request, response, formatManager, logger) {
    super()
    this._request = request
    this._response = response
    this._formatManager = formatManager
    this._logger = logger
  }

  /**
   * Executes the setting of response headers and OData annotations needed for serializing.
   * @param {Next} next The next callback to be called on finish
   */
  execute (next) {
    if (this._response.isHeadersSent()) {
      this._logger.warning('Headers already sent')
    } else {
      const responseHeaderSetter = new ResponseHeaderSetter(this._request, this._response, null, this._logger)
      const responseContract = this._response.getContract()

      responseHeaderSetter.setPreferenceAppliedHeader()
      if (this._response.getPreferencesApplied().getReturnApplied() === PreferenceNames.MINIMAL) {
        responseContract.setRepresentationKind(RepresentationKinds.NO_CONTENT)
        // Overwrite registered serializer with the NO_CONTENT serializer function.
        responseContract.setSerializerFunction(
          this._formatManager.getFormatDescriptions(RepresentationKinds.NO_CONTENT, null)[0].getSerializerFunction()
        )
      }

      const representationKind = responseContract.getRepresentationKind()
      const method = this._request.getMethod()
      const lastSegment = this._request.getUriInfo().getLastSegment()

      // Set the Location response header if the request has been an entity-create request
      // or if the handler implementation has set the status code to CREATED.
      if (
        (method === HttpMethods.POST &&
          (lastSegment.getKind() === ResourceKind.ENTITY_COLLECTION ||
            lastSegment.getKind() === ResourceKind.NAVIGATION_TO_MANY)) ||
        (this._response.getStatusCode() === HttpStatusCode.CREATED &&
          lastSegment.getKind() !== ResourceKind.ACTION_IMPORT &&
          lastSegment.getKind() !== ResourceKind.BOUND_ACTION)
      ) {
        responseHeaderSetter.setLocationHeader()
        // Set the OData-EntityId header if a create operation returns 204 No Content.
        if (representationKind === RepresentationKinds.NO_CONTENT) {
          responseHeaderSetter.setOdataEntityIdHeader()
        }
      }

      if (
        (lastSegment.getAction()
          ? lastSegment.getTarget() && lastSegment.getTarget().isConcurrent()
          : this._request.getConcurrentResource()) &&
        representationKind !== RepresentationKinds.ENTITY_COLLECTION &&
        representationKind !== RepresentationKinds.COUNT &&
        representationKind !== RepresentationKinds.REFERENCE &&
        representationKind !== RepresentationKinds.REFERENCE_COLLECTION
      ) {
        responseHeaderSetter.setEtagHeader()
      }
    }

    next()
  }
}

module.exports = SetResponseHeadersCommand
