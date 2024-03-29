const cds = require('../../_runtime/cds')
const { INSERT } = cds.ql

const RestRequest = require('../RestRequest')

const UPSERT_ALLOWED = !(cds.env.runtime && cds.env.runtime.allow_upsert === false)

const { deepCopyObject } = require('../../_runtime/common/utils/copy')

module.exports = async (_req, _res, next) => {
  let { _srv: srv, _query: query, _target, _data, _params } = _req

  let result,
    status = 200

  // unfortunately, express doesn't catch async errors -> try catch needed
  try {
    // if upsert it allowed, we need to catch 404 and retry with create
    try {
      // add the data (as copy, if upsert allowed)
      query.with(UPSERT_ALLOWED ? deepCopyObject(_data) : _data)
      // REVISIT: if PUT, req.method should be PUT -> Crud2Http maps UPSERT to PUT
      result = await srv.dispatch(new RestRequest({ query, _target, method: _req.method }))
      if (_params) Object.assign(result, _params[_params.length - 1])
    } catch (e) {
      if ((e.code === 404 || e.status === 404 || e.statusCode === 404) && UPSERT_ALLOWED) {
        query = INSERT.into(query.UPDATE.entity).entries(
          _params ? Object.assign(_data, _params[_params.length - 1]) : _data
        )
        result = await srv.dispatch(new RestRequest({ query, _target }))
        status = 201
      } else {
        throw e
      }
    }
  } catch (e) {
    return next(e)
  }

  _req._result = { result, status }
  next()
}
