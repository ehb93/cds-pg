const cds = require('../../cds')
const { SELECT } = cds.ql

const getTemplate = require('../utils/template')
const templateProcessor = require('../utils/templateProcessor')
const replaceManagedData = require('../utils/dollar')

const onlyKeysRemain = require('../utils/onlyKeysRemain')

const _targetEntityDoesNotExist = async req => {
  const { query } = req

  const cqn = SELECT.from(query.UPDATE.entity, [1])

  if (query.UPDATE.entity.as) {
    cqn.SELECT.from.as = query.UPDATE.entity.as
  }

  // REVISIT: compat mode for service functions .update
  if (query.UPDATE && query.UPDATE.where) {
    cqn.where(query.UPDATE.where)
  }

  const exists = await cds.tx(req).run(cqn)

  return exists.length === 0
}

const _processorFn = req => {
  const { event, user, timestamp } = req
  const ts = new Date(timestamp).toISOString()

  return ({ row, key, plain }) => {
    const categories = plain.categories

    for (const category of categories) {
      if (category === '@cds.on.update' || (event === 'CREATE' && category === '@cds.on.insert')) {
        replaceManagedData(row, key, user, ts)
      }
    }
  }
}

// params: element, target, parent, templateElements
const _pick = element => {
  // collect actions to apply
  const categories = []

  if (element['@cds.on.insert']) categories.push('@cds.on.insert')
  if (element['@cds.on.update']) categories.push('@cds.on.update')

  if (categories.length) return { categories }
}

const _updateReqData = (req, that) => {
  const template = getTemplate('app-output', that, req.target, { pick: _pick })
  if (template.elements.size > 0) {
    const arrayData = Array.isArray(req.data) ? req.data : [req.data]
    for (const row of arrayData) {
      const args = {
        processFn: _processorFn(req),
        row,
        template
      }
      templateProcessor(args)
    }
  }
}

module.exports = cds.service.impl(function () {
  this.on(['CREATE', 'READ', 'UPDATE', 'DELETE'], '*', async function (req) {
    if (typeof req.query !== 'string' && req.target && req.target._hasPersistenceSkip) {
      req.reject(501, 'PERSISTENCE_SKIP_NO_GENERIC_CRUD', [req.target.name])
    }

    if (!cds.db) {
      // REVISIT: error message
      req.reject(501, 'NO_DATABASE_CONNECTION')
    }

    let result

    // no changes, no op (otherwise, @cds.on.update gets new values), but we need to check existence
    if (req.event === 'UPDATE' && onlyKeysRemain(req)) {
      if (await _targetEntityDoesNotExist(req)) {
        req.reject(404)
      }

      result = req.data
    }

    if (req.event === 'DELETE' && req.target._isSingleton) {
      if (!req.target['@odata.singleton.nullable']) {
        req.reject(400, 'SINGLETON_NOT_NULLABLE')
      }

      const singleton = await cds.tx(req).run(SELECT.one(req.target))
      if (!singleton) req.reject(404)
      req.query.where(singleton)
    }

    if (!result) {
      result = await cds.tx(req).run(req.query, req.data)
    }

    if (req.event === 'READ') {
      return result
    }

    if (req.event === 'DELETE') {
      if (result === 0) {
        req.reject(404)
      }

      return result
    }

    // case: no authorization check and payload more than just keys but no changes -> affected rows === 0 -> no change or not exists?
    if (!req._authChecked && req.event === 'UPDATE' && result === 0 && (await _targetEntityDoesNotExist(req))) {
      req.reject(404)
    }

    // flag to trigger read after write in protocol adapter
    req._.readAfterWrite = true

    // update req.data
    _updateReqData(req, this)

    return req.data
  })
})
