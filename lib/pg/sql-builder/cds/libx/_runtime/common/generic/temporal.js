const cds = require('../../cds')
const LOG = cds.log('app')

const _getDateFromQueryOptions = str => {
  if (str) {
    const match = str.match(/^date'(.+)'$/)
    // REVISIT: What happens with invalid date values in query parameter? if match.length > 1
    return new Date(match ? match[1] : str)
  }
}

const _isDate = dateStr => !dateStr.includes(':')
const _isTimestamp = dateStr => dateStr.includes('.')
const _isWarningRequired = (warning, queryOptions) =>
  !warning && queryOptions && (queryOptions['sap-valid-from'] || queryOptions['sap-valid-to'])
const _isAsOfNow = queryOptions =>
  !queryOptions || (!queryOptions['sap-valid-at'] && !queryOptions['sap-valid-to'] && !queryOptions['sap-valid-from'])

const _getTimeDelta = (target, queryOption) => {
  if (!target || !target.elements || !queryOption) return 1000

  if (
    _isDate(queryOption) ||
    Object.values(target.elements).some(el => el['@cds.valid.from'] && el.type === 'cds.Date')
  ) {
    return 1000 * 60 * 60 * 24
  }

  if (
    _isTimestamp(queryOption) &&
    Object.values(target.elements).some(el => el['@cds.valid.from'] && el.type === 'cds.Timestamp')
  ) {
    return 1
  }
  // for cds.DateTime
  return 1000
}

/**
 * Generic handler for entities using temporal aspect
 *
 * @param req
 */
const _handler = function (req) {
  // REVISIT: public API for query options
  const { _queryOptions } = req

  // REVISIT: stable access
  const _ = (req.context && req.context._) || req._

  if (_isWarningRequired(cds._deprecationWarningForTemporal, _queryOptions)) {
    LOG._warn && LOG.warn('query options "sap-valid-from" and "sap-valid-to" are deprecated and will be removed.')
    cds._deprecationWarningForTemporal = true
  }

  // make sure the env vars are reset
  _['VALID-FROM'] = null
  _['VALID-TO'] = null

  if (_isAsOfNow(_queryOptions)) {
    const date = new Date()
    _['VALID-FROM'] = date
    _['VALID-TO'] = new Date(date.getTime() + _getTimeDelta(req.target))
  } else if (_queryOptions['sap-valid-at']) {
    const date = _getDateFromQueryOptions(_queryOptions['sap-valid-at'])
    _['VALID-FROM'] = date
    _['VALID-TO'] = new Date(date.getTime() + _getTimeDelta(req.target, _queryOptions['sap-valid-at']))
  } else if (_queryOptions['sap-valid-from'] || _queryOptions['sap-valid-to']) {
    _['VALID-FROM'] = _getDateFromQueryOptions(_queryOptions['sap-valid-from']) || new Date('0001-01-01T00:00:00.000Z')
    _['VALID-TO'] = _getDateFromQueryOptions(_queryOptions['sap-valid-to']) || new Date('9999-12-31T23:59:59.999Z')
  }
}

/**
 * handler registration
 */
module.exports = cds.service.impl(function () {
  _handler._initial = true
  // always run to allow interaction with temporal data in custom handlers
  this.before('*', _handler)
})
