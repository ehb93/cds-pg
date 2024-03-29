const cds = require('../../../../cds')
const { UPDATE, DELETE } = cds.ql

const { getFeatureNotSupportedError } = require('../../../util/errors')
const { convertUrlPathToCqn } = require('./utils')

const { ENTITY, NAVIGATION_TO_ONE, SINGLETON } = require('../okra/odata-server').uri.UriResource.ResourceKind

const SUPPORTED_KINDS = {
  [ENTITY]: 1,
  [SINGLETON]: 1,
  [NAVIGATION_TO_ONE]: 1
}

/**
 * Transform odata DELETE request into a CQN object.
 *
 * @param {object} odataReq - OKRA's req
 * @throws Error - If invalid path segment provided
 * @private
 */
const deleteToCQN = (service, odataReq) => {
  const segments = odataReq.getUriInfo().getPathSegments()
  const segment = segments[segments.length - 1]

  if (SUPPORTED_KINDS[segment.getKind()]) {
    return DELETE.from(convertUrlPathToCqn(segments, service))
  }

  if (segment.getKind() === 'PRIMITIVE.PROPERTY') {
    return UPDATE(convertUrlPathToCqn(segments, service)).data({ [segment.getProperty().getName()]: null })
  }

  throw getFeatureNotSupportedError(`DELETE of kind "${segment.getKind()}"`)
}

module.exports = deleteToCQN
