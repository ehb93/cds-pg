const { SQLITE_TYPE_CONVERSION_MAP } = require('./conversion')
const CustomBuilder = require('./customBuilder')
const { sqlFactory } = require('../db/sql-builder/')
const { getPostProcessMapper, postProcess } = require('../db/data-conversion/post-processing')
const { createJoinCQNFromExpanded, hasExpand, rawToExpanded } = require('../db/expand')
const { Readable } = require('stream')

const cds = require('../cds')
const LOG = cds.log('sqlite|db|sql')
// && {_debug:true, debug(sql){ cds._debug && console.log(sql+';\n') }} //> please keep that for debugging stakeholder tests
const { inspect } = require('util')

/*
 * capture stack trace on the way to exec to know origin
 * -> very expensive
 * -> only if DEBUG (which should not be used in production)
 */
const DEBUG = cds.debug('sqlite')
const _captureStack = DEBUG
  ? () => {
      const o = {}
      Error.captureStackTrace(o, _captureStack)
      return o
    }
  : () => undefined

/*
 * helpers
 */
const _colored = {
  BEGIN: '\x1b[1m\x1b[33mBEGIN\x1b[0m',
  COMMIT: '\x1b[1m\x1b[32mCOMMIT\x1b[0m',
  ROLLBACK: '\x1b[1m\x1b[91mROLLBACK\x1b[0m'
}
const _augmented = (err, sql, o) => {
  err.query = sql
  err.message += ' in: \n' + sql
  if (o) err.stack = err.message + o.stack.slice(5)
  return err
}

function _executeSimpleSQL(dbc, sql, values) {
  LOG._debug && LOG.debug(_colored[sql] || sql, values || '')

  return new Promise((resolve, reject) => {
    const o = _captureStack()
    dbc.run(sql, values, function (err) {
      if (err) return reject(_augmented(err, sql, o))

      resolve(this.changes)
    })
  })
}

function executeSelectSQL(dbc, sql, values, isOne, postMapper) {
  LOG._debug && LOG.debug(sql, values)

  return new Promise((resolve, reject) => {
    const o = _captureStack()
    dbc[isOne ? 'get' : 'all'](sql, values, (err, result) => {
      if (err) return reject(_augmented(err, sql, o))

      // REVISIT
      // .get returns undefined if nothing in db
      // our coding expects the result to be null if isOne does not return anything
      // REVISIT: -> we should definitely fix that coding which expects null
      if (isOne && result === undefined) {
        result = null
      }

      try {
        result = postProcess(result, postMapper)
        resolve(result)
      } catch (e) {
        reject(e)
      }
    })
  })
}

function _processExpand(model, dbc, cqn, user, locale, txTimestamp) {
  const queries = []
  const expandQueries = createJoinCQNFromExpanded(cqn, model, locale)

  for (const cqn of expandQueries.queries) {
    cqn._conversionMapper = getPostProcessMapper(SQLITE_TYPE_CONVERSION_MAP, model, cqn)

    // REVISIT
    // Why is the post processing in expand different?
    const { sql, values } = sqlFactory(cqn, { user, now: txTimestamp, customBuilder: CustomBuilder }, model)
    queries.push(executeSelectSQL(dbc, sql, values, false))
  }

  return rawToExpanded(expandQueries, queries, cqn.SELECT.one, cqn._target)
}

function executeSelectCQN(model, dbc, query, user, locale, txTimestamp) {
  if (hasExpand(query)) {
    return _processExpand(model, dbc, query, user, locale, txTimestamp)
  }
  const { sql, values = [] } = sqlFactory(
    query,
    {
      user,
      customBuilder: CustomBuilder,
      now: txTimestamp || { sql: "strftime('%Y-%m-%dT%H:%M:%fZ','now')" }, // '2012-12-03T07:16:23.574Z'
      locale
    },
    model
  )

  return executeSelectSQL(
    dbc,
    sql,
    values,
    query.SELECT.one,
    getPostProcessMapper(SQLITE_TYPE_CONVERSION_MAP, model, query)
  )
}

function executeDeleteCQN(model, dbc, cqn, user, locale, txTimestamp) {
  const { sql, values = [] } = sqlFactory(
    cqn,
    {
      user,
      customBuilder: CustomBuilder,
      now: txTimestamp || { sql: "strftime('%Y-%m-%dT%H:%M:%fZ','now')" } // '2012-12-03T07:16:23.574Z'
    },
    model
  )

  return _executeSimpleSQL(dbc, sql, values)
}

const _executeBulkInsertSQL = (dbc, sql, values) =>
  new Promise((resolve, reject) => {
    if (!Array.isArray(values)) {
      return reject(new Error(`Cannot execute SQL statement. Invalid values provided: ${inspect(values)}`))
    }

    LOG._debug && LOG.debug(sql, values)
    const o = _captureStack()
    const stmt = dbc.prepare(sql, err => {
      if (err) return reject(_augmented(err, sql, o))

      if (!Array.isArray(values[0])) values = [values]

      // guarantee order through counters in closure
      let i = 0
      let n = values.length
      let isFinalized = false
      const results = Array(n)
      values.forEach(each => {
        const k = i
        i++
        stmt.run(each, function (err) {
          if (err) {
            err.values = each
            if (!isFinalized) {
              isFinalized = true
              stmt.finalize()
              return reject(_augmented(err, sql, o))
            }
          }

          // InsertResult needs an object per row with its values
          results[k] = { lastID: this.lastID, affectedRows: 1, values: each }
          n--
          if (n === 0) {
            if (!isFinalized) {
              isFinalized = true
              stmt.finalize()
              resolve(results)
            }
          }
        })
      })
    })
  })

function executePlainSQL(dbc, sql, values, isOne, postMapper) {
  // support named binding parameters
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    values = new Proxy(values, {
      getOwnPropertyDescriptor: (o, p) => Object.getOwnPropertyDescriptor(o, p.slice(1)),
      get: (o, p) => o[p.slice(1)],
      ownKeys: o => Reflect.ownKeys(o).map(k => `:${k}`)
    })
  }

  if (/^\s*(select|pragma)/i.test(sql)) {
    return executeSelectSQL(dbc, sql, values, isOne, postMapper)
  }

  if (/^\s*insert/i.test(sql)) {
    return executeInsertSQL(dbc, sql, values)
  }

  return _executeSimpleSQL(dbc, sql, values && Array.isArray(values[0]) ? values[0] : values)
}

function executeInsertSQL(dbc, sql, values, query) {
  // Only bulk inserts will have arrays in arrays
  if (Array.isArray(values[0])) {
    if (values.length > 1) {
      return _executeBulkInsertSQL(dbc, sql, values)
    } else {
      values = values[0]
    }
  }

  LOG._debug && LOG.debug(sql, values)

  return new Promise((resolve, reject) => {
    const o = _captureStack()
    dbc.run(sql, values, function (err) {
      if (err) return reject(_augmented(err, sql, o))

      // InsertResult needs an object per row with its values
      if (query && values.length > 0) {
        // > single row via cqn
        resolve([{ lastID: this.lastID, affectedRows: 1, values }])
      } else {
        // > plain sql or INSERT into SELECT
        resolve([{ lastID: this.lastID, affectedRows: this.changes }])
      }
    })
  })
}

function _convertStreamValues(values) {
  let any
  values.forEach((v, i) => {
    if (v && typeof v.pipe === 'function') {
      any = values[i] = new Promise(resolve => {
        const chunks = []
        v.on('data', chunk => chunks.push(chunk))
        v.on('end', () => resolve(Buffer.concat(chunks)))
        v.on('error', () => {
          v.removeAllListeners('error')
          v.push(null)
        })
      })
    }
  })
  return any ? Promise.all(values) : values
}

async function executeInsertCQN(model, dbc, query, user, locale, txTimestamp) {
  const { sql, values = [] } = sqlFactory(
    query,
    {
      user,
      customBuilder: CustomBuilder,
      now: txTimestamp || { sql: "strftime('%Y-%m-%dT%H:%M:%fZ','now')" } // '2012-12-03T07:16:23.574Z'
    },
    model
  )
  const vals = await _convertStreamValues(values)
  return executeInsertSQL(dbc, sql, vals, query)
}

async function executeUpdateCQN(model, dbc, cqn, user, locale, txTimestamp) {
  const { sql, values = [] } = sqlFactory(
    cqn,
    {
      user,
      customBuilder: CustomBuilder,
      now: txTimestamp || { sql: "strftime('%Y-%m-%dT%H:%M:%fZ','now')" } // '2012-12-03T07:16:23.574Z'
    },
    model
  )
  const vals = await _convertStreamValues(values)
  return executePlainSQL(dbc, sql, vals)
}

// e. g. DROP, CREATE TABLE
function executeGenericCQN(model, dbc, cqn, user, locale, txTimestamp) {
  const { sql, values } = sqlFactory(
    cqn,
    {
      user,
      customBuilder: CustomBuilder,
      now: txTimestamp || { sql: "strftime('%Y-%m-%dT%H:%M:%fZ','now')" } // '2012-12-03T07:16:23.574Z'
    },
    model
  )

  return executePlainSQL(dbc, sql, values)
}

async function executeSelectStreamCQN(model, dbc, query, user, locale, txTimestamp) {
  const result = await executeSelectCQN(model, dbc, query, user, locale, txTimestamp)

  if (result == null || result.length === 0) {
    return
  }

  let val = Array.isArray(result) ? Object.values(result[0])[0] : Object.values(result)[0]
  if (val === null) {
    return null
  }
  if (typeof val === 'number') {
    val = val.toString()
  }

  const stream_ = new Readable()
  stream_.push(val)
  stream_.push(null)

  return { value: stream_ }
}

module.exports = {
  delete: executeDeleteCQN,
  insert: executeInsertCQN,
  update: executeUpdateCQN,
  select: executeSelectCQN,
  stream: executeSelectStreamCQN,
  cqn: executeGenericCQN,
  sql: executePlainSQL
}
