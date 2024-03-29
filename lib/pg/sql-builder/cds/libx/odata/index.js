const cds = require('../_runtime/cds')
const { SELECT } = cds.ql

const odata2cqn = require('./odata2cqn')
const cqn2odata = require('./cqn2odata')

const afterburner = require('./odata2cqn/afterburner')
const { getSafeNumber: safeNumber } = require('./utils')

const strict = {
  functions: {
    contains: 1,
    startswith: 1,
    endswith: 1,
    tolower: 1,
    toupper: 1,
    length: 1,
    indexof: 1,
    substring: 1,
    trim: 1,
    concat: 1,
    year: 1,
    month: 1,
    day: 1,
    hour: 1,
    minute: 1,
    second: 1,
    time: 1,
    now: 1
  }
}

/*
 * cds.odata API
 */
module.exports = {
  parse: (url, options = {}) => {
    // first arg may also be req
    if (url.url) url = url.url
    // REVISIT: for okra, remove when no longer needed
    else if (url.getIncomingRequest) url = url.getIncomingRequest().url
    url = decodeURIComponent(url)

    options = options === 'strict' ? { strict } : options.strict ? { ...options, strict } : options
    if (options.service) Object.assign(options, { minimal: true, afterburner: afterburner.for(options.service) })
    options.safeNumber = safeNumber

    let cqn
    try {
      cqn = odata2cqn(url, options)
    } catch (e) {
      // REVISIT: additional try in catch isn't nice -> find better way
      // known gaps -> e.message is a stringified error -> use that
      // unknown errors -> e is the error to keep
      let err = e
      try {
        err = JSON.parse(e.message)
      } catch {
        /* nothing to do */
      }
      err.message = 'Parsing URL failed with error: ' + err.message
      err.statusCode = err.statusCode || 400
      throw err
    }

    if (typeof options.afterburner === 'function') cqn = options.afterburner(cqn)

    const query = cqn.SELECT.one ? SELECT.one(cqn.SELECT.from) : SELECT.from(cqn.SELECT.from)
    Object.assign(query.SELECT, cqn.SELECT)

    // REVISIT: _target vs __target, i.e., pseudo csn vs actual csn
    // DO NOT USE __target outside of libx/rest!!!
    query.__target = cqn.__target

    return query
  },
  urlify: (cqn, options = {}) => {
    return cqn2odata(cqn, options.kind, options.model)
  }
}
