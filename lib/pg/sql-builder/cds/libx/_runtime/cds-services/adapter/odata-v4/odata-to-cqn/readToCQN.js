const cds = require('../../../../cds')
const { SELECT } = cds.ql

const QueryOptions = require('../okra/odata-server').QueryOptions
const { isNavigation, isPathSupported } = require('./selectHelper')
const { isViewWithParams, getValidationQuery } = require('./selectHelper')
const { ensureUnlocalized } = require('../../../../fiori/utils/handler')
const ExpressionToCQN = require('./ExpressionToCQN')
const orderByToCQN = require('./orderByToCQN')
const selectToCQN = require('./selectToCQN')
const searchToCQN = require('./searchToCQN')
const applyToCQN = require('./applyToCQN')
const { _expand } = require('../utils/handlerUtils')
const { resolveStructuredName } = require('../utils/handlerUtils')
const { isStreaming } = require('../utils/stream')
const { convertUrlPathToCqn, getAllKeys } = require('./utils')
const { getMaxPageSize } = require('../../../../common/utils/page')
const { isAsteriskColumn } = require('../../../../common/utils/rewriteAsterisks')

const {
  COUNT,
  ENTITY,
  ENTITY_COLLECTION,
  NAVIGATION_TO_MANY,
  NAVIGATION_TO_ONE,
  PRIMITIVE_PROPERTY,
  COMPLEX_PROPERTY,
  VALUE,
  SINGLETON
} = require('../okra/odata-server').uri.UriResource.ResourceKind

const SUPPORTED_SEGMENT_KINDS = {
  [ENTITY]: 1,
  [ENTITY_COLLECTION]: 1,
  [NAVIGATION_TO_ONE]: 1,
  [NAVIGATION_TO_MANY]: 1,
  [PRIMITIVE_PROPERTY]: 1,
  [COMPLEX_PROPERTY]: 1,
  [COUNT]: 1,
  [VALUE]: 1,
  [SINGLETON]: 1
}

const _applyOnlyContainsFilter = apply => {
  return Object.keys(apply).length === 1 && apply.filter
}

/**
 *
 * Converts a ref array into a string.
 * ['name'] -> 'name'
 * ['author', 'book', 'name'] -> 'author.{book.{name}}'
 * Same format is used in applyAndAggregations
 *
 * @param ref
 */
const combineRefToWeirdFormat = ref => {
  if (ref.length === 1) return ref[0]

  const copiedRefInReverseOrder = ref.map(r => r).reverse()
  return copiedRefInReverseOrder.reduce((res, curr, i) => {
    if (i === 0) return res
    if (i === ref.length - 1) return `${curr}.{${res}}`
    return `${curr}.{${res}}`
  }, copiedRefInReverseOrder[0])
}

const _setAggregatedAwayPropertiesToNullInFilter = (having, groupBy) => {
  // if properties are aggregated away, their value is equal to null w.r.t. to filtering
  // The following does not cover all cases (e.g. functions)
  for (let i = 0; i < having.length; i++) {
    if (having[i].ref && !groupBy.includes(combineRefToWeirdFormat(having[i].ref))) {
      having[i] = { val: null }
    }
  }
}

const _filter = (model, entity, uriInfo, apply, cqn) => {
  const filterQueryOption = uriInfo.getQueryOption(QueryOptions.FILTER)

  if (filterQueryOption) {
    // if $apply only contains filter, we must not use having
    if (Object.keys(apply).length !== 0 && !_applyOnlyContainsFilter(apply)) {
      cqn.having(new ExpressionToCQN(entity, model, cqn.SELECT.columns).parse(filterQueryOption))
      const applyAndAggregations = [
        ...(apply.groupBy || []),
        ...(apply.aggregations || []).map(a => Object.values(a)[0])
      ]
      _setAggregatedAwayPropertiesToNullInFilter(cqn.SELECT.having, applyAndAggregations)
    } else {
      cqn.where(new ExpressionToCQN(entity, model).parse(filterQueryOption))
    }
  }
}

const _search = (uriInfo, cqn, queryOptions, apply) => {
  const search = uriInfo.getQueryOption(QueryOptions.SEARCH)

  if (!search) {
    return
  }

  const is$apply = Object.keys(apply).length > 0

  // if $apply only contains filter, we must not use having
  if (is$apply && !_applyOnlyContainsFilter(apply)) {
    // REVISIT: at the moment, we use .func on db layer to identify aggregations for $search
    // a simple substring() or other functions would be recognized as well
    // hence, adding internal property that $apply with aggregation was used
    cqn._aggregated = true
  }

  cqn.SELECT.search = searchToCQN(search)
}

const _orderby = (uriInfo, cqn) => {
  const orderBy = uriInfo.getQueryOption(QueryOptions.ORDERBY)
  if (orderBy) {
    orderByToCQN(cqn.SELECT, orderBy)
  }
}

const _select = (queryOptions, entity) => {
  if (queryOptions && queryOptions.$select) {
    const keyColumns = getAllKeys(entity)

    return selectToCQN(queryOptions.$select, keyColumns, entity)
  }

  return []
}

const _apply = (uriInfo, queryOptions, entity, model) => {
  if (queryOptions && queryOptions.$apply) {
    return applyToCQN(uriInfo.getQueryOption(QueryOptions.APPLY), entity, model)
  }
  return {}
}

const _topSkip = (queryOptions, maxPageSize, cqn) => {
  if (queryOptions && (queryOptions.$top || queryOptions.$skip || queryOptions.$skiptoken)) {
    const top = queryOptions.$top ? parseInt(queryOptions.$top) : Number.MAX_SAFE_INTEGER
    const skip = parseInt(queryOptions.$skip || 0) + parseInt(queryOptions.$skiptoken || 0)
    cqn.limit(Math.min(top, maxPageSize), skip)
  }
}

const _getPropertyParam = pathSegments => {
  const index = pathSegments[pathSegments.length - 1].getKind() === VALUE ? 2 : 1
  const prop = pathSegments[pathSegments.length - index].getProperty()
  const name = prop && prop.getName()
  return (
    name &&
    (pathSegments.length > 1
      ? { ref: resolveStructuredName(pathSegments, pathSegments.length - 2, [name]) }
      : { ref: [name] })
  )
}

const _isCollectionOrToMany = kind => {
  return kind === ENTITY_COLLECTION || kind === NAVIGATION_TO_MANY
}

const _isCount = kind => {
  return kind === COUNT
}

const _extendCqnWithApply = (cqn, apply, entity) => {
  if (apply.groupBy) {
    apply.groupBy.forEach(col => cqn.groupBy(col))
  }

  if (apply.filter) {
    cqn.where(apply.filter)
  }

  if (apply.orderBy) {
    apply.orderBy.forEach(col => cqn.orderBy(col))
  }

  if (apply.limit) {
    cqn.limit(apply.limit.top, apply.limit.skip)
  }

  // REVISIT only execute on HANA?
  cqn.SELECT.columns = _groupByPathExpressionsToExpand(cqn, entity)
}

const _containsSelectedColumn = (o, selectColumns) => {
  return (
    (o.ref &&
      (selectColumns.includes(o.ref[o.ref.length - 1]) || (o.ref.length > 1 && selectColumns.includes(o.ref[0])))) ||
    (o.func && o.args && o.args.every(a => _containsSelectedColumn(a, selectColumns)))
  )
}

const _cleanupForApply = (apply, cqn) => {
  if (Object.keys(apply).length !== 0) {
    // cleanup order by columns which are not part of columns
    const selectColumns = cqn.SELECT.columns.map(c => c.as || (c.ref && c.ref[c.ref.length - 1]))
    if (cqn.SELECT.orderBy) {
      // include path expressions
      if (!cqn.SELECT.columns.some(c => isAsteriskColumn(c))) {
        const newOrderBy = cqn.SELECT.orderBy.filter(o => _containsSelectedColumn(o, selectColumns))
        cqn.SELECT.orderBy = newOrderBy
      }
    }

    if (!cqn.SELECT.orderBy || !cqn.SELECT.orderBy.length) {
      delete cqn.SELECT.orderBy
    }
  }
}

const _isSet = segment => {
  return segment.getNavigationProperty() && segment.getNavigationProperty().getName() === 'Set'
}

const _checkViewWithParamCall = (isView, segments, kind, name) => {
  if (!isView) {
    return
  }

  if (segments.length < 2) {
    throw new Error(`Incorrect call to a view with parameter "${name}"`)
  }

  // if the last segment is count, check if previous segment is Set, otherwise check if the last segment equals Set
  if (!_isSet(segments[segments.length - (_isCount(kind) ? 2 : 1)])) {
    throw new Error(`Incorrect call to a view with parameter "${name}"`)
  }
}

const addValidationQueryIfRequired = (segments, isView, cqn, service, kind) => {
  if (isNavigation(segments) && !isView && (kind === NAVIGATION_TO_MANY || kind === NAVIGATION_TO_ONE)) {
    cqn._validationQuery = getValidationQuery(cqn.SELECT.from.ref, service.model)
    cqn._validationQuery.__navToManyWithKeys =
      kind === NAVIGATION_TO_ONE && segments[segments.length - 1].getKeyPredicates().length !== 0
  }
}

const _addKeysToSelectIfNoStreaming = (entity, select, streaming) => {
  // might also be singleton w/o keys
  if (!streaming && entity.keys) {
    for (const k of Object.values(entity.keys)) {
      // REVISIT: !select.includes(k.name) needed?
      if (
        !k.is2one &&
        !k.is2many &&
        !select.includes(k.name) &&
        !select.some(ele => ele.ref && ele.ref.length === 1 && ele.ref[0] === k.name)
      ) {
        select.push({ ref: [k.name] })
      }
    }
  }
}

const _convertUrlPathToViewCqn = segments => {
  const args = segments[0].getKeyPredicates().reduce((prev, curr) => {
    prev[curr.getEdmRef().getName()] = { val: curr.getText() }
    return prev
  }, {})

  // REVISIT: Replace .getFullQualifiedName().toString() with findCsnTargetFor as done in convertUrlPathToCqn
  return {
    ref: [
      {
        id: segments[0]
          .getEntitySet()
          .getEntityType()
          .getFullQualifiedName()
          .toString()
          .replace(/Parameters$/, ''),
        args
      }
    ]
  }
}

const _expandRecursive = (ref, entity, expands = []) => {
  if (ref.length > 1) {
    let innerExpandElement = expands.find(e => e.ref[0] === ref[0])

    if (!innerExpandElement) {
      innerExpandElement = { ref: [ref[0]], expand: [] }
      expands.push(innerExpandElement)
    }
    _expandRecursive(ref.slice(1), entity.elements[ref[0]]._target, innerExpandElement.expand)
    return
  }

  return expands.push({ ref: [ref[0]] })
}

function _groupByPathExpressionsToExpand(cqn, entity) {
  const expands = []
  const columns = (cqn.SELECT.columns || []).filter(col => {
    if (col.ref && col.ref.length > 1 && entity.elements[col.ref[0]].isAssociation) {
      // add expand
      _expandRecursive(col.ref, entity, expands)
      return false
    }

    return true
  })

  columns.push(...expands)
  return columns
}

const _handleApply = (apply, select) => {
  const groupByColumns = apply.groupBy || []
  const additions = [...(apply.aggregations || []), ...(apply.groupBy || []), ...(apply.bottomTop || [])]

  if (!select.length) return select.push(...additions)

  // get additions if in select
  const mergedArray = []
  for (const sel of select) {
    if (groupByColumns.includes(sel.ref && sel.ref[0])) {
      mergedArray.push(sel)
    } else {
      const addition = additions.find(a => {
        return Object.values(a)[0] === (sel.ref && sel.ref[0])
      })
      if (addition) mergedArray.push(addition)
    }
  }
  // replace select with mergedArray
  select.splice(0, select.length)
  select.push(...mergedArray)
}

/**
 * Transform odata READ request into a CQN object.
 *
 * @param {object} service - Service, which will process this request.
 * @param {object} target - The target entity
 * @param {object} odataReq - OKRA's req
 * @private
 */
const readToCQN = (service, target, odataReq) => {
  const uriInfo = odataReq.getUriInfo()
  const segments = uriInfo.getPathSegments()
  isPathSupported(SUPPORTED_SEGMENT_KINDS, segments)

  const queryOptions = odataReq.getQueryOptions()
  const entity = service.model.definitions[ensureUnlocalized(target.name)]
  const propertyParam = _getPropertyParam(segments)
  const apply = _apply(uriInfo, queryOptions, entity, service.model)
  const select = _select(queryOptions, entity)
  const expand = _expand(service.model, uriInfo)

  if (Object.keys(apply).length) {
    _handleApply(apply, select)
  }

  if (propertyParam) {
    select.push(propertyParam)

    // add etag property if necessary
    if (
      entity._etag &&
      !(propertyParam.ref && propertyParam.ref.length === 1 && propertyParam.ref[0] === entity._etag)
    ) {
      select.push({ ref: [entity._etag] })
    }

    // add keys if no streaming, TODO: what if streaming via to-one
    _addKeysToSelectIfNoStreaming(entity, select, isStreaming(segments))
  }

  if (select.length === 0) {
    select.push('*')
  }

  if (expand.length) {
    select.push(...expand)
  }

  const isView = isViewWithParams(target)
  const kind = segments[segments.length - 1].getKind()
  const isCollectionOrToMany = _isCollectionOrToMany(kind)

  // views with parameters should always be called with /Set in URL
  _checkViewWithParamCall(isView, segments, kind, target.name)

  // keep target as input because of localized view
  const cqn = SELECT.from(isView ? _convertUrlPathToViewCqn(segments) : convertUrlPathToCqn(segments, service), select)
  addValidationQueryIfRequired(segments, isView, cqn, service, kind)

  if (Object.keys(apply).length) {
    _extendCqnWithApply(cqn, apply, entity)
  }

  if (isCollectionOrToMany || _isCount(kind)) {
    _filter(service.model, entity, uriInfo, apply, cqn)
    _search(uriInfo, cqn, queryOptions, apply)
  }

  if (isCollectionOrToMany) {
    _topSkip(queryOptions, getMaxPageSize(target), cqn)
    _orderby(uriInfo, cqn)
  }

  if (!isCollectionOrToMany || entity._isSingleton) {
    cqn.SELECT.one = true
  }

  _cleanupForApply(apply, cqn)
  // just like in new parser
  if (cqn.SELECT.columns.length === 1 && cqn.SELECT.columns[0] === '*') delete cqn.SELECT.columns
  return cqn
}

module.exports = readToCQN
