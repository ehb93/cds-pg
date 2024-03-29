'use strict'

const Command = require('./Command')

/**
 * The `next` callback to be called upon finish execution.
 *
 * @callback Next
 * @param {?Error} error An error if there is one or null if not
 */

/**
 * Executes the serialization of internal response buffer in debug mode.
 *
 * @extends Command
 */
class DebugSerializingCommand extends Command {
  /**
   * Executes the registered error serializing function bound with the contract created from the
   * debug content negotiation.
   *
   * @param {Next} next The next callback to be called on finish
   * @param {Error|undefined} [error] An error if there is one. Can be undefined
   */
  execute (next, error) {
    const context = this.getContext()
    const logger = context.getLogger()

    const response = this.getContext().getResponse()

    if (response.isHeadersSent()) {
      logger.warning('Headers already sent')
      next()
    } else {
      // The runtime measurement must be stopped before serializing its output,
      // otherwise we won't get the total runtime in there.
      context.getPerformanceMonitor().stop()

      const buffer = response.getBuffer()
      response.setBuffered(false)
      let serialize = response.getContract().getSerializerFunction()

      serialize(context, buffer, error, (innerError, data) => {
        response.setBody(data)
        next(innerError)
      })
    }
  }
}

module.exports = DebugSerializingCommand
