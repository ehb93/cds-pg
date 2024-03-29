const cds = require('../../cds')
const { UPDATE, SELECT } = cds.ql

const {
  getUpdateDraftAdminCQN,
  removeDraftUUIDIfNecessary,
  ensureDraftsSuffix,
  ensureNoDraftsSuffix,
  addColumnAlias
} = require('../utils/handler')
const { getKeysCondition } = require('../utils/where')
const { getColumns } = require('../../cds-services/services/utils/columns')

const { DRAFT_COLUMNS_CQN } = require('../../common/constants/draft')

const _getSelectCQN = (model, { data, target: { name } }, keysCondition, checkUser = true) => {
  const activeName = ensureNoDraftsSuffix(name)
  const draftName = ensureDraftsSuffix(name)

  const columns = [
    ...addColumnAlias(
      getColumns(model.definitions[activeName], { removeIgnore: true, filterVirtual: true }).map(obj => obj.name),
      draftName
    ),
    ...DRAFT_COLUMNS_CQN
  ]
  if (checkUser) {
    columns.push({ ref: ['DRAFT.DraftAdministrativeData', 'inProcessByUser'], as: 'draftAdmin_inProcessByUser' })
  }

  // REVISIT: support navigation to one
  return SELECT.from(draftName)
    .columns(columns)
    .join('DRAFT.DraftAdministrativeData')
    .on([
      { ref: [draftName, 'DraftAdministrativeData_DraftUUID'] },
      '=',
      { ref: ['DRAFT.DraftAdministrativeData', 'DraftUUID'] }
    ])
    .where(keysCondition)
}

const _getUpdateDraftCQN = ({ query, target: { name } }, keysCondition) => {
  const set = {}
  for (const entry in query.UPDATE.data) {
    if (entry === 'DraftAdministrativeData_DraftUUID') {
      continue
    }
    set[entry] = query.UPDATE.data[entry]
  }
  if (set.IsActiveEntity) set.IsActiveEntity = false

  return UPDATE(ensureDraftsSuffix(name)).data(set).where(keysCondition)
}

/**
 * Generic Handler for PATCH requests in the context of draft.
 * In case of success it returns the updated entry.
 * If the entry to be updated does not exist, it rejects with error to return a 404.
 * If a draft is already in process of another user it rejects with 403.
 *
 * @param req
 */
const _handler = async function (req) {
  if (req.data.IsActiveEntity === 'true') req.reject(400)

  const keysCondition = getKeysCondition(req.target, req.data)

  const dbtx = cds.tx(req)

  let result = await dbtx.run(_getSelectCQN(this.model, req, keysCondition))

  // Potential timeout scenario supported
  if (result[0].draftAdmin_inProcessByUser && result[0].draftAdmin_inProcessByUser !== req.user.id) {
    // REVISIT: security log?
    req.reject(403)
  }

  const updateDraftCQN = _getUpdateDraftCQN(req, keysCondition)
  const updateDraftAdminCQN = getUpdateDraftAdminCQN(req, result[0].DraftAdministrativeData_DraftUUID)

  await Promise.all([dbtx.run(updateDraftCQN), dbtx.run(updateDraftAdminCQN)])

  result = await dbtx.run(_getSelectCQN(this.model, req, keysCondition, false))
  if (result.length === 0) {
    req.reject(404)
  }

  removeDraftUUIDIfNecessary(result[0], req)

  return result[0]
}

module.exports = cds.service.impl(function () {
  for (const entity of Object.values(this.entities).filter(e => e._isDraftEnabled)) {
    this.on('PATCH', entity, _handler)
  }
})
