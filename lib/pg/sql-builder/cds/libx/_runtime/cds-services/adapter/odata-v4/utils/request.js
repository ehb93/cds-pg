const {
  QueryOptions,
  uri: {
    UriResource: {
      ResourceKind: { ENTITY, ENTITY_COLLECTION }
    }
  }
} = require('../okra/odata-server')

const getError = require('../../../../common/error')

const _unboundActionsAndFunctions = ['ACTION.IMPORT', 'FUNCTION.IMPORT']
const _actionsAndFunctions = [..._unboundActionsAndFunctions, 'BOUND.ACTION', 'BOUND.FUNCTION']

/**
 * Checks if a custom operation was requested.
 *
 * @param {Array} pathSegments - The uri path segments of the request.
 * @param {boolean} [includingBound] - True if the check should also accept bound operations. Default is true.
 * @returns {boolean} - True if the request targets a custom operation.
 * @private
 */
const isCustomOperation = (pathSegments, includingBound = true) => {
  const customOperationKinds = includingBound ? _actionsAndFunctions : _unboundActionsAndFunctions
  const kind = pathSegments[pathSegments.length - 1].getKind()

  if (customOperationKinds.includes(kind)) {
    return kind
  }
}

/**
 * Validate resource path length and autoexposed entities.
 * It will throw an error in case the maximum is exceeded or top entity is autoexposed.
 *
 * @param {object} odataReq
 * @param {object} service
 */
const validateResourcePath = (odataReq, service) => {
  const segment = odataReq.getUriInfo().getPathSegments()[0]
  if (segment.getKind() === ENTITY || segment.getKind() === ENTITY_COLLECTION) {
    const name = segment.getEntitySet().getName()
    // REVISIT: This validation is violating all principles of locality
    const entity = service.model.definitions[`${service.definition.name}.${name}`]
    if (!entity) return

    /*
     * For auto-exposed Compositions all direct CRUD requests are rejected in non-draft case.
     * For other auto-exposed entities in non-draft case only C_UD are rejected. Direct READ is allowed.
     * Draft case is an exception. Direct requests are allowed.
     */
    if (entity._isDraftEnabled) return
    if (entity['@cds.autoexposed']) {
      if (entity['@cds.autoexpose'] && odataReq.getIncomingRequest().method === 'GET') {
        // combination GET && @cds.autoexposed && @cds.autoexpose is OK
        return
      }
      throw getError(405, 'ENTITY_IS_AUTOEXPOSED', [entity.name])
    }
  }
}

/**
 * Used for pagination, where the start of the collection is defined via skip token.
 *
 * @param {object} uriInfo
 * @returns {number}
 * @private
 */
const skipToken = uriInfo => {
  const token = uriInfo.getQueryOption(QueryOptions.SKIPTOKEN)

  // If given, the token is a string but needed as numeric value.
  return token ? parseInt(token) : 0
}

module.exports = {
  isCustomOperation,
  validateResourcePath,
  skipToken
}
