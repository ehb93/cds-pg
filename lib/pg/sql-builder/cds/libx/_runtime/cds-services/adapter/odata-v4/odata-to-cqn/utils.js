const { findCsnTargetFor } = require('../../../../common/utils/csn')

const CDL_KEYWORDS = new Set(require('@sap/cds-compiler/lib/base/keywords').cdl)

// TODO: Which EDM Types are missing?
const notToBeConvertedForCompiler = new Set([
  'Edm.Boolean',
  'Edm.Int16',
  'Edm.Int32',
  'Edm.Int64',
  'Edm.Decimal',
  'Edm.Double'
])

const addLimit = (item, rows, offset) => {
  // ignore 0 offset -> truthy check
  if (rows != null || offset) {
    if (!item.limit) {
      item.limit = {}
    }
    if (rows != null) {
      item.limit.rows = { val: rows }
    }
    if (offset) {
      item.limit.offset = { val: offset }
    }
  }
}

const convertKeyPredicatesToStringExpr = keyPredicates => {
  if (keyPredicates.length) {
    return `[${keyPredicates
      .map(kp => {
        const keyName = kp.getEdmRef().getName().replace(/\//g, '.')
        let keyValue = kp.getText().replace(/'/g, "''")
        if (!notToBeConvertedForCompiler.has(kp.getEdmRef().getProperty().getType().toString())) {
          keyValue = `'${keyValue}'`
        }
        return `${CDL_KEYWORDS.has(keyName) ? `![${keyName}]` : keyName}=${keyValue}`
      })
      .join(' and ')}]`
  }

  return ''
}

const convertUrlPathToCqn = (segments, service) => {
  return segments
    .filter(
      segment =>
        segment.getKind() !== 'COUNT' && segment.getKind() !== 'PRIMITIVE.PROPERTY' && segment.getKind() !== 'VALUE'
    )
    .reduce((expr, segment, i) => {
      if (segment.getKind() === 'ENTITY' || segment.getKind() === 'ENTITY.COLLECTION') {
        const entity = segment.getEntitySet().getEntityType().getFullQualifiedName()
        const keys = convertKeyPredicatesToStringExpr(segment.getKeyPredicates())

        return `${findCsnTargetFor(entity.name, service.model, service.name).name}${keys}`
      }

      if (segment.getKind() === 'SINGLETON') {
        const singleton = segment.getSingleton().getEntityType().getFullQualifiedName()

        return `${findCsnTargetFor(singleton.name, service.model, service.name).name}`
      }

      if (segment.getKind() === 'COMPLEX.PROPERTY') {
        const complex = segment.getProperty().getName()
        return `${expr}${i === 1 ? ':' : '.'}${complex}`
      }

      const navigation = segment.getNavigationProperty().getName()
      const keys = convertKeyPredicatesToStringExpr(segment.getKeyPredicates())
      return `${expr}${i === 1 ? ':' : '.'}${navigation}${keys}`
    }, '')
}

const isSameArray = (arr1, arr2) => {
  return arr1.length === arr2.length && arr1.every((element, index) => element === arr2[index])
}

const _getStructKeys = (key, prefix, joinStructured) => {
  const structKeys = []
  for (const keyName in key.elements) {
    const keyElement = key.elements[keyName]
    if (keyElement._isStructured) {
      structKeys.push(..._getStructKeys(keyElement, [...prefix, keyName], joinStructured))
      continue
    }
    if (keyElement.isAssociation) continue
    const newKey = joinStructured ? [...prefix, keyName].join('_') : [...prefix, keyName]
    structKeys.push(newKey)
  }
  return structKeys
}

const getAllKeys = (entity, joinStructured = true) => {
  const allKeys = []
  if (entity && entity.elements) {
    // in elements because of aspects
    for (const keyName in entity.elements) {
      const key = entity.elements[keyName]
      if (!key.key || key.isAssociation || key.isComposition) continue
      if (key._isStructured) allKeys.push(..._getStructKeys(key, [keyName], joinStructured))
      else allKeys.push(keyName)
    }
  }
  return allKeys
}

module.exports = {
  addLimit,
  convertUrlPathToCqn,
  isSameArray,
  getAllKeys
}
