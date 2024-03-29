/*
 * input handler on ApplicationService level
 *
 * - remove readonly fields
 * - remove immutable fields on update
 * - add UUIDs
 * - asserts
 */

const cds = require('../../cds')
const { enrichDataWithKeysFromWhere } = require('../utils/keys')
const { DRAFT_COLUMNS_MAP } = require('../../common/constants/draft')
const { checkInputConstraints, checkIfAssocDeep } = require('../../cds-services/util/assert')
const getTemplate = require('../utils/template')
const templateProcessor = require('../utils/templateProcessor')
const { getDataFromCQN, setDataFromCQN } = require('../utils/data')
const { isMandatory, isReadOnly } = require('../aspects/utils')

const shouldSuppressErrorPropagation = ({ event, value }) => {
  return (
    event === 'NEW' ||
    event === 'PATCH' ||
    (event === 'UPDATE' && value.val === undefined) ||
    (value.val == null && !value.mandatory)
  )
}

const getSimpleCategory = category => {
  if (typeof category === 'object') {
    category = category.category
  }

  return category
}

const rowKeysGenerator = eventName => {
  return (keyNames, row, template) => {
    if (eventName === 'UPDATE') return

    for (const keyName of keyNames) {
      if (Object.prototype.hasOwnProperty.call(row, keyName)) {
        continue
      }

      const elementInfo = template.elements.get(keyName)
      const plain = elementInfo && elementInfo.picked && elementInfo.picked.plain
      if (!plain || !plain.categories) continue
      if (plain.categories.includes('uuid')) {
        row[keyName] = cds.utils.uuid()
      }
    }
  }
}

const _isDraftCoreComputed = (req, element, event) =>
  cds.env.features.preserve_computed !== false &&
  req._ &&
  req._.event === 'draftActivate' &&
  element['@Core.Computed'] &&
  !((event === 'CREATE' && element['@cds.on.insert']) || element['@cds.on.update'])

const _processCategory = ({ row, key, category, isRoot, event, value, req, element }) => {
  category = getSimpleCategory(category)

  // remember mandatory
  if (category === 'mandatory') {
    value.mandatory = true
    return
  }

  // remove readonly & immutable (can also be complex, so do first)
  if (category === 'readonly' || (category === 'immutable' && event === 'UPDATE')) {
    if (_isDraftCoreComputed(req, element, event)) {
      // > preserve computed values if triggered by draftActivate and not managed
      return
    }

    delete row[key]
    value.val = undefined
    return
  }

  // generate UUIDs
  if (category === 'uuid' && !value.val && (event !== 'UPDATE' || !isRoot)) {
    value.val = row[key] = cds.utils.uuid()
  }

  // check for forbidden deep operations for association
  if (category === 'associationEffective' && (event === 'UPDATE' || event === 'CREATE')) {
    if (shouldSuppressErrorPropagation({ event, value })) return
    // REVISIT: remove delay_assert_deep_assoc with cds^6
    if (!cds.env.features.delay_assert_deep_assoc) checkIfAssocDeep(element, value.val, req)
  }
}

const processorFn = (errors, req) => {
  const { event } = req

  return ({ row, key, element, plain, isRoot, pathSegments }) => {
    const categories = plain.categories
    // ugly pointer passing for sonar
    const value = { mandatory: false, val: row && row[key] }

    for (const category of categories) {
      _processCategory({ row, key, category, isRoot, event, value, req, element })
    }

    if (shouldSuppressErrorPropagation({ event, value })) {
      return
    }

    // REVISIT: Convert checkInputConstraints to template mechanism
    checkInputConstraints({ element, value: value.val, errors, pathSegments, event })
  }
}

// params: element, target, parent, templateElements
const _pick = element => {
  // collect actions to apply
  const categories = []

  if (element['@assert.range'] || element['@assert.enum'] || element['@assert.format']) {
    categories.push('assert')
  }

  if (element._isMandatory) {
    categories.push('mandatory')
  }

  if (element._isReadOnly) {
    // > _isReadOnly includes @cds.on.insert and @cds.on.update
    categories.push('readonly')
  }

  if (element['@Core.Immutable']) {
    categories.push('immutable')
  }

  if (element._isAssociationEffective && !element._target._hasPersistenceSkip) {
    categories.push('associationEffective')
  }

  if (element.key && !DRAFT_COLUMNS_MAP[element.name] && element.type === 'cds.UUID') {
    categories.push('uuid')
  }

  if (categories.length) return { categories }
}

const _callError = (req, errors) => {
  if (errors.length !== 0) {
    for (const error of errors) {
      req.error(error)
    }
  }
}

const _isBoundAction = req => !!(req.getUriInfo && req.getUriInfo().getLastSegment().getKind() === 'BOUND.ACTION')

const _getBoundActionBindingParameter = req => {
  // REVISIT: req._ gets set in onDraftActivate to original req
  const action = (req._ && req._.event) || req.event
  const actions = req.target.actions

  // 'in' is the default binding parameter name for bound actions/functions
  return (actions && actions[action] && actions[action]['@cds.odata.bindingparameter.name']) || 'in'
}

function _handler(req) {
  if (!req.target) return

  const template = getTemplate('app-input', this, req.target, { pick: _pick })
  if (template.elements.size === 0) return

  const errors = []
  const data = getDataFromCQN(req.query) // REVISIT: req.data should point into req.query

  enrichDataWithKeysFromWhere(data, req, this)

  const arrayData = Array.isArray(data) ? data : [data]
  for (const row of arrayData) {
    let pathSegments
    let extraKeys

    if (_isBoundAction(req)) {
      const pathSegment = _getBoundActionBindingParameter(req)
      const keys = req._ && req._.params && req._.params[0]
      pathSegments = pathSegment ? [pathSegment] : []

      if (keys && 'IsActiveEntity' in keys) {
        extraKeys = { IsActiveEntity: keys.IsActiveEntity }
      }
    }

    const args = {
      processFn: processorFn(errors, req),
      row,
      template,
      pathOptions: {
        extraKeys,
        rowKeysGenerator: rowKeysGenerator(req.event),
        segments: pathSegments,
        includeKeyValues: true
      }
    }

    templateProcessor(args)
  }

  setDataFromCQN(req) // REVISIT: req.data should point into req.query
  _callError(req, errors)
}

const processorFnForActionsFunctions =
  (errors, opName) =>
  ({ row, key, element }) => {
    const value = row && row[key]

    // REVISIT: Convert checkInputConstraints to template mechanism
    checkInputConstraints({ element, value, errors, key: opName })
  }

const _processActionFunctionRow = (row, param, key, errors, event, service) => {
  const values = Array.isArray(row[key]) ? row[key] : [row[key]]
  // unstructured
  for (const value of values) {
    checkInputConstraints({ element: param, value, errors, key })
  }

  // structured
  const template = getTemplate('app-input-operation', service, param, {
    pick: _pick
  })
  if (template && template.elements.size) {
    for (const value of values) {
      const args = { processFn: processorFnForActionsFunctions(errors, key), row: value, template }
      templateProcessor(args)
    }
  }
}

const _processActionFunction = (row, eventParams, errors, event, service) => {
  for (const key in eventParams) {
    let param = eventParams[key]
    const _type = param.type
    if (!_type && param.items) param = param.items
    _processActionFunctionRow(row, param, key, errors, event, service)
  }
}

const _getEventParameters = (req, service) => {
  // in bound case
  if (req.target) {
    if (req.target.actions && req.target.actions[req.event]) {
      return req.target.actions[req.event].params
    }

    return req.target.functions[req.event].params
  }

  // in unbound case
  return service.model.definitions[`${service.name}.${req.event}`].params
}

function _actionFunctionHandler(req) {
  const eventParams = _getEventParameters(req, this)
  if (!eventParams) return

  // REVISIT: find better solution
  // attach aspects, if not yet done
  for (const param of Object.values(eventParams)) {
    if ('_isMandatory' in param) continue
    param._isMandatory = isMandatory(param)
    param._isReadOnly = isReadOnly(param)
  }

  // REVISIT: find better solution, maybe compiler?
  // resolve enums like format, range, etc.
  for (const param of Object.values(eventParams)) {
    const _type = param.type && this.model && this.model.definitions[param.type]
    if (_type) {
      param.enum = _type.enum
    }
  }

  const errors = []
  const data = req.data
  const arrayData = Array.isArray(data) ? data : [data]
  for (const row of arrayData) {
    _processActionFunction(row, eventParams, errors, req.event, this)
  }
  _callError(req, errors)
}

_handler._initial = true
_actionFunctionHandler._initial = true

module.exports = cds.service.impl(function () {
  this.before(['CREATE', 'UPDATE', 'NEW', 'PATCH'], '*', _handler)

  const operationNames = []
  for (const operation of this.operations) {
    operationNames.push(operation.name.substring(this.name.length + 1))
  }
  if (operationNames.length > 0) {
    this.before(operationNames, _actionFunctionHandler)
  }

  for (const entity of this.entities) {
    const boundOps = []
    if (entity.actions) {
      boundOps.push(...Object.keys(entity.actions))
    }
    if (entity.functions) {
      boundOps.push(...Object.keys(entity.functions))
    }
    if (boundOps.length > 0) {
      this.before(boundOps, entity.name, _actionFunctionHandler)
    }
  }
})
