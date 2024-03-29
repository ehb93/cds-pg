const { DRAFT_COLUMNS } = require('../../../common/constants/draft')

const _deepEqual = (val1, val2) => {
  if (val1 && typeof val1 === 'object' && val2 && typeof val2 === 'object') {
    for (const key in val1) {
      if (!_deepEqual(val1[key], val2[key])) return false
    }
    return true
  }
  return val1 === val2
}

const _getCorrespondingEntryWithSameKeys = (source, entry, keys) => {
  const idx = _getIdxCorrespondingEntryWithSameKeys(source, entry, keys)
  return idx !== -1 ? source[idx] : undefined
}

const _getIdxCorrespondingEntryWithSameKeys = (source, entry, keys) =>
  source.findIndex(sourceEntry => keys.every(key => _deepEqual(sourceEntry[key], entry[key])))

const _getKeysOfEntity = entity =>
  Object.keys(entity.keys).filter(key => !DRAFT_COLUMNS.includes(key) && !entity.elements[key].isAssociation)

const _getCompositionsOfEntity = entity => Object.keys(entity.elements).filter(e => entity.elements[e].isComposition)

const _createToBeDeletedEntries = (oldEntry, entity, keys, compositions) => {
  const toBeDeletedEntry = {
    _op: 'delete'
  }

  for (const prop in oldEntry) {
    if (DRAFT_COLUMNS.includes(prop)) {
      continue
    }
    if (keys.includes(prop)) {
      toBeDeletedEntry[prop] = oldEntry[prop]
    } else if (compositions.includes(prop) && oldEntry[prop]) {
      toBeDeletedEntry[prop] = entity.elements[prop].is2one
        ? _createToBeDeletedEntries(
            oldEntry[prop],
            entity.elements[prop]._target,
            _getKeysOfEntity(entity.elements[prop]._target),
            _getCompositionsOfEntity(entity.elements[prop]._target)
          )
        : oldEntry[prop].map(entry =>
            _createToBeDeletedEntries(
              entry,
              entity.elements[prop]._target,
              _getKeysOfEntity(entity.elements[prop]._target),
              _getCompositionsOfEntity(entity.elements[prop]._target)
            )
          )
    } else {
      toBeDeletedEntry._old = toBeDeletedEntry._old || {}
      toBeDeletedEntry._old[prop] = oldEntry[prop]
    }
  }

  return toBeDeletedEntry
}

const _hasOpDeep = (entry, element) => {
  const entryArray = Array.isArray(entry) ? entry : [entry]
  for (const entry_ of entryArray) {
    if (entry_._op) return true

    if (element && element.isComposition) {
      const target = element._target
      for (const prop in entry_) {
        if (_hasOpDeep(entry_[prop], target.elements[prop])) {
          return true
        }
      }
    }
  }

  return false
}

const _addCompositionsToResult = (result, entity, prop, newValue, oldValue) => {
  /*
   * REVISIT: the current impl results in {} instead of keeping null for compo to one.
   *          unfortunately, many follow-up errors occur (e.g., prop in null checks) if changed.
   */
  let composition
  if (
    newValue[prop] &&
    typeof newValue[prop] === 'object' &&
    !Array.isArray(newValue[prop]) &&
    Object.keys(newValue[prop]).length === 0
  ) {
    composition = compareJsonDeep(entity.elements[prop]._target, undefined, oldValue && oldValue[prop])
  } else {
    composition = compareJsonDeep(entity.elements[prop]._target, newValue[prop], oldValue && oldValue[prop])
  }
  if (composition.some(c => _hasOpDeep(c, entity.elements[prop]))) {
    result[prop] = entity.elements[prop].is2one ? composition[0] : composition
  }
}

const _addPrimitiveValuesAndOperatorToResult = (result, prop, newValue, oldValue) => {
  result[prop] = newValue[prop]

  if (!result._op) {
    result._op = oldValue ? 'update' : 'create'
  }

  if (result._op === 'update') {
    result._old = result._old || {}
    result._old[prop] = oldValue[prop]
  }
}

const _addKeysToResult = (result, prop, newValue, oldValue) => {
  result[prop] = newValue[prop]
  if (!oldValue) {
    result._op = 'create'
  }
}

const _addToBeDeletedEntriesToResult = (results, entity, keys, newValues, oldValues) => {
  // add to be deleted entries
  for (const oldEntry of oldValues) {
    const entry = _getCorrespondingEntryWithSameKeys(newValues, oldEntry, keys)

    if (!entry) {
      // prepare to be deleted (deep) entry without manipulating oldData
      const toBeDeletedEntry = _createToBeDeletedEntries(oldEntry, entity, keys, _getCompositionsOfEntity(entity))
      results.push(toBeDeletedEntry)
    }
  }
}

const _normalizeToArray = value => (Array.isArray(value) ? value : [value])

const _addKeysToEntryIfNotExists = (keys, newEntry) => {
  for (const key of keys) {
    if (!(key in newEntry)) {
      newEntry[key] = undefined
    }
  }
}

const _isUnManaged = element => {
  return element.on && !element._isSelfManaged
}

const _skip = (entity, prop) => entity.elements[prop]._target._hasPersistenceSkip

const _skipToOne = (entity, prop) => {
  return (
    entity.elements[prop] && entity.elements[prop].is2one && _skip(entity, prop) && _isUnManaged(entity.elements[prop])
  )
}

const _skipToMany = (entity, prop) => {
  return entity.elements[prop] && entity.elements[prop].is2many && _skip(entity, prop)
}

const _iteratePropsInNewEntry = (newEntry, keys, result, oldEntry, entity) => {
  for (const prop in newEntry) {
    if (keys.includes(prop)) {
      _addKeysToResult(result, prop, newEntry, oldEntry)
      continue
    }

    // if value did not change --> ignored
    if (newEntry[prop] === (oldEntry && oldEntry[prop]) || DRAFT_COLUMNS.includes(prop)) {
      continue
    }

    if (_skipToMany(entity, prop)) {
      continue
    }

    if (_skipToOne(entity, prop)) {
      continue
    }

    if (entity.elements[prop] && entity.elements[prop].isComposition) {
      _addCompositionsToResult(result, entity, prop, newEntry, oldEntry)
      continue
    }

    _addPrimitiveValuesAndOperatorToResult(result, prop, newEntry, oldEntry)
  }
}

const compareJsonDeep = (entity, newValue = [], oldValue = []) => {
  const resultsArray = []
  const keys = _getKeysOfEntity(entity)

  // normalize input
  const newValues = _normalizeToArray(newValue)
  const oldValues = _normalizeToArray(oldValue)

  // add to be created and to be updated entries
  for (const newEntry of newValues) {
    const result = {}
    const oldEntry = _getCorrespondingEntryWithSameKeys(oldValues, newEntry, keys)

    _addKeysToEntryIfNotExists(keys, newEntry)

    _iteratePropsInNewEntry(newEntry, keys, result, oldEntry, entity)

    resultsArray.push(result)
  }

  _addToBeDeletedEntriesToResult(resultsArray, entity, keys, newValues, oldValues)

  return resultsArray
}

/**
 * Compares newValue with oldValues in a deep fashion.
 * Output format is newValue with additional administrative properties.
 * - "_op" provides info about the CRUD action to perform
 * - "_old" provides info about the current DB state
 *
 * Unchanged values are not part of the result.
 *
 * Output format is:
 * {
 *   _op: 'update',
 *   _old: { orderedAt: 'DE' },
 *   ID: 1,
 *   orderedAt: 'EN',
 *   items: [
 *     {
 *       _op: 'update',
 *       _old: { amount: 7 },
 *       ID: 7,
 *       amount: 8
 *     },
 *     {
 *       _op: 'create',
 *       ID: 8,
 *       amount: 8
 *     },
 *     {
 *       _op: 'delete',
 *       _old: {
 *         amount: 6
 *       },
 *       ID: 6
 *     }
 *   ]
 * }
 *
 *
 * If there is no change in an UPDATE, result is an object containing only the keys of the entity.
 *
 * @example
 * compareJson(csnEntity, [{ID: 1, col1: 'A'}], [{ID: 1, col1: 'B'}])
 *
 * @param oldValue
 * @param {object} entity
 * @param {Array | object} newValue
 * @param {Array} oldValues
 *
 * @returns {Array}
 */
const compareJson = (newValue, oldValue, entity) => {
  const result = compareJsonDeep(entity, newValue, oldValue)

  // in case of batch insert, result is an array
  // in all other cases it is an array with just one entry
  return Array.isArray(newValue) ? result : result[0]
}

const _isObject = item => item && typeof item === 'object' && !Array.isArray(item)

const _mergeArrays = (entity, oldValue, newValue) => {
  const merged = []
  const foundIdxNew = []
  const keys = _getKeysOfEntity(entity)
  for (const entry of oldValue) {
    const idxNew = _getIdxCorrespondingEntryWithSameKeys(newValue, entry, keys)
    if (idxNew === -1) merged.push(entry)
    else {
      foundIdxNew.push(idxNew)
      merged.push(mergeJsonDeep(entity, entry, newValue[idxNew]))
    }
  }
  for (let i = 0; i < newValue.length; i++) {
    if (!foundIdxNew.includes(i)) merged.push(newValue[i])
  }
  return merged
}

const mergeJsonDeep = (entity, oldValue, newValue) => {
  if (_isObject(oldValue) && _isObject(newValue)) {
    Object.keys(newValue).forEach(key => {
      if (_isObject(newValue[key])) {
        if (!(key in oldValue)) Object.assign(oldValue, { [key]: newValue[key] })
        else {
          const target = entity && entity.elements[key] && entity.elements[key]._target
          oldValue[key] = mergeJsonDeep(target, oldValue[key], newValue[key])
        }
      } else if (Array.isArray(newValue[key])) {
        if (!(key in oldValue)) Object.assign(oldValue, { [key]: newValue[key] })
        else {
          const target = entity && entity.elements[key] && entity.elements[key]._target
          if (target) {
            oldValue[key] = _mergeArrays(target, oldValue[key], newValue[key])
          }
          // Can't merge items without target
        }
      } else {
        Object.assign(oldValue, { [key]: newValue[key] })
      }
    })
  }
  return oldValue
}

// Signature similar to Object.assign(oldValue, newValue)
const mergeJson = (oldValue, newValue, entity) => {
  const result = mergeJsonDeep(entity, oldValue, newValue)
  return result
}

module.exports = {
  compareJson,
  mergeJson
}
