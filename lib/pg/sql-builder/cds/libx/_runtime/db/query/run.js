const { timestampToISO } = require('../data-conversion/timestamp')

const run = (insert, read, update, deleet, cqn, sql) => (model, dbc, query, req, values) => {
  if (typeof query === 'string') {
    return sql(dbc, query, values)
  }

  if (query.SELECT) {
    return read(model, dbc, query, req)
  }

  if (query.DELETE) {
    return deleet(model, dbc, query, req)
  }

  if (query.INSERT) {
    return insert(model, dbc, query, req)
  }

  if (query.UPDATE) {
    return update(model, dbc, query, req)
  }

  const { user, locale, timestamp } = req
  const isoTs = timestampToISO(timestamp)

  return cqn(model, dbc, query, user, locale, isoTs)
}

module.exports = run
