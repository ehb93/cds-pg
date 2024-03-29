const cds = require('../../cds')
const { INSERT, SELECT, UPDATE, DELETE } = cds.ql

const {
  ensureNoDraftsSuffix,
  ensureDraftsSuffix,
  filterKeys,
  getDeleteDraftAdminCqn,
  getCompositionTargets
} = require('../utils/handler')
const { readAndDeleteKeywords, isActiveEntityRequested, getKeyData } = require('../utils/where')
const { isDraftRootEntity } = require('../../fiori/utils/csn')
const { getColumns } = require('../../cds-services/services/utils/columns')

const { DRAFT_COLUMNS } = require('../../common/constants/draft')

const _getRootCQN = (context, requestActiveData) => {
  const keys = filterKeys(context.target.keys)
  const keyData = getKeyData(keys, context.query.SELECT.from.ref[0].where)
  const columns = getColumns(context.target, { onlyNames: true, filterVirtual: true })
  return SELECT.from(
    requestActiveData ? ensureNoDraftsSuffix(context.target.name) : ensureDraftsSuffix(context.target.name),
    columns
  ).where(keyData)
}

const _getExpandSubCqn = (model, parentEntityName, targets, isRoot = true) => {
  const result = []
  const parentEntity = model[parentEntityName]

  for (const element of Object.values(parentEntity.elements)) {
    const { name, target, cardinality } = element
    if (DRAFT_COLUMNS.includes(name)) {
      continue
    }

    const ref = { ref: [name] }
    if (element.isComposition && cardinality && !targets.includes(target)) {
      if (name === 'texts' && !parentEntity['@fiori.draft.enabled']) {
        continue
      }

      ref.expand = _getExpandSubCqn(model, target, [...targets, parentEntityName], false)
      result.push(ref)
    } else if (!isRoot && !element.isAssociation) {
      result.push(ref)
    }
  }

  return result
}

const _getDraftAdminRef = () => {
  return {
    ref: ['DraftAdministrativeData'],
    expand: [{ ref: ['DraftUUID'] }, { ref: ['InProcessByUser'] }]
  }
}

const _removeIsActiveEntityRecursively = resultSet => {
  resultSet.forEach(result => {
    delete result.IsActiveEntity
    Object.values(result).forEach(val => {
      if (Array.isArray(val)) {
        _removeIsActiveEntityRecursively(val)
      }
    })
  })
}

const _draftCompositionTree = async (service, req) => {
  let draftData, activeData, adminData

  const expanded = _getExpandSubCqn(service.model.definitions, ensureNoDraftsSuffix(req.target.name), [])

  const cqnDraft = _getRootCQN(req, false)
  cqnDraft.SELECT.columns.push(_getDraftAdminRef())
  cqnDraft.SELECT.columns.push(...expanded)

  const cqnActive = _getRootCQN(req, true)
  cqnActive.SELECT.columns.push(...expanded)

  const dbtx = cds.tx(req)

  const results = await Promise.all([dbtx.run(cqnDraft), dbtx.run(cqnActive)])

  if (results[0].length === 1) {
    _removeIsActiveEntityRecursively(results[0])

    adminData = results[0][0].DraftAdministrativeData
    delete results[0][0].DraftAdministrativeData
    draftData = results[0][0]
  }

  if (results[1].length === 1) {
    _removeIsActiveEntityRecursively(results[1])
    activeData = results[1][0]
  }

  return { draftData, activeData, adminData }
}

/**
 * Generic Handler for draftActivate requests.
 * In case of success it triggers an 'UPDATE' or 'CREATE' event.
 *
 * @param req
 */
const _handler = async function (req) {
  if (
    isActiveEntityRequested(req.query.SELECT.from.ref[0].where || []) ||
    req.query.SELECT.from.ref.length > 2 ||
    !isDraftRootEntity(this.model.definitions, ensureNoDraftsSuffix(req.target.name))
  ) {
    req.reject(400)
  }

  const { draftData, activeData, adminData } = await _draftCompositionTree(this, req)

  if (!draftData) req.reject(404)
  if (adminData.InProcessByUser !== req.user.id) {
    // REVISIT: security log?
    req.reject(403, 'DRAFT_LOCKED_BY_ANOTHER_USER')
  }

  /*
   * create or update
   */
  let query, event
  if (activeData) {
    readAndDeleteKeywords(['IsActiveEntity'], req.query.SELECT.from.ref[0].where)
    event = 'UPDATE'
    // REVSIIT: setting data should be part of ql
    query = UPDATE(req.target).where(req.query.SELECT.from.ref[0].where)
    query.UPDATE.data = draftData
    query._activeData = activeData
  } else {
    event = 'CREATE'
    query = INSERT.into(req.target).entries(draftData)
  }

  // REVISIT: _draftMetadata
  const r = new cds.Request({ event, query, data: draftData, _draftMetadata: adminData })

  // REVISIT: should not be necessary
  r._ = Object.assign(r._, req._)
  r.getUriInfo = () => req.getUriInfo()
  r.getUrlObject = () => req.getUrlObject()
  r._.params = req.params

  // use finally to preserve r.messages in success or error case
  let result
  try {
    result = await this.dispatch(r)
  } finally {
    // REVISIT: should not be necessary
    if (r.messages) for (const m of r.messages) req.info(m)
  }

  /*
   * delete draft data
   */
  const deleteDraftAdminCqn = getDeleteDraftAdminCqn(adminData.DraftUUID)
  const draftTablesToDeleteFrom = [req.target.name + '_drafts']
  for (const [entity] of getCompositionTargets(req.target, this).entries())
    draftTablesToDeleteFrom.push(entity + '_drafts')
  await cds.db.tx(req).run([
    deleteDraftAdminCqn,
    ...draftTablesToDeleteFrom.map(dt => {
      const d = DELETE.from(dt).where({ DraftAdministrativeData_DraftUUID: adminData.DraftUUID })
      d._suppressDeepDelete = true // hidden flag to tell db layer that no deep delete is required
      return d
    })
  ])

  return result
}

module.exports = cds.service.impl(function () {
  for (const entity of Object.values(this.entities).filter(e => e._isDraftEnabled)) {
    this.on('draftActivate', entity, _handler)
  }
})
