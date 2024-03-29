/*
 * additional input handler on ApplicationService level for PUT
 *
 * - add default value or null (if nullable) for each property that was not provided
 *   and is neither key nor read-only (e.g., managed, virtual, etc.)
 */

const cds = require('../../cds')
const getTemplate = require('../utils/template')
const templateProcessor = require('../utils/templateProcessor')
const { getDataFromCQN, setDataFromCQN } = require('../utils/data')

const _fillStructure = (row, parts, element, category, args) => {
  if (parts.length === 1) {
    if (row[parts[0]] === undefined) {
      row[parts[0]] = (args && args.val) || null
    }
  } else {
    if (row[parts[0]] === undefined) {
      row[parts[0]] = {}
    }
    _fillStructure(row[parts[0]], parts.slice(1), element, category, args)
  }
}

const processorFn = req => {
  const REST = req.constructor.name === 'RestRequest'

  return ({ row, key, element, plain }) => {
    if (!row || row[key] !== undefined) return

    const { category, args } = plain

    // fills non-navigation structures if REST
    if (REST && element.name.match(/._./)) {
      const parts = element.name.split('_')
      if (!element.parent.elements[parts[0]]) {
        _fillStructure(row, parts, element, category, args)
        return
      }
    }

    /* istanbul ignore else */
    if (category === 'default') {
      row[key] = args.val
    } else if (category === 'null') {
      if (!element._isStructured) row[key] = null
    }
  }
}

// params: element, target, parent, templateElements
const _pick = element => {
  if (!element.isAssociation && !element.key && !element._isReadOnly) {
    /* istanbul ignore else */
    if (element.default) {
      return { category: 'default', args: element.default }
    } else if (!element.notNull) {
      return { category: 'null' }
    }
  }
}

function _handler(req) {
  if (req.method !== 'PUT') return
  if (!req.target) return

  // not for payloads with stream properties
  const { elements } = req.target
  for (const k in req.data) if (k in elements && elements[k]['@Core.MediaType']) return

  const template = getTemplate('app-put', this, req.target, { pick: _pick })
  if (template.elements.size === 0) return

  // REVISIT: req.data should point into req.query
  const data = getDataFromCQN(req.query)

  const arrayData = Array.isArray(data) ? data : [data]
  for (const row of arrayData) {
    const args = {
      processFn: processorFn(req),
      row,
      template
    }
    templateProcessor(args)
  }

  // REVISIT: req.data should point into req.query
  setDataFromCQN(req)
}

_handler._initial = true

module.exports = cds.service.impl(function () {
  this.before(['UPDATE'], '*', _handler)
})
