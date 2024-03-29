const { where2obj } = require('./cqn')

function _getOnCondElements(onCond, onCondElements = []) {
  const andIndex = onCond.indexOf('and')
  const entityKey = onCond[2].ref && onCond[2].ref.join('.')
  const entityVal = onCond[2].val
  const targetKey = onCond[0].ref && onCond[0].ref.join('.')
  const targetVal = onCond[0].val
  onCondElements.push({ entityKey, targetKey, entityVal, targetVal })

  if (andIndex !== -1) {
    _getOnCondElements(onCond.slice(andIndex + 1), onCondElements)
  }
  return onCondElements
}

function _modifyWhereWithNavigations(where, newWhere, targetKeyElement, keyName) {
  if (where) {
    // copy where else query will be modified
    const whereCopy = JSON.parse(JSON.stringify(where))
    if (newWhere.length > 0) newWhere.push('and')
    newWhere.push(...whereCopy)
  }

  newWhere.forEach(element => {
    if (element.ref && targetKeyElement._target.keys[element.ref[0]]) {
      element.ref = [keyName + '_' + element.ref[0]]
    }
  })
}

function _buildWhereForNavigations(ref, newWhere, model, target) {
  const currentRef = ref[0]
  const nextRef = ref[1]

  if (nextRef) {
    const csnEntity = target || model.definitions[currentRef.id || currentRef]
    const navigationElement = csnEntity && csnEntity.elements[nextRef.id || nextRef]

    if (!navigationElement || !navigationElement.on) return

    const nextKeys = _getOnCondElements(navigationElement.on)
    for (const key of nextKeys) {
      const keyName = key.targetKey.replace(navigationElement.name + '.', '')
      const targetKeyElement = navigationElement._target.elements[keyName]
      if (targetKeyElement && targetKeyElement.isAssociation) {
        _modifyWhereWithNavigations(currentRef.where, newWhere, targetKeyElement, keyName)
      }
    }
    _buildWhereForNavigations(ref.slice(1), newWhere, model, navigationElement._target)
  }
}

function _getWhereFromInsert(query, target, model) {
  const where = []
  if (query.INSERT.into.ref && query.INSERT.into.ref.length > 1) {
    _buildWhereForNavigations(query.INSERT.into.ref, where, model)
  }
  return where
}

function _getWhereFromUpdate(query, target, model) {
  if (query.UPDATE.entity.ref && query.UPDATE.entity.ref.length > 1) {
    const where = []
    _buildWhereForNavigations(query.UPDATE.entity.ref, where, model)

    return where
  }

  return query.UPDATE.where
}

// params: data, req, service/tx
function enrichDataWithKeysFromWhere(data, { query, target }, { model }) {
  if (query.INSERT) {
    const where = _getWhereFromInsert(query, target, model)
    if (!where || !where.length) return
    if (!Array.isArray(data)) data = [data]
    for (const d of data) Object.assign(d, where2obj(where, target))
  } else if (query.UPDATE) {
    const where = _getWhereFromUpdate(query, target, model)
    if (!where || !where.length) return
    // REVISIT: We should not expect data to be present always!
    if (!data) data = query.UPDATE.data = {}
    Object.assign(data, where2obj(where, target))
  }
}

module.exports = {
  where2obj,
  enrichDataWithKeysFromWhere
}
