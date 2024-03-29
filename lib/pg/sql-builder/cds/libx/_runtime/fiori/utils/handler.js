const cds = require('../../cds')
const { UPDATE, SELECT } = cds.ql
const { removeIsActiveEntityRecursively, isActiveEntityRequested } = require('./where')
const { getColumns } = require('../../cds-services/services/utils/columns')
const { ensureNoDraftsSuffix, ensureDraftsSuffix, ensureUnlocalized } = require('../../common/utils/draft')
const getTemplate = require('../../common/utils/template')

const { DRAFT_COLUMNS } = require('../../common/constants/draft')

// unofficial config!
const MAX_RECURSION_DEPTH = (cds.env.features.recursion_depth && Number(cds.env.features.recursion_depth)) || 2

const _getParentCQNWithKeyColumn = (parentCQN, parentKeyName) => {
  const parentCQNWithKeyColumn = Object.assign({}, parentCQN)
  parentCQNWithKeyColumn.SELECT = Object.assign({}, parentCQN.SELECT)
  parentCQNWithKeyColumn.SELECT.columns = [{ ref: [parentKeyName] }]
  return parentCQNWithKeyColumn
}

const _getSubSelectFromCQN = (element, columns, selectFromDraft) => {
  return SELECT.from(
    selectFromDraft ? ensureDraftsSuffix(element.source) : element.source,
    selectFromDraft ? [...columns, 'DraftAdministrativeData_DraftUUID'] : columns
  )
}

const getSubCQNs = ({ definitions, rootCQN, compositionTree, selectFromDraft = false }) => {
  const subCQNs = []
  // only one backLink
  const _generateSubCQNs = (parentCQN, compositionElements, elementMap = new Map()) => {
    for (const element of compositionElements) {
      const backLink = element.backLinks[0] || element.customBackLinks[0]
      if (backLink) {
        const fqn = element.source + ':' + element.name
        const seen = elementMap.get(fqn)
        if (seen && seen >= MAX_RECURSION_DEPTH) {
          // recursion -> abort
          continue
        }

        const columns = getColumns(definitions[element.source], { onlyNames: true, filterVirtual: true })
        const subCQN = _getSubSelectFromCQN(element, columns, selectFromDraft)
        subCQN.where([{ ref: [backLink.entityKey] }, 'in', _getParentCQNWithKeyColumn(parentCQN, backLink.targetKey)])
        subCQNs.push({ cqn: subCQN })
        const newElementMap = new Map(elementMap)
        newElementMap.set(fqn, (seen && seen + 1) || 1)
        _generateSubCQNs(subCQN, element.compositionElements, newElementMap)
      }
    }
  }

  _generateSubCQNs(rootCQN, compositionTree.compositionElements)

  return subCQNs
}

const proxifyToNoDraftsName = target => {
  const entityProxyHandler = {
    get: (obj, prop) => (prop === 'name' ? ensureNoDraftsSuffix(target.name) : obj[prop])
  }
  return new Proxy(target, entityProxyHandler)
}

const hasDraft = (definitions, cqn) => {
  if (
    cqn.SELECT.from.ref &&
    definitions[cqn.SELECT.from.ref[cqn.SELECT.from.ref.length - 1]] &&
    definitions[cqn.SELECT.from.ref[cqn.SELECT.from.ref.length - 1]]._isDraftEnabled
  ) {
    return true
  }

  if (cqn.SELECT.where) {
    for (const element of cqn.SELECT.where) {
      if (element.SELECT && hasDraft(definitions, element)) {
        return true
      }
    }
  }

  return false
}

const getUpdateDraftAdminCQN = ({ user }, draftUUID) => {
  const set = {
    InProcessByUser: user.id,
    LastChangedByUser: user.id,
    LastChangeDateTime: new Date()
  }

  return UPDATE('DRAFT.DraftAdministrativeData').data(set).where({ DraftUUID: draftUUID })
}

const _addAlias = (where, tableName) => {
  // copy where
  return where.map(element => {
    if (element.ref && element.ref.length === 1) {
      // and copy ref
      return { ref: [tableName, element.ref[0]] }
    }
    return element
  })
}

const _getSelectedColumns = (columns, selectedColumns) => {
  return columns.filter(col => {
    if (
      col.ref &&
      selectedColumns.some(sel => sel.ref && sel.ref[sel.ref.length - 1] === col.ref[col.ref.length - 1])
    ) {
      return true
    } else if (col.as && selectedColumns.some(sel => sel.as && sel.as === col.as)) {
      return true
    }

    return false
  })
}

const getEnrichedCQN = (cqn, select, draftWhere, scenarioAlias, addLimitOrder = true) => {
  const tableName =
    (cqn.SELECT.from.ref && cqn.SELECT.from.ref[0]) || (cqn.SELECT.from.args && cqn.SELECT.from.args[0].ref[0])

  if (draftWhere && draftWhere.length !== 0) {
    cqn.where(_addAlias(draftWhere, tableName))
  }

  if (select.distinct) {
    cqn.distinct()
  }

  const alias = (select.from && select.from.as) || scenarioAlias

  if (select.count) cqn.SELECT.count = true
  if (select.one) cqn.SELECT.one = true

  if (select.having) {
    cqn.having(_aliased(select.having, alias))
  }

  // groupBy, orderBy and limit do not support partial CQNs
  if (select.groupBy) {
    cqn.SELECT.groupBy = _aliased(select.groupBy, alias)
    cqn.SELECT.columns = _getSelectedColumns(cqn.SELECT.columns, select.columns)
  }

  if (select.orderBy && addLimitOrder) {
    cqn.SELECT.orderBy = _aliased(select.orderBy, alias)
  }

  if (select.limit && addLimitOrder) {
    cqn.SELECT.limit = select.limit
  }

  return cqn
}

const _aliasRef = (ref, alias) => {
  const newRef = [...ref]
  // we skip draft columns because they are mostly calculated later on
  if (alias && !DRAFT_COLUMNS.includes(ref[ref.length - 1])) {
    newRef.unshift(alias)
  }
  return newRef
}

const getDeleteDraftAdminCqn = draftUUID =>
  DELETE.from('DRAFT.DraftAdministrativeData').where([{ ref: ['DraftUUID'] }, '=', { val: draftUUID }])

const _aliased = (arr, alias) =>
  arr.map(item => {
    if (alias && item.ref && item.ref[0] !== alias) {
      return Object.assign({}, item, { ref: _aliasRef(item.ref, alias) })
    }
    return item
  })

// Only works for root entity, otherwise the relative position needs to be adapted
const setStatusCodeAndHeader = (response, keys, entityName, isActiveEntity) => {
  response.setStatusCode(201)

  const keysString = Object.keys(keys)
    .map(key => `${key}=${keys[key]}`)
    .join(',')
  response.setHeader('location', `../${entityName}(${keysString},IsActiveEntity=${isActiveEntity})`)
}

const removeDraftUUIDIfNecessary = (result, req) => {
  if (req._.req && req._.req.headers && req._.req.headers['x-cds-odata-version'] === 'v2') return

  if (Array.isArray(result)) {
    for (const row of result) {
      delete row.DraftAdministrativeData_DraftUUID
    }
  } else {
    delete result.DraftAdministrativeData_DraftUUID
  }
}

const isDraftActivateAction = req => {
  // REVISIT: get rid of getUrlObject
  if (req.getUrlObject) return req.getUrlObject().pathname.endsWith('draftActivate')
}

const addColumnAlias = (columns, alias) => {
  if (!alias) {
    return columns
  }

  return columns.map(col => {
    if (typeof col === 'string') {
      return { ref: [alias, col] }
    }

    if (col.ref && !col.expand) {
      const obj = Object.assign({}, col)
      obj.ref = [alias, ...col.ref.slice(0)]
      return obj
    }

    if (col.func && col.args) {
      const obj = Object.assign({}, col)
      obj.args = addColumnAlias(col.args, alias)
      return obj
    }

    return col
  })
}

const getCompositionTargets = (entity, srv) => {
  if (!entity.own('_deepCompositionTargets')) {
    const _deepCompositionTargets = []
    getTemplate(undefined, srv, entity, {
      pick: element => {
        if (element.isAssociation && !element._isAssociationStrict && srv.model.definitions[element.target].drafts)
          _deepCompositionTargets.push(element.target)
      },
      ignore: element => !element.isAssociation || element._isAssociationStrict
    })
    entity.set('_deepCompositionTargets', new Set(_deepCompositionTargets))
  }

  return entity.own('_deepCompositionTargets')
}

const replaceRefWithDraft = ref => {
  if (!ref || !ref[0]) return
  ref[0] = ensureDraftsSuffix(ref[0])
}

const adaptStreamCQN = cqn => {
  if (isActiveEntityRequested(cqn.SELECT.where)) {
    cqn.SELECT.where = removeIsActiveEntityRecursively(cqn.SELECT.where)
  } else {
    replaceRefWithDraft(cqn.SELECT.from.ref)
  }
}

const draftIsLocked = lastChangedAt => {
  // default timeout timer is 15 minutes
  const DRAFT_CANCEL_TIMEOUT_IN_MS = ((cds.env.drafts && cds.env.drafts.cancellationTimeout) || 15) * 60 * 1000
  return DRAFT_CANCEL_TIMEOUT_IN_MS > Date.now() - Date.parse(lastChangedAt)
}

const getKeyProperty = keys => {
  return Object.keys(keys).find(k => {
    return k !== 'IsActiveEntity' && !keys[k]._isAssociationStrict
  })
}

const filterKeys = keys => {
  return Object.keys(keys).filter(key => {
    return key !== 'IsActiveEntity' && !keys[key]._isAssociationStrict
  })
}

module.exports = {
  getSubCQNs,
  draftIsLocked,
  getUpdateDraftAdminCQN,
  getEnrichedCQN,
  removeDraftUUIDIfNecessary,
  setStatusCodeAndHeader,
  isDraftActivateAction,
  ensureDraftsSuffix,
  ensureNoDraftsSuffix,
  ensureUnlocalized,
  hasDraft,
  proxifyToNoDraftsName,
  addColumnAlias,
  adaptStreamCQN,
  replaceRefWithDraft,
  getKeyProperty,
  filterKeys,
  getDeleteDraftAdminCqn,
  getCompositionTargets
}
