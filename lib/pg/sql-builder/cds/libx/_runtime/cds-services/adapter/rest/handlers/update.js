const cds = require('../../../../cds')

const RestRequest = require('../RestRequest')

const getData = require('../utils/data')
const getError = require('../../../../common/error')
const { bufferToBase64 } = require('../utils/binary')

const UPSERT_ALLOWED = !(cds.env.runtime && cds.env.runtime.allow_upsert === false)

const _getData = (parsed, restReq) => {
  const [validationError, data] = getData(parsed, restReq)
  if (validationError) throw validationError
  if (parsed.event === 'CREATE') return data[0]
  if (Array.isArray(data)) throw getError(400, 'Batch updates are no longer supported.')
  return data
}

const _updateThenCreate = async (parsed, restReq, restRes, tx) => {
  let req, result

  try {
    req = new RestRequest(parsed, _getData(parsed, restReq), restReq, restRes, tx)
    result = await tx.dispatch(req)
  } catch (e) {
    if ((e.code === 404 || e.status === 404 || e.statusCode === 404) && UPSERT_ALLOWED) {
      // REVISIT: remove error (and child?) from tx.context? -> would require a unique req.id

      parsed.event = 'CREATE'
      req = new RestRequest(parsed, _getData(parsed, restReq), restReq, restRes, tx)
      result = await tx.dispatch(req)

      // REVISIT
      result = Array.isArray(result) ? result[0] : result
    } else {
      throw e
    }
  }

  return result
}

const update = service => {
  return async (restReq, restRes, next) => {
    const {
      _parsed: parsed,
      _parsed: { target }
    } = restReq

    // create tx and set as cds.context
    // REVISIT: _model should not be necessary
    const tx = service.tx({ user: restReq.user, req: restReq, _model: service.model })
    cds.context = tx

    let result, err, commit, status
    try {
      // try UPDATE and, on 404 error, try CREATE
      result = await _updateThenCreate(parsed, restReq, restRes, tx)

      // PUT resulting in CREATE shall return 201
      if (restReq.method === 'PUT' && parsed.event === 'CREATE') status = 201

      bufferToBase64(result, target)

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
        restRes.send(result)
      }
    }
  }
}

module.exports = update
