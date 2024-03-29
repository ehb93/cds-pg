const cds = require('../../../../cds')

const RestRequest = require('../RestRequest')

const getData = require('../utils/data')
const { toRestResult } = require('../utils/result')
const getError = require('../../../../common/error')
const { bufferToBase64 } = require('../utils/binary')

module.exports = service => {
  return async (restReq, restRes, next) => {
    const {
      _parsed: parsed,
      _parsed: { segments }
    } = restReq

    const [validationError, data] = getData(parsed, restReq)
    if (validationError) return next(validationError)

    // create tx and set as cds.context
    // REVISIT: _model should not be necessary
    const tx = service.tx({ user: restReq.user, req: restReq, _model: service.model })
    cds.context = tx

    let result, err, commit
    try {
      const req = new RestRequest(parsed, data, restReq, restRes, service)

      result = await tx.dispatch(req)

      if (result == null) {
        throw getError(404, 'NO_MATCHING_RESOURCE')
      }

      bufferToBase64(result, segments[0])

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
      else restRes.send(toRestResult(result))
    }
  }
}
