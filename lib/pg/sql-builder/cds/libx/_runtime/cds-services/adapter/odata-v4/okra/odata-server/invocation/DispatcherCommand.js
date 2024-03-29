'use strict'

const cds = require('../../../../../../cds')

const commons = require('../../odata-commons')
const RepresentationKinds = commons.format.RepresentationKind.Kinds
const MetaProperties = commons.format.JsonFormat.MetaProperties
const Command = require('./Command')

/**
 * The `next` callback to be called upon finish execution.
 *
 * @callback Next
 * @param {?Error} error An error if there is one or null if not
 */

/**
 * Executes the request dispatching.
 *
 * @extends Command
 */
class DispatcherCommand extends Command {
  /**
   * Creates an instance of DispatcherCommand.
   *
   * @param {OdataRequest} request the current OData request
   * @param {OdataResponse} response the current OData response
   * @param {?MetadataCache} metadataCache the metadata cache
   * @param {ComponentManager} componentManager The current component manager instance
   * @param {Dispatcher} dispatcher The current dispatcher
   * @param {LoggerFacade} logger the logger
   */
  constructor (request, response, metadataCache, componentManager, dispatcher, logger) {
    super()
    this._request = request
    this._response = response

    // dummy cache if alpha_toggles
    if (cds.env.features.alpha_toggles) this._metadataCache = { get: () => {}, set: () => {} }
    else this._metadataCache = metadataCache
    
    this._componentManager = componentManager
    this._dispatcher = dispatcher
    this._logger = logger
  }

  /**
   * Executes the registered request dispatcher
   *
   * @param {Next} next The next callback to be called on finish
   */
  execute (next) {
    const contract = this._response.getContract()
    const locale = contract.getLocale()
    // If $metadata is requested and a locale is set, the locale-specific metadata document should be cached
    const isLocaleSpecificMetadataRequest = contract.getRepresentationKind() === RepresentationKinds.METADATA && locale
    const cachedMetadata = isLocaleSpecificMetadataRequest
      ? this._metadataCache.get(contract.getContentTypeInfo().getMimeType(), locale)
      : null

    if (cachedMetadata) {
      this._response.setBody({ value: cachedMetadata.metadata, [MetaProperties.ETAG]: cachedMetadata.etag })
      this._request.validateEtag(cachedMetadata.etag)
      next()
    } else {
      this._dispatcher
        .dispatch(this._request, this._response, this._componentManager)
        .then(result => {
          if (
            isLocaleSpecificMetadataRequest &&
            result.data !== null &&
            result.data !== undefined &&
            result.data.value !== null &&
            result.data.value !== undefined
          ) {
            const metadataEtag = this._metadataCache.set(
              contract.getContentTypeInfo().getMimeType(),
              locale,
              result.data.value
            )
            if (!cds.env.features.alpha_toggles && !this._metadataCache.get(contract.getContentTypeInfo().getMimeType(), locale)) {
              this._logger.info(
                'Metadata size exceeds cache boundary. Use cds option odata.metadataCacheLimit to increase the cache size.'
              )
            }
            this._request.validateEtag(metadataEtag)
            let data = result.data
            data[MetaProperties.ETAG] = metadataEtag
          }

          this._response.setBody(result.data).setOdataOptions(result.options)
          next()
        })
        .catch(next)
    }
  }
}

module.exports = DispatcherCommand
