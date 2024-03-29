const {
  Components: { DATA_DELETE_HANDLER, DATA_READ_HANDLER, DATA_CREATE_HANDLER, DATA_UPDATE_HANDLER }
} = require('../okra/odata-server')

const { findCsnTargetFor } = require('../../../../common/utils/csn')
const { isStreaming } = require('./stream')
const { deepCopyObject, deepCopyArray } = require('../../../../common/utils/copy')

const _isFunctionInvocation = req =>
  req.getUriInfo().getLastSegment().getFunction || req.getUriInfo().getLastSegment().getFunctionImport

const _getTypeName = edmRef =>
  edmRef.getProperty ? edmRef.getProperty().getType().getName() : edmRef.getType().getName()

const _addStructuredProperties = ([structName, property, ...nestedProperties], paramData, value) => {
  paramData[structName] = paramData[structName] || {}
  if (nestedProperties.length) {
    _addStructuredProperties([property, ...nestedProperties], paramData[structName], value)
    return
  }

  paramData[structName][property] = value
}

const _getParamKeyValue = segmentParam => {
  const edmRef = segmentParam.getEdmRef()
  const typeName = _getTypeName(edmRef)
  if (segmentParam.getAliasValue())
    // must be JSON  or a string according to
    // https://docs.oasis-open.org/odata/odata/v4.01/os/part2-url-conventions/odata-v4.01-os-part2-url-conventions.html#sec_ComplexandCollectionLiterals
    try {
      return { keyName: edmRef.getName(), value: JSON.parse(segmentParam.getAliasValue()) }
    } catch (e) {
      return { keyName: edmRef.getName(), value: segmentParam.getAliasValue() }
    }

  return {
    keyName: edmRef.getName(),
    // Convert any integer type into numeric values.
    value: typeName.startsWith('Int') ? Number(segmentParam.getText()) : segmentParam.getText()
  }
}

/**
 * The key predicates or function parameters will contain the keys and values for this request.
 * Combine all key value pairs into one object.
 *
 * @param parameters
 * @returns {object}
 * @private
 */
const _getParamData = parameters => {
  const paramData = {}

  for (const segmentParam of parameters) {
    const { keyName, value } = _getParamKeyValue(segmentParam)

    if (keyName.includes('/')) {
      _addStructuredProperties(keyName.split('/'), paramData, value)
      continue
    }

    paramData[keyName] = value
  }

  return paramData
}

// works only for custom on condition working on keys with '=' operator
// and combination of multiple conditions connected with 'and'
const _addKeysToData = (navSourceKeyValues, onCondition, data) => {
  for (const key in navSourceKeyValues) {
    // find index of source column
    const sourceIndex = onCondition.findIndex(e => e.ref && e.ref[0] === 'source' && e.ref[1] === key)
    if (sourceIndex === -1) {
      if (key === 'IsActiveEntity') {
        data[key] = false
      }
      // if key is not part of on condition, it must not be added
    } else {
      // if '=' follows on index, the target columns comes next
      const {
        ref: [, target]
      } = onCondition[sourceIndex + 1] === '=' ? onCondition[sourceIndex + 2] : onCondition[sourceIndex - 2]
      data[target] = navSourceKeyValues[key]
    }
  }
}

function _entityOrTypeName(navSourceSegment) {
  // if navigation has more than 2 segments, the precessor is a naviation and we must use .getTarget
  if (navSourceSegment.getKind() === 'COMPLEX.PROPERTY') {
    return navSourceSegment.getProperty().getType().getFullQualifiedName()
  }

  // TODO do it similar for both cases below?
  return (
    navSourceSegment.getEntitySet()
      ? navSourceSegment.getEntitySet()
      : navSourceSegment.getNavigationProperty() || navSourceSegment.getSingleton()
  )
    .getEntityType()
    .getFullQualifiedName()
}

const _addForeignKeys = (service, req, data) => {
  const pathSegments = req.getUriInfo().getPathSegments()
  // retrieve keys/values from the path segment representing the navigation source
  const navSourceSegment = pathSegments[pathSegments.length - 2]
  const navSourceKeyValues = _getParamData(navSourceSegment.getKeyPredicates())

  // retrieve relevant foreign key properties of the target entity, including the corresponding source key properties
  const navProperty = req.getUriInfo().getLastSegment().getNavigationProperty()

  // REVISIT: cannot be removed yet because of navigation of draft to non draft would add IsActiveEntity to .data
  if (navProperty.getPartner() && navProperty.getPartner().getReferentialConstraints().size) {
    const refConstraints = navProperty.getPartner().getReferentialConstraints()

    // set value of foreign key properties as specified in the navigation source segment
    for (const key in navSourceKeyValues) {
      const refConstraint = [...refConstraints].find(r => r[1].constraint.referencedProperty === key)
      // exclude source keys if they cannot be matched (e.g. isActiveEntity in draft scenario)
      if (refConstraint) {
        data[refConstraint[0]] = navSourceKeyValues[key]
      }
    }
  } else {
    const { name, namespace } = _entityOrTypeName(navSourceSegment)
    const def = findCsnTargetFor(name, service.model, namespace)
    const onCondition = def._relations[navProperty.getName()].join('target', 'source')
    _addKeysToData(navSourceKeyValues, onCondition, data)
  }
}

const _getFunctionParameters = (lastSegment, keyValues) => {
  const functionParameters = lastSegment.getFunctionParameters()
  const paramValues = _getParamData(functionParameters)

  // Working assumption for the case of name collisions: take the entity's key
  for (const key in keyValues) {
    paramValues[key] = keyValues[key]
  }
  return paramValues
}

const _getCopiedData = (odataReq, streaming, lastSegment) => {
  let data = odataReq.getBody() || {}

  if (streaming || lastSegment.getKind() === 'PRIMITIVE.PROPERTY') {
    data = { [lastSegment.getProperty().getName()]: data }
    return data
  }

  data = Array.isArray(data) ? deepCopyArray(data) : deepCopyObject(data)
  return data
}

/**
 * Gets a deep copy of the request payload, preserving the original payload.
 *
 * READ and DELETE work are retrieved from URL; CREATE and UPDATE from body.
 * For function invocations the URL parameters are set as data.
 * For CREATE and UPDATE annotated columns can be mixed in.
 *
 * @param {string} component - odata-v4 component which processes this request
 * @param {import('../okra/odata-server/core/OdataRequest')} odataReq - OKRA's req
 * @param {import('../../../services/Service')} service - Service, which will process this request
 * @returns {object | Array}
 * @private
 */
const getData = (component, odataReq, service) => {
  const segments = odataReq.getUriInfo().getPathSegments()
  const lastSegment = odataReq.getUriInfo().getLastSegment()
  const streaming = isStreaming(segments)
  const keyPredicates = streaming ? segments[segments.length - 2].getKeyPredicates() : lastSegment.getKeyPredicates()
  const keyValues = _getParamData(keyPredicates)

  if (component === DATA_READ_HANDLER && _isFunctionInvocation(odataReq)) {
    return _getFunctionParameters(lastSegment, keyValues)
  }

  if (component === DATA_DELETE_HANDLER || component === DATA_READ_HANDLER) {
    if (component === DATA_DELETE_HANDLER && lastSegment.getKind() === 'PRIMITIVE.PROPERTY') {
      return Object.assign(keyValues, { [lastSegment.getProperty().getName()]: null })
    }
    return keyValues
  }

  // copy so that original payload is preserved
  const data = _getCopiedData(odataReq, streaming, lastSegment)

  // Only to be done for post via navigation
  if (
    component === DATA_CREATE_HANDLER &&
    (lastSegment.getKind() === 'NAVIGATION.TO.MANY' || lastSegment.getKind() === 'NAVIGATION.TO.ONE')
  ) {
    _addForeignKeys(service, odataReq, data)
  }

  // Only to be done for patch via navigation
  // TODO: revert with new CQN
  if (component === DATA_UPDATE_HANDLER && lastSegment.getKind() === 'NAVIGATION.TO.ONE') {
    _addForeignKeys(service, odataReq, data)
  }

  // prefer identifier from URL
  if (keyValues) {
    Array.isArray(data) ? Object.assign(data[0], keyValues) : Object.assign(data, keyValues)
  }

  return data
}

const _getParamsAsIterableObject = req => {
  const params = {
    *[Symbol.iterator]() {
      for (const e in this) {
        yield this[e].ID && Object.keys(this[e]).length === 1 ? this[e].ID : this[e]
      }
    }
  }

  const segments = [...req.getUriInfo().getPathSegments()]
  let next = segments.shift()
  let psi = ''
  while (next) {
    psi += next.getPathSegmentIdentifier()
    const keyPredicates = next.getKeyPredicates()
    keyPredicates.length > 0 && (params[psi] = _getParamData(keyPredicates))
    psi += '/'
    next = segments.shift()
  }

  return params
}

const _getParamsAsArray = req => {
  const params = []

  const segments = [...req.getUriInfo().getPathSegments()]
  let next = segments.shift()
  while (next) {
    const keyPredicates = next.getKeyPredicates()
    if (keyPredicates.length > 0) {
      const param = _getParamData(keyPredicates)
      params.push(param.ID && Object.keys(param).length === 1 ? param.ID : param)
    }
    next = segments.shift()
  }

  return params
}

const getParams = req => {
  if (process.env.CDS_FEATURES_PARAMS) {
    return _getParamsAsIterableObject(req)
  }
  return _getParamsAsArray(req)
}

module.exports = {
  getData,
  getParams
}
