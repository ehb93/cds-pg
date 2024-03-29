const cds = require('../../../../cds')

const RestRequest = require('../RestRequest')

const getData = require('../utils/data')

module.exports = service => {
  return async (restReq, restRes, next) => {
    const { _parsed: parsed } = restReq

    const [validationError, data] = getData(parsed, restReq)
    if (validationError) return next(validationError)

    // create tx and set as cds.context
    // REVISIT: _model should not be necessary
    const tx = service.tx({ user: restReq.user, req: restReq, _model: service.model })
    cds.context = tx

    const req = new RestRequest(parsed, data, restReq, restRes, service)

    let err, commit
    try {
      await tx.dispatch(req)

      commit = true
      await tx.commit(null)
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
        if (restRes.statusCode === 200) restRes.status(204)
        restRes.send()
      }
    }
  }
}
