const odata = require('../okra/odata-server')
const ResourceKind = odata.uri.UriResource.ResourceKind
const TransformationKind = odata.uri.Transformation.TransformationKind
const ExpressionKind = odata.uri.Expression.ExpressionKind
const StandardMethod = odata.uri.AggregateExpression.StandardMethod
const BottomTopMethod = odata.uri.BottomTopTransformation.Method

const ExpressionToCQN = require('./ExpressionToCQN')
const { getFeatureNotSupportedError } = require('../../../util/errors')

const AGGREGATION_METHODS = {
  [StandardMethod.SUM]: x => `sum(${x})`,
  [StandardMethod.MIN]: x => `min(${x})`,
  [StandardMethod.MAX]: x => `max(${x})`,
  [StandardMethod.AVERAGE]: x => `avg(${x})`,
  [StandardMethod.COUNT_DISTINCT]: x => `count(distinct ${x})`
}

const BOTTOMTOP_METHODS = {
  [BottomTopMethod.TOP_COUNT]: (x, y) => `topcount(${x},${y})`,
  [BottomTopMethod.BOTTOM_COUNT]: (x, y) => `bottomcount(${x},${y})`
}

const AGGREGATION_DEFAULT = '@Aggregation.default'

const _createNavGroupBy = pathSegments => {
  let name = pathSegments[0].getNavigationProperty().getName()
  for (let i = 1; i < pathSegments.length; i++) {
    name += pathSegments[i].getProperty()
      ? '.' + pathSegments[i].getProperty().getName()
      : '.' + pathSegments[i].getNavigationProperty().getName()
  }
  return name
}

const _getColumnName = expression => {
  if (expression.getKind() === ExpressionKind.MEMBER) {
    const pathSegments = expression.getPathSegments()

    if (pathSegments[0].getKind() === 'COMPLEX.PROPERTY') {
      return _complexProperty(pathSegments)
    }
    return pathSegments[0].getNavigationProperty()
      ? _createNavGroupBy(pathSegments)
      : pathSegments[0].getProperty().getName()
  }
  throw getFeatureNotSupportedError(`Expression ${expression.getKind()} with query option $apply`)
}

const _checkAggregateExpression = aggregateExpression => {
  if (
    aggregateExpression.getInlineAggregateExpression() ||
    aggregateExpression.getFrom().length ||
    (aggregateExpression.getPathSegments().length &&
      aggregateExpression.getPathSegments()[0].getKind() !== ResourceKind.COUNT)
  ) {
    throw getFeatureNotSupportedError('Only simple aggregate expressions are supported with query option $apply')
  }
}

const _addAggregation = aggregateExpression => {
  const columnName = _getColumnName(aggregateExpression.getExpression())
  const aggregate = AGGREGATION_METHODS[aggregateExpression.getStandardMethod()]
  if (!aggregate) throw new Error('Unsupported aggregate function: ' + aggregateExpression.getStandardMethod())
  const aggregation = aggregate(columnName)
  const alias = aggregateExpression.getAlias()
  if (alias) {
    const column = {}
    column[aggregation] = alias
    return column
  } else {
    return aggregation
  }
}

const _addCount = aggregateExpression => {
  const alias = aggregateExpression.getAlias()
  if (alias) {
    return { 'count(1)': alias }
  } else {
    return 'count(1)'
  }
}

const _createColumnsForAggregateExpressions = (aggregateExpressions, entity) => {
  const columns = []
  for (const aggregateExpression of aggregateExpressions) {
    // custom aggregates
    if (aggregateExpression.getPathSegments() && aggregateExpression.getPathSegments().length === 1) {
      const name =
        aggregateExpression.getPathSegments()[0].getProperty() &&
        aggregateExpression.getPathSegments()[0].getProperty().getName()
      if (
        name &&
        entity[`@Aggregation.CustomAggregate#${name}`] &&
        entity.elements[name] &&
        entity.elements[name][AGGREGATION_DEFAULT] &&
        entity.elements[name][AGGREGATION_DEFAULT]['#']
      ) {
        columns.push({ [`${entity.elements[name][AGGREGATION_DEFAULT]['#'].toLowerCase()}(${name})`]: name })
        continue
      }
    }

    _checkAggregateExpression(aggregateExpression)
    if (aggregateExpression.getExpression() && aggregateExpression.getStandardMethod() !== null) {
      columns.push(_addAggregation(aggregateExpression))
    } else {
      // checked in checkAggregateExpression to be ResourceKind.COUNT
      columns.push(_addCount(aggregateExpression))
    }
  }
  return columns
}

const _addAggregationToResult = (transformation, entity, result) => {
  const expressions = transformation.getExpressions()

  if (expressions.length) {
    result.aggregations = result.aggregations || []
    result.aggregations.push(..._createColumnsForAggregateExpressions(expressions, entity))
  }
}

const _methodName = transformation => {
  if (transformation.constructor.Method) {
    for (const method in transformation.constructor.Method) {
      if (transformation.getMethod() === transformation.constructor.Method[method]) {
        return method
      }
    }
  }
  return transformation.getMethod() // old behaviour if no method can be found
}

const _addBottomTopTransformation = (transformation, result, withGroupBy) => {
  const method = transformation.getMethod()

  if (!BOTTOMTOP_METHODS[method]) {
    throw getFeatureNotSupportedError(`Transformation "${_methodName(transformation)}" with query option $apply`)
  } else if (!withGroupBy) {
    result.orderBy = []
    result.orderBy.push({
      [_getColumnName(transformation.getValue())]: method === BottomTopMethod.TOP_COUNT ? 'desc' : 'asc'
    })
    result.limit = { top: transformation.getNumber().getText() }
  } else {
    result.bottomTop = result.bottomTop || []
    const bottomTop = BOTTOMTOP_METHODS[method]
    result.bottomTop.push(bottomTop(transformation.getNumber().getText(), _getColumnName(transformation.getValue())))
  }
}

const _handleTransformation = (transformation, entity, res) => {
  if (transformation.getTransformations()[0].getKind() === TransformationKind.AGGREGATE) {
    _addAggregationToResult(transformation.getTransformations()[0], entity, res)
  } else if (transformation.getTransformations()[0].getKind() === TransformationKind.BOTTOM_TOP) {
    _addBottomTopTransformation(transformation.getTransformations()[0], res, true)
  } else {
    throw getFeatureNotSupportedError(
      `Transformation "${_methodName(transformation.getTransformations()[0])}" with query option $apply`
    )
  }
}

function _complexProperty(pathSegments) {
  const name = []
  for (const pathSegment of pathSegments) {
    if (pathSegment.getProperty()) {
      name.push(pathSegment.getProperty().getName())
    } else if (pathSegment.getNavigationProperty()) {
      // future support for assocs in structured
      // TODO
    }
  }
  return name.join('.')
}

/**
 * Add odata apply to a CQN object.
 *
 * @param {Array<import('../okra/odata-commons/uri/apply/Transformation')>} transformations - odata-v4 transformation object
 * @param {object} entity - csn entity targeted by the request
 * @param {object} model - reflected model
 *
 * @private
 */
const applyToCQN = (transformations, entity, model) => {
  const res = {}
  for (const transformation of transformations) {
    switch (transformation.getKind()) {
      case TransformationKind.GROUP_BY:
        res.groupBy = []
        if (transformation.getTransformations().length) {
          _handleTransformation(transformation, entity, res)
        }
        for (const item of transformation.getGroupByItems()) {
          const pathSegment = item.getPathSegments().length > 0 && item.getPathSegments()[0]
          if (!pathSegment) {
            throw getFeatureNotSupportedError(
              'Transformation "groupby" with query option $apply does not support this request'
            )
          }
          if (pathSegment.getKind() === 'COMPLEX.PROPERTY') {
            throw getFeatureNotSupportedError(
              'Transformation "groupby" with query option $apply does not support complex properties'
            )
            // TODO support annotations Groupable
            // Odata spec: http://docs.oasis-open.org/odata/odata-data-aggregation-ext/v4.0/cs01/odata-data-aggregation-ext-v4.0-cs01.html#_Toc378326318
            // res.groupBy.push(_complexProperty(item.getPathSegments()))
          } else if (pathSegment.getProperty()) {
            const name = item.getPathSegments()[0].getProperty().getName()
            res.groupBy.push(name)
          } else if (pathSegment.getNavigationProperty()) {
            res.groupBy.push(_createNavGroupBy(item.getPathSegments()))
          }
        }
        break
      case TransformationKind.AGGREGATE:
        _addAggregationToResult(transformation, entity, res)
        break
      case TransformationKind.FILTER:
        res.filter = new ExpressionToCQN(entity, model).parse(transformation.getFilter())
        break
      case TransformationKind.BOTTOM_TOP:
        _addBottomTopTransformation(transformation, res)
        break
      default:
        throw getFeatureNotSupportedError(`Transformation "${transformation.getKind()}" with query option $apply`)
    }
  }

  return res
}

module.exports = applyToCQN
