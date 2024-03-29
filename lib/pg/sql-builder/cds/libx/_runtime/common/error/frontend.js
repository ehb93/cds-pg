/*
 * OData spec:
 *   This object MUST contain name/value pairs with the names code and message,
 *   and it MAY contain name/value pairs with the names target, details and innererror.
 *   [...]
 *   Error responses MAY contain annotations in any of its JSON objects.
 */

const cds = require('../../cds')

let _i18n
const i18n = (...args) => {
  if (!_i18n) _i18n = require('../i18n')
  return _i18n(...args)
}

const {
  ALLOWED_PROPERTIES,
  ADDITIONAL_MSG_PROPERTIES,
  DEFAULT_SEVERITY,
  MIN_SEVERITY,
  MAX_SEVERITY
} = require('./constants')

const SKIP_SANITIZATION = '@cds.skip_sanitization'

const _getFiltered = err => {
  const error = {}

  Object.keys(err)
    .concat(['message'])
    .forEach(k => {
      if (k === 'innererror' && process.env.NODE_ENV === 'production') {
        return
      }
      if (ALLOWED_PROPERTIES.includes(k) || k.startsWith('@')) {
        error[k] = err[k]
      } else if (k === 'numericSeverity') {
        error['@Common.numericSeverity'] = err[k]
      }
    })

  return error
}

const _rewrite = error => {
  // REVISIT: db stuff probably shouldn't be here
  if (error.code === 'SQLITE_ERROR') {
    error.code = '500'
  } else if (
    (error.code.startsWith('SQLITE_CONSTRAINT') && error.message.match(/COMMIT/)) ||
    (error.code.startsWith('SQLITE_CONSTRAINT') && error.message.match(/FOREIGN KEY/)) ||
    (error.code === '155' && error.message.match(/fk constraint violation/))
  ) {
    // > foreign key constaint violation no sqlite/ hana
    error.code = '400'
    error.message = i18n('FK_CONSTRAINT_VIOLATION')
  } else if (error.code.startsWith('ASSERT_')) {
    error.code = '400'
  }
}

const _normalize = (err, locale, inner = false) => {
  // message (i18n)
  err.message = i18n(err.message || err.code, locale, err.args) || err.message || `${err.code}`

  // only allowed properties
  const error = _getFiltered(err)

  // ensure code is set and a string
  error.code = String(error.code || 'null')

  // details
  if (!inner && err.details) {
    error.details = err.details.map(ele => _normalize(ele, locale, true))
  }

  // REVISIT: code and message rewriting
  _rewrite(error)

  return error
}

const _isAllowedError = errorCode => {
  return errorCode >= 300 && errorCode < 505
}

const _anonymousUser = req => {
  // if no authentication used, we create a new user object in order to get the correct locale
  return Object.defineProperty(new cds.User(), '_req', { enumerable: false, value: req })
}

const normalizeError = (err, req) => {
  const user = (req && req.user) || _anonymousUser(req)
  const locale = user.locale

  const error = _normalize(err, locale)

  // derive status code from err status OR root code OR matching detail codes
  let statusCode = err.status || err.statusCode || (_isAllowedError(error.code) && error.code)
  if (!statusCode && error.details && error.details.every(ele => ele.code === error.details[0].code)) {
    statusCode = _isAllowedError(error.details[0].code) < 505 && error.details[0].code
  }

  // make sure it's a number
  statusCode = statusCode ? Number(statusCode) : 500

  // REVISIT: make === 500 in cds^6
  // error[SKIP_SANITIZATION] is not an official API!!!
  if (statusCode >= 500 && process.env.NODE_ENV === 'production' && !error[SKIP_SANITIZATION]) {
    // > return sanitized error to client
    return { error: { code: `${statusCode}`, message: i18n(statusCode, locale) }, statusCode }
  }
  delete error[SKIP_SANITIZATION]

  // no top level null codes
  if (error.code === 'null') {
    error.code = String(statusCode)
  }

  return { error, statusCode }
}

const _ensureSeverity = arg => {
  if (typeof arg === 'number' && arg >= MIN_SEVERITY && arg <= MAX_SEVERITY) {
    return arg
  }

  return DEFAULT_SEVERITY
}

const _normalizeMessage = (message, locale) => {
  const normalized = _normalize(message, locale)

  // numericSeverity without @Common
  normalized.numericSeverity = _ensureSeverity(message.numericSeverity)
  delete normalized['@Common.numericSeverity']

  ADDITIONAL_MSG_PROPERTIES.forEach(k => {
    if (message[k] && typeof message[k] === 'string') {
      normalized[k] = message[k]
    }
  })

  return normalized
}

const getSapMessages = (messages, req) => {
  const user = (req && req.user) || _anonymousUser(req)
  const locale = user.locale

  const s = JSON.stringify(messages.map(message => _normalizeMessage(message, locale)))
  // convert non ascii to unicode
  return s.replace(/[\u007F-\uFFFF]/g, chr => {
    return '\\u' + ('0000' + chr.charCodeAt(0).toString(16)).substr(-4)
  })
}

const isClientError = e => {
  // e.code may be undefined, string, number, ... -> NaN -> not a client error
  const numericCode = e.statusCode || Number(e.code)
  return numericCode >= 400 && numericCode < 500
}

module.exports = {
  normalizeError,
  getSapMessages,
  isClientError
}
