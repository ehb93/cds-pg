const cds = require('../../../../cds')

const { INSERT, SELECT, UPDATE, DELETE } = cds.ql

const { createCqlString } = require('./utils')
const { getColumns } = require('../../../services/utils/columns')
const { getMaxPageSize } = require('../../../../common/utils/page')

const _readToCQN = ({ isCollection, segments }, target, restReq) => {
  const key = Object.keys(target.keys)[0]

  const cqn = SELECT.from(
    createCqlString(target, key, segments[1]),
    getColumns(target, {
      onlyNames: true,
      removeIgnore: true
    })
  )

  if (!isCollection) cqn.SELECT.one = true

  if (isCollection && (restReq.query.$top || restReq.query.$skip)) {
    const top = restReq.query.$top ? parseInt(restReq.query.$top) : Number.MAX_SAFE_INTEGER
    cqn.limit(Math.min(top, getMaxPageSize(target)), parseInt(restReq.query.$skip) || 0)
  }

  return cqn
}

/**
 * @param {object} parsed
 * @param {object} data
 * @param {object} restReq
 * @returns {object}
 */
module.exports = (parsed, data, restReq, service) => {
  const odata2cqn = cds.env.features.rest_new_parser

  const { event, segments, target } = parsed

  const key = target && Object.keys(target.keys)[0]
  const value = segments && segments.length > 1 && segments[1]

  switch (event) {
    case 'CREATE':
      return INSERT.into(target).entries(data)
    case 'READ':
      return odata2cqn ? cds.odata.parse(restReq, { service }) : _readToCQN(parsed, target, restReq)
    case 'UPDATE':
      return UPDATE(createCqlString(target, key, value)).data(data)
    case 'DELETE':
      return DELETE.from(createCqlString(target, key, value))
    default:
      return target ? SELECT.from(createCqlString(target, key, value)) : undefined
  }
}
