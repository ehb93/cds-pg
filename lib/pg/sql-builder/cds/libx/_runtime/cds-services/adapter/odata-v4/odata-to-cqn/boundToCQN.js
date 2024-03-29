const cds = require('../../../../cds')
const { SELECT } = cds.ql

const { isPathSupported } = require('./selectHelper')
const { convertUrlPathToCqn } = require('./utils')

const {
  BOUND_ACTION,
  BOUND_FUNCTION,
  COUNT,
  ENTITY,
  ENTITY_COLLECTION,
  NAVIGATION_TO_MANY,
  NAVIGATION_TO_ONE,
  PRIMITIVE_PROPERTY
} = require('../okra/odata-server').uri.UriResource.ResourceKind

const SUPPORTED_SEGMENT_KINDS = {
  [BOUND_ACTION]: 1,
  [BOUND_FUNCTION]: 1,
  [ENTITY]: 1,
  [ENTITY_COLLECTION]: 1,
  [NAVIGATION_TO_ONE]: 1,
  [NAVIGATION_TO_MANY]: 1,
  [PRIMITIVE_PROPERTY]: 1,
  [COUNT]: 1
}

/**
 * Transform odata bound action or functiuon request into a CQN object.
 *
 * @param {object} odataReq - An odata request.
 * @private
 */
const boundToCQN = (service, odataReq) => {
  const segments = odataReq.getUriInfo().getPathSegments()
  isPathSupported(SUPPORTED_SEGMENT_KINDS, segments)

  return SELECT.from(convertUrlPathToCqn(segments.slice(0, segments.length - 1), service))
}

module.exports = boundToCQN
