'use strict'

const Command = require('./Command')
const ResponseHeaderSetter = require('../core/ResponseHeaderSetter')

/**
 * The `next` callback to be called upon finish execution.
 * @callback Next
 * @param {?Error} error An error if there is one or null if not
 */

/**
 * Executes the setting of response headers.
 * @extends Command
 */
class PresetResponseHeadersCommand extends Command {
  /**
   * Creates an instance of PresetResponseHeadersCommand.
   * @param {OdataRequest} request the current OData request
   * @param {OdataResponse} response the current OData response
   * @param {string} version the supported OData version
   * @param {LoggerFacade} logger the logger
   */
  constructor (request, response, version, logger) {
    super()
    this._request = request
    this._response = response
    this._version = version
    this._logger = logger
  }

  /**
   * Executes the setting of response headers.
   * @param {Next} next The next callback to be called on finish
   */
  execute (next) {
    if (this._response.isHeadersSent()) {
      this._logger.warning('Headers already sent')
    } else {
      new ResponseHeaderSetter(this._request, this._response, this._version, this._logger).setHeaders(true)
    }

    next()
  }
}

module.exports = PresetResponseHeadersCommand
