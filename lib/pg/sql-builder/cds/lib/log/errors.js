const error = exports = module.exports = (..._) => { throw _error(..._) }
const _error = (msg, _details, _base = error, ...etc) => {
  if (msg.raw) return _error (String.raw (msg,_details,_base,...etc))
  const e = msg instanceof Error ? msg : new Error (msg)
  Error.captureStackTrace(e,_base)
  if (_details) Object.assign (e,_details)
  return e
}

exports.reject = function (msg, _details, _base) {
  return Promise.reject(_error(msg, _details, _base))
}

exports.expected = ([,type], arg) => {
  const [ name, value ] = Object.entries(arg)[0]
  return error `Expected argument '${name}'${type}, but got: ${require('util').inspect(value,{depth:11})}`
}

exports.duplicate_cds = (...locations) => {
  const { local } = require('../utils')
  throw error `Duplicate @sap/cds/common!

  There are duplicate versions of @sap/cds loaded from these locations:

    ${locations.map(local).join('\n    ')}

  To fix this, check all dependencies to "@sap/cds" in your package.json and
  those of reused packages and ensure they allow deduped use of @sap/cds.
  `
}

exports.no_primary_db = (p,_base) => error (`Not connected to primary datasource!

  Attempt to use 'cds.${p}' without prior connect to primary datasource,
  i.e. cds.connect.to('db').
  ${ process.argv[1].endsWith('cds') && process.argv[2] in {run:1,serve:1} ? `
  Please configure one thru 'cds.requires.db' or use in-memory db:
  cds ${process.argv[2]} --in-memory` : ''}`

,{},_base)
