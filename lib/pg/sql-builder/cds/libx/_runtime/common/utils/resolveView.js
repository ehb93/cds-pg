const cds = require('../../cds')
let LOG = cds.log('app')
let _event
const PERSISTENCE_TABLE = '@cds.persistence.table'
const { rewriteAsterisks } = require('../../common/utils/rewriteAsterisks')

const getError = require('../error')
const { getEntityNameFromDeleteCQN, getEntityNameFromUpdateCQN } = require('../utils/cqn')

const _setInverseTransition = (mapping, ref, mapped) => {
  const existing = mapping.get(ref)
  if (!existing) mapping.set(ref, mapped)
  else {
    const alternatives = existing.alternatives || []
    alternatives.push(mapped)
    existing.alternatives = alternatives
    mapping.set(ref, existing)
  }
}

const _inverseTransition = transition => {
  const inverseTransition = {}
  inverseTransition.target = transition.queryTarget
  inverseTransition.queryTarget = transition.target
  inverseTransition.mapping = new Map()

  if (!transition.mapping.size) inverseTransition.mapping = new Map()

  for (const [key, value] of transition.mapping) {
    const mapped = {}
    if (value.ref) {
      if (value.transition) mapped.transition = _inverseTransition(value.transition)

      const ref0 = value.ref[0]
      if (value.ref.length > 1) {
        const nested = inverseTransition.mapping.get(ref0) || {}
        if (!nested.transition) nested.transition = { mapping: new Map() }
        let current = nested.transition.mapping
        for (let i = 1; i < value.ref.length; i++) {
          const last = i === value.ref.length - 1
          const obj = last ? { ref: [key] } : { transition: { mapping: new Map() } }
          _setInverseTransition(current, value.ref[i], obj)
          if (!last) current = current.get(value.ref[i]).transition.mapping
        }
        inverseTransition.mapping.set(ref0, nested)
      } else {
        mapped.ref = [key]
        _setInverseTransition(inverseTransition.mapping, ref0, mapped)
      }
    }
  }

  return inverseTransition
}

const revertData = (data, transition, service) => {
  if (!transition || !transition.mapping.size) return data
  const inverseTransition = _inverseTransition(transition)
  return Array.isArray(data)
    ? data.map(entry => _newData(entry, inverseTransition, true, service))
    : _newData(data, inverseTransition, true, service)
}

const _newSubData = (newData, key, transition, el, inverse, service) => {
  const val = newData[key]
  if ((!Array.isArray(val) && typeof val === 'object') || (Array.isArray(val) && val.length !== 0)) {
    let mapped = transition.mapping.get(key)
    if (!mapped) {
      mapped = {}
      transition.mapping.set(key, mapped)
    }
    if (!mapped.transition) {
      const subTransition = getTransition(el._target, service)
      mapped.transition = inverse ? _inverseTransition(subTransition) : subTransition
    }
    if (Array.isArray(val)) {
      newData[key] = val.map(singleVal => _newData(singleVal, mapped.transition, inverse, service))
    } else {
      newData[key] = _newData(val, mapped.transition, inverse, service)
    }
  }
}

const _newNestedData = (queryTarget, newData, ref, value) => {
  const parent = queryTarget.query && queryTarget.query._target
  let currentEntity = parent
  let currentData = newData
  for (let i = 0; i < ref.length; i++) {
    currentEntity = currentEntity.elements[ref[i]]
    if (currentEntity.isAssociation) {
      // > don't follow associations
      break
    } else {
      // > intermediate or final struct element
      if (i === ref.length - 1) currentData[ref[i]] = value
      else currentData = currentData[ref[i]] = currentData[ref[i]] || {}
    }
  }
}

const _newData = (data, transition, inverse, service) => {
  // no transition -> nothing to do
  if (transition.target && transition.target.name === transition.queryTarget.name) return data

  const newData = { ...data }
  const queryTarget = transition.queryTarget

  /*
   * REVISIT: the current impl results in {} instead of keeping null for compo to one.
   *          unfortunately, many follow-up errors occur (e.g., prop in null checks) if changed.
   */
  for (const key in newData) {
    const el = queryTarget && queryTarget.elements && queryTarget.elements[key]
    const isAssoc = el && el.isAssociation
    if (isAssoc) {
      if (newData[key] || (newData[key] === null && service.name === 'db')) {
        _newSubData(newData, key, transition, el, inverse, service)
      }
    }

    const mapped = transition.mapping.get(key)
    if (!mapped) {
      // if there is no mapping and no element with the same name in the target, then we don't need the data
      if ((typeof newData[key] !== 'object' || newData[key] === null) && !transition.target.elements[key])
        delete newData[key]
      continue
    }

    if (!isAssoc && mapped.transition) {
      _newSubData(newData, key, transition, el, inverse)
      const value = newData[key]
      delete newData[key]
      Object.assign(newData, value)
    }

    if (mapped.ref) {
      const value = newData[key]
      delete newData[key]
      const { ref } = mapped
      if (ref.length === 1) {
        newData[ref[0]] = value
        if (mapped.alternatives) mapped.alternatives.forEach(({ ref }) => (newData[ref[0]] = value))
      } else {
        _newNestedData(queryTarget, newData, ref, value)
      }
    }
  }

  return newData
}

const _newColumns = (columns = [], transition, service, withAlias = false) => {
  const newColumns = []

  columns.forEach(column => {
    const mapped = column.ref && transition.mapping.get(column.ref[0])

    let newColumn
    if (mapped && mapped.ref) {
      newColumn = { ...column }

      if (withAlias) {
        newColumn.as = column.ref[column.ref.length - 1]
      }

      newColumn.ref = [...mapped.ref, ...column.ref.slice(mapped.ref.length)]
    } else if (mapped && mapped.val) {
      newColumn = {}
      newColumn.as = column.ref[0]
      newColumn.val = mapped.val
    } else {
      newColumn = column
    }

    // ensure that renaming of a redirected assoc are also respected
    if (mapped && column.expand) {
      // column.ref might be structured elements
      let def
      column.ref.forEach((ref, i) => {
        if (i === 0) {
          def = transition.queryTarget.elements[ref]
        } else {
          def = def.elements[ref]
        }
      })

      // reuse _newColumns with new transition
      const expandTarget = def._target
      const subtransition = getTransition(expandTarget, service)
      mapped.transition = subtransition

      newColumn.expand = _newColumns(column.expand, subtransition, service, withAlias)
    }
    newColumns.push(newColumn)
  })

  return newColumns
}

const _newInsertColumns = (columns = [], transition) => {
  const newColumns = []

  columns.forEach(column => {
    const mapped = transition.mapping.get(column)
    if (mapped && mapped.ref) {
      newColumns.push(mapped.ref[0])
    } else if (!mapped) {
      newColumns.push(column)
    }
  })

  return newColumns
}

const _newWhereRef = (newWhereElement, transition, alias, tableName, isSubSelect) => {
  const newRef = Array.isArray(newWhereElement.ref) ? [...newWhereElement.ref] : [newWhereElement.ref]
  if (newRef[0] === alias) {
    const mapped = transition.mapping.get(newRef[1])
    if (mapped) newRef[1] = mapped.ref[0]
  } else if (newRef[0] === tableName) {
    newRef[0] = transition.target.name
    const mapped = transition.mapping.get(newRef[1])
    if (mapped) newRef[1] = mapped.ref[0]
  } else {
    const mapped = transition.mapping.get(newRef[0])
    if (isSubSelect && mapped) {
      newRef.unshift(transition.target.name)
      newRef[1] = mapped.ref[0]
    } else {
      if (mapped) newRef[0] = mapped.ref[0]
    }
  }
  newWhereElement.ref = newRef
}

const _newEntries = (entries = [], transition, service) =>
  entries.map(entry => _newData(entry, transition, false, service))

const _newWhere = (where = [], transition, tableName, alias, isSubselect = false) => {
  const newWhere = where.map(whereElement => {
    const newWhereElement = { ...whereElement }
    if (!whereElement.ref && !whereElement.SELECT) return whereElement
    if (whereElement.SELECT && whereElement.SELECT.where) {
      newWhereElement.SELECT.where = _newWhere(whereElement.SELECT.where, transition, tableName, alias, true)
      return newWhereElement
    } else {
      if (newWhereElement.ref) {
        _newWhereRef(newWhereElement, transition, alias, tableName, isSubselect)
        return newWhereElement
      } else {
        return whereElement
      }
    }
  })

  return newWhere
}

const _initialColumns = transition => {
  const columns = []

  for (const [transitionEl] of transition.mapping) {
    // REVISIT: structured elements
    if (!transition.queryTarget.elements[transitionEl] || transition.queryTarget.elements[transitionEl].isAssociation) {
      continue
    }
    columns.push({ ref: [transitionEl] })
  }

  return columns
}

const _rewriteQueryPath = (path, transitions) => {
  return path.ref.map((f, i) => {
    if (i === 0) {
      const target = transitions[0].target

      if (typeof f === 'string') {
        return target.name
      }

      if (f.id) {
        return {
          id: target.name,
          where: _newWhere(f.where, transitions[0], f.id)
        }
      }
    } else {
      if (typeof f === 'string') {
        const transitionMapping = transitions[i - 1].mapping.get(f)
        return (transitionMapping && transitionMapping.ref && transitionMapping.ref[0]) || f
      }

      if (f.id) {
        const transitionMapping = transitions[i - 1].mapping.get(f.id)
        return {
          id: (transitionMapping && transitionMapping.ref && transitionMapping.ref[0]) || f.id,
          where: _newWhere(f.where, transitions[i], f.id)
        }
      }
    }
  })
}

const _newUpdate = (query, transitions, service) => {
  const targetTransition = transitions[transitions.length - 1]
  const targetName = targetTransition.target.name
  const newUpdate = { ...query.UPDATE }
  newUpdate.entity = newUpdate.entity.ref
    ? {
        ...newUpdate.entity,
        ref: _rewriteQueryPath(query.UPDATE.entity, transitions)
      }
    : targetName
  if (newUpdate.data) newUpdate.data = _newData(newUpdate.data, targetTransition, false, service)
  if (newUpdate.with) newUpdate.with = _newData(newUpdate.with, targetTransition, false, service)
  if (newUpdate.where) {
    newUpdate.where = _newWhere(
      newUpdate.where,
      targetTransition,
      getEntityNameFromUpdateCQN(query),
      query.UPDATE.entity.as
    )
  }
  Object.defineProperty(newUpdate, '_transitions', {
    enumerable: false,
    value: transitions
  })
  return newUpdate
}

const _newSelect = (query, transitions, service) => {
  const targetTransition = transitions[transitions.length - 1]
  const newSelect = { ...query.SELECT }
  newSelect.from = {
    ...newSelect.from,
    ref: _rewriteQueryPath(query.SELECT.from, transitions)
  }
  if (!newSelect.columns && targetTransition.mapping.size) newSelect.columns = _initialColumns(targetTransition)
  if (newSelect.columns) {
    const isDB = service instanceof cds.DatabaseService
    rewriteAsterisks({ SELECT: newSelect }, targetTransition.queryTarget, isDB)
    newSelect.columns = _newColumns(newSelect.columns, targetTransition, service, service.kind !== 'app-service')
  }
  if (newSelect.having) newSelect.having = _newColumns(newSelect.having, targetTransition)
  if (newSelect.groupBy) newSelect.groupBy = _newColumns(newSelect.groupBy, targetTransition)
  if (newSelect.orderBy) newSelect.orderBy = _newColumns(newSelect.orderBy, targetTransition)
  if (newSelect.where) {
    newSelect.where = _newWhere(
      newSelect.where,
      targetTransition,
      query.SELECT.from && query.SELECT.from.ref[0],
      query.SELECT.from && query.SELECT.from.as
    )
  }
  Object.defineProperty(newSelect, '_transitions', {
    enumerable: false,
    value: transitions
  })
  return newSelect
}

const _newInsert = (query, transitions, service) => {
  const targetTransition = transitions[transitions.length - 1]
  const targetName = targetTransition.target.name
  const newInsert = { ...query.INSERT }
  newInsert.into = newInsert.into.ref
    ? {
        ...newInsert.into,
        ref: _rewriteQueryPath(query.INSERT.into, transitions)
      }
    : targetName
  if (newInsert.columns) newInsert.columns = _newInsertColumns(newInsert.columns, targetTransition)
  if (newInsert.entries) newInsert.entries = _newEntries(newInsert.entries, targetTransition, service)
  Object.defineProperty(newInsert, '_transitions', {
    enumerable: false,
    value: transitions
  })
  return newInsert
}

const _newDelete = (query, transitions) => {
  const targetTransition = transitions[transitions.length - 1]
  const targetName = targetTransition.target.name
  const newDelete = { ...query.DELETE }
  newDelete.from = newDelete.from.ref
    ? {
        ...newDelete.from,
        ref: _rewriteQueryPath(query.DELETE.from, transitions)
      }
    : targetName
  if (newDelete.where) {
    newDelete.where = _newWhere(
      newDelete.where,
      targetTransition,
      getEntityNameFromDeleteCQN(query),
      query.DELETE.from.as
    )
  }
  Object.defineProperty(newDelete, '_transitions', {
    enumerable: false,
    value: transitions
  })
  return newDelete
}

const _isPersistenceTable = target =>
  Object.prototype.hasOwnProperty.call(target, PERSISTENCE_TABLE) && target[PERSISTENCE_TABLE]

const _findRenamed = (cqnColumns, column) =>
  cqnColumns.find(
    cqnColumn =>
      cqnColumn.as &&
      ((column.ref && column.ref[column.ref.length - 1] === cqnColumn.as) ||
        (column.as === cqnColumn.as && Object.prototype.hasOwnProperty.call(cqnColumn, 'val')))
  )

const _queryColumns = (target, columns = [], persistenceTable = false, force = false) => {
  if (!(target && target.query && target.query.SELECT)) return columns
  const cqnColumns = target.query.SELECT.columns || []
  const from = target.query.SELECT.from
  const isTargetAliased = from.as && cqnColumns.some(c => c.ref && c.ref[0] === from.as)
  if (!columns.length) columns = Object.keys(target.elements).map(e => ({ ref: [e], as: e }))
  return columns.reduce((res, column) => {
    const renamed = _findRenamed(cqnColumns, column)
    if (renamed) {
      if (renamed.val) return res.concat({ as: renamed.as, val: renamed.val })
      // There could be some `where` clause inside `ref` which we don't support yet
      if (!renamed.ref || renamed.ref.some(e => typeof e !== 'string') || renamed.xpr) return res
      if (isTargetAliased) renamed.ref.shift()
      // If the entity is annotated with the annotation `@cds.persistence.table`
      // and elements aliases exist, the aliases must be used as column references.
      // The reason is that in this scenario, the cds compiler generate a table
      // instead of a view. If forced, skip this.
      column.ref = !force && persistenceTable ? [renamed.as] : [...renamed.ref]
    }
    res.push(column)
    return _appendForeignKeys(res, target, columns, column)
  }, [])
}

const _mappedValue = (col, alias) => {
  const key = col.as || col.ref[0]

  if (col.ref) {
    const columnRef = col.ref.filter(columnName => columnName !== alias)
    return [key, { ref: columnRef }]
  }

  return [key, { val: col.val }]
}

const getDBTable = target => {
  if (target.query && target.query._target && !_isPersistenceTable(target)) {
    return getDBTable(target.query._target)
  }
  return target
}

const _appendForeignKeys = (newColumns, target, columns, { as, ref = [] }) => {
  const el = target.elements[as] || target.query._target.elements[ref[ref.length - 1]]
  if (el && el.isAssociation && el.keys) {
    for (const key of el.keys) {
      // .as and .ref has a different meaning here
      // .as means the original property name, if the foreign key is renamed
      const keyName = key.as || key.ref[0]
      const keyAlias = key.ref[0]
      const found = columns.find(col => col.as === `${as}_${keyAlias}`)
      if (found) {
        found.ref = [`${ref.join('_')}_${keyName}`]
      } else {
        newColumns.push({
          ref: [`${ref.join('_')}_${keyName}`],
          as: `${as}_${keyAlias}`
        })
      }
    }
  }
  return newColumns
}

const _checkForForbiddenViews = queryTarget => {
  const select = queryTarget && queryTarget.query && queryTarget.query.SELECT
  if (select) {
    if (!select.from || select.from.join || select.from.length > 1) {
      throw getError({
        code: 501,
        message: 'NON_WRITABLE_VIEW',
        target: queryTarget.name,
        args: [_event || 'INSERT|UPDATE|DELETE']
      })
    }
    if (select.where) {
      LOG._debug &&
        LOG.debug(`Ignoring where clause during ${_event || 'INSERT|UPDATE|DELETE'} on view "${queryTarget.name}".`)
    }
  }
}

const _getTransitionData = (target, columns, service, skipForbiddenViewCheck) => {
  // REVISIT: Find less param polluting way to skip forbidden view check for reads
  if (!skipForbiddenViewCheck) _checkForForbiddenViews(target)
  const targetStartsWithSrvName = service.namespace && target.name.startsWith(`${service.namespace}.`)
  const persistenceTable = _isPersistenceTable(target)
  columns = _queryColumns(
    target,
    columns,
    persistenceTable,
    !(service instanceof cds.DatabaseService) && !targetStartsWithSrvName
  )
  if (persistenceTable && service instanceof cds.DatabaseService) {
    return { target, transitionColumns: columns }
  }
  // stop projection resolving if it starts with the service name prefix
  if (!(service instanceof cds.DatabaseService) && targetStartsWithSrvName) {
    return { target, transitionColumns: columns }
  }
  // continue projection resolving if the target is a projection
  if (target.query && target.query._target) {
    const newTarget = target.query._target
    if (
      service instanceof cds.DatabaseService ||
      !(service.namespace && newTarget.name.startsWith(`${service.namespace}.`))
    ) {
      return _getTransitionData(newTarget, columns, service, skipForbiddenViewCheck)
    }
    return { target: newTarget, transitionColumns: columns }
  }
  return { target, transitionColumns: columns }
}

/**
 * If no entity definition is found, no transition is done.
 *
 * @param queryTarget
 * @param service
 * @param skipForbiddenViewCheck
 */
const getTransition = (queryTarget, service, skipForbiddenViewCheck) => {
  // Never resolve unknown targets (e.g. for drafts)
  if (!queryTarget) {
    return { target: queryTarget, queryTarget, mapping: new Map() }
  }

  const { target: _target, transitionColumns } = _getTransitionData(queryTarget, [], service, skipForbiddenViewCheck)
  const query = queryTarget.query
  const alias = query && query.SELECT && query.SELECT.from && query.SELECT.from.as
  const mappedColumns = transitionColumns.map(column => _mappedValue(column, alias))
  const mapping = new Map(mappedColumns)
  return { target: _target, queryTarget, mapping }
}

const _entityTransitionsForTarget = (from, model, service) => {
  let previousEntity

  if (typeof from === 'string') {
    return model.definitions[from] && [getTransition(model.definitions[from], service)]
  }

  return from.ref.map((f, i) => {
    const element = f.id || f

    if (i === 0) {
      const entity = model.definitions[element]
      if (entity) {
        previousEntity = entity
        return getTransition(entity, service)
      }
    }

    if (previousEntity) {
      const entity = previousEntity.elements[element] && previousEntity.elements[element]._target
      if (entity) {
        // > assoc
        previousEntity = entity
        return getTransition(entity, service)
      } else {
        // > struct
        previousEntity = previousEntity.elements[element]
        return {
          target: previousEntity,
          queryTarget: previousEntity,
          mapping: new Map()
        }
      }
    }
  })
}

const _newQuery = (query, event, model, service) => {
  const [_prop, _func] = {
    SELECT: ['from', _newSelect],
    INSERT: ['into', _newInsert],
    UPDATE: ['entity', _newUpdate],
    DELETE: ['from', _newDelete]
  }[event]
  const newQuery = Object.create(query)
  const transitions = _entityTransitionsForTarget(query[event][_prop], model, service)
  newQuery[event] = (transitions[0] && _func(newQuery, transitions, service)) || { ...query[event] }
  return newQuery
}

const resolveView = (query, model, service) => {
  // swap logger
  const _LOG = LOG
  LOG = cds.log(service.kind) // REVISIT: Avoid obtaining loggers per request!

  // If the query is a projection, one must follow it
  // to let the underlying service know its true entity.
  if (query.cmd) _event = query.cmd
  else if (query.SELECT) _event = 'SELECT'
  else if (query.INSERT) _event = 'INSERT'
  else if (query.UPDATE) _event = 'UPDATE'
  else if (query.DELETE) _event = 'DELETE'

  const newQuery = _newQuery(query, _event, model, service)

  // restore logger and clear _event
  LOG = _LOG
  _event = undefined

  return newQuery
}

/**
 * Restores the link of req.data and req.query in case req.query was overwritten.
 * Only applicable for UPDATEs and INSERTs.
 *
 * @param {*} req
 */
const restoreLink = req => {
  if (req.query.INSERT && req.query.INSERT.entries) {
    if (Array.isArray(req.query.INSERT.entries)) req.data = req.query.INSERT.entries[0]
    else req.data = req.query.INSERT.entries
  } else if (req.query.UPDATE && req.query.UPDATE.data) {
    req.data = req.query.UPDATE.data
  }
}

/**
 * Retrieves the actual query target by evaluating the created transitions.
 * @param {*} q - the resolved query
 * @returns {*} csn entity or undefined
 */
const findQueryTarget = q => {
  return q.SELECT
    ? q.SELECT._transitions[q.SELECT._transitions.length - 1].target
    : q.INSERT
    ? q.INSERT._transitions[q.INSERT._transitions.length - 1].target
    : q.UPDATE
    ? q.UPDATE._transitions[q.UPDATE._transitions.length - 1].target
    : q.DELETE
    ? q.DELETE._transitions[q.DELETE._transitions.length - 1].target
    : undefined
}

module.exports = {
  findQueryTarget,
  getDBTable,
  resolveView,
  getTransition,
  restoreLink,
  revertData
}
