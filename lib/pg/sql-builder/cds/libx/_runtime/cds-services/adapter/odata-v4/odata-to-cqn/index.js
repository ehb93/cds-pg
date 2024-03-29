const cds = require('../../../../cds')

const {
  Components: { DATA_CREATE_HANDLER, DATA_DELETE_HANDLER, DATA_READ_HANDLER, DATA_UPDATE_HANDLER }
} = require('../okra/odata-server')

const boundToCQN = require('./boundToCQN')
const readToCQN = require('./readToCQN')
const updateToCQN = require('./updateToCQN')
const createToCQN = require('./createToCQN')
const deleteToCQN = require('./deleteToCQN')

/**
 * This method transforms an odata request into a CQN object.
 *
 * @param {string} component - Component name
 * @param {object} service - Service, which will process this request
 * @param {object} target - The target entity
 * @param {object | Array} data - A copy of the request payload
 * @param {object} odataReq - OKRA's req
 * @param {boolean} upsert - CREATE on PUT/PATCH
 * @returns {object} - The CQN object
 */
module.exports = (component, service, target, data, odataReq, upsert) => {
  const odata2cqn = cds.env.features.odata_new_parser

  switch (component) {
    case DATA_CREATE_HANDLER:
      return createToCQN(service, target, data, odataReq, upsert)
    case DATA_DELETE_HANDLER:
      return deleteToCQN(service, odataReq)
    case DATA_READ_HANDLER:
      return odata2cqn ? cds.odata.parse(odataReq, { service }) : readToCQN(service, target, odataReq)
    case DATA_UPDATE_HANDLER:
      return updateToCQN(service, data, odataReq)
    case 'BOUND.ACTION':
    case 'BOUND.FUNCTION':
      return boundToCQN(service, odataReq)
    default:
      return {}
  }
}
