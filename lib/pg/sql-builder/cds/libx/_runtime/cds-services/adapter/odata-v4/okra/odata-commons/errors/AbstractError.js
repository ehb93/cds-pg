'use strict'

/**
 * @extends Error
 * @abstract
 * @hideconstructor
 * @ignore
 */
class AbstractError extends Error {
  /**
   * @param {string} name the error name (used to determine HTTP status code elsewhere)
   * @param {string} message the error message
   * @param {?Error} [rootCause] the root cause
   */
  constructor (name, message, rootCause) {
    if (!name || typeof name !== 'string') throw new Error("Parameter 'name' must be a string")
    if (!message || typeof message !== 'string') throw new Error("Parameter 'message' must be a string")
    super(message)

    /**
     * Overwrite the JavaScript standard Error property 'name'.
     * @type {string}
     */
    this.name = name

    this.setRootCause(rootCause || null)
  }

  /**
   * Sets the root error if there is any.
   * @param {?Error} rootCause The root cause
   * @returns {AbstractError} This instance of error
   * @package
   */
  setRootCause (rootCause) {
    if (rootCause) {
      if (!(rootCause instanceof Error)) {
        throw new Error("Parameter 'rootCause' must be an instance of Error")
      }
      this._rootCause = rootCause
    }
    return this
  }

  /**
   * @returns {?Error} the root cause
   */
  getRootCause () {
    return this._rootCause
  }
}

/**
 * Error names
 * @enum {string}
 * @readonly
 */
AbstractError.ErrorNames = {
  BAD_REQUEST: 'BadRequestError',
  ILLEGAL_ARGUMENT: 'IllegalArgumentError',
  ILLEGAL_CALL: 'IllegalCallError',
  METHOD_NOT_ALLOWED: 'MethodNotAllowedError',
  NOT_ACCEPTABLE: 'NotAcceptableError',
  NOT_AUTHORIZED: 'NotAuthorizedError',
  NOT_FOUND: 'NotFoundError',
  CONFLICT: 'ConflictError',
  NOT_IMPLEMENTED: 'NotImplementedError',
  SERIALIZATION: 'SerializationError',
  DESERIALIZATION: 'DeserializationError',
  URI_SEMANTIC: 'UriSemanticError',
  URI_QUERY_OPTION_SEMANTIC: 'UriQueryOptionSemanticError',
  URI_SYNTAX: 'UriSyntaxError',
  INTERNAL_SERVER_ERROR: 'InternalServerError',
  PRECONDITION_FAILED_ERROR: 'PreconditionFailedError',
  PRECONDITION_REQUIRED_ERROR: 'PreconditionRequiredError'
}

module.exports = AbstractError
