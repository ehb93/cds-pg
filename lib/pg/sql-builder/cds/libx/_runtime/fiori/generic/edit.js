const cds = require('../../cds')
const { INSERT, SELECT, DELETE } = cds.ql

const { getCompositionTree } = require('../../common/composition')
const { getColumns } = require('../../cds-services/services/utils/columns')
const { getTransition } = require('../../common/utils/resolveView')
const {
  draftIsLocked,
  ensureDraftsSuffix,
  ensureNoDraftsSuffix,
  getSubCQNs,
  setStatusCodeAndHeader,
  filterKeys
} = require('../utils/handler')
const { isActiveEntityRequested, getKeyData } = require('../utils/where')

const _getDraftColumns = draftUUID => ({
  IsActiveEntity: false,
  HasDraftEntity: false,
  HasActiveEntity: true,
  DraftAdministrativeData_DraftUUID: draftUUID
})

const _getAdminData = ({ user }, draftUUID, time) => {
  const currentUser = user.id || null
  return {
    DraftUUID: draftUUID,
    CreationDateTime: time,
    CreatedByUser: currentUser,
    LastChangeDateTime: time,
    LastChangedByUser: currentUser,
    DraftIsCreatedByMe: true,
    DraftIsProcessedByMe: true,
    InProcessByUser: currentUser
  }
}

const _getInsertAdminDataCQN = ({ user }, draftUUID, time) => {
  return INSERT.into('DRAFT.DraftAdministrativeData').entries(_getAdminData({ user }, draftUUID, time))
}

const _getLockWhere = (where, columnsMap) => {
  if (columnsMap.size === 0) {
    return where
  }

  const whereKeys = Object.keys(where)
  const lockWhere = {}

  whereKeys.forEach(key => {
    const mappedKey = columnsMap.get(key)
    const lockKey = mappedKey ? mappedKey.ref[0] : key // REVISIT: Why the mapped key is empty?
    lockWhere[lockKey] = where[key]
  })

  return lockWhere
}

const _select = async (CQNs, req, dbtx) => {
  let allResults

  try {
    allResults = await Promise.all(CQNs.map(CQN => dbtx.run(CQN)))
  } catch (err) {
    // resource busy and NOWAIT (WAIT 0) specified (heuristic error handling method)
    if (err.query.includes('FOR UPDATE')) {
      req.reject(409, 'DRAFT_ALREADY_EXISTS')
    }

    req.reject(err)
  }

  return allResults
}

/**
 * Generic event handler for draft edit requests.
 *
 * @param req
 */
const _handler = async function (req) {
  if (!isActiveEntityRequested(req.query.SELECT.where || [])) {
    req.reject(400)
  }

  const { definitions } = this.model

  // TODO replace with generic where filter
  const keys = filterKeys(req.target.keys)
  const data = getKeyData(keys, req.query.SELECT.from.ref[0].where)
  const rootWhere = keys.reduce((res, key) => {
    res[key] = data[key]
    return res
  }, {})

  // cds.db and not "this" as we want to resolve as db here
  const transition = getTransition(req.target, cds.db)
  const lockWhere = _getLockWhere(rootWhere, transition.mapping)

  // gets the underlying target entity, as record locking can't be
  // applied to localized views
  const lockTargetEntity = transition.target

  // Lock the root record of the active entity to prevent simultaneous access to it,
  // thus preventing duplicate draft entities from being created or overwritten.
  // Only allows one active entity to be processed at a time, locking out other
  // users who need to edit the same record simultaneously.
  // .forUpdate(): lock the record, a wait of 0 is equivalent to no wait
  const lockRecordCQN = SELECT.from(lockTargetEntity, [1]).where(lockWhere).forUpdate({ wait: 0 })

  const columnNames = getColumns(req.target, { onlyNames: true, filterVirtual: true })
  const rootCQN = SELECT.from(req.target, columnNames).where(rootWhere)
  const subCQNs = getSubCQNs({
    definitions,
    rootCQN,
    compositionTree: getCompositionTree({ definitions, rootEntityName: ensureNoDraftsSuffix(req.target.name) })
  })
  const rootDraftName = ensureDraftsSuffix(req.target.name)
  const draftExistsCQN = SELECT.from(rootDraftName, ['DraftAdministrativeData_DraftUUID as DraftUUID']).where(rootWhere)
  const selectCQNs = [rootCQN, ...subCQNs.map(obj => obj.cqn)]

  // fetch unlocalized data if not a texts entity
  for (const q of selectCQNs) {
    const entity = definitions[q.SELECT.from.ref[0]]
    if (entity && !entity.name.match(/\.texts$/)) {
      Object.defineProperty(q, '_suppressLocalization', { value: true })
    }
  }

  const lockAndSelectCQNs = [lockRecordCQN, draftExistsCQN, ...selectCQNs]

  const dbtx = cds.tx(req)
  const [, draftExists, ...results] = await _select(lockAndSelectCQNs, req, dbtx)

  if (!results[0].length) {
    req.reject(404)
  }

  if (draftExists.length) {
    const adminData = await dbtx.run(
      SELECT.one('DRAFT.DraftAdministrativeData', ['InProcessByUser', 'LastChangeDateTime']).where(draftExists[0])
    )

    // draft is locked (default cancellation timeout timer has not expired) OR
    // draft is not locked but must be rejected for popup
    if (draftIsLocked(adminData.LastChangeDateTime) || req.data.PreserveChanges) {
      req.reject(409, 'DRAFT_ALREADY_EXISTS')
    }

    await Promise.all([
      dbtx.run(DELETE.from('DRAFT.DraftAdministrativeData').where(draftExists[0])),
      dbtx.run(DELETE.from(rootDraftName).where(rootWhere))
    ])
  }

  const draftUUID = cds.utils.uuid()
  const insertCQNs = [_getInsertAdminDataCQN(req, draftUUID, req.timestamp)]

  for (const resultIndex in results) {
    if (results[resultIndex].length === 0) continue
    const draftEntity = ensureDraftsSuffix(selectCQNs[resultIndex].SELECT.from.ref[0])
    const entries = results[resultIndex].map(entityResult =>
      Object.assign({}, entityResult, _getDraftColumns(draftUUID))
    )

    insertCQNs.push(INSERT.into(draftEntity).entries(entries))
  }

  await Promise.all(insertCQNs.map(CQN => dbtx.run(CQN)))
  setStatusCodeAndHeader(req._.odataRes, rootWhere, req.target.name.replace(`${this.name}.`, ''), false)

  return Object.assign({}, results[0][0], { HasDraftEntity: false, HasActiveEntity: true, IsActiveEntity: false })
}

module.exports = cds.service.impl(function () {
  for (const entity of Object.values(this.entities).filter(e => e._isDraftEnabled)) {
    this.on('EDIT', entity, _handler)
  }
})
