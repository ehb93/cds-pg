const cds = require('../../cds')
const { all, resolve } = require('../../common/utils/thenable')
const { getDependents } = require('../../common/utils/csn')

// REVISIT: replace with cds.Request
const getEntry = require('../../common/error/entry')
const crypto = require('crypto')

const ISO_DATE_PART1 =
  '[1-9]\\d{3}-(?:(?:0[1-9]|1[0-2])-(?:0[1-9]|1\\d|2[0-8])|(?:0[13-9]|1[0-2])-(?:29|30)|(?:0[13578]|1[02])-31)'
const ISO_DATE_PART2 = '(?:[1-9]\\d(?:0[48]|[2468][048]|[13579][26])|(?:[2468][048]|[13579][26])00)-02-29'
const ISO_DATE = `(?:${ISO_DATE_PART1}|${ISO_DATE_PART2})`
const ISO_TIME_NO_MILLIS = '(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d'
const ISO_TIME = `${ISO_TIME_NO_MILLIS}(?:\\.\\d{1,9})?`
const ISO_DATE_TIME = `${ISO_DATE}T${ISO_TIME_NO_MILLIS}(?:Z|[+-][01]\\d:?[0-5]\\d)`
const ISO_TIMESTAMP = `${ISO_DATE}T${ISO_TIME}(?:Z|[+-][01]\\d:?[0-5]\\d)`

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE_REGEX = new RegExp(`^${ISO_DATE}$`, 'i')
const ISO_TIME_REGEX = new RegExp(`^${ISO_TIME_NO_MILLIS}$`, 'i')
const ISO_DATE_TIME_REGEX = new RegExp(`^${ISO_DATE_TIME}$`, 'i')
const ISO_TIMESTAMP_REGEX = new RegExp(`^${ISO_TIMESTAMP}$`, 'i')

const ASSERT_VALID_ELEMENT = 'ASSERT_VALID_ELEMENT'
const ASSERT_RANGE = 'ASSERT_RANGE'
const ASSERT_FORMAT = 'ASSERT_FORMAT'
const ASSERT_DATA_TYPE = 'ASSERT_DATA_TYPE'
const ASSERT_ENUM = 'ASSERT_ENUM'
const ASSERT_NOT_NULL = 'ASSERT_NOT_NULL'
const ASSERT_REFERENCE_INTEGRITY = 'ASSERT_REFERENCE_INTEGRITY'
const ASSERT_DEEP_ASSOCIATION = 'ASSERT_DEEP_ASSOCIATION'

const ASSERT_INTEGRITY_ANNOTATION = '@assert.integrity'

const _enumValues = element => {
  return Object.keys(element).map(enumKey => {
    const enum_ = element[enumKey]
    const enumValue = enum_ && enum_.val
    if (enumValue !== undefined) {
      if (enumValue['=']) return enumValue['=']
      if (enum_ && enum_.literal && enum_.literal === 'number') return Number(enumValue)
      return enumValue
    }
    return enumKey
  })
}

// REVISIT: this needs a cleanup!
const assertError = (code, element, value, key, pathSegments = []) => {
  let args
  if (typeof code === 'object') {
    args = code.args
    code = code.code
  }
  const { name, type, precision, scale } = element
  const path = pathSegments.join('/') || name || key

  const e = new Error()
  const error = Object.assign(e, getEntry({ code, message: code, target: path, args: args || [name || key] }))
  Object.assign(error, {
    entity: element.parent && element.parent.name,
    element: name, // > REVISIT: when is error.element needed?
    type: element.items ? element.items.type : type,
    value
  })

  if (element.enum) error.enum = _enumValues(element)

  if (precision) error.precision = precision
  if (scale) error.scale = scale

  if (element.target) {
    // REVISIT: when does this case apply?
    error.target = element.target
  }

  return error
}

const _checkString = value => {
  return typeof value === 'string'
}

const _checkNumber = value => {
  return typeof value === 'number'
}

const _checkDecimal = (value, element) => {
  const [left, right] = String(value).split('.')
  return (
    _checkNumber(value) &&
    (!element.precision || left.length <= element.precision - (element.scale || 0)) &&
    (!element.scale || ((right || '').length <= element.scale && parseFloat(right) !== 0))
  )
}

const _checkInteger = value => {
  return _checkNumber(value) && parseInt(value, 10) === value
}

const _checkBoolean = value => {
  return typeof value === 'boolean'
}

const _checkBuffer = value => {
  return Buffer.isBuffer(value)
}

const _checkUUID = value => {
  return _checkString(value) && UUID_REGEX.test(value)
}

const _checkISODate = value => {
  return (_checkString(value) && ISO_DATE_REGEX.test(value)) || value instanceof Date
}

const _checkISOTime = value => {
  return _checkString(value) && ISO_TIME_REGEX.test(value)
}

const _checkISODateTime = value => {
  return (_checkString(value) && ISO_DATE_TIME_REGEX.test(value)) || value instanceof Date
}

const _checkISOTimestamp = value => {
  return (_checkString(value) && ISO_TIMESTAMP_REGEX.test(value)) || value instanceof Date
}

const _checkInRange = (val, range) => {
  return _checkISODate(val)
    ? (new Date(val) - new Date(range[0])) * (new Date(val) - new Date(range[1])) <= 0
    : (val - range[0]) * (val - range[1]) <= 0
}

const _checkRegExpFormat = (val, format) => {
  // process.env.CDS_ASSERT_FORMAT_FLAGS not official!
  return _checkString(val) && val.match(new RegExp(format, process.env.CDS_ASSERT_FORMAT_FLAGS || 'u'))
}

const CDS_TYPE_CHECKS = {
  'cds.UUID': _checkUUID,
  'cds.Boolean': _checkBoolean,
  'cds.Integer': _checkInteger,
  'cds.Integer64': _checkInteger,
  'cds.Decimal': _checkDecimal,
  'cds.DecimalFloat': _checkNumber,
  'cds.Double': _checkNumber,
  'cds.Date': _checkISODate,
  'cds.Time': _checkISOTime,
  'cds.DateTime': _checkISODateTime,
  'cds.Timestamp': _checkISOTimestamp,
  'cds.String': _checkString,
  'cds.Binary': _checkBuffer,
  'cds.LargeString': _checkString,
  'cds.LargeBinary': _checkBuffer
}

// Limitation: depth 1
const checkComplexType = ([key, value], elements, ignoreNonModelledData) => {
  let found = false

  for (const objKey in elements) {
    if (objKey.startsWith(`${key}_`)) {
      const element = elements[objKey]
      const check = CDS_TYPE_CHECKS[element.type]
      found = true

      const nestedData = value[objKey.substring(key.length + 1)]
      // check existence of nestedData to not stumble across not-provided, yet-modelled type parts with depth > 1
      if (nestedData && !check(nestedData)) {
        return false
      }
    }
  }

  return found || ignoreNonModelledData
}

const _checkStaticElementByKey = (definition, key, value, result, ignoreNonModelledData) => {
  const elementsOrParameters = definition.elements || definition.params
  const elementOrParameter = elementsOrParameters[key]

  if (!elementOrParameter) {
    if (!checkComplexType([key, value], elementsOrParameters, ignoreNonModelledData)) {
      result.push(assertError(ASSERT_VALID_ELEMENT, { name: key }))
    }

    return result
  }

  let check
  if (elementOrParameter.type === 'cds.UUID' && definition.name === 'ProvisioningService.tenant') {
    // > old SCP accounts don't have UUID ids
    check = CDS_TYPE_CHECKS['cds.String']
  } else {
    check = CDS_TYPE_CHECKS[elementOrParameter.type]
  }

  if (check && !check(value, elementOrParameter)) {
    // code, entity, element, value
    const args = [typeof value === 'string' ? '"' + value + '"' : value, elementOrParameter.type]
    result.push(assertError({ code: ASSERT_DATA_TYPE, args }, elementOrParameter, value, key))
  }

  return result
}

const _isNotFilled = value => {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

const _checkMandatoryElement = (element, value, errors, key, pathSegments) => {
  if (element._isMandatory && !element.default && _isNotFilled(value)) {
    errors.push(assertError(ASSERT_NOT_NULL, element, value, key, pathSegments))
  }
}

const _getEnumElement = element => {
  return (element['@assert.range'] && element.enum) || element['@assert.enum'] ? element.enum : undefined
}

const _checkEnumElement = (element, value, errors, key, pathSegments) => {
  const enumElements = _getEnumElement(element)
  const enumValues = enumElements && _enumValues(enumElements)
  if (enumElements && !enumValues.includes(value)) {
    const args =
      typeof value === 'string'
        ? ['"' + value + '"', enumValues.map(ele => '"' + ele + '"').join(', ')]
        : [value, enumValues.join(', ')]
    errors.push(assertError({ code: ASSERT_ENUM, args }, element, value, key, pathSegments))
  }
}

const _checkRangeElement = (element, value, errors, key, pathSegments) => {
  const rangeElements = element['@assert.range'] && !_getEnumElement(element) ? element['@assert.range'] : undefined
  if (rangeElements && !_checkInRange(value, rangeElements)) {
    const args = [value, ...element['@assert.range']]
    errors.push(assertError({ code: ASSERT_RANGE, args }, element, value, key, pathSegments))
  }
}

const _checkFormatElement = (element, value, errors, key, pathSegments) => {
  const formatElements = element['@assert.format']
  if (formatElements && !_checkRegExpFormat(value, formatElements)) {
    errors.push(assertError({ code: ASSERT_FORMAT, args: [value, formatElements] }, element, value, key, pathSegments))
  }
}

// check for forbidden deep operations for association
const checkIfAssocDeep = (element, value, req) => {
  if (!value) return
  if (element.on) {
    req.error(
      assertError(
        element.is2one
          ? { code: ASSERT_DEEP_ASSOCIATION, args: ['unmanaged to-one', element.name] }
          : { code: ASSERT_DEEP_ASSOCIATION, args: ['to-many', element.name] },
        element,
        value
      )
    )
  } else if (element.is2one) {
    // managed to one
    Object.keys(value).forEach(prop => {
      if (typeof value[prop] !== 'object') {
        const key = element.keys.find(el => el.ref[0] === prop)
        if (!key) {
          const err = assertError(
            { code: ASSERT_DEEP_ASSOCIATION, args: ['managed to-one', element.name] },
            element,
            value
          )
          err.target += `.${prop}`
          req.error(err)
        }
      }
    })
  }
}

/**
 * @param {import('../../types/api').InputConstraints} constraints
 */
const checkInputConstraints = ({ element, value, errors, key, pathSegments, event }) => {
  if (!element) return errors

  _checkMandatoryElement(element, value, errors, key, pathSegments)

  if (value == null) return errors

  _checkEnumElement(element, value, errors, key, pathSegments)

  _checkRangeElement(element, value, errors, key, pathSegments)

  _checkFormatElement(element, value, errors, key, pathSegments)

  return errors
}

const checkStatic = (definition, data, ignoreNonModelledData = false) => {
  if (!Array.isArray(data)) data = [data]

  return data.reduce((result, row) => {
    return Object.entries(row)
      .filter(([key, value]) => value !== null && value !== undefined)
      .reduce((result, [key, value]) => {
        return _checkStaticElementByKey(definition, key, value, result, ignoreNonModelledData)
      }, result)
  }, [])
}

const _checkExistsWhere = (entity, whereList, run) => {
  const checks = whereList.map(where => {
    if (where.length === 0) {
      return true
    }

    const cqn = {
      SELECT: {
        columns: [{ val: 1, as: '_exists' }],
        from: { ref: [entity.name || entity] },
        where: where
      }
    }

    if (cds.context) {
      const hash = crypto.createHash('sha1').update(JSON.stringify(cqn)).digest('base64') // fastest hash
      if (!cds.context.__alreadyExecutedIntegrityChecks) cds.context.__alreadyExecutedIntegrityChecks = new Map()
      if (cds.context.__alreadyExecutedIntegrityChecks.has(hash)) {
        return cds.context.__alreadyExecutedIntegrityChecks.get(hash)
      } else {
        const promise = run(cqn).then(exists => {
          return exists.length !== 0
        })
        // we store the promise object in the map, it won't get executed twice when calling await Promise.all([promise, promise])
        cds.context.__alreadyExecutedIntegrityChecks.set(hash, promise)
        return promise
      }
    }
    return run(cqn).then(exists => {
      return exists.length !== 0
    })
  })

  return all(checks)
}

const _checkExists = (entity, data, req, run) => {
  if (!Array.isArray(data)) {
    return _checkExists(entity, [data], req, run).then(result => {
      return result[0]
    })
  }

  const where = data.map(row => {
    return Object.keys(entity.keys).reduce((where, name) => {
      if (row[name] !== undefined && row[name] !== null) {
        if (where.length > 0) {
          where.push('and')
        }
        where.push({ ref: [name] }, '=', { val: row[name] })
      }

      return where
    }, [])
  })
  return _checkExistsWhere(entity, where, run)
}

const _getFullForeignKeyName = (elementName, foreignKeyName) => `${elementName}_${foreignKeyName}`

const _foreignKeyReducer = (key, foreignKeyName, row, element, ref) => {
  const fullForeignKeyName = _getFullForeignKeyName(element.name, foreignKeyName)

  if (ref.length > 1) {
    // ref includes assoc name, so we need to replace it by foreign key name
    const refWithFlatForeignKey = [...ref.slice(0, ref.length - 1), fullForeignKeyName]
    key[foreignKeyName] = _getDataFromRef(row, refWithFlatForeignKey)
  } else {
    key[foreignKeyName] = Object.prototype.hasOwnProperty.call(row, fullForeignKeyName) ? row[fullForeignKeyName] : null
  }

  return key
}

const _buildForeignKey = (element, row, ref) => {
  let foreignKey

  if (element.keys) {
    foreignKey = element.keys
      .map(obj => obj.ref[obj.ref.length - 1])
      .reduce((key, foreignKeyName) => {
        return _foreignKeyReducer(key, foreignKeyName, row, element, ref)
      }, {})
  }

  return foreignKey
}

const _getDataFromRef = (row, ref) => {
  if (row === undefined) return

  if (ref.length > 1) {
    return _getDataFromRef(row[ref[0]], ref.slice(1))
  }

  return row[ref[0]]
}

const _getElement = (entity, ref) => {
  if (ref.length > 1) {
    // structured
    return _getElement(entity.elements[ref[0]], ref.slice(1))
  }

  return entity.elements[ref[0]]
}

const _checkCreateUpdate = (result, ref, rootEntity, checks, data, req, run) => {
  const resolvedElement = _getElement(rootEntity, ref)

  return data.reduce((result, row) => {
    if (resolvedElement.on) return result

    const foreignKey = _buildForeignKey(resolvedElement, row, ref)
    if (foreignKey === undefined) return result

    checks.push(
      _checkExists(resolvedElement._target, foreignKey, req, run).then(exists => {
        if (!exists) {
          result.push(assertError(ASSERT_REFERENCE_INTEGRITY, resolvedElement, foreignKey))
        }
      })
    )

    return result
  }, result)
}

const _buildWhereDelete = (result, key, element, data) => {
  return data
    .map(d => {
      return Object.keys(d).reduce((result, name) => {
        if (key.ref[0] === name) {
          if (result.length > 0) {
            result.push('and')
          }
          result.push({ ref: [_getFullForeignKeyName(element.name, key.ref[0])] }, '=', { val: d[name] })
        }

        return result
      }, result)
    })
    .reduce((accumulatedWhere, currentWhere, i) => {
      if (i > 0) accumulatedWhere.push('or')
      accumulatedWhere.push(...currentWhere)
      return accumulatedWhere
    }, [])
}

const _checkDelete = (result, key, entity, checks, req, csn, run, data) => {
  const elements = csn.definitions[key].elements
  const source = csn.definitions[key].name

  const dependents = getDependents(req.target, csn) || []
  const sourceDependent = dependents.find(dep => dep.parent.name === source)
  if (!sourceDependent) return result

  return Object.keys(elements).reduce((result, assoc) => {
    if (!elements[assoc].target || !elements[assoc].keys) return result

    const targetDependent = dependents.find(dep => dep.target.name === elements[assoc].target)
    if (!targetDependent) return result

    const where = elements[assoc].keys.reduce((buildWhere, key) => {
      return _buildWhereDelete(buildWhere, key, elements[assoc], data)
    }, [])
    checks.push(
      _checkExistsWhere(source, [where], run).then(exists => {
        if (exists.includes(true)) {
          result.push(assertError(ASSERT_REFERENCE_INTEGRITY, elements[assoc], req.data))
        }
      })
    )
    return result
  }, result)
}

function _filterStructured(element, structuredAssocs, prefix) {
  const elements = element.elements
  for (const subElement in elements) {
    if (_filterAssocs(elements[subElement], structuredAssocs, prefix)) {
      structuredAssocs.push([...prefix, elements[subElement].name])
    }
  }
}

const _filterAssocs = (element, structuredAssocs, prefix = []) => {
  if (element.elements) {
    _filterStructured(element, structuredAssocs, [...prefix, element.name])
  }

  return (
    element._isAssociationStrict &&
    !element.virtual &&
    !element.abstract &&
    element[ASSERT_INTEGRITY_ANNOTATION] !== false &&
    !element['@odata.contained'] &&
    !element._target._hasPersistenceSkip
  )
}

// can be removed ones we switch to db integrity check
const checkReferenceIntegrity = (entity, data, req, csn, run) => {
  const service = entity._service
  if (entity[ASSERT_INTEGRITY_ANNOTATION] === false || (service && service[ASSERT_INTEGRITY_ANNOTATION] === false)) {
    return
  }

  if (!Array.isArray(data)) data = [data]

  const checks = []
  let result
  if (req.event === 'CREATE' || req.event === 'UPDATE') {
    const structuredAssocRefs = []
    const associationRefs = Object.keys(entity.elements)
      .filter(elementName => _filterAssocs(entity.elements[elementName], structuredAssocRefs))
      .map(name => [name])
    result = [...associationRefs, ...structuredAssocRefs].reduce((createUpdateResult, ref) => {
      return _checkCreateUpdate(createUpdateResult, ref, entity, checks, data, req, run)
    }, [])
  }
  if (req.event === 'DELETE') {
    // we are only interested in table-level references not all derived ones on view levels
    // TODO: why?
    while (entity.query && entity.query._target) {
      entity = csn.definitions[entity.query._target.name]
    }

    result = Object.keys(csn.definitions)
      .filter(
        key =>
          !csn.definitions[key]['@cds.persistence.skip'] &&
          csn.definitions[key].elements !== undefined &&
          // skip check for events, aspects and localized tables
          csn.definitions[key].kind !== 'event' &&
          csn.definitions[key].kind !== 'aspect' &&
          csn.definitions[key].kind !== 'type' &&
          !csn.definitions[key].name.startsWith('localized.')
      )
      .reduce((deleteResult, key) => {
        return _checkDelete(deleteResult, key, entity, checks, req, csn, run, data)
      }, [])
  }

  if (checks.length) {
    return Promise.all(checks).then(() => {
      return result
    })
  }

  return resolve(result || [])
}

const checkKeys = (entity, data) => {
  if (!Array.isArray(data)) {
    return checkKeys(entity, [data])
  }

  const entityKeys = Object.keys(entity.keys)
  return data.reduce((result, row) => {
    for (const key of entityKeys) {
      if (row[key] === undefined && entity.elements[key].type !== 'cds.Association')
        result.push(assertError(ASSERT_NOT_NULL, entity.elements[key]))
    }
    return result
  }, [])
}

module.exports = {
  CDS_TYPE_CHECKS,
  checkComplexType,
  checkStatic,
  checkInputConstraints,
  checkKeys,
  checkReferenceIntegrity,
  assertError,
  checkIfAssocDeep
}
