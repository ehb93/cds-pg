const cds = require('../../../cds')
// requesting logger without module on purpose!
const LOG = cds.log()

const {
  BatchExitHandler: { ATOMICITY_GROUP_START, ATOMICITY_GROUP_END },
  Components: {
    DATA_CREATE_HANDLER,
    DATA_DELETE_HANDLER,
    DATA_READ_HANDLER,
    DATA_UPDATE_HANDLER,
    ACTION_EXECUTE_HANDLER,
    LOCALE_NEGOTIATOR,
    METADATA_HANDLER
  }
} = require('./okra/odata-server')

const _config = require('./utils/oDataConfiguration')
const _error = require('./handlers/error')
const _debug = require('./handlers/debug')
const _request = require('./handlers/request')
const _language = require('./handlers/language')
const _metadata = require('./handlers/metadata')
const _create = require('./handlers/create')
const _update = require('./handlers/update')
const _delete = require('./handlers/delete')
const _read = require('./handlers/read')
const _action = require('./handlers/action')
const { normalizeError, isClientError } = require('../../../common/error/frontend')

let _i18n
const i18n = (...args) => {
  if (!_i18n) _i18n = require('../../../common/i18n')
  return _i18n(...args)
}

function _log(level, arg) {
  const { params } = arg

  // cds.log() called with multiple args or first arg not an object or string? -> pass through
  if (params.length !== 1 || (typeof params[0] !== 'object' && typeof params[0] !== 'string')) {
    LOG[level](arg)
    return
  }

  // single arg of type object (from string, if necessary)
  const obj = typeof params[0] === 'object' ? params[0] : { message: params[0] }

  // augment
  if (!obj.id) obj.id = arg.id
  if (!obj.level) obj.level = arg.level
  if (!obj.timestamp) obj.timestamp = arg.timestamp

  // replace messages in toLog with developer texts (i.e., undefined locale) iff level === 'error' (cf. req.reject() etc.)
  const _message = obj.message
  const _details = obj.details
  if (level === 'error') {
    obj.message = i18n(obj.message || obj.code, undefined, obj.args) || obj.message
    if (obj.details) {
      const details = []
      for (const d of obj.details) {
        details.push(Object.assign({}, d, { message: i18n(d.message || d.code, undefined, d.args) || d.message }))
      }
      obj.details = details
    }

    // reduce 4xx to warning
    if (isClientError(obj)) {
      if (!LOG._warn) return
      level = 'warn'
    }
  }

  // log it
  LOG[level](obj)

  // restore
  obj.message = _message
  if (_details) obj.details = _details
}

const _logger = {
  debug: arg => LOG._debug && _log('debug', arg),
  path: () => {},
  info: arg => LOG._info && _log('info', arg),
  warning: arg => LOG._warn && _log('warn', arg),
  error: arg => LOG._error && _log('error', arg),
  fatal: arg => LOG._error && _log('error', arg)
}

/**
 * Facade for creating an instance of a EDM based OData service.
 *
 * @alias module:odata.OData
 */
class OData {
  /**
   * Constructs an OData service for the given EDM model.
   *
   * @param {object} edm - the EDM model.
   * @param {object} csn
   * @param {object} [options] - optional object with options.
   * @param {object} [options.logger] - optional logger object to be used in the odata library.
   * @param {string} [options.logLevel] - optional log level to be used according to winston/npm specification.
   * @param {boolean} [options.crashOnError] - Application should crash on error. Defaults to true.
   *
   * @throws Error in case no or an invalid csn model is provided.
   */
  constructor(edm, csn, options = {}) {
    this._validateEdm(edm)
    this._options = options
    this._csn = csn
    this._createOdataService(edm)
  }

  _validateEdm(edm) {
    if (typeof edm !== 'object' || !edm.$Version) {
      const { getModelNotDefinedError } = require('../../util/errors')
      throw getModelNotDefinedError('EDM model')
    }
  }

  _createOdataService(edm) {
    const ServiceFactory = require('./okra/odata-server').ServiceFactory

    // skip okra's validation in production or implicitly for w4 and x4
    const { effective } = cds.env
    const isTrusted =
      process.env.NODE_ENV === 'production' ||
      !Object.prototype.hasOwnProperty.call(cds.env.odata, 'skipValidation') ||
      cds.env.odata.skipValidation ||
      effective.odata.containment ||
      effective.odata.structs ||
      effective.odata.refs ||
      effective.odata.proxies ||
      effective.odata.xrefs

    this._odataService = ServiceFactory.createService(edm, _config(edm, this._csn, this._options)).trust(isTrusted)

    // will be added to express app like app.use('/base/path/', service) and odata-v4 wants app.use('/', service) if basePath is set
    this._odataService.setBasePath('/')
  }

  /**
   * The added cds service will be used at the handlers.
   * Some channel events have a 1:N relation to service handler events.
   *
   * @param {Service} cdsService
   */
  addCDSServiceToChannel(cdsService) {
    // use cds.log and preserve everything
    this._odataService.log(_logger, arg => arg)

    this._cdsService = cdsService

    this._odataService.on('error', _error(this._options.crashOnError, cdsService))
    if (this._options.debug) this._odataService.on('debug', _debug)
    this._odataService.on('request', _request(cdsService))

    this._odataService.on(ATOMICITY_GROUP_START, (odataContext, done) => {
      const data = odataContext.applicationData

      // start tx
      const txs = (data.txs = data.txs || {})
      const {
        req: { user },
        req
      } = data
      // REVISIT: _model should not be necessary
      const tx = (txs[odataContext.id] = cdsService.tx({ user, req, _model: cdsService.model }))
      cds.context = tx.context
      // for collecting results and errors
      data.results = data.results || {}
      data.results[odataContext.id] = []
      data.errors = data.errors || {}
      data.errors[odataContext.id] = []
      done()
    })

    this._odataService.on(ATOMICITY_GROUP_END, async (odataErr, odataContext, done) => {
      const tx = odataContext.applicationData.txs[odataContext.id]
      let errors = odataErr || odataContext.failedRequests.length > 0

      if (errors) {
        // rollback without errors to not trigger srv.on('error') with array
        await tx.rollback()
        // invoke srv.on('error') for each error and build failedRequests that reflects error modifications
        errors = odataContext.applicationData.errors[odataContext.id]
        const failedRequests = {}

        for (const e of errors) {
          const { error: err, req } = e
          for (const each of cdsService._handlers._error) each.handler.call(cdsService, err, req)
          const requestId = req._.odataReq.getOdataRequestId()
          const { error, statusCode } = normalizeError(err, req)
          failedRequests[requestId] = Object.assign(error, { statusCode })
        }

        done(new Error(`Atomicity group "${odataContext.id}" failed`), { failedRequests })
        return
      }

      try {
        await tx.commit(odataContext.applicationData.results[odataContext.id])
        done()
      } catch (e) {
        // tx gets rolled back automatically
        // set error on each request of changeset, if commit failed
        const changesetResults = odataContext.applicationData.results[odataContext.id]
        const failedRequests = changesetResults.reduce((obj, resultEntry) => {
          const requestId = resultEntry.req._.odataReq.getOdataRequestId()
          const { error, statusCode } = normalizeError(e, resultEntry.req)
          obj[requestId] = Object.assign(error, { statusCode })
          return obj
        }, {})

        done(e, { failedRequests })
      }
    })

    this._odataService.use(LOCALE_NEGOTIATOR, _language)
    this._odataService.use(METADATA_HANDLER, _metadata(cdsService))

    this._odataService.use(DATA_CREATE_HANDLER, _create(cdsService))
    this._odataService.use(DATA_READ_HANDLER, _read(cdsService))
    this._odataService.use(DATA_UPDATE_HANDLER, _update(cdsService))
    this._odataService.use(DATA_DELETE_HANDLER, _delete(cdsService))

    this._odataService.use(ACTION_EXECUTE_HANDLER, _action(cdsService))
  }

  // _startPerfMeasurementOData (req) {
  //   if (req.performanceMeasurement) {
  //     const uuid = req.performanceMeasurement.uuid
  //     req.performanceMeasurement.performance.mark(`${uuid} ODataIn Start`)
  //   }
  // }

  /**
   * Process request.
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @private
   */
  // REVISIT: Remove this when we replaced Okra
  process(req, res) {
    const headers = req.headers
    const acceptHeader = headers && headers.accept

    // default to combination [...];IEEE754Compatible=true;ExponentialDecimals=true if one is omitted
    if (acceptHeader && acceptHeader.startsWith('application/json')) {
      if (acceptHeader.includes('IEEE754Compatible=true') && !acceptHeader.includes('ExponentialDecimals')) {
        req.headers.accept += ';ExponentialDecimals=true'
      } else if (acceptHeader.includes('ExponentialDecimals=true') && !acceptHeader.includes('IEEE754Compatible')) {
        req.headers.accept += ';IEEE754Compatible=true'
      }

      const contentType = headers['content-type']

      // add IEEE754Compatible=true if !strict_numbers
      if (
        !cds.env.features.strict_numbers &&
        contentType &&
        contentType.includes('application/json') &&
        !contentType.includes('IEEE754Compatible')
      ) {
        req.headers['content-type'] = contentType.replace('application/json', 'application/json;IEEE754Compatible=true')
      }
    }

    // this._startPerfMeasurementOData(req)
    this._odataService.process(req, res).catch(err => {
      // REVISIT: use i18n
      res.status(500).send({ error: { code: 'null', message: err.message } })
    })
  }
}

module.exports = OData
