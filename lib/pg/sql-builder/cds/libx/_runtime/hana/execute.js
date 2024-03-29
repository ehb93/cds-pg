const { HANA_TYPE_CONVERSION_MAP } = require('./conversion')
const CustomBuilder = require('./customBuilder')
const { sqlFactory } = require('../db/sql-builder/')
const {
  getPostProcessMapper,
  getPropertyMapper,
  getStructMapper,
  postProcess
} = require('../db/data-conversion/post-processing')
const { createJoinCQNFromExpanded, hasExpand, rawToExpanded } = require('../db/expand')
const {
  hasStreamInsert,
  hasStreamUpdate,
  writeStreamWithHanaClient,
  readStreamWithHanaClient,
  writeStreamWithHdb,
  readStreamWithHdb
} = require('./streaming')

function _cqnToSQL(model, query, user, locale, txTimestamp) {
  return sqlFactory(
    query,
    {
      user,
      customBuilder: CustomBuilder,
      now: txTimestamp || { sql: 'NOW ()' },
      locale
    },
    model
  )
}

const cds = require('../cds')
const LOG = cds.log('hana|db|sql')

function _getOutputParameters(stmt) {
  const result = {}
  const info = stmt.getParameterInfo()
  for (let i = 0; i < info.length; i++) {
    const param = info[i]
    if (param.direction === 2) {
      result[param.name] = stmt.getParameterValue(i)
    }
  }

  return Object.keys(result).length > 0 ? result : undefined
}

function _executeAsPreparedStatement(dbc, sql, values, reject, resolve) {
  dbc.prepare(sql, function (err, stmt) {
    if (err) {
      err.query = sql
      if (values) err.values = values
      return reject(err)
    }

    // REVISIT: adjust binary values on hdb
    if (_hasValues(values) && dbc.name === 'hdb' && stmt.parameterMetadata) {
      const vals = Array.isArray(values[0]) ? values : [values]
      for (const row of vals) {
        for (let i = 0; i < stmt.parameterMetadata.length; i++) {
          /*
           * BINARY: 12
           * VARBINARY: 13
           */
          if (stmt.parameterMetadata[i].dataType === 12 || stmt.parameterMetadata[i].dataType === 13) {
            if (row[i] && !Buffer.isBuffer(row[i])) {
              row[i] = Buffer.from(row[i].match(/.{1,2}/g).map(val => parseInt(val, 16)))
            }
          }
        }
      }
    }

    stmt.exec(values, function (err, rows, procedureReturn) {
      if (err) {
        stmt.drop(() => {})
        err.query = sql
        if (values) err.values = values
        return reject(err)
      }

      let result = rows
      if (dbc.name !== 'hdb') {
        result = _getOutputParameters(stmt) || rows
      }

      stmt.drop(() => {})
      resolve(procedureReturn || result)
    })
  })
}

const _hasValues = values => values && (values.length > 0 || Object.values(values).length > 0)

const regex = /with parameters\s*?\(\s*?'LOCALE'\s*?=\s*?'.*?'\s*?\)/gim

function _executeSimpleSQL(dbc, sql, values) {
  const res = sql.match(regex)
  if (res) sql = sql.replace(regex, '') + ' ' + res[0]

  LOG._debug && LOG.debug(`${sql} ${values && values.length ? JSON.stringify(values) : ''}`)
  return new Promise((resolve, reject) => {
    // hana-client only accepts arrays
    if (dbc.name !== 'hdb' && typeof values === 'object') {
      values = Object.values(values)
    }
    // ensure that stored procedure with parameters is always executed as prepared
    if (_hasValues(sql, values) || sql.match(/^call.*?\?.*$/i)) {
      _executeAsPreparedStatement(dbc, sql, values, reject, resolve)
    } else {
      dbc.exec(sql, function (err, result, procedureReturn) {
        if (err) {
          err.query = sql
          return reject(err)
        }
        resolve(procedureReturn || result)
      })
    }
  })
}

function _executeSelectSQL(dbc, sql, values, isOne, postMapper, propertyMapper, objStructMapper) {
  return _executeSimpleSQL(dbc, sql, values).then(result => {
    if (isOne) {
      result = result.length > 0 ? result[0] : null
    }

    return postProcess(result, postMapper, propertyMapper, objStructMapper)
  })
}

function _processExpand(model, dbc, cqn, user, locale, txTimestamp) {
  const queries = []
  const expandQueries = createJoinCQNFromExpanded(cqn, model)

  for (const cqn of expandQueries.queries) {
    cqn._conversionMapper = getPostProcessMapper(HANA_TYPE_CONVERSION_MAP, model, cqn)

    // REVISIT
    // Why is the post processing in expand different?
    const { sql, values } = _cqnToSQL(model, cqn, user, locale, txTimestamp)

    queries.push(_executeSelectSQL(dbc, sql, values, false))
  }

  return rawToExpanded(expandQueries, queries, cqn.SELECT.one, cqn._target)
}

function executeSelectCQN(model, dbc, query, user, locale, txTimestamp) {
  if (hasExpand(query)) {
    return _processExpand(model, dbc, query, user, locale, txTimestamp)
  }

  const { sql, values = [] } = _cqnToSQL(model, query, user, locale, txTimestamp)
  const propertyMapper = getPropertyMapper(model, query, true)

  return _executeSelectSQL(
    dbc,
    sql,
    values,
    query.SELECT.one,
    getPostProcessMapper(HANA_TYPE_CONVERSION_MAP, model, query),
    propertyMapper,
    getStructMapper(model, query, propertyMapper)
  )
}

function _getValuesProxy(values) {
  return new Proxy(values, {
    getOwnPropertyDescriptor: (obj, prop) => {
      if (prop.length > 1 && prop.startsWith(':')) {
        return Object.getOwnPropertyDescriptor(obj, prop.slice(1))
      }
      return Object.getOwnPropertyDescriptor(obj, prop)
    },
    get: (obj, prop) => {
      if (prop.length > 1 && prop.startsWith(':')) {
        return obj[prop.slice(1)]
      }
      return obj[prop]
    },
    ownKeys: target => {
      return Reflect.ownKeys(target).map(key => `:${key}`)
    }
  })
}

function executePlainSQL(dbc, sql, values) {
  // Revisit: Keep for Hana?
  // support named binding parameters
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    values = _getValuesProxy(values)
  }

  return _executeSimpleSQL(dbc, sql, values)
}

function executeInsertCQN(model, dbc, query, user, locale, txTimestamp) {
  const { sql, values = [] } = _cqnToSQL(model, query, user, locale, txTimestamp)

  if (hasStreamInsert(query.INSERT, model)) {
    if (dbc.name === 'hdb') {
      return writeStreamWithHdb(dbc, sql, values)
    }
    return writeStreamWithHanaClient(dbc, sql, values)
  }

  return _executeSimpleSQL(dbc, sql, values).then(affectedRows => {
    // InsertResult needs an object per row with its values
    // query.INSERT.values -> one row
    if (query.INSERT.values) return [{ affectedRows: 1, values: [values] }]
    // query.INSERT.entries or .rows -> multiple rows
    if (query.INSERT.entries || query.INSERT.rows) return values.map(v => ({ affectedRows: 1, values: v }))
    // INSERT into SELECT
    return [{ affectedRows }]
  })
}

function executeUpdateCQN(model, dbc, query, user, locale, txTimestamp) {
  const { sql, values = [] } = _cqnToSQL(model, query, user, locale, txTimestamp)

  // query can be insert from deep update
  if (query.UPDATE && hasStreamUpdate(query.UPDATE, model)) {
    if (dbc.name === 'hdb') {
      return writeStreamWithHdb(dbc, sql, values)
    }
    return writeStreamWithHanaClient(dbc, sql, values)
  }

  return _executeSimpleSQL(dbc, sql, values)
}

// e. g. DROP, CREATE TABLE, DELETE
function executeGenericCQN(model, dbc, query, user, locale, txTimestamp) {
  const { sql, values = [] } = _cqnToSQL(model, query, user, locale, txTimestamp)

  return executePlainSQL(dbc, sql, values)
}

async function executeSelectStreamCQN(model, dbc, query, user, locale, txTimestamp) {
  const { sql, values = [] } = _cqnToSQL(model, query, user, locale, txTimestamp)
  let result
  if (dbc.name === 'hdb') {
    result = await readStreamWithHdb(dbc, sql, values)
  } else {
    result = await readStreamWithHanaClient(dbc, sql, values)
  }

  if (result.length === 0) {
    return
  }

  const val = Object.values(result[0])[0]
  if (val === null) {
    return null
  }

  return { value: val }
}

module.exports = {
  delete: executeGenericCQN, // > no extra executeDeleteCQN needed
  insert: executeInsertCQN,
  update: executeUpdateCQN,
  select: executeSelectCQN,
  stream: executeSelectStreamCQN,
  cqn: executeGenericCQN,
  sql: executePlainSQL
}
