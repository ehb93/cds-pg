const cds = require('../../../../cds')

const RestRequest = require('../RestRequest')

const getData = require('../utils/data')
const { validateReturnType } = require('../utils/validation-checks')
const { bufferToBase64 } = require('../utils/binary')
const { toRestResult } = require('../utils/result')

const _convertCustomOperationReturnValue = (returns, result) => {
  if (returns.items) {
    return result
  } else {
    return Array.isArray(result) ? result[0] : result
  }
}

module.exports = service => {
  return async (restReq, restRes, next) => {
    const {
      _parsed: parsed,
      _parsed: { segments, operation }
    } = restReq

    const [validationError, data] = getData(parsed, restReq)
    if (validationError) return next(validationError)

    // create tx and set as cds.context
    // REVISIT: _model should not be necessary
    const tx = service.tx({ user: restReq.user, req: restReq, _model: service.model })
    cds.context = tx

    const req = new RestRequest(parsed, data, restReq, restRes, service)

    let result, err, commit, status, body
    try {
      result = await tx.dispatch(req)

      if (!operation.returns) {
        status = 204
      } else {
        validateReturnType(operation, result)
        bufferToBase64(result, segments[0])
        body = _convertCustomOperationReturnValue(operation.returns, result)
      }

      commit = true
      await tx.commit(result)
    } catch (e) {
      err = e
      if (!commit) {
        // ignore rollback error, which should never happen
        await tx.rollback(e).catch(() => {})
      }
    } finally {
      if (err) next(err)
      else {
        // only set status if not yet modified
        if (restRes.statusCode === 200 && status) restRes.status(status)
        restRes.send(toRestResult(body))
      }
    }
  }
}
