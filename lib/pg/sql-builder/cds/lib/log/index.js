const cds = require ('../index'), { log } = cds.env

// Use configured logger in case of cds serve
if (log.Logger || log.service) {
  if (log.Logger) exports.Logger = require (log.Logger)
  if (log.service) {
    const {app} = cds, srv = require('./service')
    app ? setImmediate(()=>srv.serveIn(app)) : cds.on('bootstrap', app => srv.serveIn(app))
  }
}


/**
 * Returns a trace logger for the given module if trace is switched on for it,
 * otherwise returns null. All cds runtime packages use this method for their
 * trace and debug output. It can also be used in applications like that:
 *
 *    const LOG = cds.log('sql')
 *    LOG._info && LOG.info ('whatever', you, 'like...')
 *
 * You can also specify alternate module names:
 *
 *    const LOG = cds.log('sql|db')
 *
 * By default this logger would prefix all output with '[sql] - '.
 * You can change this by specifying another prefix in the options:
 *
 *    const LOG = cds.log('sql|db',{ prefix:'cds.ql' })
 *
 * Call cds.log() for a given module again to dynamically change the log level
 * of all formerly created loggers, for example:
 *
 *    const LOG = cds.log('sql')
 *    LOG.info ('this will show, as default level is info')
 *    cds.log('sql','warn')
 *    LOG.info ('this will be suppressed now')
 *
 * Tracing can be switched on/off through env variable DEBUG:
 * Set it to a comma-separated list of modules to switch on tracing.
 * Set it to 'all' or 'y' to switch on tracing for all modules.
 *
 * @param {string} [module] the module for which a logger is requested
 * @param {string|number|{ level, prefix }} [options] the log level to enable -> 0=off, 1=error, 2=warn, 3=info, 4=debug, 5=trace
 */
module.exports = exports = function cds_log (module, options) { // NOSONAR
  let id = module ? module.match(/^[^|]+/)[0] : 'cds'
  let logger = cached[id]; if (logger && !options) return logger

  let { level, prefix } = typeof options === 'object' ? options : {level:options}
  if (!prefix) prefix = logger && logger.prefix || id
  if (!level) level = (
    process.env.DEBUG && process.env.DEBUG.match(RegExp(`\\b(y|all|${module||'any'})\\b`)) ? DEBUG :
    log.levels[id] || INFO
  )
  if (typeof level === 'string') {
    level = exports.levels [level.toUpperCase()]
  }

  // IMPORTANT: cds.log() can be called again to change the log level
  // of formerly constructed loggers!!
  if (logger && logger.level === level) return logger
  else logger = exports.Logger (prefix, level)
  return cached[id] = Object.assign (cached[id] || logger.log, logger, {
    id, level, prefix, setFormat(fn){ logger.format = fn }
  })
}


/**
 * Shortcut to `cds.log(...).debug`, returning undefined if `cds.log(...)._debug` is false.
 * @param {string} [module] the module for which a logger is requested
 */
exports.debug = function cds_debug (module) {
  const L = this.log (module)
  return L._debug && L.debug
}


/**
 * Constructs a new Logger with the method signature of `{ debug, log, info, warn, error }`
 * from console. The default implementation actually maps it to `global.console`.
 * You can assign different implementations, e.g. to integrate with advanced
 * logging frameworks, for example like that:
 *
 *    cds.log.Logger = () => winston.createLogger (...)
 *
 * @param {string} [module] the module for which a logger is requested
 * @param {number} [level]  the log level to enable -> 0=off, 1=error, 2=warn, 3=info, 4=debug, 5=trace
 */
/* eslint-disable no-console */
exports.Logger = (module, level) => {
  const fmt = (level,args) => logger.format (module,level,...args)
  const logger = Object.assign ({
    format: exports.format,
    trace:  level < TRACE ? ()=>{} : (...args) => console.trace (...fmt(TRACE,args)),
    debug:  level < DEBUG ? ()=>{} : (...args) => console.debug (...fmt(DEBUG,args)),
    log:    level < INFO  ? ()=>{} : (...args) => console.log (...fmt(INFO,args)),
    info:   level < INFO  ? ()=>{} : (...args) => console.info (...fmt(INFO,args)),
    warn:   level < WARN  ? ()=>{} : (...args) => console.warn (...fmt(WARN,args)),
    error:  level < ERROR ? ()=>{} : (...args) => console.error (...fmt(ERROR,args)),
    _trace: level >= TRACE,
    _debug: level >= DEBUG,
    _info:  level >= INFO,
    _warn:  level >= WARN,
    _error: level >= ERROR,
  })
  // deleted stdout -> stderr redirection for cds compile as bin/utils/log.js is used
  return logger
}


/**
 * Formats a log outputs by returning an array of arguments which are passed to
 * console.log() et al.
 * You can assign custom formatters like that:
 *
 *    cds.log.format = (module, level, ...args) => [ '[', module, ']', ...args ]
 *
 * @param {string} module the module for which a logger is requested
 * @param {number} level  the log level to enable -> 0=off, 1=error, 2=warn, 3=info, 4=debug, 5=trace
 * @param {any[]} args  the arguments passed to Logger.debug|log|info|wanr|error()
 */
exports.format = (
  process.env.NODE_ENV === 'production' && cds.env.features.kibana_formatter ? require('./format/kibana')
  : (module, level, ...args) => [ `[${module}] -`, ...args ]
)


const { ERROR, WARN, INFO, DEBUG, TRACE } = exports.levels = {
  SILENT:0, ERROR:1, WARN:2, INFO:3, DEBUG:4, TRACE:5, SILLY:5, VERBOSE:5
}
const cached = exports.loggers = {}
