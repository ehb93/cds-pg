const getError = require('../../../../common/error')
const { getConvertedValue } = require('./key-value-utils')
const { checkStatic } = require('../../../util/assert')
const { findCsnTargetFor } = require('../../../../common/utils/csn')

const _normalizeAndSplitUrl = req => {
  // Normalize /path////to/someWhere into path/to/someWhere and split by /
  const parts = `/${req.path}/`
    .replace(/[/]+/g, '/')
    .replace(/\/(.*)\//, '$1')
    .split('/')

  // TODO: replace with generic solution, currently we do not support longer urls
  if (parts.length > 3) {
    throw getError(501, 'CRUD_VIA_NAVIGATION_NOT_SUPPORTED')
  }

  return parts
}

const _enrichCustomOperation = (csnElement, customOperationName) => {
  return Object.assign({ name: customOperationName }, csnElement)
}

const _initializeParsed = event => {
  return { event, segments: [] }
}

const _parseEntityOrOperation = part => {
  let decodedPart = decodeURI(part)
  decodedPart = decodedPart.replace(/"/gi, '')
  const [, name, paramsString = ''] = decodedPart.match(/([^(]+)\(?(.*[^)]+)?\)?/)
  const params = paramsString
    .split(',')
    .map(keyValue => keyValue.split('='))
    .reduce((obj, [key, value]) => {
      if (key) {
        obj[key] = value
      }
      return obj
    }, {})
  const returnObj = { name }
  if (Object.keys(params).length > 0) {
    returnObj.params = params
  }
  return returnObj
}

const _findEntityOrCustomOperation = (customOperation, service, name) => {
  const thing =
    service.entities[name] || service.operations[name] || findCsnTargetFor(name, service.model, service.name)
  if (!thing) {
    throw getError(404, 'INVALID_RESOURCE', [name])
  }

  if (thing.kind === 'entity') {
    return thing
  }

  if (thing.kind === customOperation) {
    return _enrichCustomOperation(thing, name)
  }

  throw getError(400, 'INVALID_RESOURCE', [name])
}

const _validateEntity = entity => {
  if (!entity) {
    throw getError(404)
  }

  if (entity.kind === 'entity') {
    return entity
  }

  throw getError(400, 'INVALID_RESOURCE', [entity.name])
}

const _validateCustomOperation = (entity, name, customOperation) => {
  if (entity.actions && entity.actions[name] && entity.actions[name].kind === customOperation) {
    return _enrichCustomOperation(entity.actions[name], name)
  } else if (entity.elements && entity.elements[name] && entity.elements[name]._isAssociationEffective) {
    // REVISIT hack to at least support one step navigations
    return _enrichCustomOperation(entity.elements[name], name)
  }

  throw getError(400, 'INVALID_OPERATION_FOR_ENTITY', [entity.name, customOperation.toUpperCase(), name])
}

const _validateAndConvertParamValues = (csnElement, params = {}) => {
  for (const param in params) {
    const csnElementParam = csnElement.params[param]
    if (!csnElementParam) {
      throw getError(400, 'INVALID_PARAMETER', [param])
    }
    const convertedParam = getConvertedValue(csnElementParam.type, params[param])
    if (Number.isNaN(convertedParam)) {
      throw getError(400, 'INVALID_PARAMETER_VALUE_TYPE', [param, csnElementParam.type])
    }
    params[param] = convertedParam
  }
  checkStatic({ elements: csnElement.params }, params)
}

const _getLastEntity = segments => {
  let last
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].target) {
      last = segments[i].target
      break
    } else if (segments[i].kind === 'entity') {
      last = segments[i]
      break
    }
  }
  return last
}

const _setConvenienceProperties = parsed => {
  const lastElement = parsed.segments[parsed.segments.length - 1]

  if (typeof lastElement === 'string') {
    parsed.isCollection = false
  } else if (lastElement.kind === 'entity') {
    parsed.isCollection = true
  } else if (lastElement.type === 'cds.Association' || lastElement.type === 'cds.Composition') {
    parsed.isCollection = true
  } else {
    parsed.operation = lastElement
    parsed.kind = lastElement.kind
    parsed.event = lastElement.name
  }

  parsed.target = _getLastEntity(parsed.segments)
}

const _parseCreateOrRead1 = (parts, customOperation, service, parsed) => {
  const { name, params } = _parseEntityOrOperation(parts[0])
  const entityOrCustomOperation = _findEntityOrCustomOperation(customOperation, service, name)
  if (params) {
    _validateAndConvertParamValues(entityOrCustomOperation, params)
  }
  if (params && customOperation === 'function') {
    parsed.params = params
  }
  parsed.segments.push(entityOrCustomOperation)
}

const _parseCreateOrRead2 = (event, parsed, service, parts) => {
  if (event === 'CREATE') {
    throw getError(400, 'INVALID_POST')
  }

  parsed.segments.push(
    _validateEntity(service.entities[parts[0]] || findCsnTargetFor(parts[0], service.model, service.name)),
    parts[1]
  )
}

const _parseCreateOrRead3 = (service, parts, customOperation, parsed) => {
  const entity = _validateEntity(service.entities[parts[0]] || findCsnTargetFor(parts[0], service.model, service.name))
  const key = parts[1]
  const { name, params } = _parseEntityOrOperation(parts[2])
  const operation = _validateCustomOperation(entity, name, customOperation)
  if (params) {
    _validateAndConvertParamValues(operation, params)
  }
  if (params && customOperation === 'function') {
    parsed.params = params
  }
  parsed.segments.push(entity, key, operation)
}

const parseCreateOrReadUrl = (event, service, req) => {
  const parts = _normalizeAndSplitUrl(req)
  const customOperation = event === 'READ' ? 'function' : 'action'
  const parsed = _initializeParsed(event)

  // TODO: replace with generic solution
  if (parts.length === 1) {
    _parseCreateOrRead1(parts, customOperation, service, parsed)
  }

  if (parts.length === 2) {
    _parseCreateOrRead2(event, parsed, service, parts)
  }

  if (parts.length === 3) {
    _parseCreateOrRead3(service, parts, customOperation, parsed)
  }

  _setConvenienceProperties(parsed)
  if (typeof parsed.target === 'string') parsed.target = service.model.definitions[parsed.target]

  return parsed
}

const parseUpdateOrDeleteUrl = (event, service, req) => {
  const parts = _normalizeAndSplitUrl(req)

  // TODO: replace with generic solution
  if (req.method === 'DELETE' && parts.length !== 2) {
    throw getError(400, 'INVALID_DELETE')
  }
  if (req.method === 'PATCH' && parts.length !== 2) {
    throw getError(400, 'INVALID_PATCH')
  }
  if (req.method === 'PUT' && parts.length !== 2) {
    throw getError(400, 'INVALID_PUT')
  }

  const entity = _validateEntity(service.entities[parts[0]] || findCsnTargetFor(parts[0], service.model, service.name))
  const segments = [entity]

  if (parts[1]) {
    segments.push(parts[1])
  }

  let target = _getLastEntity(segments)
  if (typeof target === 'string') target = service.model.definitions[target]

  return { event, segments, target }
}

module.exports = {
  POST: (service, req) => {
    return parseCreateOrReadUrl('CREATE', service, req)
  },
  GET: (service, req) => {
    return parseCreateOrReadUrl('READ', service, req)
  },
  PUT: (service, req) => {
    return parseUpdateOrDeleteUrl('UPDATE', service, req)
  },
  PATCH: (service, req) => {
    return parseUpdateOrDeleteUrl('UPDATE', service, req)
  },
  DELETE: (service, req) => {
    return parseUpdateOrDeleteUrl('DELETE', service, req)
  }
}
