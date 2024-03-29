const cds = require('../../cds')

const { getCompositionTree } = require('./tree')
const { getDeepInsertCQNs } = require('./insert')
const { getDeepDeleteCQNs } = require('./delete')
const ctUtils = require('./utils')

const { ensureNoDraftsSuffix } = require('../utils/draft')
const { deepCopyObject } = require('../utils/copy')

const getError = require('../../common/error')

/*
 * own utils
 */

const _serializedKey = (entity, data) => {
  if (data === null) return 'null'

  return JSON.stringify(
    ctUtils
      .keyElements(entity)
      .map(key => key.name)
      .sort()
      .map(keyName => data[keyName])
  )
}

const _dataByKey = (entity, data) => {
  const dataByKey = new Map()
  for (const entry of data) {
    dataByKey.set(_serializedKey(entity, entry), entry)
  }
  return dataByKey
}

function _addSubDeepUpdateCQNForDelete({ entity, data, selectData, deleteCQN }) {
  const dataByKey = _dataByKey(entity, data)
  for (const selectEntry of selectData) {
    const dataEntry = dataByKey.get(_serializedKey(entity, selectEntry))
    if (!dataEntry) {
      if (deleteCQN.DELETE.where.length > 0) {
        deleteCQN.DELETE.where.push('or')
      }
      deleteCQN.DELETE.where.push('(', ...ctUtils.whereKey(ctUtils.key(entity, selectEntry)), ')')
    }
  }
}

const _unwrapVal = obj => {
  for (const key in obj) {
    const value = obj[key]
    if (value && value.val) obj[key] = value.val
  }
  return obj
}

function _fillLinkFromStructuredData(entity, entry) {
  for (const elementName in entity.elements) {
    const foreignKey4 = entity.elements[elementName]['@odata.foreignKey4']
    if (foreignKey4 && entry[foreignKey4]) {
      const foreignKey = entity.elements[elementName].name
      const childKey = foreignKey.split('_')[1]
      const val = _unwrapVal(entry[foreignKey4])[childKey]
      if (val !== undefined) entry[foreignKey] = val
    }
  }
}

const _diffData = (newData, oldData, entity, newEntry, oldEntry, definitions) => {
  const result = {}

  const keysSet = new Set(Object.keys(newData).concat(Object.keys(oldData)))
  for (const key of keysSet.keys()) {
    const newVal = ctUtils.val(newData[key])
    const oldVal = ctUtils.val(oldData[key])

    if (newVal !== undefined && newVal !== oldVal) {
      if (entity.elements[key]._isStructured && Object.keys(newData[key]).length === 0) {
        // empty structured -> skip
        continue
      }
      result[key] = newData[key]
      continue
    }

    // comp2one removed?
    const fk = entity.elements[key] && entity.elements[key]['@odata.foreignKey4']
    if (fk && newVal === undefined && oldVal !== undefined) {
      const nav = entity.elements[fk]
      // REVISIT: why check @cds.persistence.skip needed? bad tests?
      if (
        nav.isComposition &&
        nav.is2one &&
        newEntry[nav.name] !== undefined &&
        !definitions[nav.target]._hasPersistenceSkip
      ) {
        result[key] = null
      }
    }
  }

  return result
}

function _addSubDeepUpdateCQNForUpdateInsert({
  entity,
  entityName,
  data,
  selectData,
  updateCQNs,
  insertCQN,
  definitions
}) {
  const selectDataByKey = _dataByKey(entity, selectData)
  const deepUpdateData = []
  for (const entry of data) {
    if (entry === null) continue

    const key = ctUtils.key(entity, entry)
    const selectEntry = selectDataByKey.get(_serializedKey(entity, entry))
    _fillLinkFromStructuredData(entity, entry)
    if (selectEntry) {
      deepUpdateData.push(entry)
      const newData = ctUtils.cleanDeepData(entity, entry)
      const oldData = ctUtils.cleanDeepData(entity, selectEntry)
      const diff = _diffData(newData, oldData, entity, entry, selectEntry, definitions)
      // empty updates will be removed later
      updateCQNs.push({ UPDATE: { entity: entityName, data: diff, where: ctUtils.whereKey(key) } })
    } else {
      insertCQN.INSERT.entries.push(entry)
      // inserts are handled deep so they must not be put into deepUpdateData
    }
  }
  return deepUpdateData
}

function _addSubDeepUpdateCQNCollectDelete(deleteCQNs, cqns, index) {
  deleteCQNs.forEach(deleteCQN => {
    if (
      !cqns.find((subCQNs, subIndex) => {
        if (subIndex > 0) {
          const deleteIndex = subCQNs.findIndex(cqn => {
            return cqn.DELETE && cqn.DELETE.from === deleteCQN.DELETE.from
          })
          if (deleteIndex > -1) {
            if (subIndex < index) {
              subCQNs.splice(deleteIndex, 1)
            } else {
              return true
            }
          }
        }
        return false
      })
    ) {
      cqns[index] = cqns[index] || []
      cqns[index].push(deleteCQN)
    }
  })
}

function _addSubDeepUpdateCQNCollect(definitions, cqns, updateCQNs, insertCQN, deleteCQN) {
  if (updateCQNs.length > 0) {
    cqns[0] = cqns[0] || []
    cqns[0].push(...updateCQNs)
  }
  if (insertCQN.INSERT.entries.length > 0) {
    cqns[0] = cqns[0] || []
    const deepInsertCQNs = getDeepInsertCQNs(definitions, insertCQN)
    deepInsertCQNs.forEach(insertCQN => {
      const intoCQN = cqns[0].find(cqn => {
        return cqn.INSERT && cqn.INSERT.into === insertCQN.INSERT.into
      })
      if (!intoCQN) {
        cqns[0].push(insertCQN)
      } else {
        intoCQN.INSERT.entries.push(...insertCQN.INSERT.entries)
      }
    })
  }

  if (deleteCQN.DELETE.where.length > 0) {
    cqns[0] = cqns[0] || []
    const deepDeleteCQNs = getDeepDeleteCQNs(definitions, deleteCQN)
    deepDeleteCQNs.forEach((deleteCQNs, index) => {
      _addSubDeepUpdateCQNCollectDelete(deleteCQNs, cqns, index)
    })
  }
}

const _unwrapIfNotArray = x => (Array.isArray(x) ? x : _unwrapVal(x))

const _addToData = (subData, entity, element, entry) => {
  const value = ctUtils.val(entry[element.name])
  const subDataEntries = ctUtils.array(value)
  const unwrappedSubData = subDataEntries.map(entry => _unwrapIfNotArray(entry))
  subData.push(...unwrappedSubData)
}

function _addSubDeepUpdateCQNRecursion({ definitions, compositionTree, entity, data, selectData, cqns, draft }) {
  const selectDataByKey = _dataByKey(entity, selectData)
  for (const element of compositionTree.compositionElements) {
    const subData = []
    const selectSubData = []
    for (const entry of data) {
      if (element.name in entry) {
        const selectEntry = selectDataByKey.get(_serializedKey(entity, entry))

        if (selectEntry && element.name in selectEntry) {
          if (
            selectEntry[element.name] === null &&
            (entry[element.name] === null || Object.keys(entry[element.name]).length === 0)
          ) {
            continue
          }
          _addToData(selectSubData, entity, element, selectEntry)
        }

        _addToData(subData, entity, element, entry)
      }
    }
    _addSubDeepUpdateCQN({
      definitions,
      compositionTree: element,
      data: subData,
      selectData: selectSubData,
      cqns,
      draft
    })
  }
  return cqns
}

const _addSubDeepUpdateCQN = ({ definitions, compositionTree, data, selectData, cqns, draft }) => {
  // We handle each level for deepUpdate, the moment we see that there will be an INSERT,
  // it'll be removed from our deepUpdateData (and handled deep separately).
  const entity = definitions && definitions[compositionTree.source]

  if (entity._hasPersistenceSkip) return Promise.resolve()

  const entityName = ctUtils.addDraftSuffix(draft, entity.name)
  const updateCQNs = []
  const insertCQN = { INSERT: { into: entityName, entries: [] } }
  const deleteCQN = { DELETE: { from: entityName, where: [] } }
  _addSubDeepUpdateCQNForDelete({ entity, data, selectData, deleteCQN })
  const deepUpdateData = _addSubDeepUpdateCQNForUpdateInsert({
    entity,
    entityName,
    data,
    selectData,
    updateCQNs,
    insertCQN,
    definitions
  })
  _addSubDeepUpdateCQNCollect(definitions, cqns, updateCQNs, insertCQN, deleteCQN)

  if (deepUpdateData.length === 0) {
    return Promise.resolve()
  }
  return _addSubDeepUpdateCQNRecursion({
    definitions,
    compositionTree,
    entity,
    data: deepUpdateData,
    selectData,
    cqns,
    draft
  })
}

/*
 * exports
 */

const hasDeepUpdate = (definitions, cqn) => {
  if (cqn && cqn.UPDATE && cqn.UPDATE.entity && (cqn.UPDATE.data || cqn.UPDATE.with)) {
    const entityName =
      (cqn.UPDATE.entity.ref && cqn.UPDATE.entity.ref[0]) || cqn.UPDATE.entity.name || cqn.UPDATE.entity
    const entity = definitions && definitions[ensureNoDraftsSuffix(entityName)]
    if (entity) {
      return !!Object.keys(Object.assign({}, cqn.UPDATE.data || {}, cqn.UPDATE.with || {})).find(k => {
        return ctUtils.isCompOrAssoc(entity, k)
      })
    }
  }
  return false
}

const getDeepUpdateCQNs = (definitions, cqn, selectData) => {
  if (!Array.isArray(selectData)) selectData = [selectData]

  if (selectData.length === 0) return []

  if (selectData.length > 1) throw getError('Deep update can only be performed on a single instance')

  const cqns = []
  const from = (cqn.UPDATE.entity.ref && cqn.UPDATE.entity.ref[0]) || cqn.UPDATE.entity.name || cqn.UPDATE.entity
  const entityName = ensureNoDraftsSuffix(from)
  const draft = entityName !== from
  const data = cqn.UPDATE.data ? deepCopyObject(cqn.UPDATE.data) : {}
  const withObj = cqn.UPDATE.with ? deepCopyObject(cqn.UPDATE.with) : {}
  const entity = definitions && definitions[entityName]
  const entry = Object.assign({}, data, withObj, ctUtils.key(entity, selectData[0]))
  const compositionTree = getCompositionTree({
    definitions,
    rootEntityName: entityName,
    checkRoot: false,
    resolveViews: !draft,
    service: cds.db
  })

  const subCQNs = _addSubDeepUpdateCQN({ definitions, compositionTree, data: [entry], selectData, cqns: [], draft })
  subCQNs.forEach((subCQNs, index) => {
    cqns[index] = cqns[index] || []
    cqns[index].push(...subCQNs)
  })

  // remove empty updates and inserts
  return cqns
    .map(cqns => {
      return cqns.filter(cqn => {
        if (!cqn.UPDATE && !cqn.INSERT) return true
        if (cqn.UPDATE) return Object.keys(cqn.UPDATE.data).length > 0
        if (!cqn.INSERT.entries || cqn.INSERT.entries.length > 1) return true
        return Object.keys(cqn.INSERT.entries[0]).length > 0
      })
    })
    .filter(cqns => cqns.length > 0)
}

module.exports = {
  hasDeepUpdate,
  getDeepUpdateCQNs
}
