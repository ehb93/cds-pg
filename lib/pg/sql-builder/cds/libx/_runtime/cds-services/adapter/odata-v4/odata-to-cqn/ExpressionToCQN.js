const odata = require('../okra/odata-server')
const ExpressionKind = odata.uri.Expression.ExpressionKind
const BinaryOperatorKind = odata.uri.BinaryExpression.OperatorKind
const UnaryOperatorKind = odata.uri.UnaryExpression.OperatorKind
const MethodKind = odata.uri.MethodExpression.MethodKind
const ResourceKind = odata.uri.UriResource.ResourceKind
const EdmPrimitiveTypeKind = odata.edm.EdmPrimitiveTypeKind
const { getFeatureNotSupportedError } = require('../../../util/errors')

const _binaryOperatorToCQN = new Map([
  [BinaryOperatorKind.EQ, '='],
  [BinaryOperatorKind.NE, '!='],
  [BinaryOperatorKind.GE, '>='],
  [BinaryOperatorKind.GT, '>'],
  [BinaryOperatorKind.LE, '<='],
  [BinaryOperatorKind.LT, '<']
])

class ExpressionToCQN {
  constructor(entity, model, columns = []) {
    this._model = model
    this._entity = entity
    this._columns = columns
  }

  _convert(expression) {
    const type = expression.getType()
    const value = expression.getText()

    if (value === null) return { val: null }

    switch (type) {
      case EdmPrimitiveTypeKind.Boolean:
        return { val: value === true || value === 'true' }
      case EdmPrimitiveTypeKind.Byte:
      case EdmPrimitiveTypeKind.SByte:
      case EdmPrimitiveTypeKind.Int16:
      case EdmPrimitiveTypeKind.Int32:
        return { val: parseInt(value) }
      case EdmPrimitiveTypeKind.Decimal:
      case EdmPrimitiveTypeKind.Single:
      case EdmPrimitiveTypeKind.Double:
        return { val: parseFloat(value) }
      case EdmPrimitiveTypeKind.DateTimeOffset: {
        try {
          let val = new Date(value).toISOString()
          // cut off ms if cds.DateTime
          if (expression._cdsType === 'cds.DateTime') val = val.replace(/\.\d\d\dZ$/, 'Z')
          return { val }
        } catch (e) {
          throw Object.assign(new Error(`The type 'Edm.DateTimeOffset' is not compatible with '${value}'`), {
            status: 400
          })
        }
      }
      default:
        return { val: value }
    }
  }

  _lambda(pathSegments) {
    // we don't care about the variable name
    if (pathSegments[0].getKind() === 'EXPRESSION.VARIABLE') pathSegments = pathSegments.slice(1)
    const nav =
      pathSegments.length > 2 ? pathSegments.slice(0, pathSegments.length - 2).map(this._segmentFromMember) : []
    const navName = this._segmentFromMember(pathSegments[pathSegments.length - 2])
    const condition = this._segmentFromMember(pathSegments[pathSegments.length - 1])

    return pathSegments[pathSegments.length - 1].getKind() === 'ALL.EXPRESSION'
      ? ['not', 'exists', { ref: [...nav, { id: navName, where: ['not', { xpr: condition }] }] }]
      : ['exists', { ref: [...nav, { id: navName, where: condition }] }]
  }

  _segmentFromMember(segment) {
    switch (segment.getKind()) {
      case ResourceKind.PRIMITIVE_PROPERTY:
      case ResourceKind.COMPLEX_PROPERTY:
      case ResourceKind.PRIMITIVE_COLLECTION_PROPERTY:
      case ResourceKind.COMPLEX_COLLECTION_PROPERTY:
        return segment.getProperty().getName()
      case ResourceKind.NAVIGATION_TO_ONE:
      case ResourceKind.NAVIGATION_TO_MANY:
        return segment.getNavigationProperty().getName()
      case ResourceKind.ALL_EXPRESSION:
      case ResourceKind.ANY_EXPRESSION:
        return segment.getExpression() ? this.parse(segment.getExpression()) : undefined
      default:
        throw getFeatureNotSupportedError(`Segment kind "${segment.getKind()}" in $filter query option`)
    }
  }

  _getMemberRecursively(pathSegments) {
    const [segment, ...nextSegments] = pathSegments

    if (!segment) return []

    if (segment.getKind() === ResourceKind.NAVIGATION_TO_ONE) {
      return [this._segmentFromMember(segment), ...this._getMemberRecursively(nextSegments)]
    }

    if (segment.getKind() === ResourceKind.EXPRESSION_VARIABLE) {
      return [...this._getMemberRecursively(nextSegments)]
    }

    if (segment.getKind() === ResourceKind.COMPLEX_PROPERTY) {
      if (nextSegments.length) {
        return [this._segmentFromMember(segment), ...this._getMemberRecursively(nextSegments)]
      }

      return [this._segmentFromMember(segment)]
    }

    return [this._segmentFromMember(segment)]
  }

  _member(expression) {
    const pathSegments = expression.getPathSegments()
    if (
      pathSegments.some(segment =>
        [ResourceKind.ANY_EXPRESSION, ResourceKind.ALL_EXPRESSION].includes(segment.getKind())
      )
    ) {
      return this._lambda(pathSegments)
    }

    const members = this._getMemberRecursively(pathSegments)
    for (const entry of this._columns) {
      // for having we need the func instead of alias / column name
      if (entry.func === members[0] || (entry.func && entry.as === members[0])) {
        return entry
      }
    }
    return { ref: members }
  }

  _getParameters(expression) {
    return expression.getParameters().map(parameter => {
      return this.parse(parameter)
    })
  }

  _genericFn(methodName, args, operator) {
    if (methodName === 'contains') {
      // contains on collection?
      try {
        const ele = args.find(ele => ele.val)
        if (ele && ele.val.match(/^\["/)) {
          ele.list = JSON.parse(ele.val).map(ele => ({ val: ele }))
          delete ele.val
        }
      } catch (e) {
        // ignore
      }
    }
    return { func: `${operator ? `${operator} ` : ''}${methodName}`, args }
  }

  /* eslint-disable complexity */
  /**
   * Evaluate an method expression, which in SQL would be 'column condition value'.
   * Can also be nested.
   *
   * @param {object} expression
   * @param {string} [operator] - Operator, that might be used to invert a method or similar
   * @throws Error - if method expression is not supported
   * @private
   * @returns {Array | object}
   */
  _method(expression, operator) {
    const parameters = this._getParameters(expression)
    const method = expression.getMethod()

    switch (method) {
      case MethodKind.NOW:
        return { val: new Date().toISOString() }
      case MethodKind.SUBSTRING:
      case MethodKind.CONTAINS:
      case MethodKind.ENDSWITH:
      case MethodKind.STARTSWITH:
      case MethodKind.INDEXOF:
      case MethodKind.TOUPPER:
      case MethodKind.TOLOWER:
      case MethodKind.DAY:
      case MethodKind.DATE:
      case MethodKind.TIME:
      case MethodKind.CEILING:
      case MethodKind.TRIM:
      case MethodKind.LENGTH:
      case MethodKind.CONCAT:
      case MethodKind.HOUR:
      case MethodKind.MINUTE:
      case MethodKind.SECOND:
      case MethodKind.MONTH:
      case MethodKind.YEAR:
      case MethodKind.FLOOR:
      case MethodKind.ROUND:
        return this._genericFn(method, parameters, operator)

      default:
        throw getFeatureNotSupportedError(`Method "${method}" in $filter or $orderby query options`)
    }
  }
  /* eslint-enable complexity */

  _ensureArr(something) {
    return Array.isArray(something) ? something : [something]
  }

  _compare(operator, left, right, unary) {
    return unary === 'not'
      ? [unary, '(', left, _binaryOperatorToCQN.get(operator), right, ')']
      : [left, _binaryOperatorToCQN.get(operator), right]
  }

  _binary(expression, unary) {
    const operator = expression.getOperator()
    const left = this.parse(expression.getLeftOperand())

    // add cds type to right operand for use in _convert
    if (left.ref && left.ref.length === 1 && this._entity && this._entity.elements[left.ref[0]]) {
      expression.getRightOperand()._cdsType = this._entity.elements[left.ref[0]].type
    }

    const right = this.parse(expression.getRightOperand())

    switch (operator) {
      case BinaryOperatorKind.AND:
        return unary === 'not'
          ? [unary, '(', ...this._ensureArr(left), 'and', ...this._ensureArr(right), ')']
          : [...this._ensureArr(left), 'and', ...this._ensureArr(right)]

      case BinaryOperatorKind.OR:
        return [
          ...(unary === 'not' ? [unary] : []),
          '(',
          ...this._ensureArr(left),
          'or',
          ...this._ensureArr(right),
          ')'
        ]

      case BinaryOperatorKind.NE:
      case BinaryOperatorKind.EQ:
      case BinaryOperatorKind.GE:
      case BinaryOperatorKind.GT:
      case BinaryOperatorKind.LE:
      case BinaryOperatorKind.LT:
        return this._compare(operator, left, right, unary)

      default:
        throw getFeatureNotSupportedError(`Binary operator "${expression.getOperator()}" in $filter query option`)
    }
  }

  _unary(expression) {
    if (expression.getOperator() !== UnaryOperatorKind.NOT) {
      throw getFeatureNotSupportedError(`Unary operator "${expression.getOperator()}" in $filter query option`)
    }

    return this.parse(expression.getOperand(), UnaryOperatorKind.NOT)
  }

  /**
   * Convert a odata-v4 filter expression object into a CQN object.
   *
   * @param {Expression} expression - odata filter expression
   * @param {string} [operator] - Operator, that might be used to invert a method or similar
   * @throws Error - if expression object is not supported
   * @returns {Array | object}
   */
  parse(expression, operator) {
    switch (expression.getKind()) {
      case ExpressionKind.ALIAS:
        return this.parse(expression.getExpression())

      case ExpressionKind.BINARY:
        operator = operator || expression.getOperator()
        return this._binary(expression, operator)

      case ExpressionKind.LITERAL:
        return this._convert(expression)

      case ExpressionKind.MEMBER:
        return this._member(expression)

      case ExpressionKind.METHOD:
        return this._method(expression, operator)

      case ExpressionKind.UNARY:
        return this._unary(expression)

      default:
        throw getFeatureNotSupportedError(`Expression "${expression.getKind()}" in $filter or $orderby query options`)
    }
  }
}

module.exports = ExpressionToCQN
