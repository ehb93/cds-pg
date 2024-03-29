const { ensureNoDraftsSuffix, ensureDraftsSuffix } = require('../utils/draft')

const addDraftSuffix = (draft, name) => {
  return draft ? ensureDraftsSuffix(name) : ensureNoDraftsSuffix(name)
}

const whereKey = key => {
  const where = []
  Object.keys(key).forEach(keyPart => {
    if (where.length > 0) where.push('and')
    where.push({ ref: [keyPart] }, '=', { val: key[keyPart] })
  })
  return where
}

const keyElements = entity => {
  // REVISIT: this is expensive
  return Object.keys(entity.keys)
    .map(key => entity.keys[key])
    .filter(e => !e.virtual && !e.isAssociation)
}

const key = (entity, data) => {
  return keyElements(entity).reduce((result, element) => {
    if (element.name === 'IsActiveEntity' && !Object.prototype.hasOwnProperty.call(data, element.name)) return result
    result[element.name] = data[element.name]
    return result
  }, {})
}

const val = element => (element && element.val) || element

const array = x => (Array.isArray(x) ? x : [x])

const isCompOrAssoc = (entity, k, onlyToOne) => {
  return (
    entity.elements &&
    entity.elements[k] &&
    entity.elements[k].isAssociation &&
    ((onlyToOne && entity.elements[k].is2one) || !onlyToOne)
  )
}

const cleanDeepData = (entity, data, onlyToOne = false) => {
  if (!Array.isArray(data)) {
    return cleanDeepData(entity, [data], onlyToOne)[0]
  }
  return data.map(entry => {
    return Object.keys(entry || {}).reduce((result, k) => {
      if (!isCompOrAssoc(entity, k, onlyToOne)) {
        result[k] = entry[k]
      }
      return result
    }, {})
  })
}

const _getBacklinkNameFromOnCond = element => {
  if (element.on && element.on.length === 3 && element.on[0].ref && element.on[2].ref) {
    if (element.on[0].ref[0] === '$self') {
      return element.on[2].ref[element.on[2].ref.length - 1]
    } else if (element.on[2].ref[0] === '$self') {
      return element.on[0].ref[element.on[0].ref.length - 1]
    }
  }
}

const isBacklink = (element, parent, checkContained, backLinkName) => {
  if (!element._isAssociationStrict) return false
  if (!parent || !(element.keys || element.on)) return false
  if (element.target !== parent.name) return false

  const _isBackLink = parentElement =>
    (!checkContained || parentElement._isContained) && _getBacklinkNameFromOnCond(parentElement) === element.name

  if (backLinkName) {
    const parentElement = parent.elements[backLinkName]
    return parentElement.isAssociation && _isBackLink(parentElement)
  }
  for (const parentElementName in parent.elements) {
    const parentElement = parent.elements[parentElementName]
    if (!parentElement.isAssociation) continue
    if (_isBackLink(parentElement)) return true
  }

  return false
}

module.exports = {
  addDraftSuffix,
  whereKey,
  keyElements,
  key,
  val,
  array,
  isCompOrAssoc,
  cleanDeepData,
  isBacklink
}
