const cds = require('../../cds')
const { INSERT, SELECT, UPDATE } = cds.ql

const onDraftActivate = require('./activate')._handler
const { isNavigationToMany } = require('../utils/req')
const { getKeysCondition } = require('../utils/where')
const { removeDraftUUIDIfNecessary, ensureDraftsSuffix } = require('../utils/handler')
const { DRAFT_COLUMNS } = require('../../common/constants/draft')

const _getUpdateDraftAdminCQN = ({ user, timestamp }, draftUUID) => {
  return UPDATE('DRAFT.DraftAdministrativeData')
    .data({
      InProcessByUser: user.id,
      LastChangedByUser: user.id,
      LastChangeDateTime: timestamp
    })
    .where({ DraftUUID: draftUUID })
}

const _getInsertDraftAdminCQN = ({ user, timestamp }, uuid) => {
  return INSERT.into('DRAFT.DraftAdministrativeData').entries({
    DraftUUID: uuid,
    CreationDateTime: timestamp,
    CreatedByUser: user.id,
    LastChangeDateTime: timestamp,
    LastChangedByUser: user.id,
    DraftIsCreatedByMe: true,
    DraftIsProcessedByMe: true,
    InProcessByUser: user.id
  })
}

const _getInsertDataCQN = (req, draftUUID) => {
  const draftName = ensureDraftsSuffix(req.target.name)

  const insertData = INSERT.into(draftName).entries(req.query.INSERT.entries[0]) // entries is always set because there are no entities without keys

  req.data.IsActiveEntity = false
  req.data.HasDraftEntity = false
  req.data.HasActiveEntity = false
  req.data.DraftAdministrativeData_DraftUUID = draftUUID

  return insertData
}

/**
 * Generic Handler for CREATE requests in the context of draft.
 * In case of success it returns the created entry.
 *
 * @param req
 * @param next
 */
const _handler = async function (req, next) {
  if (!req._draftMetadata) {
    // REVISIT: when is this the case?
    return onDraftActivate(req, next)
  }

  // fill default values
  const elements = req.target.elements
  for (const column in elements) {
    const col = elements[column]
    if (col.default !== undefined && !DRAFT_COLUMNS.includes(column)) {
      if ('val' in col.default) req.data[col.name] = col.default.val
      else if ('ref' in col.default) req.data[col.name] = col.default.ref[0]
      else req.data[col.name] = col.default
    }
  }

  const navigationToMany = isNavigationToMany(req)

  const adminDataCQN = navigationToMany
    ? _getUpdateDraftAdminCQN(req, req.data.DraftAdministrativeData_DraftUUID)
    : _getInsertDraftAdminCQN(req, req.data.DraftAdministrativeData_DraftUUID)
  const insertDataCQN = _getInsertDataCQN(req, req.data.DraftAdministrativeData_DraftUUID)

  // read data as on db and return
  const columns = Object.keys(req.target.elements)
    .map(e => req.target.elements[e])
    .filter(e => !e.isAssociation)
    .map(e => e.name)
  const readInsertDataCQN = SELECT.from(insertDataCQN.INSERT.into).columns(columns)
  readInsertDataCQN.where(getKeysCondition(req.target, req.data))

  const dbtx = cds.tx(req)

  await Promise.all([dbtx.run(adminDataCQN), dbtx.run(insertDataCQN)])

  const result = await dbtx.run(readInsertDataCQN)
  if (result.length === 0) {
    req.reject(404)
  }

  removeDraftUUIDIfNecessary(result[0], req)

  return result[0]
}

module.exports = cds.service.impl(function () {
  for (const entity of Object.values(this.entities).filter(e => e._isDraftEnabled)) {
    this.on('NEW', entity, _handler)
  }
})
