const cds = require('../cds')
const LOG = cds.log('hana|db|sql')

const { dynatraceStreamingExtension, isDynatraceEnabled } = require('./dynatrace')
const { ensureNoDraftsSuffix } = require('../common/utils/draft')

const STREAM_PLACEHOLDER = '[<stream>]'

const _loadStreamExtensionIfNeeded = () => {
  const hana = require('./driver')
  if (hana.name !== 'hdb') {
    const extension = require('@sap/hana-client/extension/Stream.js')
    return isDynatraceEnabled() ? dynatraceStreamingExtension(extension) : extension
  }
}

const streamExtension = _loadStreamExtensionIfNeeded()

function hasStreamInsert(insert, model) {
  if (!model) return true
  const into = model.definitions[ensureNoDraftsSuffix(insert.into)]
  if (!into) return false

  if (insert.entries && insert.entries.length > 0) {
    return Object.keys(insert.entries[0])
      .map(col => into.elements[col])
      .some(e => e && e['@Core.MediaType'])
  }
  if (insert.columns && insert.columns.length > 0) {
    return Object.keys(insert.columns)
      .map(col => into.elements[col])
      .some(e => e && e['@Core.MediaType'])
  }

  return false
}

function hasStreamUpdate(update, model) {
  if (!model) {
    return true
  }

  const entity = model.definitions[ensureNoDraftsSuffix((update.entity.ref && update.entity.ref[0]) || update.entity)]
  if (!entity) return false

  const data = Object.assign({}, update.data || {}, update.with || {})
  return Object.keys(data)
    .map(col => entity.elements[col])
    .some(e => e && e['@Core.MediaType'])
}

function _getColumnInfo(result) {
  const columnInfo = []

  for (let i = 0, length = result.getColumnCount(); i < length; i++) {
    columnInfo.push({
      name: result.getColumnInfo()[i].originalColumnName,
      lob: result.getColumnInfo()[i].nativeTypeName === 'BLOB'
    })
  }

  return columnInfo
}

function _getResultSetRow(result, columnInfo, stmt) {
  const res = {}

  for (let i = 0, length = result.getColumnCount(); i < length; i++) {
    if (columnInfo[i].lob) {
      if (result.isNull(i)) {
        res[columnInfo[i].name] = null
      } else {
        res[columnInfo[i].name] = streamExtension.createLobStream(result, i, { readSize: 1024000 })
        res[columnInfo[i].name].on('end', () => {
          stmt.drop(() => {})
        })
        res[columnInfo[i].name].on('error', () => {
          stmt.drop(() => {})
        })
      }
    } else {
      res[columnInfo[i].name] = result.getValue(i)
    }
  }

  return res
}

const _writeStreamCb = (resolve, reject, sql, values) => {
  return (err, stmt) => {
    if (err) {
      err.query = sql
      err.values = values
      return reject(err)
    }

    stmt.exec(values, (err, result) => {
      stmt.drop(() => {})
      if (err) {
        err.query = sql
        err.values = values
        return reject(err)
      }
      resolve(result)
    })
  }
}

// TODO combine with hana client fn?
function writeStreamWithHdb(dbc, sql, values) {
  LOG._debug && LOG.debug(`${sql} ${values && values.length ? STREAM_PLACEHOLDER : ''}`)
  return new Promise((resolve, reject) => {
    try {
      dbc.prepare(sql, _writeStreamCb(resolve, reject, sql, values))
    } catch (err) {
      // TODO convertErrorCodeToString(err)
      err.query = sql
      return reject(err)
    }
  })
}

function writeStreamWithHanaClient(dbc, sql, values) {
  LOG._debug && LOG.debug(`${sql} ${values && values.length ? STREAM_PLACEHOLDER : ''}`)
  return new Promise((resolve, reject) => {
    streamExtension.createStatement(dbc, sql, _writeStreamCb(resolve, reject, sql, values))
  })
}

function _getReadObjectHanaClient(result, stmt, resolve, reject) {
  const resultSet = []
  const columnInfo = _getColumnInfo(result)

  let next = true

  while (next) {
    next = result.next((err, ret) => {
      if (err) {
        return reject(err)
      }

      if (ret) {
        resultSet.push(_getResultSetRow(result, columnInfo, stmt))
      }

      if (!next) {
        resolve(resultSet)
      }
    })
  }
}

function readStreamWithHanaClient(dbc, sql, values) {
  LOG._debug && LOG.debug(`${sql} ${values && values.length ? STREAM_PLACEHOLDER : ''}`)
  return new Promise((resolve, reject) => {
    streamExtension.createStatement(dbc, sql, (err, stmt) => {
      if (err) {
        err.query = sql
        err.values = values
        return reject(err)
      }

      stmt.stmt.executeQuery(values, (err, result) => {
        if (err) {
          err.query = sql
          err.values = values
          return reject(err)
        }

        // The method createObjectStream does not work in hana-client as expected.
        // It provides the complete LOBs and not the streams.
        // The resultset should be constructed like bellow.
        _getReadObjectHanaClient(result, stmt, resolve, reject)
      })
    })
  })
}

function _getReadObjectHdb(result, rows, statement) {
  return () => {
    const row = result.read()

    if (row) {
      for (const key in row) {
        if (typeof row[key] === 'object' && row[key] !== null) {
          row[key] = row[key].createReadStream()
          row[key].on('end', () => {
            statement.drop()
          })
          row[key].on('error', () => {
            statement.drop()
          })
        }
      }

      rows.push(row)
    }
  }
}

function readStreamWithHdb(dbc, sql, values) {
  LOG._debug && LOG.debug(`${sql} ${values && values.length ? STREAM_PLACEHOLDER : ''}`)
  return new Promise((resolve, reject) => {
    const cb = (err, statement) => {
      if (err) {
        // TODO convertErrorCodeToString(err)
        err.query = sql

        return reject(err)
      }

      statement.execute(values, (err, result) => {
        if (err) {
          // TODO convertErrorCodeToString(err)
          err.query = this.sql
          statement.drop()

          return reject(err)
        }

        const rows = []
        const objStream = result.createObjectStream()

        objStream
          .on('readable', _getReadObjectHdb(objStream, rows, statement))
          .once('error', err => reject(err))
          .once('end', () => resolve(rows))
      })
    }

    try {
      dbc.prepare(sql, cb)
    } catch (err) {
      //  TODO convertErrorCodeToString(err)
      err.query = sql
      return reject(err)
    }
  })
}

module.exports = {
  hasStreamInsert,
  hasStreamUpdate,
  writeStreamWithHanaClient,
  readStreamWithHanaClient,
  writeStreamWithHdb,
  readStreamWithHdb
}
