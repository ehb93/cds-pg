const cds = require ('../../')
const util = require('util')

const _l2l = { 1: 'error', 2: 'warn', 3: 'info', 4: 'debug', 5: 'trace' }

/*
 * log formatter for kibana
 */
module.exports = (module, level, ...args) => {
  // config
  const { user: log_user , kibana_custom_fields } = cds.env.log

  // build the object to log
  const toLog = {
    level: _l2l[level] || 'info',
    logger: module,
    component_type: 'application'
  }

  // add correlation
  if (cds.context) {
    const { id, tenant, user } = cds.context
    toLog.correlation_id = id
    if (tenant) toLog.tenant_id = tenant
    // log user id, if configured (data privacy)
    if (user && log_user) toLog.remote_user = user.id
    // add headers, if available, with _ instead of -
    const req = cds.context._ && cds.context._.req
    if (req && req.headers) for (const k in req.headers) toLog[k.replace(/-/g, '_')] = req.headers[k]
  }
  toLog.timestamp = new Date()

  // merge toLog with passed Error (or error-like object)
  if (args.length && typeof args[0] === 'object' && args[0].message) {
    const err = args.shift()
    toLog.msg = err.message
    if (err instanceof Error) toLog.stacktrace = err.stack.split(/\s*\r?\n\s*/)
    Object.assign(toLog, err)
  }

  // append remaining args via util.format()
  if (args.length) toLog.msg = toLog.msg ? util.format(toLog.msg, ...args) : util.format(...args)

  // 4xx: remove stack and lower to warning (if error)
  if (toLog.code >= 400 && toLog.code < 500) {
    delete toLog.stacktrace
    if (toLog.level && toLog.level.match(/error/i)) toLog.level = 'warn'
  }

  // kibana custom fields
  if (kibana_custom_fields) {
    const cf = []
    for (const k in kibana_custom_fields) if (toLog[k]) cf.push({ k, v: toLog[k], i: kibana_custom_fields[k] })
    if (cf.length) toLog['#cf'] = { string: cf }
  }

  // return array with the stringified toLog (to avoid multiple log lines) as the sole element
  return [JSON.stringify(toLog)]
}
