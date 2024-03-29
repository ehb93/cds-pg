'use strict'

const HttpStatusCode = require('../http/HttpStatusCode')

/**
 * The CommandExecutor executes a chain of commands and handles possible errors.
 */
class CommandExecutor {
  /**
   * Creates an instance of CommandExecutor.
   * @param {LoggerFacade} logger the logger
   * @param {?PerformanceMonitor} runTimeMeasurement the runtime-measurement instance
   */
  constructor (logger, runTimeMeasurement) {
    this._logger = logger
    this._runTimeMeasurement = runTimeMeasurement
    this._error = null
  }

  /**
   * Executes the command success chain and executes the error chain in case of an error in the success chain.
   * @param {Array.<Array>} successCommands command chain (array of commands with their descriptions) to execute
   * @param {Array.<Array>} failCommands command chain (array of commands with their descriptions) to execute in case of an error
   * @param {?Error} initialError Error that occurred before initializing the command chain
   * @param {Function} endCallback the function called at the end, with parameter error
   */
  execute (successCommands, failCommands, initialError, endCallback) {
    const chainEndCallback = error => {
      if (error) {
        const statusCode = HttpStatusCode.resolveErrorStatusCode(null, null, error)
        if (statusCode >= 400 && statusCode < 500) {
          this._logger.warning(error)
        } else {
          this._logger.error(error)
        }

        if (failCommands) {
          this._error = error
          this._execute(failCommands, 0, endCallback)
        } else {
          endCallback(error)
        }
      } else {
        endCallback()
      }
    }

    // If the method was called with an initial error, only the error command chain will be executed
    if (initialError) {
      chainEndCallback(initialError)
    } else {
      this._execute(successCommands, 0, chainEndCallback)
    }
  }

  /**
   * Executes the command referenced by its index recursively. The execution is asynchronous.
   * @param {Array.<Array>} commands command chain (array of commands with their descriptions) to execute recursively
   * @param {number} index The current command index to execute
   * @param {Function} callback called when chain ends or an error occurs
   * @private
   */
  _execute (commands = [], index = 0, callback) {
    const commandInfo = commands[index]
    if (commandInfo) {
      const command = commandInfo[0]
      const description = commandInfo[1]

      if (this._runTimeMeasurement && description) this._runTimeMeasurement.createChild(description).start()
      try {
        command.execute((err, mappedError) => {
          if (this._error && mappedError) {
            // The 'next(null, mappedError)' signature is used in case of an error listener
            // where the listener can be used to map/exchange/wrap the original error.
            this._error = mappedError
          }
          if (this._runTimeMeasurement && description) this._runTimeMeasurement.getChild(description).stop()
          if (err) {
            callback(err)
          } else {
            this._execute(commands, index + 1, callback)
          }
        }, this._error)
      } catch (innerError) {
        if (innerError.__crashOnError) {
          throw innerError
        }
        if (this._runTimeMeasurement && description) this._runTimeMeasurement.getChild(description).stop()
        callback(innerError)
      }
    } else {
      callback()
    }
  }
}

module.exports = CommandExecutor
