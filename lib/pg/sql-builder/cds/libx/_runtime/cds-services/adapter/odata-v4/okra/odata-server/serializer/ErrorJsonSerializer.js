'use strict'

const ErrorSerializer = require('./ErrorSerializer')

/**
 * The ErrorJsonSerializer serializes an error to an OData error in JSON format.
 * @extends ErrorSerializer
 */
class ErrorJsonSerializer extends ErrorSerializer {
  /**
   * Serializes the provided error to an OData error in JSON format.
   * @returns {string} an OData error JSON string
   */
  serialize () {
    function addAnnotations (source, target) {
      for (const name in source) if (name[0] === '@') target[name] = source[name]
    }

    let result = {
      code: this._error.code || 'null',
      message: this._error.message,
      target: this._error.target
    }

    if (this._error.details) {
      result.details = this._error.details.map(d => {
        let detail = {
          code: d.code || 'null',
          message: d.message,
          target: d.target
        }
        addAnnotations(d, detail)
        return detail
      })
    }

    addAnnotations(this._error, result)

    return JSON.stringify({ error: result })
  }
}

module.exports = ErrorJsonSerializer
