const cds = require('../../cds')
const { SELECT, DELETE } = cds.ql

const { isDraftRootEntity } = require('./csn')
const {
  getUpdateDraftAdminCQN,
  ensureDraftsSuffix,
  ensureNoDraftsSuffix,
  getDeleteDraftAdminCqn,
  getCompositionTargets
} = require('./handler')
const { extractKeyConditions } = require('./where')

const _getSelectCQN = (req, keys) => {
  return SELECT.from(ensureNoDraftsSuffix(req.target.name), [1]).where(keys.keyList)
}

const _getDraftSelectCQN = (req, keys) => {
  const draftEntityName = ensureDraftsSuffix(req.target.name)

  return SELECT.from(draftEntityName, ['DraftUUID'])
    .join('DRAFT.DraftAdministrativeData')
    .on('DraftAdministrativeData_DraftUUID =', { ref: ['DRAFT.DraftAdministrativeData', 'DraftUUID'] })
    .where(keys.keyList)
}

const _validate = (activeResult, draftResult, req, IsActiveEntity) => {
  if (
    (IsActiveEntity === true && activeResult.length === 0) ||
    (IsActiveEntity === false && draftResult.length === 0)
  ) {
    req.reject(404)
  }
}

const deleteDraft = async (req, srv, includingActive = false) => {
  const dbtx = cds.tx(req)
  const definitions = srv.model.definitions

  // REVISIT: how to handle delete of to 1 assoc
  const keys = extractKeyConditions(req.query.DELETE.from.ref[req.query.DELETE.from.ref.length - 1].where)

  // IsActiveEntity is deleted from where clause in auth.js, hence keys.IsActiveEntity is undefined here.
  // Intentional?
  const deleteActive = keys.IsActiveEntity !== false

  const [activeResult, draftResult] = await Promise.all([
    dbtx.run(_getSelectCQN(req, keys)),
    dbtx.run(_getDraftSelectCQN(req, keys))
  ])

  _validate(activeResult, draftResult, req, deleteActive)

  if (isDraftRootEntity(definitions, ensureNoDraftsSuffix(req.target.name)) && !deleteActive) {
    const draftUUID = draftResult[0].DraftUUID

    const draftTablesToDeleteFrom = [req.target.name + '_drafts']
    for (const [entity] of getCompositionTargets(req.target, srv).entries()) {
      if (!draftTablesToDeleteFrom.includes(entity + '_drafts')) draftTablesToDeleteFrom.push(entity + '_drafts')
    }

    const deleteDraftAdminCqn = getDeleteDraftAdminCqn(draftUUID)

    return dbtx.run([
      deleteDraftAdminCqn,
      ...draftTablesToDeleteFrom.map(dt => {
        const d = DELETE.from(dt).where({ DraftAdministrativeData_DraftUUID: draftUUID })
        d._suppressDeepDelete = true // hidden flag to tell db layer that no deep delete is required
        return d
      })
    ])
  }

  const source = definitions[ensureNoDraftsSuffix(req.target.name)]
  const delCQNs = []

  if (includingActive) {
    delCQNs.push(DELETE.from(ensureNoDraftsSuffix(req.target.name)).where(keys.keyList))
  }

  if (draftResult.length !== 0) {
    delCQNs.push(DELETE.from(ensureDraftsSuffix(source.name)).where(keys.keyList))

    const draftUUID = draftResult[0].DraftUUID
    if (isDraftRootEntity(definitions, ensureNoDraftsSuffix(req.target.name))) {
      delCQNs.push(DELETE.from('DRAFT.DraftAdministrativeData').where({ draftUUID }))
    } else {
      delCQNs.push(getUpdateDraftAdminCQN(req, draftUUID))
    }
  }

  return Promise.all(delCQNs.map(cqn => dbtx.run(cqn)))
}

module.exports = { deleteDraft }
