const cds = require('../../../../cds')
const { SELECT } = cds.ql

const {
  QueryOptions,
  edm: { EdmTypeKind }
} = require('../okra/odata-server')

const { getFeatureNotSupportedError } = require('../../../util/errors')
const orderByToCQN = require('./orderByToCQN')
const ExpressionToCQN = require('./ExpressionToCQN')
const { getColumns } = require('../../../services/utils/columns')
const { addLimit, isSameArray } = require('./utils')
const { findCsnTargetFor } = require('../../../../common/utils/csn')
/**
 * Check which element(s) of the entity has been expanded.
 *
 * @param isAll
 * @param {Array} expandItems
 * @param name
 * @returns {Array | null}
 * @private
 */
const _getExpandItem = (isAll, expandItems, name) => {
  if (isAll) {
    return null
  }

  return expandItems.find(item => {
    const pathSegments = item.getPathSegments()
    return pathSegments[pathSegments.length - 1].getNavigationProperty().getName() === name
  })
}

/**
 * Check if not supported function is used and if so, throw an error.
 *
 * @param expandItem
 * @private
 */
const _notSupported = expandItem => {
  if (!expandItem) {
    return
  }

  if (expandItem.getOption(QueryOptions.COUNT)) {
    throw getFeatureNotSupportedError(`Expand with query option "${QueryOptions.COUNT}"`)
  }

  if (expandItem.getOption(QueryOptions.SEARCH)) {
    throw getFeatureNotSupportedError(`Expand with query option "${QueryOptions.SEARCH}"`)
  }
}

/**
 * No lookup at the CSN needed. Get columns from target.
 *
 * @param targetType
 * @param relatedEntity
 * @param all
 * @returns {Array}
 * @private
 */
const _getColumnsFromTargetType = (targetType, relatedEntity, all = false) => {
  if (!targetType || targetType.getKind() !== EdmTypeKind.ENTITY) {
    return []
  }

  if (all) {
    return getColumns(relatedEntity, { onlyNames: true, removeIgnore: true, filterDraft: false })
      .filter(c => c !== 'DraftAdministrativeData_DraftUUID')
      .map(c => ({
        ref: [c]
      }))
  }

  return Object.keys(relatedEntity.keys)
    .filter(k => !relatedEntity.keys[k].is2one && !relatedEntity.keys[k].is2many)
    .map(element => ({
      ref: [element]
    }))
}

const _getInnerSelect = expandItem => {
  if (!expandItem) {
    return []
  }

  return expandItem.getOption(QueryOptions.SELECT) || []
}

/**
 * Get the selected columns and navigation paths.
 *
 * @param expandItem
 * @param targetType
 * @param relatedEntity
 * @returns {Array}
 * @private
 */
const _getSelectedElements = (expandItem, targetType, relatedEntity, options) => {
  if (cds.env.effective.odata.proxies || cds.env.effective.odata.xrefs) {
    // proxy target?
    let proxy = true
    targetType.getProperties().forEach((value, key) => {
      if (!relatedEntity.keys[key]) proxy = false
    })
    if (proxy) {
      return _getColumnsFromTargetType(targetType, relatedEntity)
    }
  }

  let innerSelectItems = _getInnerSelect(expandItem)

  if (innerSelectItems.length === 0 || innerSelectItems.some(item => item.isAll())) {
    // REVISIT: Remove once we clean up our draft handling
    if (options && options.rewriteAsterisks) return _getColumnsFromTargetType(targetType, relatedEntity, true)
    return ['*']
  }

  // remove navigations from select clause
  innerSelectItems = innerSelectItems.filter(item => {
    // check only last segment, could be complex type
    return !_getNavigationProperty(item.getPathSegments())
  })

  const selectedPaths = _getColumnsFromTargetType(targetType, relatedEntity)

  for (const selectItem of innerSelectItems) {
    const selectRef = { ref: [] }
    for (const segment of selectItem.getPathSegments()) {
      selectRef.ref.push(segment.getPathSegmentIdentifier())
    }

    // don't add already existing refs
    if (selectedPaths.some(ref => isSameArray(ref.ref, selectRef.ref))) {
      continue
    }

    if (selectRef.ref.length) {
      selectedPaths.push(selectRef)
    }
  }

  return selectedPaths
}

/**
 * Nested expands are inner expand items.
 *
 * @param model
 * @param expandItem
 * @param targetType
 * @returns {Array}
 * @private
 */
const _getInnerExpandItems = (model, expandItem, targetType) => {
  if (!expandItem || !expandItem.getOption(QueryOptions.EXPAND)) {
    return []
  }

  return expandToCQN(model, expandItem.getOption(QueryOptions.EXPAND), targetType)
}

const _filter = (item, expression) => {
  if (!expression) return
  const expressionToCQN = new ExpressionToCQN()
  item.where = SELECT.from('a').where(expressionToCQN.parse(expression)).SELECT.where
}

const _getItemCQN = (model, name, navigationProperty, expandItem, options) => {
  _notSupported(expandItem)

  const targetType = navigationProperty.getEntityType()
  const { name: entityName, namespace } = navigationProperty.getEntityType().getFullQualifiedName()

  // autoexposed entities now used . in csn and _ in edm
  const relatedEntity = findCsnTargetFor(entityName, model, namespace)
  const item = {
    ref: name, // ['structured', 'nested_', nestedAssocToOne] if expand on structured
    expand: _getSelectedElements(expandItem, targetType, relatedEntity, options)
  }

  item.expand.push(..._getInnerExpandItems(model, expandItem, targetType))

  if (!expandItem) {
    // $expand=* can't have own query options -> no limit, orderBy, etc. needed
    return item
  }

  const orderBy = expandItem.getOption(QueryOptions.ORDERBY)
  if (orderBy) {
    orderByToCQN(item, orderBy)
  }

  const top = expandItem.getOption(QueryOptions.TOP)
  if (navigationProperty.isCollection())
    addLimit(item, top != null ? top : null, expandItem.getOption(QueryOptions.SKIP) || 0)

  _filter(item, expandItem.getOption(QueryOptions.FILTER))

  return item
}

const _getNavigationProperty = pathSegments => {
  if (pathSegments.length === 0) return
  return pathSegments[pathSegments.length - 1].getNavigationProperty()
}

const _name = expandItem =>
  expandItem
    .getPathSegments()
    .map(
      item =>
        (item.getProperty() && item.getProperty().getName()) ||
        (item.getNavigationProperty() && item.getNavigationProperty().getName())
    )

/**
 * Convert odata-v4 expand to into argument for query API.
 *
 * @param model
 * @param expandItems
 * @param type
 * @returns {Array}
 */
const expandToCQN = (model, expandItems, type, options) => {
  const allElements = []
  const isAll = expandItems.some(item => item.isAll())

  for (const [name, navigationProperty] of type.getNavigationProperties()) {
    const expandItem = _getExpandItem(isAll, expandItems, name)

    if (isAll || expandItem) {
      allElements.push(_getItemCQN(model, [name], navigationProperty, expandItem, options))
    }
  }

  // structured
  for (const expandItem of expandItems) {
    const pathSegments = expandItem.getPathSegments()
    if (pathSegments.length && pathSegments[0].getKind() === 'COMPLEX.PROPERTY') {
      const navigationProperty = _getNavigationProperty(pathSegments)

      if (isAll || expandItem) {
        allElements.push(_getItemCQN(model, _name(expandItem), navigationProperty, expandItem))
      }
    }
  }

  return allElements
}

module.exports = expandToCQN
