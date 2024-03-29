// REVISIT: UpdateResult
// const UpdateResult = require('../result/UpdateResult')

const { allKeysAreProvided } = require('../../cds-services/services/utils/handlerUtils')
const onlyKeysRemain = require('../../common/utils/onlyKeysRemain')

const _enrichKeysFromOldData = (req, oldData) => {
  const data = req.data && (Array.isArray(req.data) ? req.data : [req.data])
  for (const key of Object.values(req.target.keys)) {
    for (const d of data) {
      // If key not in data, check if in old data (example case: PATCH singleton)
      if (d[key.name] === undefined && oldData && oldData[key.name] !== undefined) {
        d[key.name] = oldData[key.name]
      }
    }
  }
}

const _addKeysToQuery = req => {
  req.query.where(
    Object.keys(req.data).reduce((prev, curr) => {
      if (req.target.keys[curr]) {
        prev[curr] = req.data[curr]
      }
      return prev
    }, {})
  )
}

const _targetKeys = target => {
  return Object.values(target.keys || {})
    .filter(k => !(k.is2one || k.is2many))
    .map(k => ({ ref: [k.name] }))
}

/**
 * Generic Handler for UPDATE requests.
 * REVISIT: correct description?
 * In case of success it returns the updated entry.
 * If the entry to be updated does not exist, a new entry is created.
 *
 * @param req - cds.Request
 */
module.exports = async function (req) {
  if (typeof req.query === 'string') {
    return this._execute.sql(this.dbc, req.query, req.data)
  }

  if (req.target && !req.target._unresolved && req.target._isSingleton) {
    if (!allKeysAreProvided(req)) {
      // REVISIT: There can also be renaming... we better use resolveView here.
      const targetKeys = _targetKeys(req.target)
      const readKeysCQN =
        req.target.query && req.target.query.SELECT
          ? {
              SELECT: Object.assign({ columns: targetKeys, one: true }, req.target.query.SELECT)
            }
          : SELECT.from(req.target).columns(targetKeys)

      // REVISIT: avoid additional read
      const current = await this._read(this.model, this.dbc, readKeysCQN, req)
      _enrichKeysFromOldData(req, current)
    }

    if (!req.query.UPDATE.where && req.target.keys) {
      _addKeysToQuery(req)
    }
  }

  if (onlyKeysRemain(req)) return

  try {
    const result = await this._update(this.model, this.dbc, req.query, req)
    return result
  } catch (err) {
    // REVISIT: db specifics
    if (err.message.match(/unique constraint/i)) {
      err.originalMessage = err.message
      err.message = 'UNIQUE_CONSTRAINT_VIOLATION'
      err.code = 400
    }
    req.reject(err)
  }
}
