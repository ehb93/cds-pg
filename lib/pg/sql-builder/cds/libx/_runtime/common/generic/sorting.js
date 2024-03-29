const cds = require('../../cds')
const LOG = cds.log('app')

const DRAFT_COLUMNS = ['IsActiveEntity', 'HasDraftEntity', 'HasActiveEntity']

const _getStaticOrders = req => {
  const { target: entity, query } = req
  const defaultOrders = entity['@cds.default.order'] || entity['@odata.default.order'] || []

  if (!cds._deprecationWarningForDefaultSort && defaultOrders.length > 0) {
    LOG._warn &&
      LOG.warn('Annotations "@cds.default.order" and "@odata.default.order" are deprecated and will be removed.')
    cds._deprecationWarningForDefaultSort = true
  }

  const ordersFromKeys = []

  // implicit sorting?
  if (cds.env.features.implicit_sorting !== false && (req.target._isSingleton || query.SELECT.limit)) {
    for (const keyName in entity.elements) {
      if (
        entity.elements[keyName].key &&
        !entity.elements[keyName].is2one &&
        !DRAFT_COLUMNS.includes(keyName) &&
        !defaultOrders.some(o => o.by['='] === keyName)
      )
        ordersFromKeys.push({ by: { '=': keyName } })
    }
  }

  if (entity.query && entity.query.SELECT && entity.query.SELECT.orderBy) {
    const orderBy = entity.query.SELECT.orderBy
    const ordersFromView = orderBy.map(keyName => ({ by: { '=': keyName.ref[0] }, desc: keyName.sort === 'desc' }))
    return [...ordersFromView, ...defaultOrders, ...ordersFromKeys]
  }

  return [...defaultOrders, ...ordersFromKeys]
}

/**
 * 1. query options --> already set in req.query
 * 2. orders from view || @cds.default.order/@odata.default.order
 * 3. orders from keys if singleton or limit is set
 *
 * @param req
 */
const _handler = function (req) {
  if (!req.query || !req.query.SELECT || req.query.SELECT.one) return

  const select = req.query.SELECT

  // do not sort for /$count queries or queries only using aggregations
  if (select.columns && select.columns.length && select.columns.every(col => col.func)) {
    return
  }

  // "static orders" = the orders not from the query options
  let staticOrders = _getStaticOrders(req)

  // remove defaultOrder if not part of group by
  if (select.groupBy && select.groupBy.length > 0) {
    staticOrders = staticOrders.filter(d => select.groupBy.find(e => e.ref[0] === d.by['=']))
  }

  if (!select.orderBy && staticOrders.length === 0) return
  select.orderBy = select.orderBy || []

  for (const defaultOrder of staticOrders) {
    const some = select.orderBy.some(orderBy => {
      const managedKey = orderBy.ref && orderBy.ref.length > 1 && orderBy.ref.join('_')
      const element = managedKey && req.target.elements[managedKey]
      const isManagedKey = element && element.key && !element.is2one

      // don't add duplicates
      return (
        (orderBy.ref && orderBy.ref.length === 1 && orderBy.ref[0] === defaultOrder.by['=']) ||
        (isManagedKey && managedKey === defaultOrder.by['='])
      )
    })

    if (!some) {
      const orderByItem = { ref: [defaultOrder.by['=']], sort: defaultOrder.desc ? 'desc' : 'asc' }
      select.orderBy.push(orderByItem)
    }
  }
}

/**
 * handler registration
 */
module.exports = cds.service.impl(function () {
  _handler._initial = true
  this.before('READ', '*', _handler)
})

// REVISIT: remove (currently needed for test)
module.exports.handler = _handler
