const cds = require('../../_runtime/cds')

// requesting logger without module on purpose!
const LOG = cds.log()

let _i18n
const i18n = (...args) => {
  if (!_i18n) _i18n = require('../../_runtime/common/i18n')
  return _i18n(...args)
}

const { normalizeError, isClientError } = require('../../_runtime/common/error/frontend')

const _log = err => {
  const level = isClientError(err) ? 'warn' : 'error'
  if ((level === 'warn' && !LOG._warn) || (level === 'error' && !LOG._error)) return

  // replace messages in toLog with developer texts (i.e., undefined locale)
  const _message = err.message
  const _details = err.details
  err.message = i18n(err.message || err.code, undefined, err.args) || err.message
  if (err.details) {
    const details = []
    for (const d of err.details) {
      details.push(Object.assign({}, d, { message: i18n(d.message || d.code, undefined, d.args) || d.message }))
    }
    err.details = details
  }

  // log it
  LOG[level](err)

  // restore
  err.message = _message
  if (_details) err.details = _details
}

// eslint-disable-next-line no-unused-vars
module.exports = (err, req, res, next) => {
  const { _srv: srv } = req

  // invoke srv.on('error', function (err, req) { ... }) here in special situations
  let ctx = cds.context
  if (!ctx) {
    // > error before req was dispatched
    ctx = new cds.Request({ req, res: req.res, user: req.user || new cds.User.Anonymous() })
    for (const each of srv._handlers._error) each.handler.call(srv, err, ctx)
  }

  // log the error (4xx -> warn)
  _log(err)

  const { error, statusCode } = normalizeError(err, req)

  res.status(statusCode).send({ error })
}
