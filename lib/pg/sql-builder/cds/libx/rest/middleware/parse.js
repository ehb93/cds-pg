const cds = require('../../_runtime/cds')
const { INSERT, SELECT, UPDATE, DELETE } = cds.ql

const { getDeepCopy } = require('../utils/data')

const { where2obj } = require('../../_runtime/common/utils/cqn')

module.exports = (req, res, next) => {
  const { _srv: service } = req
  const { model } = service

  let query = cds.odata.parse(req.url, { service })

  // parser always produces selects
  const _target = (req._target = query.SELECT && query.SELECT.from)
  if (!_target) return next()

  // REVISIT: __target is the csn target definition
  const {
    __target: definition,
    SELECT: { one }
  } = query
  delete query.__target

  // REVISIT: hack for actions and functions
  let operation, args
  const last = _target.ref[_target.ref.length - 1]
  if (last.operation) {
    operation = last.operation
    if (last.args) args = last.args
    _target.ref.pop()
  }

  const unbound = _target.ref.length === 0

  // query based on method
  switch (req.method) {
    case 'GET':
      if (operation) {
        // function
        req._operation = operation = definition.kind === 'function' ? definition : definition.actions[operation]
        if (!unbound) query = one ? SELECT.one(_target) : SELECT.from(_target)
        else query = undefined
      } else {
        // read (nothing to do)
      }
      break
    case 'POST':
      if (operation) {
        // action
        req._operation = operation = definition.kind === 'action' ? definition : definition.actions[operation]
        if (!unbound) query = one ? SELECT.one(_target) : SELECT.from(_target)
        else query = undefined
      } else {
        // create
        if (one) cds.error('POST not allowed on entity', { code: 400 })
        query = INSERT.into(_target)
      }
      break
    case 'PUT':
    case 'PATCH':
      if (!one) throw { statusCode: 400, code: '400', message: `INVALID_${req.method}` }
      query = UPDATE(_target)
      break
    case 'DELETE':
      if (!one) cds.error('DELETE not allowed on collection', { code: 400 })
      query = DELETE.from(_target)
      break
    default:
    // anything to do?
  }
  req._query = query

  // REVISIT: query._data hack
  // deep copy of body (incl. validations such as correct data type)
  if ((query && (query.INSERT || query.UPDATE)) || (operation && operation.kind === 'action') || args) {
    const [validations, copy] = getDeepCopy(args || req.body, operation || definition, model, req.method !== 'POST')
    if (validations) throw validations
    req._data = copy
  }

  // REVISIT: req.params as documented
  for (let i = 0; i < _target.ref.length; i++) {
    req._params = req._params || []
    if (_target.ref[i].where) req._params.push(where2obj(_target.ref[i].where))
    else req._params.push({})
  }

  next()
}
