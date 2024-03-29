const cds = require('../../cds')
const { getDefaultPageSize } = require('../utils/page')

const _handler = function (req) {
  // only if http request
  if (!req._.req) return

  // target === null if view with parameters
  if (!req.target || !req.query.SELECT || req.query.SELECT.one) return

  let { rows, offset } = req.query.SELECT.limit || {}
  rows = rows && 'val' in rows ? rows.val : getDefaultPageSize(req.target)
  offset = offset && 'val' in offset ? offset.val : 0
  req.query.limit(...[rows, offset])
}

/**
 * handler registration
 */
module.exports = cds.service.impl(function () {
  _handler._initial = true
  this.before('READ', '*', _handler)
})
