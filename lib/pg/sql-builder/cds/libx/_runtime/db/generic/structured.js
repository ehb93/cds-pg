const { getEntityFromCQN } = require('../../common/utils/entityFromCqn')

const _getStructuredTypes = entity => {
  return Object.values(entity.elements || {}).filter(e => e.elements || e.isAssociation)
}

const _handleNavigation = (structuredType, data, prefixes) => {
  if (!data) return
  const nestedStructuredTypes = _getStructuredTypes(structuredType._target)

  for (const nestedStructuredType of nestedStructuredTypes) {
    if (structuredType.is2many) {
      for (const entry of data) {
        _flatToStructured(nestedStructuredType, entry, [...prefixes])
      }
    } else {
      _flatToStructured(nestedStructuredType, data, [...prefixes])
    }
  }
}

const _allValuesAreNull = data => {
  const values = Object.values(data)
  return values.length && !Object.values(data).some(d => d !== null)
}

// REVISIT: very limited, see xtests in structured-x4
const _flatToStructured = (structuredType, data, prefixes = [], subData = data) => {
  if (structuredType.isAssociation) {
    // expanded navigation
    _handleNavigation(structuredType, data[structuredType.name], prefixes)
    return
  }

  if (structuredType.elements) {
    subData[structuredType.name] = subData[structuredType.name] || {}
    prefixes.push(structuredType.name)
  }

  for (const element in structuredType.elements) {
    if (structuredType.elements[element].elements) {
      _flatToStructured(structuredType.elements[element], data, [...prefixes], subData[structuredType.name])
      continue
    }

    // expand of navigation in a structured combined with requesting structured elements
    if (subData[structuredType.name] !== undefined && structuredType.elements[element].isAssociation) {
      _handleNavigation(structuredType.elements[element], subData[structuredType.name][element], [])
      continue
    }

    const propertyValue = data[`${prefixes.join('_')}_${element}`]
    if (propertyValue !== undefined) {
      subData[structuredType.name][element] = data[`${prefixes.join('_')}_${element}`] // data[property]
      delete data[`${prefixes.join('_')}_${element}`]
    }
  }

  if (_allValuesAreNull(subData[structuredType.name])) {
    subData[structuredType.name] = null
  }

  if (subData[structuredType.name] && Object.keys(subData[structuredType.name]).length === 0) {
    delete subData[structuredType.name]
  }
}

/**
 * Formats flat data to structured data
 *
 * @param result - the result of the event
 * @param req - the context object
 * @returns {Promise}
 */
module.exports = function (result, req) {
  if (!this.model || result == null || result.length === 0) return

  if (!Array.isArray(result)) result = [result]

  // REVISIT: No entity for sets/unions outside of common draft scenarios
  const entity = getEntityFromCQN(req, this)
  if (!entity) return

  const structuredTypes = _getStructuredTypes(entity)
  for (let i = 0; i < result.length; i++) {
    const d = result[i]

    for (const structuredType of structuredTypes) {
      _flatToStructured(structuredType, d)
    }
  }
}
