const InsertResult = require('../result/InsertResult')

/**
 * Generic Handler for CREATE requests.
 * REVISIT: add description
 *
 * @param req - cds.Request
 */
module.exports = async function (req) {
  if (typeof req.query === 'string') {
    const results = await this._execute.sql(this.dbc, req.query, req.data)
    return Array.isArray(results) && results[0] != null && results[0].affectedRows != null
      ? results[0].affectedRows
      : results
  }

  try {
    // REVISIT: should be handled in protocol adapter
    // execute validation query first to fail early
    if (req.query._validationQuery) {
      const validationResult = await this._read(this.model, this.dbc, req.query._validationQuery, req)

      if (validationResult.length === 0) {
        // > validation target (e.g., root of navigation) doesn't exist
        req.reject(404)
      }
    }
    const results = await this._insert(this.model, this.dbc, req.query, req)
    return new InsertResult(req, results)
  } catch (err) {
    // If entry is available, reject event
    // REVISIT: db specifics
    if (err.message.match(/unique constraint/i)) {
      err.originalMessage = err.message
      err.message = 'ENTITY_ALREADY_EXISTS'
      err.code = 400
    }
    req.reject(err)
  }
}
