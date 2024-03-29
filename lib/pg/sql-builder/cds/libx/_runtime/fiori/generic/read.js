const cds = require('../../cds')
const { SELECT } = cds.ql

const { cqn2cqn4sql } = require('../../common/utils/cqn2cqn4sql')
const { getElementDeep } = require('../../common/utils/csn')

const { DRAFT_COLUMNS, DRAFT_COLUMNS_MAP, SCENARIO } = require('../../common/constants/draft')
const {
  adaptStreamCQN,
  addColumnAlias,
  draftIsLocked,
  ensureDraftsSuffix,
  ensureNoDraftsSuffix,
  ensureUnlocalized,
  getEnrichedCQN,
  removeDraftUUIDIfNecessary,
  replaceRefWithDraft,
  filterKeys
} = require('../utils/handler')
const { deleteCondition, readAndDeleteKeywords, removeIsActiveEntityRecursively } = require('../utils/where')

const { getColumns } = require('../../cds-services/services/utils/columns')

// append where with clauses from @restrict
const _getWhereWithAppendedDraftRestrictions = (where = [], req, scenarioAlias, model) => {
  if (req.query._draftRestrictions) {
    for (const each of req.query._draftRestrictions) {
      if (where.length) where.push('and')

      // REVISIT: remove with cds^6
      // adjust alias of @restrict where "exists (select ...)"
      if (scenarioAlias && model)
        each
          .filter(e => e.SELECT && e.SELECT.from && e.SELECT.where)
          .forEach(e => {
            const entity = model.definitions[e.SELECT.from.ref[0]]
            e.SELECT.where = e.SELECT.where.map(w => {
              if (w.ref && w.ref.length === 1 && !entity.elements[w.ref[0]]) w.ref.unshift(scenarioAlias)
              return w
            })
          })

      where.push(...each)
    }
  }
  return where
}

const _isTrue = val => val === true || val === 'true'

const _isFalse = val => val === false || val === 'false'

const _inProcessByUserWhere = userId => [{ ref: ['filterAdmin', 'InProcessByUser'] }, '=', { val: userId }]

const _getTableName = (
  {
    target: { name },
    query: {
      SELECT: { from }
    }
  },
  isDraft = false
) => {
  const table = isDraft ? ensureDraftsSuffix(name) : ensureNoDraftsSuffix(name)
  const as = from.args ? from.args[0].as : from.as
  if (as) {
    return {
      table: {
        ref: [table],
        as: as
      },
      name: as
    }
  }

  return {
    table: {
      ref: [table]
    },
    name: table
  }
}

const _getTargetKeys = ({ target }) => {
  return filterKeys(target.keys)
}

const DRAFT_COLUMNS_CASTED = [
  {
    ref: ['IsActiveEntity'],
    cast: { type: 'cds.Boolean' }
  },
  {
    ref: ['HasActiveEntity'],
    cast: { type: 'cds.Boolean' }
  },
  {
    ref: ['HasDraftEntity'],
    cast: { type: 'cds.Boolean' }
  }
]

// default draft values for active entities
const _getDefaultDraftProperties = ({ hasDraft, isActive = true, withDraftUUID = true }) => {
  const columns = [
    { val: isActive, as: 'IsActiveEntity', cast: { type: 'cds.Boolean' } },
    { val: false, as: 'HasActiveEntity', cast: { type: 'cds.Boolean' } }
  ]

  if (hasDraft !== null) {
    columns.push({
      val: Boolean(hasDraft),
      as: 'HasDraftEntity',
      cast: { type: 'cds.Boolean' }
    })
  }

  if (withDraftUUID) {
    columns.push(
      isActive
        ? { val: null, as: 'DraftAdministrativeData_DraftUUID' }
        : { ref: ['DraftAdministrativeData_DraftUUID'], as: 'DraftAdministrativeData_DraftUUID' }
    )
  }

  return columns
}

// draft values for active entities with calculated hasDraft property
const _getDraftPropertiesDetermineDraft = (req, where, tableName, calcDraftUUID = false) => {
  const { table } = _getTableName(req, true)

  tableName = tableName || table

  const hasDraftQuery = SELECT.from(tableName, [{ val: 1 }])
  if (where && where.length > 0) {
    // clone where to protect from later modification
    hasDraftQuery.where([...where])
  }

  let draftUUIDColumn
  if (calcDraftUUID) {
    draftUUIDColumn = SELECT.from(tableName, ['DraftAdministrativeData_DraftUUID'])
    if (where && where.length > 0) {
      draftUUIDColumn.where(where)
    }
  } else {
    draftUUIDColumn = { val: null, as: 'DraftAdministrativeData_DraftUUID' }
  }

  const xpr = {
    xpr: ['case', 'when', hasDraftQuery, 'IS NOT NULL', 'then', 'true', 'else', 'false', 'end'],
    as: 'HasDraftEntity',
    cast: { type: 'cds.Boolean' }
  }

  hasDraftQuery.as = 'HasDraftEntity'
  hasDraftQuery.cast = { type: 'cds.Boolean' }

  return [
    { val: true, as: 'IsActiveEntity', cast: { type: 'cds.Boolean' } },
    { val: false, as: 'HasActiveEntity', cast: { type: 'cds.Boolean' } },
    xpr,
    draftUUIDColumn
  ]
}

function _copyCQNPartial(partial) {
  if (partial.SELECT && partial.SELECT.where) {
    const newPartial = Object.assign({}, partial)
    const newSELECT = Object.assign({}, partial.SELECT)
    newSELECT.from = _copyCQNPartial(partial.SELECT.from)
    newPartial.SELECT = newSELECT
    if (partial.SELECT.columns) newPartial.SELECT.columns = _copyArray(partial.SELECT.columns)
    if (partial.SELECT.where) newPartial.SELECT.where = _copyArray(partial.SELECT.where)
    return newPartial
  }

  return partial.ref ? Object.assign({}, partial, { ref: _copyArray(partial.ref) }) : Object.assign({}, partial)
}

function _copyArray(array) {
  return array.map(entry => {
    return typeof entry === 'object' && !(entry instanceof String) ? _copyCQNPartial(entry) : entry
  })
}

const _isValidDraftOfWhichIAmOwner = isActiveEntity => {
  return isActiveEntity.op === '=' && _isFalse(isActiveEntity.value.val)
}

const _isValidActiveWithoutDraft = (isActiveEntity, hasDraftEntity) => {
  return (
    isActiveEntity.op === '=' &&
    _isTrue(isActiveEntity.value.val) &&
    hasDraftEntity.op === '=' &&
    _isFalse(hasDraftEntity.value.val)
  )
}

const _isValidWithDraftLocked = (isActiveEntity, siblingIsActive, draftInProcessByUser) => {
  return (
    isActiveEntity.op === '=' &&
    _isTrue(isActiveEntity.value.val) &&
    siblingIsActive.op === '=' &&
    siblingIsActive.value.val === null &&
    draftInProcessByUser.op === '!=' &&
    draftInProcessByUser.value.val === ''
  )
}

const _isValidWithDraftTimeout = (isActiveEntity, siblingIsActive, draftInProcessByUser) => {
  return (
    isActiveEntity.op === '=' &&
    _isTrue(isActiveEntity.value.val) &&
    siblingIsActive.op === '=' &&
    siblingIsActive.value.val === null &&
    draftInProcessByUser.op === '=' &&
    draftInProcessByUser.value.val === ''
  )
}

const _isValidExcludeActiveDraftExists = (isActiveEntity, siblingIsActive) => {
  return (
    isActiveEntity.op === '=' &&
    _isFalse(isActiveEntity.value.val) &&
    siblingIsActive.op === '=' &&
    siblingIsActive.value.val === null
  )
}

const _filterDraftColumnsBySelected = (draftColumns, columns) => {
  const _findByAlias = (draftColumn, alias) => alias && draftColumn.as && alias === draftColumn.as
  const _findByRef = (draftColumn, ref) => ref && draftColumn.ref && ref === draftColumn.ref[draftColumn.ref.length - 1]
  // include draft-specific columns only if there is no SELECT.columns or if they are selected explicitly
  return (
    (!columns && draftColumns) ||
    draftColumns.filter(
      draftColumn =>
        (!draftColumn.ref && !draftColumn.as) ||
        columns.find(col => {
          const ref = col.ref && col.ref[col.ref.length - 1]
          return _findByRef(draftColumn, ref) || _findByAlias(draftColumn, ref) || _findByAlias(draftColumn, col.as)
        })
    )
  )
}

const _isOnlyCount = columns => columns.length === 1 && (columns[0].as === '_counted_' || columns[0].as === '$count')

const _getOuterMostColumns = (columnsFromRequest, additionalDraftColumns) => {
  if (_isOnlyCount(columnsFromRequest)) return columnsFromRequest

  // remove draft columns from columnsFromRequest (if present) to avoid duplicates
  const columns = [...columnsFromRequest.filter(ele => !ele.as || !DRAFT_COLUMNS_MAP[ele.as])]
  columns.push(...additionalDraftColumns)
  return columns
}

// adds base columns 'InProcessByUser' and 'CreatedByUser' to columns param if needed
// those are required for calculating 'DraftIsProcessedByMe' and 'DraftIsCreatedByMe'
const _ensureDraftAdminColumnsForCalculation = columns => {
  columns.forEach((c, i) => {
    if (c.ref && c.ref[0] === 'DraftIsCreatedByMe' && !columns.find(e => e.ref && e.ref[0] === 'CreatedByUser')) {
      columns.push({ ref: ['CreatedByUser'] })
    } else if (
      c.ref &&
      c.ref[0] === 'DraftIsProcessedByMe' &&
      !columns.find(e => e.ref && e.ref[0] === 'InProcessByUser')
    ) {
      columns.push({ ref: ['InProcessByUser'] })
    }
  })
}

const _draftAdminTable = req => {
  const { table } = _getTableName(req)

  let cqn = SELECT.from(table)
  if (req.query.SELECT.columns) {
    cqn = cqn.columns(...req.query.SELECT.columns)
    _ensureDraftAdminColumnsForCalculation(cqn.SELECT.columns)
  }

  return {
    cqn: getEnrichedCQN(cqn, req.query.SELECT, req.query.SELECT.where),
    scenario: SCENARIO.DRAFT_ADMIN
  }
}

const _allInactive = (req, columns) => {
  const table = {
    ref: [ensureDraftsSuffix(req.query.SELECT.from.ref[0])],
    as: req.query.SELECT.from.as || 'drafts'
  }

  const outerMostColumns = _getOuterMostColumns(
    addColumnAlias(columns, table.as),
    _getDefaultDraftProperties({ hasDraft: false, isActive: false, withDraftUUID: false })
  )

  const ids = filterKeys(req.target.keys)
  const isCount = columns.some(element => element.func === 'count')

  const cqn = SELECT.from(table)

  if (isCount) {
    cqn.columns(...outerMostColumns)
  } else {
    cqn.columns(...outerMostColumns.filter(o => o.as !== 'HasActiveEntity'), { ref: ['HasActiveEntity'] })
    cqn.leftJoin(ensureNoDraftsSuffix(table.ref[0]) + ' as active').on(`${table.as}.${ids[0]} = active.${ids[0]}`)

    for (let i = 1; i < ids.length; i++) {
      // REVISIT: this is extremely expensive as it repeatedly invokes the compiler's cds.parse.expr -> better extend plain CQN yourself here
      cqn.and(`${table.as}.${ids[i]} = active.${ids[i]}`)
    }
  }

  cqn.where(req.query.SELECT.where)

  return { cqn: getEnrichedCQN(cqn, req.query.SELECT, []), scenario: SCENARIO.ALL_INACTIVE }
}

const _setRefAlias = (ref, as) => {
  if (ref && ref[0] !== as) {
    ref.unshift(as)
  }
}

const _buildWhere = (where, table) => {
  for (const entry of where) {
    if (entry.ref) {
      _setRefAlias(entry.ref, table.as)
    } else if (entry.func && entry.args) {
      _buildWhere(entry.args, table)
    } else if (entry.list) {
      _buildWhere(entry.list, table)
    } else if (entry.xpr) {
      _buildWhere(entry.xpr, table)
    }
  }
}

const _buildOrderBy = (query, columns, table) => {
  for (const entry of query.SELECT.orderBy || []) {
    // detect if calculated value
    if (entry.ref && columns.some(c => c.as === entry.ref[entry.ref.length - 1])) {
      // remove table alias if present
      if (entry.ref[0] === table.as) {
        entry.ref.splice(0, 1)
      }
    } else if (table.as && entry.ref[0] !== table.as) {
      // if regular column and no alias present, add it
      entry.ref.unshift(table.as)
    }
  }
}

const _allActive = (req, columns, model) => {
  const { table } = _getTableName(req)
  if (!table.as) {
    table.as = 'active'
  }

  const outerMostColumns = _getOuterMostColumns(
    addColumnAlias(columns, table.as),
    _getDefaultDraftProperties({ hasDraft: null })
  )

  const ids = filterKeys(req.target.keys)
  const isCount = columns.some(element => element.func === 'count')

  const xpr = {
    xpr: [
      'case',
      'when',
      'drafts.DraftAdministrativeData_DraftUUID',
      'IS NOT NULL',
      'then',
      'true',
      'else',
      'false',
      'end'
    ],
    as: 'HasDraftEntity',
    cast: { type: 'cds.Boolean' }
  }

  const cqn = SELECT.from(table)

  if (isCount) {
    cqn.columns(..._filterDraftColumnsBySelected(outerMostColumns, req.query.SELECT.columns))
  } else {
    cqn.columns(..._filterDraftColumnsBySelected([...outerMostColumns, xpr], req.query.SELECT.columns))
    cqn.leftJoin(ensureDraftsSuffix(table.ref[0]) + ' as drafts').on(`${table.as}.${ids[0]} = drafts.${ids[0]}`)

    for (let i = 1; i < ids.length; i++) {
      // REVISIT: this is extremely expensive as it repeatedly invokes the compiler's cds.parse.expr -> better extend plain CQN yourself here
      cqn.and(`${table.as}.${ids[i]} = drafts.${ids[i]}`)
    }
  }

  const scenarioAlias = 'active'

  req.query.SELECT.where = _getWhereWithAppendedDraftRestrictions(req.query.SELECT.where, req, scenarioAlias, model)

  if (req.query.SELECT.where) {
    _buildWhere(req.query.SELECT.where, table)
  }

  _buildOrderBy(req.query, cqn.SELECT.columns, table)

  return {
    cqn: getEnrichedCQN(cqn, req.query.SELECT, req.query.SELECT.where, scenarioAlias),
    scenario: SCENARIO.ALL_ACTIVE
  }
}

const _activeWithoutDraft = (req, draftWhere, columns) => {
  const { table } = _getTableName(req, true)
  const draftName = table.ref[0]
  const active = _getTableName(req)
  const keys = _getTargetKeys(req)

  let subSelect = SELECT.from(draftName).columns(...keys)
  subSelect = keys.reduce(
    (select, key) =>
      subSelect.where([
        { ref: [active.name, key] },
        '=',
        {
          ref: [draftName, key]
        }
      ]),
    subSelect
  )

  const outerMostColumns = _getOuterMostColumns(columns, _getDefaultDraftProperties({ hasDraft: false }))

  const cqn = SELECT.from(active.table)
    .columns(...outerMostColumns)
    .where(['not exists', subSelect])

  draftWhere = _getWhereWithAppendedDraftRestrictions(draftWhere, req)

  return { cqn: getEnrichedCQN(cqn, req.query.SELECT, draftWhere), scenario: SCENARIO.ACTIVE_WITHOUT_DRAFT }
}

const _draftOfWhichIAmOwner = (req, draftWhere, columns) => {
  const { table, name } = _getTableName(req, true)

  const outerMostColumns = _getOuterMostColumns(addColumnAlias(columns, name), DRAFT_COLUMNS_CASTED)

  const cqn = SELECT.from(table)
    .columns(...outerMostColumns)
    .join('DRAFT.DraftAdministrativeData', 'filterAdmin')
    .on([
      { ref: [name, 'DraftAdministrativeData_DraftUUID'] },
      '=',
      {
        ref: ['filterAdmin', 'DraftUUID']
      }
    ])
    .where(_inProcessByUserWhere(req.user.id))

  return { cqn: getEnrichedCQN(cqn, req.query.SELECT, draftWhere), scenario: SCENARIO.DRAFT_WHICH_OWNER }
}

const _activeWithDraftInProcess = (req, draftWhere, columns, isLocked) => {
  const draft = _getTableName(req, true)
  const draftName = draft.table.ref[0]
  const active = _getTableName(req)
  const keys = _getTargetKeys(req)
  const draftColumns = _getDefaultDraftProperties({ hasDraft: true })

  let subSelect = SELECT.from(draftName)
    .columns(...keys)
    .join('DRAFT.DraftAdministrativeData', 'filterAdmin')
    .on([
      { ref: [draftName, 'DraftAdministrativeData_DraftUUID'] },
      '=',
      {
        ref: ['filterAdmin', 'DraftUUID']
      }
    ])

  const DRAFT_CANCEL_TIMEOUT_IN_SEC = ((cds.env.drafts && cds.env.drafts.cancellationTimeout) || 15) * 60

  subSelect = subSelect.where([
    { ref: ['filterAdmin', 'InProcessByUser'] },
    '!=',
    { val: req.user.id },
    'and',
    { ref: ['filterAdmin', 'InProcessByUser'] },
    'is not null',
    'and',
    {
      func: 'seconds_between',
      args: [{ ref: ['filterAdmin', 'LastChangeDateTime'] }, 'CURRENT_TIMESTAMP']
    },
    isLocked ? '<' : '>',
    { val: DRAFT_CANCEL_TIMEOUT_IN_SEC }
  ])

  subSelect = keys.reduce(
    (select, key) => subSelect.where([{ ref: [active.name, key] }, '=', { ref: [draftName, key] }]),
    subSelect
  )

  subSelect.SELECT.where = _getWhereWithAppendedDraftRestrictions(subSelect.SELECT.where, req)

  const outerMostColumns = _getOuterMostColumns(columns, draftColumns)

  const cqn = SELECT.from(active.table).columns(outerMostColumns).where(['exists', subSelect])

  return { cqn: getEnrichedCQN(cqn, req.query.SELECT, draftWhere), scenario: SCENARIO.DRAFT_IN_PROCESS }
}

const _alignAliasForUnion = (table, as, select) => {
  if (!as || !select.SELECT.where) {
    return select
  }

  for (const entry of select.SELECT.where) {
    if (entry.ref && entry.ref[0] === table) {
      entry.ref[0] = as
    }
  }

  return select
}

const _findJoinInQuery = (query, parentAlias) => {
  const targetAlias = query.SELECT.from.as
  const isTargetRef = el => targetAlias && el.ref && el.ref.length > 1 && el.ref[0] === targetAlias
  if (query.SELECT && query.SELECT.where)
    return query.SELECT.where.reduce((links, el, idx, where) => {
      if (el.ref && el.ref[0] === parentAlias && el.ref[el.ref.length - 1] !== 'IsActiveEntity') {
        if (where[idx - 1] && where[idx - 1] === '=' && isTargetRef(where[idx - 2])) {
          if (links.length) links.push('and')
          links.push(el, '=', where[idx - 2])
        }
        if (where[idx + 1] && where[idx + 1] === '=' && isTargetRef(where[idx + 2])) {
          if (links.length) links.push('and')
          links.push(el, '=', where[idx + 2])
        }
      }
      return links
    }, [])
  return []
}

const _isFiltered = where => where.some(element => !(element in ['(', ')']))

const _isDraftField = element => element.ref && element.ref.length > 1 && element.ref[0] === 'DraftAdministrativeData'

const _functionContainsDraftField = obj =>
  typeof obj === 'object' &&
  obj.func &&
  obj.args.some(arg => {
    return _isDraftField(arg) || _functionContainsDraftField(arg)
  })

const _isLogicalFunction = (where, index) => {
  const borders = ['(', ')', 'and', 'or', undefined]

  return borders.includes(where[index - 1]) && borders.includes(where[index + 1])
}

const _getWhereForActive = where => {
  const activeWhere = []
  for (let i = 0; i < where.length; i++) {
    if (_isDraftField(where[i])) {
      activeWhere.push({ val: null })
    } else if (_functionContainsDraftField(where[i])) {
      if (_isLogicalFunction(where, i)) {
        activeWhere.push({ val: 1 }, '=', { val: 2 })
      } else {
        activeWhere.push({ val: null })
      }
    } else {
      activeWhere.push(where[i])
    }
  }

  for (let i = 0; i < activeWhere.length; i++) {
    if (
      activeWhere[i].val === null &&
      activeWhere[i + 1] === '=' &&
      activeWhere[i + 2] &&
      activeWhere[i + 2].val === null
    ) {
      activeWhere[i] = { val: 1 }
      activeWhere[i + 2] = { val: 1 }
    }
  }

  return activeWhere
}

const _siblingEntity = ({ query, target, nav, params }, columns, model, draftAdminAlias, parentQuery, siblingIndex) => {
  const parentLinks = parentQuery ? _findJoinInQuery(query, parentQuery.SELECT.from.as) : []
  const keys = (nav[siblingIndex + 1].where && (params[siblingIndex] || params[0])) || {}
  const siblingQuery = query.SELECT.where[query.SELECT.where.indexOf('exists') + 1]
  const onCond = _findJoinInQuery(siblingQuery, target.as)
  const siblingAlias = siblingQuery.SELECT.from.as
  const subScenario = _siblingSubScenario(nav, siblingIndex, siblingQuery, target, params, model, onCond)
  const isSiblingDraft = subScenario
    ? subScenario.isSiblingActive || subScenario.scenario === 'ACTIVE' || subScenario.scenario === 'ALL_ACTIVE'
    : keys.IsActiveEntity && keys.IsActiveEntity !== 'false'
  const { table } = _getTableName({ query, target }, isSiblingDraft)
  const cqn = SELECT.from(table)
  if (siblingIndex === 0) {
    const columnCqnPartial = columns.map(col => {
      const colName = col.ref ? col.ref[col.ref.length - 1] : col
      const ref = col.ref ? [table.as, ...col.ref] : [table.as, colName]
      return Object.assign({}, col, { ref })
    })
    columnCqnPartial.push({ ref: ['draftAdmin', 'InProcessByUser'], as: 'draftAdmin_inProcessByUser' })
    cqn.columns(...columnCqnPartial)
  } else {
    cqn.columns([{ val: 1 }])
  }

  if (isSiblingDraft) {
    cqn
      .join(ensureNoDraftsSuffix(target.name), siblingAlias)
      .on(onCond)
      .join('DRAFT.DraftAdministrativeData', 'draftAdmin')
      .on(`${table.as}.DraftAdministrativeData_DraftUUID = draftAdmin.DraftUUID`)
  } else {
    cqn
      .join(ensureDraftsSuffix(target.name), siblingAlias)
      .on(onCond)
      .join('DRAFT.DraftAdministrativeData', 'draftAdmin')
      .on(`${siblingAlias}.DraftAdministrativeData_DraftUUID = draftAdmin.DraftUUID`)
  }

  for (const key in keys) {
    if (key !== 'IsActiveEntity') cqn.where([{ ref: [table.as, key] }, '=', { val: keys[key] }])
  }
  if (subScenario) {
    cqn.where(['exists', subScenario.cqn])
  }
  // in DraftAdminData scenario parent is linked via join
  if (draftAdminAlias) {
    cqn.where([{ ref: [draftAdminAlias, 'DraftUUID'] }, '=', { ref: ['draftAdmin', 'DraftUUID'] }])
  } else if (parentLinks.length) {
    cqn.where('(', ...parentLinks, ')')
  }

  return { cqn, scenario: SCENARIO.SIBLING_ENTITY, isSiblingActive: !isSiblingDraft }
}

function _siblingSubScenario(nav, siblingIndex, siblingQuery, target, params, model, onCond) {
  if (nav[siblingIndex + 1].where) return
  let subScenario
  const subNav = nav.slice(siblingIndex + 1)
  const subSiblingIndex = subNav.indexOf('SiblingEntity')
  const subReq = { query: siblingQuery, target: model.definitions[target.name], params: [...params].reverse() }
  if (subSiblingIndex > -1) {
    subScenario = _getSiblingScenario(subReq, [{ val: 1 }], model, subSiblingIndex, subNav, params)
    if (subSiblingIndex > 0) {
      const subQuery = SELECT.from(siblingQuery.SELECT.from).columns([{ val: 1 }])
      _mergeSiblingIntoCQN(subQuery, subScenario, subSiblingIndex - 1)
      subQuery.where(onCond)
      subScenario.cqn = subQuery
    }
  } else {
    subReq.query = SELECT.from(siblingQuery.SELECT.from).columns([{ val: 1 }])
    const existsIdx = siblingQuery.SELECT.where.indexOf('exists')
    if (existsIdx > -1) subReq.query.where(siblingQuery.SELECT.where.slice(existsIdx, existsIdx + 2))
    const subReqOrig = { query: { SELECT: { from: { ref: [...subNav].reverse() } } } }
    subScenario = _generateCQN(subReqOrig, subReq, [{ val: 1 }], model)
    subScenario.cqn.where(onCond)
  }
  return subScenario
}

const _getSiblingScenario = (req, columns, model, siblingIndex, nav) => {
  const draftAdminAlias = _isDraftAdminScenario(req) && req.query.SELECT.from.as
  const params = [...req.params].reverse()
  const _getSiblingQueryFromWhere = (query, queryIndex, parentQuery) => {
    if (query.SELECT && query.SELECT.where) {
      const indexExists = query.SELECT.where.indexOf('exists')
      if (indexExists > -1 && queryIndex > 0) {
        return _getSiblingQueryFromWhere(query.SELECT.where[indexExists + 1], queryIndex - 1, query)
      }
    }
    const target = { name: query.SELECT.from.ref[0].id || query.SELECT.from.ref[0], as: query.SELECT.from.as }
    return _siblingEntity({ query, target, params, nav }, columns, model, draftAdminAlias, parentQuery, siblingIndex)
  }
  return _getSiblingQueryFromWhere(req.query, siblingIndex)
}

const _mergeSiblingIntoCQN = (cqn, { cqn: siblingCQN }, siblingIndex) => {
  const _replaceWhereExists = (query, _siblingIndex) => {
    if (query.SELECT && query.SELECT.where) {
      const indexExists = query.SELECT.where.indexOf('exists')
      if (indexExists > -1) {
        if (_siblingIndex > 0) return _replaceWhereExists(query.SELECT.where[indexExists + 1], _siblingIndex - 1)
        query.SELECT.where.splice(indexExists + 1, 1, siblingCQN)
      }
    }
  }
  return _replaceWhereExists(cqn, siblingIndex)
}

const _getDraftDoc = (req, draftName, draftWhere) => {
  const refDraft = req.query.SELECT.from.as ? { ref: [draftName], as: req.query.SELECT.from.as } : draftName

  const draftDocs = getEnrichedCQN(
    SELECT.from(refDraft)
      .join('DRAFT.DraftAdministrativeData', 'filterAdmin')
      .on([
        { ref: [req.query.SELECT.from.as || draftName, 'DraftAdministrativeData_DraftUUID'] },
        '=',
        {
          ref: ['filterAdmin', 'DraftUUID']
        }
      ])
      .where(_inProcessByUserWhere(req.user.id)),
    req.query.SELECT,
    draftWhere,
    undefined,
    false
  )

  return draftDocs
}

const _getOrderByEnrichedColumns = (orderBy, columns) => {
  const enrichedCol = []
  if (orderBy.length > 1) {
    const colNames = columns.map(el => el.ref[el.ref.length - 1])
    // REVISIT: GET Books?$select=title&$expand=NotBooks($select=pages)&$orderby=NotBooks/title - what's then?
    for (const el of orderBy) {
      if (!DRAFT_COLUMNS.includes(el.ref[el.ref.length - 1]) && !colNames.includes(el.ref[el.ref.length - 1])) {
        enrichedCol.push({ ref: [...el.ref] })
      }
    }
  }
  return enrichedCol
}

const _replaceDraftAlias = where => {
  where.forEach(element => {
    if (_isDraftField(element)) {
      element.ref[0] = 'filterAdmin'
    }

    if (typeof element === 'object' && element.func) {
      _replaceDraftAlias(element.args)
    }
  })
}

const _poorMansAlias4 = xpr => '_' + xpr.ref.join('_') + '_'

const _getUnionCQN = (req, draftName, columns, subSelect, draftWhere) => {
  const draftActiveWhere = _getWhereForActive(draftWhere)
  const activeDocs = getEnrichedCQN(SELECT.from(req.target), req.query.SELECT, draftActiveWhere, undefined, false)

  _replaceDraftAlias(draftWhere)
  const draftDocs = _getDraftDoc(req, draftName, draftWhere)

  const union = SELECT.from({ SET: { op: 'union', all: true, args: [draftDocs, activeDocs] } })
  if (req.query.SELECT.count) union.SELECT.count = true

  if (req.query.SELECT.from.as) {
    draftDocs.SELECT.from.as = req.query.SELECT.from.as
    activeDocs.SELECT.from.as = req.query.SELECT.from.as
  }

  if (_isOnlyCount(columns)) {
    draftDocs.columns(...columns)
    activeDocs
      .columns(...columns)
      .where([
        'not exists',
        _alignAliasForUnion(ensureNoDraftsSuffix(req.target.name), req.query.SELECT.from.as, subSelect)
      ])

    return union.columns({ func: 'sum', args: [{ ref: ['$count'] }], as: '$count' })
  }

  const enrichedColumns = _getOrderByEnrichedColumns(req.query.SELECT.orderBy, columns)

  for (const col of enrichedColumns) {
    // if we have columns for outer order by that may also be needed for joins, we need to duplicate them
    const element = getElementDeep(req.target, col.ref)
    if (element && element['@odata.foreignKey4']) columns.push({ ref: [...col.ref] })

    col.as = _poorMansAlias4(col)
    // add alias to outer order by
    const ob = req.query.SELECT.orderBy.find(ele => _poorMansAlias4(ele) === col.as)
    ob.ref = [col.as]
  }

  const draftColumns = [
    ...addColumnAlias([...columns, ...enrichedColumns], req.query.SELECT.from.as || draftName),
    ..._filterDraftColumnsBySelected(DRAFT_COLUMNS_CASTED, req.query.SELECT.columns),
    'DraftAdministrativeData_DraftUUID'
  ]
  draftDocs.columns(draftColumns)

  const activeName = activeDocs.SELECT.from.as || (activeDocs.SELECT.from.ref && activeDocs.SELECT.from.ref[0])

  const hasDraftWhere = []
  for (const key of _getTargetKeys(req)) {
    // add 'and' token if not the first iteration
    if (hasDraftWhere.length) hasDraftWhere.push('and')
    hasDraftWhere.push({ ref: [activeName, key] }, '=', { ref: [draftName, key] })
  }

  const activeColumns = [
    ...columns,
    ...enrichedColumns,
    ..._filterDraftColumnsBySelected(
      _getDraftPropertiesDetermineDraft(req, hasDraftWhere, ensureDraftsSuffix(req.target.name), true),
      req.query.SELECT.columns
    )
  ]
  activeDocs.columns(activeColumns)

  activeDocs.where([
    'not exists',
    _alignAliasForUnion(ensureNoDraftsSuffix(req.target.name), req.query.SELECT.from.as, subSelect)
  ])

  // groupBy, orderBy and limit do not support partial CQNs
  if (req.query.SELECT.groupBy) {
    union.SELECT.groupBy = req.query.SELECT.groupBy
  }

  if (req.query.SELECT.orderBy) {
    union.SELECT.orderBy = req.query.SELECT.orderBy
  }

  if (req.query.SELECT.limit) {
    union.SELECT.limit = req.query.SELECT.limit
  }

  return union
    .columns(...columns)
    .columns(..._filterDraftColumnsBySelected(DRAFT_COLUMNS_CASTED, req.query.SELECT.columns))
}

const _excludeActiveDraftExists = (req, draftWhere, columns) => {
  const { table, name } = _getTableName(req, true)
  const draftName = table.ref[0]

  const subSelect = SELECT.from(draftName, [1])
    .join('DRAFT.DraftAdministrativeData', 'filterAdmin')
    .on([
      { ref: [draftName, 'DraftAdministrativeData_DraftUUID'] },
      '=',
      {
        ref: ['filterAdmin', 'DraftUUID']
      }
    ])
    .where(_inProcessByUserWhere(req.user.id))

  for (const key of _getTargetKeys(req)) {
    subSelect.where([{ ref: [ensureNoDraftsSuffix(req.target.name), key] }, '=', { ref: [draftName, key] }])
  }

  draftWhere = _getWhereWithAppendedDraftRestrictions(draftWhere, req)

  draftWhere = removeIsActiveEntityRecursively(draftWhere)
  const cqn = _getUnionCQN(req, draftName, columns, subSelect, draftWhere)
  cqn.SELECT.from.as = name

  if (cqn.SELECT.orderBy) {
    for (const entry of cqn.SELECT.orderBy || []) {
      if (entry.ref.length > 1 && entry.ref[0] !== name) {
        entry.ref[0] = name
      }
    }
  }

  return { cqn: cqn, scenario: SCENARIO.UNION }
}

const _readDraftParameters = where => {
  const obj = {
    isActiveEntity: readAndDeleteKeywords(['IsActiveEntity'], where),
    hasDraftEntity: readAndDeleteKeywords(['HasDraftEntity'], where),
    siblingIsActive: readAndDeleteKeywords(['SiblingEntity', 'IsActiveEntity'], where),
    draftInProcessByUser: readAndDeleteKeywords(['DraftAdministrativeData', 'InProcessByUser'], where)
  }

  // remove "DraftAdministrativeData/InProcessByUser ne null" from request if necessary
  readAndDeleteKeywords(['DraftAdministrativeData', 'InProcessByUser'], where)

  return obj
}

const _validatedActiveWithoutDraft = (req, draftWhere, draftParameters, columns) =>
  _isValidActiveWithoutDraft(draftParameters.isActiveEntity, draftParameters.hasDraftEntity) &&
  _activeWithoutDraft(req, draftWhere, columns)

const _validatedWithSiblingInProcess = (req, draftWhere, draftParameters, columns) => {
  const { isActiveEntity, siblingIsActive, draftInProcessByUser } = draftParameters
  if (
    !draftInProcessByUser &&
    _isValidExcludeActiveDraftExists(draftParameters.isActiveEntity, draftParameters.siblingIsActive)
  )
    return _excludeActiveDraftExists(req, draftWhere, columns)
  if (
    draftInProcessByUser.op === '!=' &&
    _isValidWithDraftLocked(isActiveEntity, siblingIsActive, draftInProcessByUser)
  ) {
    return _activeWithDraftInProcess(req, draftWhere, columns, req.user.id)
  } else if (_isValidWithDraftTimeout(isActiveEntity, siblingIsActive, draftInProcessByUser)) {
    return _activeWithDraftInProcess(req, draftWhere, columns, null)
  }
}

const _validatedDraftOfWhichIAmOwner = (req, draftWhere, draftParameters, columns) =>
  _isValidDraftOfWhichIAmOwner(draftParameters.isActiveEntity) && _draftOfWhichIAmOwner(req, draftWhere, columns)

const _draftInSubSelect = (where, req) => {
  return where.some(({ SELECT }) => {
    if (SELECT && SELECT.where) {
      const isActiveEntity = readAndDeleteKeywords(['IsActiveEntity'], SELECT.where, false)
      if (isActiveEntity) {
        const isFalse = _isFalse(isActiveEntity.value.val)
        if (isFalse) SELECT.where = _getWhereWithAppendedDraftRestrictions(SELECT.where, req)
        return isFalse
      }

      return _draftInSubSelect(SELECT.where, req)
    }

    return false
  })
}

const _isDraftAdminScenario = req =>
  req.target.query && req.target.query._target && req.target.query._target.name === 'DRAFT.DraftAdministrativeData'

// eslint-disable-next-line complexity
const _generateCQN = (reqOriginal, req, columns, model) => {
  const nav = [...reqOriginal.query.SELECT.from.ref].reverse() || []
  const siblingIndex = nav.indexOf('SiblingEntity')
  let siblingScenario
  if (siblingIndex > -1) {
    siblingScenario = _getSiblingScenario(req, columns, model, siblingIndex, nav)
    if (siblingIndex === 0) {
      return siblingScenario
    } else {
      _mergeSiblingIntoCQN(req.query, siblingScenario, siblingIndex - 1)
    }
  }

  if (_isDraftAdminScenario(req)) {
    return _draftAdminTable(req)
  }

  if (!req.query.SELECT.where || !_isFiltered(req.query.SELECT.where)) {
    return _allActive(req, columns, model)
  }

  // REVISIT this function does not only read, but modifies where!
  const draftParameters = _readDraftParameters(req.query.SELECT.where)

  if (
    draftParameters.isActiveEntity &&
    _isTrue(draftParameters.isActiveEntity.value.val) &&
    !draftParameters.siblingIsActive &&
    !draftParameters.hasDraftEntity
  ) {
    return _allActive(req, columns, model)
  }

  if (!draftParameters.isActiveEntity) {
    // _draftInSubSelect adds draft restrictions in case check is truthy
    // -> not nice but works for now and we don't need to go in recursively again
    if (_draftInSubSelect(req.query.SELECT.where, req) || (siblingScenario && !siblingScenario.isSiblingActive)) {
      // this is only the case when navigating into tree
      return _allInactive(req, columns)
    }
    return _allActive(req, columns, model)
  }

  if (draftParameters.hasDraftEntity) {
    return _validatedActiveWithoutDraft(req, req.query.SELECT.where, draftParameters, columns)
  }

  if (draftParameters.siblingIsActive) {
    return _validatedWithSiblingInProcess(req, req.query.SELECT.where, draftParameters, columns)
  }

  return _validatedDraftOfWhichIAmOwner(req, req.query.SELECT.where, draftParameters, columns)
}

const _getColumns = ({ query: { SELECT } }, model) => {
  return SELECT.columns
    ? SELECT.columns.filter(
        col =>
          (col.ref && !DRAFT_COLUMNS.includes(col.ref[col.ref.length - 1])) ||
          (!col.ref && !DRAFT_COLUMNS.includes(col))
      )
    : getColumns(model.definitions[ensureNoDraftsSuffix(SELECT.from.ref[0])], {
        onlyNames: true,
        removeIgnore: true
      })
}

const _isIsActiveEntity = element => element.ref && element.ref[element.ref.length - 1] === 'IsActiveEntity'

const _adaptSubSelects = ({ SELECT: { from, where } }, scenario) => {
  if (!where) return

  if (scenario === 'ALL_INACTIVE') {
    replaceRefWithDraft(from.ref)
  }

  for (let i = 0; i < where.length; i++) {
    const element = where[i]

    if (_isIsActiveEntity(element) && where.length > i + 2) {
      if (
        (scenario !== 'ALL_INACTIVE' && _isFalse(where[i + 2].val)) ||
        (scenario === SCENARIO.DRAFT_ADMIN && !_isFalse(where[i + 2].val))
      ) {
        replaceRefWithDraft(from.ref)
      }

      if (!_isIsActiveEntity(where[i + 2])) {
        i = deleteCondition(i, where) - 1
      } else {
        i = i + 3 < where.length ? i + 2 : i + 3
      }
    } else if (element.SELECT) {
      _adaptSubSelects(element, scenario)
    }
  }
}

const _calculateDraftAdminColumns = (result, user) => {
  if (
    Object.prototype.hasOwnProperty.call(result, 'DraftIsCreatedByMe') &&
    Object.prototype.hasOwnProperty.call(result, 'CreatedByUser')
  ) {
    result.DraftIsCreatedByMe = result.CreatedByUser === user
  }

  if (
    Object.prototype.hasOwnProperty.call(result, 'DraftIsProcessedByMe') &&
    Object.prototype.hasOwnProperty.call(result, 'InProcessByUser')
  ) {
    result.DraftIsProcessedByMe = result.InProcessByUser === user
  }
}

const _adaptDraftColumnsForSiblingEntity = (result, isSiblingActive) => {
  result.IsActiveEntity = isSiblingActive
  result.HasDraftEntity = isSiblingActive
  result.HasActiveEntity = !isSiblingActive
}

const _collectAliases = (from, aliases) => {
  if (from) {
    if (from.ref && from.as) {
      // Actually table names in where annotations should be provided with '.' separator.
      // Normalization to '_' is done for the exceptional case if '_' is still used (based on db table names).
      aliases.set(from.ref[0].replace(/\./g, '_'), from.as)
    } else if (from.args) {
      from.args.forEach(arg => {
        _collectAliases(arg, aliases)
      })
    } else if (from.SET && from.SET.args) {
      from.SET.args.forEach(arg => {
        _collectAliases(arg, aliases)
      })
    }
  }
}

const _adaptAnnotationAliases = cqn => {
  const aliases = new Map()
  _collectAliases(cqn.SELECT.from, aliases)
}

const calculateDraftTimeout = (scenario, result, deleteLastChangeDateTime) => {
  if (scenario === SCENARIO.DRAFT_ADMIN) {
    if (!draftIsLocked(result[0].LastChangeDateTime)) {
      result[0].InProcessByUser = ''
    }
    if (deleteLastChangeDateTime) delete result[0].LastChangeDateTime

    return
  }

  // non empty result that and DraftAdministrativeData was expanded
  if (result.length && Object.prototype.hasOwnProperty.call(result[0], 'DraftAdministrativeData')) {
    result.forEach(row => {
      if (!row.DraftAdministrativeData) return
      if (Object.prototype.hasOwnProperty.call(row.DraftAdministrativeData, 'InProcessByUser')) {
        if (!draftIsLocked(row.DraftAdministrativeData.LastChangeDateTime)) {
          row.DraftAdministrativeData.InProcessByUser = ''
        }
      }
      if (deleteLastChangeDateTime) delete row.DraftAdministrativeData.LastChangeDateTime
    })
  }
}

const enhanceQueryForTimeoutIfNeeded = (scenario, columns = []) => {
  if (scenario !== SCENARIO.DRAFT_ADMIN) {
    const draftAdmin = columns.find(col => col.ref && col.ref[col.ref.length - 1] === 'DraftAdministrativeData')
    columns = (draftAdmin && draftAdmin.expand) || []
  }
  const inProcessByUser = columns.find(col => col.ref && col.ref[col.ref.length - 1] === 'InProcessByUser')
  const lastChangeDateTime = columns.find(col => col.ref && col.ref[col.ref.length - 1] === 'LastChangeDateTime')
  if (inProcessByUser && !lastChangeDateTime) {
    columns.push({ ref: [...inProcessByUser.ref.slice(0, inProcessByUser.ref.length - 1), 'LastChangeDateTime'] })
    return true
  }
}

// REVISIT: HACK for sqlite support, union not yet properly supported in before handler on db
// remove once union is removed, should be part of before handler
const _getLocalizedEntity = (model, target, user) => {
  const prefix = 'localized'
  let localizedEntity
  /*
   * REVISIT: in case of not sqlite, model.definitions[`${prefix}.${user.locale}.${target.name}`] is undefined
   * and the fallback lookup model.definitions[`${prefix}.${target.name}`] gets the entity -> bad coding
   */
  if (cds.env.i18n.for_sqlite.includes(user.locale)) {
    localizedEntity = model.definitions[`${prefix}.${user.locale}.${target.name}`]
  }
  return localizedEntity || model.definitions[`${prefix}.${target.name}`]
}

const _adaptDraftAdminExpand = cqn => {
  const draftAdminExpand =
    cqn.SELECT.columns && cqn.SELECT.columns.find(c => c.expand && c.ref[0] === 'DraftAdministrativeData')
  if (draftAdminExpand) {
    _ensureDraftAdminColumnsForCalculation(draftAdminExpand.expand)
  }
}

/**
 * Generic Handler for READ requests in the context of draft.
 *
 * @param req
 */
// eslint-disable-next-line complexity
const _handler = async function (req) {
  // handle localized here as it was previously handled for req.target
  req.target = _getLocalizedEntity(this.model, req.target, req.user) || req.target

  // REVISIT
  delete req.query._validationQuery

  // REVISIT DRAFT HANDLING: cqn2cqn4sql must not be called here
  const sqlQuery = cqn2cqn4sql(req.query, this.model, { draft: true })

  // do not clone with Object.assign as that would skip all non-enumerable properties
  const reqClone = { __proto__: req, query: _copyCQNPartial(sqlQuery) }

  // ensure draft restrictions are copied to new query
  reqClone.query._draftRestrictions = req.query._draftRestrictions

  if (req.query._streaming) {
    adaptStreamCQN(reqClone.query)
    reqClone.query._streaming = true
    return cds.tx(req).run(reqClone.query)
  }

  const cqnScenario = _generateCQN(req, reqClone, _getColumns(reqClone, this.model), this.model)

  if (!cqnScenario) {
    req.reject(400)
    return
  }

  // ensure base columns for calculation are selected in draft admin expand
  _adaptDraftAdminExpand(cqnScenario.cqn)

  if (cqnScenario.scenario === SCENARIO.ALL_ACTIVE && cqnScenario.cqn.SELECT.where) {
    cqnScenario.cqn.SELECT.where = removeIsActiveEntityRecursively(cqnScenario.cqn.SELECT.where)
  }

  const enhancedWithLastChangeDateTime = enhanceQueryForTimeoutIfNeeded(
    cqnScenario.scenario,
    cqnScenario.cqn.SELECT.columns
  )

  _adaptSubSelects(cqnScenario.cqn, cqnScenario.scenario)

  _adaptAnnotationAliases(cqnScenario.cqn)

  // unlocalize for db and after handlers as it was before
  req.target = this.model.definitions[ensureUnlocalized(req.target.name)]

  const result = await cds.tx(req).send({ query: cqnScenario.cqn, target: req.target })

  const resultAsArray = Array.isArray(result) ? result : result ? [result] : []

  removeDraftUUIDIfNecessary(resultAsArray, req)

  if (cqnScenario.scenario === SCENARIO.DRAFT_ADMIN) {
    if (!result || (Array.isArray(result) && !result.length)) return result

    _calculateDraftAdminColumns(resultAsArray[0], req.user.id)
  }

  calculateDraftTimeout(cqnScenario.scenario, resultAsArray, enhancedWithLastChangeDateTime)

  if (cqnScenario.scenario === SCENARIO.SIBLING_ENTITY) {
    if (!result || (Array.isArray(result) && !result.length)) return result
    if (resultAsArray[0].draftAdmin_inProcessByUser !== req.user.id) return []

    delete resultAsArray[0].draftAdmin_inProcessByUser
    _adaptDraftColumnsForSiblingEntity(resultAsArray[0], cqnScenario.isSiblingActive)
  }

  if (resultAsArray.length && Object.prototype.hasOwnProperty.call(resultAsArray[0], 'DraftAdministrativeData')) {
    resultAsArray.forEach(row => {
      row.DraftAdministrativeData && _calculateDraftAdminColumns(row.DraftAdministrativeData, req.user.id)
    })
  }

  return result
}

module.exports = cds.service.impl(function () {
  for (const entity of Object.values(this.entities).filter(e => e._isDraftEnabled)) {
    this.on('READ', entity, _handler)
  }
})
