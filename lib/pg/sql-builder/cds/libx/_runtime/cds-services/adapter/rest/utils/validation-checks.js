const { processDeep } = require('../../../util/dataProcessUtils')
const { checkKeys, checkStatic, CDS_TYPE_CHECKS } = require('../../../util/assert')
const getError = require('../../../../common/error')
const { MULTIPLE_ERRORS } = require('../../../../common/error/constants')
const cds = require('../../../../cds')

const validationChecks = (event, data, target) => {
  const checkResult = []

  let validateFn

  if (event === 'UPDATE' && Array.isArray(data)) {
    validateFn = (entry, entity) => {
      checkResult.push(...checkKeys(entity, entry))
      checkResult.push(...checkStatic(entity, entry, true))
    }
  } else {
    validateFn = (entry, entity) => {
      checkResult.push(...checkStatic(entity, entry, true))
    }
  }

  // REVISIT: adopt template mechanism?
  processDeep(validateFn, data, target, false, true)

  if (checkResult.length === 0) {
    // > all good
    return
  }

  if (checkResult.length === 1) {
    return checkResult[0]
  } else {
    return Object.assign(new Error(MULTIPLE_ERRORS), { details: checkResult })
  }
}

// REVISIT: use i18n
const _enrichErrorDetails = (isPrimitive, error) => {
  const element = error.target ? ` '${error.target}' ` : ' '
  const typeDetails = isPrimitive ? '.' : ` according to type definition '${error.type}'.`
  const value = typeof error.value === 'string' ? `'${error.value}'` : error.value
  if (element && element.match(/\w/)) return `Value ${value} of element${element}is invalid${typeDetails}`
  return `Value ${value} is invalid${typeDetails}`
}

// REVISIT: use i18n
const _getTypeError = (operation, type, errorDetails) => {
  const typeErrors = errorDetails.map(error => _enrichErrorDetails(cds.builtin.types[type], error))
  const msg = `Failed to validate return value ${type ? `of type '${type}' ` : ''}for custom ${operation.kind} '${
    operation.name
  }': ${typeErrors.join(' ')}`
  return getError(msg)
}

const _buildTypeErrorObject = (type, value) => {
  return { type, value }
}

const _checkArray = (type, check, data) => {
  return data.filter(value => !check(value)).map(value => _buildTypeErrorObject(type, value))
}

const _checkSingle = (type, check, data) => {
  if (!check(data)) {
    return [_buildTypeErrorObject(type, data)]
  }
  return []
}

/**
 * Validate the return type values of custom operations (actions and functions) for primitive or complex values as
 * single values or arrays.
 *
 * @param {Operation} operation
 * @param {object} data
 * @throws Will throw an error with error code 500 if the validation fails. Contains a detailed error message of the
 * type and name of the custom operation, the invalid values, their names and their expected types.
 * @returns {boolean} Returns true if return type validation has passed.
 */
const validateReturnType = (operation, data) => {
  // array of or single return type
  // in case of modeled return type: { type: 'bookModel.Books', _type: csnDefinition }
  // in case of inline return type: { elements: ... } and no explicit name of return type
  const returnType = operation.returns.items ? operation.returns.items : operation.returns

  if (typeof data === 'undefined') {
    const { kind, name } = operation
    // REVISIT: use i18n
    throw getError(`'undefined' is invalid according to return type definition of custom ${kind} '${name}'.`)
  }

  let checkResult

  // Return type contains primitives
  if (cds.builtin.types[returnType.type]) {
    const check = CDS_TYPE_CHECKS[returnType.type]

    checkResult = operation.returns.items
      ? _checkArray(returnType.type, check, data)
      : _checkSingle(returnType.type, check, data)
  } else {
    // Only check complex objects, ignore non-modelled data
    data = (Array.isArray(data) ? data : [data]).filter(entry => typeof entry === 'object' && !Array.isArray(entry))

    // Determine entity from bound or unbound action/function
    const returnTypeCsnDefinition = returnType._type || returnType

    // REVISIT: remove exception with cds^6
    // mtx returns object instead of string (as in modell) -> skip validation
    if (returnTypeCsnDefinition.type !== 'cds.String') {
      checkResult = checkStatic(returnTypeCsnDefinition, data, true)
    }
  }

  if (checkResult && checkResult.length !== 0) {
    throw _getTypeError(operation, returnType.type, checkResult)
  }

  return true
}

module.exports = {
  validationChecks,
  validateReturnType
}
