'use strict'

const commons = require('../../odata-commons')
const HttpMethods = commons.http.HttpMethod.Methods
const RepresentationKinds = commons.format.RepresentationKind.Kinds
const MetaProperties = commons.format.JsonFormat.MetaProperties
const Command = require('./Command')
const ContextUrlFactory = require('../serializer/ContextURLFactory')
const NextLinkSerializer = require('../serializer/NextLinkSerializer')
const ExpandHelper = require('../utils/ExpandHelper')
const InternalServerError = require('../errors/InternalServerError')

/**
 * The `next` callback to be called upon finish execution.
 * @callback Next
 * @param {?Error} error An error if there is one or null if not
 */

/**
 * Executes the serialization of the provided data.
 * @extends Command
 */
class SerializingCommand extends Command {
  /**
   * Executes the registered serializing function bound with the contract created from the content negotiation.
   * @param {Next} next The next callback to be called on finish
   * @returns {undefined}
   */
  execute (next) {
    const context = this.getContext()
    const logger = context.getLogger()

    const request = context.getRequest()
    const response = context.getResponse()

    if (response.isHeadersSent()) {
      logger.warning('Headers already sent')
      return next()
    }

    if (request.getMethod() === HttpMethods.HEAD) {
      // A body in the response is not needed in a HEAD request.
      response.setBody('')
      return next()
    }

    const responseContract = response.getContract()
    const representationKind = responseContract.getRepresentationKind()
    let responseBody = response.getBody()

    if (representationKind === RepresentationKinds.METADATA && responseBody && responseBody.value) {
      // In case of locale-specific $metadata requests the application sets the metadata document
      // in the metadata handler. Thus serializing will be skipped in this case.
      response.setBody(responseBody.value)
      return next()
    }

    let options = response.getOdataOptions()

    if (
      representationKind &&
      representationKind !== RepresentationKinds.NO_CONTENT &&
      representationKind !== RepresentationKinds.PRIMITIVE_VALUE &&
      representationKind !== RepresentationKinds.BINARY &&
      representationKind !== RepresentationKinds.COUNT &&
      representationKind !== RepresentationKinds.BATCH
    ) {
      if (!options) {
        options = {}
        response.setOdataOptions(options)
      }

      if (responseBody && typeof responseBody === 'object') {
        if (
          representationKind === RepresentationKinds.ENTITY ||
          representationKind === RepresentationKinds.COMPLEX ||
          representationKind === RepresentationKinds.REFERENCE
        ) {
          if (responseBody.value && !responseBody.value[MetaProperties.CONTEXT]) {
            responseBody.value[MetaProperties.CONTEXT] = this._createContextUrl(request, representationKind, options)
          }
        } else if (!responseBody[MetaProperties.CONTEXT]) {
          responseBody[MetaProperties.CONTEXT] = this._createContextUrl(request, representationKind, options)
        }

        if (responseBody[MetaProperties.NEXT_LINK]) {
          // Skiptoken is currently only allowed for collections of entities and of references.
          if (
            representationKind !== RepresentationKinds.ENTITY_COLLECTION &&
            representationKind !== RepresentationKinds.REFERENCE_COLLECTION
          ) {
            return next(new InternalServerError('Skiptoken is only allowed for entity- and reference-collections'))
          }

          // Check whether a maxPageSize is configured for the returned collection.
          const segment = request
            .getUriInfo()
            .getLastSegment(representationKind === RepresentationKinds.REFERENCE_COLLECTION ? -1 : 0)
          if (
            (representationKind === RepresentationKinds.ENTITY_COLLECTION ||
              representationKind === RepresentationKinds.REFERENCE_COLLECTION) &&
            ((segment.getEntitySet() && !segment.getEntitySet().getMaxPageSize()) ||
              (segment.getTarget() && !segment.getTarget().getMaxPageSize()))
          ) {
            return next(
              new InternalServerError(
                'Skiptoken is only allowed for entity- ' +
                  'and reference-collections where a maximum page size is configured'
              )
            )
          }

          const odataPath = request.getOdataPath()
          const queryOptionsString = request.getUrlObject().search
          responseBody[MetaProperties.NEXT_LINK] = new NextLinkSerializer().serializeNextLink(
            odataPath,
            queryOptionsString,
            responseBody[MetaProperties.NEXT_LINK]
          )
        }
      }
    }

    let serialize = responseContract.getSerializerFunction()
    serialize(context, responseBody, options, (error, serializedBody) => {
      response.setBody(serializedBody)
      next(error)
    })

    return undefined
  }

  /**
   * Creates the context URL for a given request.
   * @param {OdataRequest} request the OData request
   * @param {RepresentationKind.Kinds} representationKind representation kind of the target
   * @param {Object} options optional keys for the building of the context URL
   * @returns {string} the context URL
   * @private
   */
  _createContextUrl(request, representationKind, options) {
    const incomingRequest = request.getIncomingRequest()
    return new ContextUrlFactory().createContextURL(
      request.getUriInfo(),
      ExpandHelper.getFinalExpand(request),
      representationKind,
      options.keys,
      this.getContext()
        .getService()
        .getEdm(),
      (incomingRequest && incomingRequest.getBatchContext && incomingRequest.getBatchContext().getRequest().getIncomingRequest())
      || incomingRequest,
      this.getContext()
        .getLogger()
    )
  }
}

module.exports = SerializingCommand
