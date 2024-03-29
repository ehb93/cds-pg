const cds = require('../../../cds')
// requesting logger without module on purpose!
const LOG = cds.log()

const createHandler = require('./handlers/create')
const readHandler = require('./handlers/read')
const updateHandler = require('./handlers/update')
const deleteHandler = require('./handlers/delete')
const operationHandler = require('./handlers/operation')

const { contentTypeCheck } = require('./utils/header-checks')
const parse = require('./utils/parse-url')
const { base64toBuffer } = require('./utils/binary')

const { UNAUTHORIZED, FORBIDDEN, getRequiresAsArray } = require('../../../common/utils/auth')

const PPP = { POST: 1, PUT: 1, PATCH: 1 }

let _i18n
const i18n = (...args) => {
  if (!_i18n) _i18n = require('../../../common/i18n')
  return _i18n(...args)
}

const { normalizeError, isClientError } = require('../../../common/error/frontend')

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

class Rest {
  constructor(cdsService) {
    this._cdsService = cdsService
    this._createRouter()
    this._addDispatcher()
  }

  get _express() {
    const express = require('express')
    Object.defineProperty(this, '_express', { value: express })
    return express
  }

  _createRouter() {
    this.router = this._express.Router()
    this.router.use(this._express.json())
  }

  _addDispatcher() {
    const srv = this._cdsService

    const create = createHandler(srv)
    const read = readHandler(srv)
    const update = updateHandler(srv)
    const deleet = deleteHandler(srv)
    const operation = operationHandler(srv)

    const requires = getRequiresAsArray(srv.definition)

    /*
     * pre handler stuff
     */
    this.router.use('/', (req, res, next) => {
      // check @requires as soon as possible (DoS)
      if (req.path !== '/' && requires.length > 0 && !requires.some(r => req.user.is(r))) {
        // > unauthorized or forbidden?
        if (req.user._is_anonymous) {
          if (req.user._challenges) res.set('WWW-Authenticate', req.user._challenges.join(';'))
          // REVISIT: security log in else case?
          throw UNAUTHORIZED
        }
        // REVISIT: security log?
        throw FORBIDDEN
      }

      // content-type check, parse url, and base64 to buffer
      try {
        if (PPP[req.method]) contentTypeCheck(req)
        req._parsed = parse[req.method](srv, req)
        base64toBuffer(req.body, req._parsed.segments[0])
      } catch (e) {
        return next(e)
      }

      next()
    })

    // POST
    this.router.post('/*', (req, res, next) => {
      // CREATE or custom operation?
      if (req._parsed.event === 'CREATE') {
        create(req, res, next)
      } else {
        operation(req, res, next)
      }
    })

    // GET
    this.router.get('/*', (req, res, next) => {
      // READ or custom operation?
      if (req._parsed.event === 'READ') {
        read(req, res, next)
      } else {
        operation(req, res, next)
      }
    })

    // PUT, PATCH, DELETE
    this.router.put('/*', update)
    this.router.patch('/*', update)
    this.router.delete('/*', deleet)

    /*
     * error handling (the express way)
     */
    this.router.use((err, req, res, next) => {
      // invoke srv.on('error', function (err, req) { ... }) here in special situations
      // REVISIT: if for compat reasons, remove once cds^5.1
      if (srv._handlers._error) {
        let ctx = cds.context
        if (!ctx) {
          // > error before req was dispatched
          ctx = new cds.Request({ req, res: req.res, user: req.user || new cds.User.Anonymous() })
          for (const each of srv._handlers._error) each.handler.call(srv, err, ctx)
        }
      }

      // log the error (4xx -> warn)
      _log(err)

      const { error, statusCode } = normalizeError(err, req)

      if (res.statusCode === 200) {
        // > i.e., not set in custom handler
        res.status(statusCode)
      }
      res.send({ error })
    })
  }
}

module.exports = Rest
