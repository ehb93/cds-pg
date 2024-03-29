const cds = require('../../cds')
const { SELECT } = cds.ql

const { cqn2cqn4sql } = require('../../common/utils/cqn2cqn4sql')
const { getDependents } = require('../../common/utils/csn')

const CRUD = {
  CREATE: 1,
  READ: 1,
  UPDATE: 1,
  DELETE: 1
}

const _skipIntegrityCheck = (req, tx) => {
  // REVISIT: remove skipIntegrity after grace period
  if (
    (cds.env.features && cds.env.features.assert_integrity === false) ||
    (cds.env.runtime && cds.env.runtime.skipIntegrity)
  ) {
    return true
  }

  if (!tx.model) return true

  if (req.event in CRUD) {
    if (typeof req.query === 'string') return true
    if (!req.target || req.target._unresolved) return true
  }

  return false
}

/*
 * before delete
 */
const _isPrimitiveKey = e => !e.is2one && !e.is2many

async function beforeDelete(req) {
  if (_skipIntegrityCheck(req, this)) return

  // via protocol adapter with key predicates?
  if (Object.keys(req.data).length > 0) return

  const target = this.model.definitions[req.target.name]
  if (!target) return

  // only if target has dependents (i.e., is the target of a managed to one association)
  const dependents = getDependents(target, this.model)
  if (!dependents) return

  const keys = Object.keys(target.keys).filter(k => _isPrimitiveKey(target.elements[k]) && k !== 'IsActiveEntity')
  let select = SELECT(keys).from(req.target.name)
  if (req.query.DELETE.where) {
    select = select.where(req.query.DELETE.where)
  }

  select = cqn2cqn4sql(select, this.model, { service: this })

  req._beforeDeleteData = await this._read(this.model, this.dbc, select, req.context || req)
}

beforeDelete._initial = true

/*
 * perform check
 */
const { checkIntegrityUtil } = require('../../cds-services/services/utils/handlerUtils')
const C_UD = { CREATE: 1, INSERT: 1, UPDATE: 1, DELETE: 1 }

const _performCheck = async (req, cur, csn, run) => {
  const prev = (cur.errors && cur.errors.length) || 0

  if (Array.isArray(cur.query)) {
    for (const each of cur.query) {
      const r = { query: each, target: each._target, event: each.cmd === 'INSERT' ? 'CREATE' : each.cmd }
      Object.setPrototypeOf(r, cur)
      await checkIntegrityUtil(r, csn, run)
      if (r.errors && r.errors.length) r.errors.forEach(e => req.error(e))
    }
  } else {
    await checkIntegrityUtil(cur, csn, run)
  }

  // only additional errors
  if (cur.errors && cur.errors.length > prev) {
    cur.errors.forEach(e => req.error(e))
  }
}

function performCheck(req) {
  if (_skipIntegrityCheck(req, this)) return

  const root = req.context || req
  const children = root._children
  if (!children || !(this.name in children)) return

  const relevant = children[this.name].filter(r => {
    if (r.event) return r.event in C_UD
    if (Array.isArray(r.query)) return r.query.some(q => q.cmd in C_UD)
    return r.query && r.query.cmd in C_UD
  })
  if (relevant.length === 0) return

  return Promise.all(
    relevant.map(r => _performCheck(req, r, this.model, query => this._read(this.model, this.dbc, query, root)))
  )
}

performCheck._initial = true

module.exports = {
  beforeDelete,
  performCheck
}
