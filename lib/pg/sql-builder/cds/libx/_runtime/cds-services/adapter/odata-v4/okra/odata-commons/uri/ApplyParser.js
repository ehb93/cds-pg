'use strict'

const ExpandParser = require('./ExpandParser')
const ExpressionParser = require('./ExpressionParser')
const FilterParser = require('./FilterParser')
const OrderByParser = require('./OrderByParser')
const SearchParser = require('./SearchParser')
const TokenKind = require('./UriTokenizer').TokenKind
const EdmPrimitiveTypeKind = require('../edm/EdmPrimitiveTypeKind')
const EdmTypeKind = require('../edm/EdmType').TypeKind
const TransientStructuredType = require('../edm/TransientStructuredType')
const FullQualifiedName = require('../FullQualifiedName')
const UriResource = require('./UriResource')
const ResourceKind = UriResource.ResourceKind
const QueryOption = require('./UriInfo').QueryOptions
const UriSyntaxError = require('../errors/UriSyntaxError')
const UriSemanticError = require('../errors/UriSemanticError')
const UriQueryOptionSemanticError = require('../errors/UriQueryOptionSemanticError')
const FeatureSupport = require('../FeatureSupport')

const AggregateTransformation = require('./apply/AggregateTransformation')
const AggregateExpression = require('./apply/AggregateExpression')
const BottomTopTransformation = require('./apply/BottomTopTransformation')
const ComputeTransformation = require('./apply/ComputeTransformation')
const ComputeExpression = require('./apply/ComputeExpression')
const ConcatTransformation = require('./apply/ConcatTransformation')
const CustomFunctionTransformation = require('./apply/CustomFunctionTransformation')
const ExpandTransformation = require('./apply/ExpandTransformation')
const FilterTransformation = require('./apply/FilterTransformation')
const GroupByTransformation = require('./apply/GroupByTransformation')
const GroupByItem = require('./apply/GroupByItem')
const IdentityTransformation = require('./apply/IdentityTransformation')
const OrderByTransformation = require('./apply/OrderByTransformation')
const SearchTransformation = require('./apply/SearchTransformation')
const SkipTransformation = require('./apply/SkipTransformation')
const TopTransformation = require('./apply/TopTransformation')
const ExpandItem = require('./ExpandItem')
const MemberExpression = require('./MemberExpression')

class ApplyParser {
  /**
   * Create an apply parser.
   * @param {Edm} edm entity data model
   */
  constructor (edm) {
    this._edm = edm
    this._expressionParser = new ExpressionParser(edm)
  }

  /**
   * Parse a string into an array of transformations and adapt the referenced type to the resulting structure.
   * @param {UriTokenizer} tokenizer tokenizer containing the string to be parsed
   * @param {?TransientStructuredType} referencedType type that the apply option references
   * @param {?(string[])} crossjoinEntitySetNames entityset names in case of a $crossjoin request
   * @param {?Object} aliases alias definitions
   * @returns {Transformation[]} the transformations
   * @throws {UriSyntaxError}
   * @throws {UriQueryOptionSemanticError}
   */
  parse (tokenizer, referencedType, crossjoinEntitySetNames, aliases) {
    this._tokenizer = tokenizer
    this._crossjoinEntitySetNames = crossjoinEntitySetNames
    this._aliases = aliases

    return this._parseApply(referencedType)
  }

  /**
   * Parse an apply option.
   * @param {?TransientStructuredType} referencedType type that the apply option references
   * @returns {Transformation[]} the parsed transformations
   * @throws {UriSyntaxError}
   * @throws {UriQueryOptionSemanticError}
   * @private
   */
  _parseApply (referencedType) {
    let apply = []
    do {
      apply.push(this._parseTrafo(referencedType))
    } while (this._tokenizer.next(TokenKind.SLASH))
    return apply
  }

  /**
   * Parse a transformation.
   * @param {?TransientStructuredType} referencedType type that the transformation references
   * @returns {Transformation} the parsed transformation
   * @throws {UriSyntaxError}
   * @throws {UriQueryOptionSemanticError}
   * @private
   */
  _parseTrafo (referencedType) {
    if (this._tokenizer.next(TokenKind.AggregateTrafo)) {
      return this._parseAggregateTrafo(referencedType)
    } else if (this._tokenizer.next(TokenKind.IDENTITY)) {
      return new IdentityTransformation()
    } else if (this._tokenizer.next(TokenKind.ComputeTrafo)) {
      return this._parseComputeTrafo(referencedType)
    } else if (this._tokenizer.next(TokenKind.ConcatMethod)) {
      return this._parseConcatTrafo(referencedType)
    } else if (this._tokenizer.next(TokenKind.ExpandTrafo)) {
      return new ExpandTransformation().setExpand(this._parseExpandTrafo(referencedType))
    } else if (this._tokenizer.next(TokenKind.FilterTrafo)) {
      const filter = new FilterParser(this._edm).parse(
        this._tokenizer,
        referencedType,
        this._crossjoinEntitySetNames,
        this._aliases
      )
      this._tokenizer.requireNext(TokenKind.CLOSE)
      return new FilterTransformation().setFilter(filter)
    } else if (this._tokenizer.next(TokenKind.GroupByTrafo)) {
      return this._parseGroupByTrafo(referencedType)
    } else if (this._tokenizer.next(TokenKind.OrderByTrafo)) {
      const orderBy = new OrderByParser(this._edm).parse(
        this._tokenizer,
        referencedType,
        this._crossjoinEntitySetNames,
        this._aliases
      )
      this._tokenizer.requireNext(TokenKind.CLOSE)
      return new OrderByTransformation().setOrderBy(orderBy)
    } else if (this._tokenizer.next(TokenKind.SearchTrafo)) {
      const search = new SearchParser().parse(this._tokenizer)
      this._tokenizer.requireNext(TokenKind.CLOSE)
      return new SearchTransformation().setSearch(search)
    } else if (this._tokenizer.next(TokenKind.SkipTrafo)) {
      this._tokenizer.requireNext(TokenKind.UnsignedIntegerValue)
      const skip = Number.parseInt(this._tokenizer.getText(), 10)
      this._tokenizer.requireNext(TokenKind.CLOSE)
      if (!Number.isSafeInteger(skip)) {
        throw new UriSyntaxError(UriSyntaxError.Message.OPTION_NON_NEGATIVE_INTEGER, 'skip')
      }
      return new SkipTransformation().setSkip(skip)
    } else if (this._tokenizer.next(TokenKind.TopTrafo)) {
      this._tokenizer.requireNext(TokenKind.UnsignedIntegerValue)
      const top = Number.parseInt(this._tokenizer.getText(), 10)
      this._tokenizer.requireNext(TokenKind.CLOSE)
      if (!Number.isSafeInteger(top)) {
        throw new UriSyntaxError(UriSyntaxError.Message.OPTION_NON_NEGATIVE_INTEGER, 'top')
      }
      return new TopTransformation().setTop(top)
    } else if (this._tokenizer.next(TokenKind.QualifiedName)) {
      return this._parseCustomFunction(referencedType)
    } else {
      // eslint-disable-line no-else-return
      return this._parseBottomTop(referencedType)
    }
  }

  /**
   * Parse an aggregate transformation.
   * @param {?TransientStructuredType} referencedType type that the transformation references
   * @returns {AggregateTransformation} the parsed transformation
   * @throws {UriSyntaxError}
   * @throws {UriQueryOptionSemanticError}
   * @private
   */
  _parseAggregateTrafo (referencedType) {
    let aggregate = new AggregateTransformation()
    let properties = new Map()
    do {
      let type = new TransientStructuredType(referencedType)
      aggregate.addExpression(this._parseAggregateExpr(type))
      for (const [name, property] of type.getProperties()) {
        if (property === referencedType.getProperty(name)) continue
        if (properties.has(name)) {
          throw new UriQueryOptionSemanticError(UriQueryOptionSemanticError.Message.IS_PROPERTY, name)
        }
        properties.set(name, property)
      }
    } while (this._tokenizer.next(TokenKind.COMMA))
    this._tokenizer.requireNext(TokenKind.CLOSE)

    for (const [name, val] of referencedType.getProperties()) {
      if (!referencedType.isProtected(name)) {
        referencedType.addIgnoredProperty(val)
      }
    }

    referencedType.deleteProperties()
    for (const property of properties.values()) referencedType.addProperty(property)
    return aggregate
  }

  /**
   * Parse an aggregate expression.
   * @param {?TransientStructuredType} referencedType type that the expression references
   * @returns {AggregateExpression} the parsed expression
   * @throws {UriSyntaxError}
   * @throws {UriQueryOptionSemanticError}
   * @private
   */
  _parseAggregateExpr (referencedType) {
    this._tokenizer.saveState()
    let aggregateExpression
    let error

    // First try is checking for a common expression.
    try {
      aggregateExpression = new AggregateExpression()
      const expression = this._expressionParser.parse(
        this._tokenizer,
        referencedType,
        this._crossjoinEntitySetNames,
        this._aliases
      )
      aggregateExpression.setExpression(expression)
      const customMethods = referencedType.getCustomAggregationMethods()
      this._parseAggregateWith(aggregateExpression, customMethods)
      switch (aggregateExpression.getStandardMethod()) {
        case null:
          if (aggregateExpression.getCustomMethod() === null) {
            throw new UriSyntaxError(
              UriSyntaxError.Message.WRONG_AGGREGATE_EXPRESSION_SYNTAX,
              this._tokenizer.getPosition()
            )
          }
          break
        case AggregateExpression.StandardMethod.MIN:
        case AggregateExpression.StandardMethod.MAX:
          this._expressionParser.checkNoCollection(expression)
          if (
            expression.getType().getKind() !== EdmTypeKind.PRIMITIVE &&
            expression.getType().getKind() !== EdmTypeKind.ENUM &&
            expression.getType().getKind() !== EdmTypeKind.DEFINITION
          ) {
            throw new UriQueryOptionSemanticError(
              UriQueryOptionSemanticError.Message.ONLY_FOR_PRIMITIVE_TYPES,
              'aggregate'
            )
          }
          break
        case AggregateExpression.StandardMethod.SUM:
        case AggregateExpression.StandardMethod.AVERAGE:
          this._expressionParser.checkNumericType(expression)
          break
        default:
      }
      const alias = this._parseAsAlias(referencedType, true)
      aggregateExpression.setAlias(alias)
      referencedType.addProperty(
        this._createDynamicAggregationProperty(
          alias,
          aggregateExpression.getStandardMethod(),
          aggregateExpression.getCustomMethod()
            ? customMethods.get(aggregateExpression.getCustomMethod().toString())
            : expression.getType()
        )
      )
      this._parseAggregateFrom(aggregateExpression, referencedType)
      return aggregateExpression
    } catch (err) {
      error = err
    }

    // No legitimate continuation of a common expression has been found.
    // Second try is checking for a (potentially empty) path prefix and the things that could follow it.
    this._tokenizer.returnToSavedState()
    aggregateExpression = new AggregateExpression()

    const pathSegments = this._parsePathPrefix(referencedType)
    const identifierLeft = pathSegments && pathSegments.length && !pathSegments[pathSegments.length - 1].getKind()
    let type = referencedType
    if (identifierLeft && pathSegments.length > 1) type = pathSegments[pathSegments.length - 2].getEdmType()
    if (!identifierLeft && pathSegments.length) type = pathSegments[pathSegments.length - 1].getEdmType()
    const slashLeft = this._tokenizer.getText() === '/'

    // A custom aggregate (an OData identifier) is defined in the
    // CustomAggregate EDM annotation (in namespace Org.OData.Aggregation.V1)
    // of the structured type or of the entity container.
    // Instead of looking into annotations, we expect the custom aggregate
    // to be declared in the service configuration.
    // Its name could be a property name, too, and the specification says
    // "the name refers to the custom aggregate within an aggregate expression
    // without a with clause, and to the property in all other cases."
    if (
      identifierLeft &&
      type.getCustomAggregates().has(this._tokenizer.getText()) &&
      !this._tokenizer.next(TokenKind.WithOperator)
    ) {
      const customAggregate = this._tokenizer.getText()
      const customAggregateType = type.getCustomAggregates().get(customAggregate)
      const property = this._createDynamicProperty(customAggregate, customAggregateType)
      pathSegments[pathSegments.length - 1].setKind(ResourceKind.PRIMITIVE_PROPERTY).setProperty(property)
      aggregateExpression.setPathSegments(pathSegments)
      const alias = this._parseAsAlias(referencedType, false)
      if (alias) {
        aggregateExpression.setAlias(alias)
        referencedType.addProperty(this._createDynamicProperty(alias, customAggregateType))
      } else if (type.addProperty) type.addProperty(property) // TODO: Add property to related types.

      this._parseAggregateFrom(aggregateExpression, referencedType)
    } else if (
      !identifierLeft &&
      !slashLeft &&
      type.getKind() === EdmTypeKind.ENTITY &&
      this._tokenizer.next(TokenKind.OPEN)
    ) {
      if (!pathSegments.length) {
        throw new UriSyntaxError(
          UriSyntaxError.Message.WRONG_AGGREGATE_EXPRESSION_SYNTAX,
          this._tokenizer.getPosition()
        )
      }
      aggregateExpression.setPathSegments(pathSegments)
      let inlineType = new TransientStructuredType(type)
      aggregateExpression.setInlineAggregateExpression(this._parseAggregateExpr(inlineType))
      this._tokenizer.requireNext(TokenKind.CLOSE)
    } else if (!identifierLeft && (slashLeft || !pathSegments.length) && this._tokenizer.next(TokenKind.COUNT)) {
      pathSegments.push(new UriResource().setKind(ResourceKind.COUNT))
      aggregateExpression.setPathSegments(pathSegments)
      const alias = this._parseAsAlias(referencedType, true)
      aggregateExpression.setAlias(alias)
      referencedType.addProperty(
        this._createDynamicProperty(
          alias,
          // The OData standard mandates Edm.Decimal (with no decimals), although counts are always integer.
          EdmPrimitiveTypeKind.Decimal,
          null,
          0
        )
      )
    } else {
      // If there is still no success, we throw the error from the first try,
      // assuming it to be the case the user intended.
      throw error
    }
    return aggregateExpression
  }

  /**
   * Parse the "with" part of an aggregate expression.
   * @param {AggregateExpression} aggregateExpression the aggregate expression
   * @param {Map.<string, EdmPrimitiveType|EdmTypeDefinition>} customAggregationMethods the defined custom aggregation methods
   * @throws {UriSyntaxError}
   * @private
   */
  _parseAggregateWith (aggregateExpression, customAggregationMethods) {
    if (this._tokenizer.next(TokenKind.WithOperator)) {
      if (this._tokenizer.next(TokenKind.QualifiedName)) {
        const customMethod = this._tokenizer.getText()
        // A custom aggregation method is announced in the CustomAggregationMethods
        // EDM annotation (in namespace Org.OData.Aggregation.V1) of the structured type
        // or of the entity container.
        // Instead of looking into annotations, we expect the custom aggregation methods
        // to be declared in the service configuration.
        if (customAggregationMethods.has(customMethod)) {
          aggregateExpression.setCustomMethod(FullQualifiedName.createFromNameSpaceAndName(customMethod))
        } else {
          throw new UriQueryOptionSemanticError(
            UriQueryOptionSemanticError.Message.CUSTOM_AGGREGATION_METHOD_NOT_FOUND,
            customMethod
          )
        }
      } else if (this._tokenizer.next(TokenKind.SUM)) {
        aggregateExpression.setStandardMethod(AggregateExpression.StandardMethod.SUM)
      } else if (this._tokenizer.next(TokenKind.MIN)) {
        aggregateExpression.setStandardMethod(AggregateExpression.StandardMethod.MIN)
      } else if (this._tokenizer.next(TokenKind.MAX)) {
        aggregateExpression.setStandardMethod(AggregateExpression.StandardMethod.MAX)
      } else if (this._tokenizer.next(TokenKind.AVERAGE)) {
        aggregateExpression.setStandardMethod(AggregateExpression.StandardMethod.AVERAGE)
      } else if (this._tokenizer.next(TokenKind.COUNTDISTINCT)) {
        aggregateExpression.setStandardMethod(AggregateExpression.StandardMethod.COUNT_DISTINCT)
      } else {
        throw new UriSyntaxError(UriSyntaxError.Message.WRONG_WITH_SYNTAX, this._tokenizer.getPosition())
      }
    }
  }

  /**
   * Parse the alias part of an aggregate expression.
   * @param {?(TransientStructuredType|EdmEntityType|EdmComplexType)} referencedType type that the expression references
   * @param {boolean} isRequired whether the alias is required
   * @returns {?string} the alias name
   * @throws {UriSyntaxError}
   * @throws {UriQueryOptionSemanticError}
   * @private
   */
  _parseAsAlias (referencedType, isRequired) {
    if (this._tokenizer.next(TokenKind.AsOperator)) {
      this._tokenizer.requireNext(TokenKind.ODataIdentifier)
      const name = this._tokenizer.getText()
      if (referencedType.getProperty(name)) {
        throw new UriQueryOptionSemanticError(UriQueryOptionSemanticError.Message.IS_PROPERTY, name)
      }
      return name
    } else if (isRequired) {
      throw new UriSyntaxError(UriSyntaxError.Message.ALIAS_EXPECTED, this._tokenizer.getPosition())
    }
    return null
  }

  /**
   * Parse the "from" part of an aggregate expression.
   * @param {AggregateExpression} aggregateExpression the aggregate expression
   * @param {?(TransientStructuredType|EdmEntityType|EdmComplexType)} referencedType type that the expression references
   * @throws {UriSyntaxError}
   * @throws {UriQueryOptionSemanticError}
   * @private
   */
  _parseAggregateFrom (aggregateExpression, referencedType) {
    while (this._tokenizer.next(TokenKind.FromOperator)) {
      const expression = new MemberExpression(this._parseGroupingProperty(referencedType), referencedType)
      let from = new AggregateExpression().setExpression(expression)
      this._parseAggregateWith(from, referencedType.getCustomAggregationMethods())
      if (
        from.getStandardMethod() === AggregateExpression.StandardMethod.SUM ||
        from.getStandardMethod() === AggregateExpression.StandardMethod.AVERAGE
      ) {
        this._expressionParser.checkNumericType(expression)
      }
      aggregateExpression.addFrom(from)
    }
  }

  /**
   * Create a dynamic structural property.
   * @param {string} name the name of the property
   * @param {?EdmPrimitiveType} type the type of the property
   * @param {?number} [precision] the precision facet of the property
   * @param {?(number|string)} [scale] the scale facet of the property
   * @returns {Object} the dynamic property as look-alike of EdmProperty
   * @private
   */
  _createDynamicProperty (name, type, precision, scale) {
    return {
      getName: () => name,
      getType: () => type,
      isCollection: () => false,
      isNullable: () => true,
      getMaxLength: () => null,
      getPrecision: () => (precision === undefined ? null : precision),
      getScale: () => (scale === undefined ? 'variable' : scale),
      getSrid: () => 'variable',
      isUnicode: () => true,
      getDefaultValue: () => null,
      isPrimitive: () => true,
      getAnnotations: () => []
    }
  }

  /**
   * Create a dynamic aggregation property and set its type according to the result type of the aggregation method.
   * @param {string} name the name of the property
   * @param {?AggregateExpression.StandardMethod} method the aggregation method
   * @param {EdmPrimitiveType} type type the method acts on
   * @returns {Object} the dynamic property as look-alike of EdmProperty
   * @private
   */
  _createDynamicAggregationProperty (name, method, type) {
    const resultType =
      method === AggregateExpression.StandardMethod.COUNT_DISTINCT ||
      method === AggregateExpression.StandardMethod.SUM ||
      method === AggregateExpression.StandardMethod.AVERAGE
        ? EdmPrimitiveTypeKind.Decimal
        : type
    const precision =
      resultType === EdmPrimitiveTypeKind.DateTimeOffset ||
      resultType === EdmPrimitiveTypeKind.Duration ||
      resultType === EdmPrimitiveTypeKind.TimeOfDay
        ? 12
        : null
    const scale = method === AggregateExpression.StandardMethod.COUNT_DISTINCT ? 0 : 'variable'
    return this._createDynamicProperty(name, resultType, precision, scale)
  }

  /**
   * Parse a compute transformation.
   * @param {?TransientStructuredType} referencedType type that the transformation references
   * @returns {ComputeTransformation} the parsed transformation
   * @throws {UriSyntaxError}
   * @throws {UriQueryOptionSemanticError}
   * @private
   */
  _parseComputeTrafo (referencedType) {
    let compute = new ComputeTransformation()
    do {
      const expression = this._expressionParser.parse(
        this._tokenizer,
        referencedType,
        this._crossjoinEntitySetNames,
        this._aliases
      )
      this._expressionParser.checkNoCollection(expression)
      const expressionTypeKind = expression.getType().getKind()
      if (
        expressionTypeKind !== EdmTypeKind.PRIMITIVE &&
        expressionTypeKind !== EdmTypeKind.ENUM &&
        expressionTypeKind !== EdmTypeKind.DEFINITION
      ) {
        throw new UriQueryOptionSemanticError(UriQueryOptionSemanticError.Message.ONLY_FOR_PRIMITIVE_TYPES, 'compute')
      }
      const alias = this._parseAsAlias(referencedType, true)
      referencedType.addProperty(this._createDynamicProperty(alias, expression.getType()))
      compute.addExpression(new ComputeExpression().setExpression(expression).setAlias(alias))
    } while (this._tokenizer.next(TokenKind.COMMA))
    this._tokenizer.requireNext(TokenKind.CLOSE)
    return compute
  }

  /**
   * Parse a concat transformation.
   * @param {?TransientEdmStructuredType} referencedType type that the transformation references
   * @returns {ConcatTransformation} the parsed transformation
   * @throws {UriSyntaxError}
   * @throws {UriQueryOptionSemanticError}
   * @private
   */
  _parseConcatTrafo (referencedType) {
    let concat = new ConcatTransformation()

    // Each sub-transformation could aggregate properties away,
    // so it has to start with the original referenced type to avoid
    // unintended consequences for subsequent sub-transformations.
    // Each sub-transformation adds its properties to the resulting properties.
    let types = []
    do {
      let type = new TransientStructuredType(referencedType)
      concat.addSequence(this._parseApply(type))
      types.push(type)
    } while (this._tokenizer.next(TokenKind.COMMA))
    if (concat.getSequences().length < 2) this._tokenizer.requireNext(TokenKind.COMMA) // for the error message
    this._tokenizer.requireNext(TokenKind.CLOSE)

    let properties = new Map()
    for (const type of types) {
      for (const [name, property] of type.getProperties()) {
        if (properties.has(name)) {
          if (this._expressionParser.isCompatible(properties.get(name).getType(), property.getType())) {
            continue
          }
          if (!this._expressionParser.isCompatible(property.getType(), properties.get(name).getType())) {
            throw new UriQueryOptionSemanticError(
              UriSemanticError.Message.INCOMPATIBLE_TYPE,
              property.getType().getFullQualifiedName(),
              properties
                .get(name)
                .getType()
                .getFullQualifiedName()
            )
          }
        }
        properties.set(name, property)
      }
    }
    for (const [name, property] of properties) {
      referencedType.addProperty(property, types.some(type => !type.getProperty(name)))
    }
    referencedType.deleteProperties()

    return concat
  }

  /**
   * Parse an expand transformation.
   * @param {?TransientStructuredType} referencedType type that the transformation references
   * @returns {ExpandItem} the parsed expand item
   * @throws {UriSyntaxError}
   * @throws {UriQueryOptionSemanticError}
   * @private
   */
  _parseExpandTrafo (referencedType) {
    let item = new ExpandItem()
    const pathSegments = new ExpandParser(this._edm).parseExpandPath(
      this._tokenizer,
      referencedType,
      this._crossjoinEntitySetNames
    )
    if (!pathSegments.length) {
      throw new UriSyntaxError(
        UriSyntaxError.Message.EXPAND_NO_VALID_PATH,
        this._tokenizer.getParseString(),
        this._tokenizer.getPosition()
      )
    }
    item.setPathSegments(pathSegments)
    const type = pathSegments[pathSegments.length - 1].getEdmType()
    if (this._tokenizer.next(TokenKind.COMMA)) {
      if (this._tokenizer.next(TokenKind.FilterTrafo)) {
        item.setOption(
          QueryOption.FILTER,
          new FilterParser(this._edm).parse(this._tokenizer, type, this._crossjoinEntitySetNames, this._aliases)
        )
        this._tokenizer.requireNext(TokenKind.CLOSE)
      } else {
        this._tokenizer.requireNext(TokenKind.ExpandTrafo)
        item.setOption(QueryOption.EXPAND, [this._parseExpandTrafo(type)])
      }
    }
    while (this._tokenizer.next(TokenKind.COMMA)) {
      this._tokenizer.requireNext(TokenKind.ExpandTrafo)
      let nestedExpands = item.getOption(QueryOption.EXPAND) || []
      nestedExpands.push(this._parseExpandTrafo(type))
      item.setOption(QueryOption.EXPAND, nestedExpands)
    }
    this._tokenizer.requireNext(TokenKind.CLOSE)
    return item
  }

  /**
   * Parse a group-by transformation.
   * @param {?TransientStructuredType} referencedType type that the transformation references
   * @returns {GroupByTransformation} the parsed transformation
   * @throws {UriSyntaxError}
   * @throws {UriQueryOptionSemanticError}
   * @private
   */
  _parseGroupByTrafo (referencedType) {
    let groupBy = new GroupByTransformation()
    this._parseGroupByList(groupBy, referencedType)
    if (this._tokenizer.next(TokenKind.COMMA)) {
      groupBy.setTransformations(this._parseApply(referencedType))
    }
    for (const [name, val] of referencedType.getProperties()) {
      if (!referencedType.isProtected(name)) {
        referencedType.addIgnoredProperty(val)
      }
    }
    for (const [name, val] of referencedType.getNavigationProperties()) {
      if (!referencedType.isProtected(name)) {
        referencedType.addIgnoredNavigationProperty(val)
      }
    }
    this._tokenizer.requireNext(TokenKind.CLOSE)
    referencedType.deleteProperties()
    referencedType.unprotectProperties()
    return groupBy
  }

  /**
   * Parse the list of groups.
   * @param {GroupByItem} groupBy the current group-by item
   * @param {?(TransientStructuredType|EdmEntityType|EdmComplexType)} referencedType type that the group-by references
   * @private
   */
  _parseGroupByList (groupBy, referencedType) {
    this._tokenizer.requireNext(TokenKind.OPEN)
    do {
      groupBy.addGroupByItem(this._parseGroupByElement(referencedType))
    } while (this._tokenizer.next(TokenKind.COMMA))
    this._tokenizer.requireNext(TokenKind.CLOSE)
  }

  /**
   * Parse the group-by element.
   * @param {?(TransientStructuredType|EdmEntityType|EdmComplexType)} referencedType type that the group-by references
   * @returns {GroupByItem} the group-by item object
   * @private
   */
  _parseGroupByElement (referencedType) {
    return this._tokenizer.next(TokenKind.RollUpSpec)
      ? this._parseRollUpSpec(referencedType)
      : new GroupByItem().setPathSegments(this._parseGroupingProperty(referencedType))
  }

  /**
   * Parse the rollup.
   * @param {?(TransientStructuredType|EdmEntityType|EdmComplexType)} referencedType type that the rollup references
   * @returns {GroupByItem} the rollup
   * @private
   */
  _parseRollUpSpec (referencedType) {
    let item = new GroupByItem()
    if (this._tokenizer.next(TokenKind.ALL)) {
      item.setIsRollupAll()
    } else {
      item.addRollupItem(new GroupByItem().setPathSegments(this._parseGroupingProperty(referencedType)))
    }
    this._tokenizer.requireNext(TokenKind.COMMA)
    do {
      item.addRollupItem(new GroupByItem().setPathSegments(this._parseGroupingProperty(referencedType)))
    } while (this._tokenizer.next(TokenKind.COMMA))
    this._tokenizer.requireNext(TokenKind.CLOSE)
    return item
  }

  /**
   * Parse the path to the grouping property.
   * @param {?(TransientStructuredType|EdmEntityType|EdmComplexType)} referencedType type that the path references
   * @returns {UriResource[]} path segments
   * @private
   */
  _parseGroupingProperty (referencedType) {
    let pathSegments = this._parsePathPrefix(referencedType)
    const leftOver =
      (pathSegments.length && !pathSegments[pathSegments.length - 1].getKind()) || this._tokenizer.getText() === '/'
    if (pathSegments.length && !pathSegments[pathSegments.length - 1].getKind()) pathSegments.pop()
    if (this._tokenizer.getText() === '/') this._tokenizer.requireNext(TokenKind.ODataIdentifier)
    if (leftOver) {
      const type = pathSegments.length ? pathSegments[pathSegments.length - 1].getEdmType() : referencedType
      const property = type.getProperty(this._tokenizer.getText())
      if (!property) {
        throw new UriQueryOptionSemanticError(
          UriSemanticError.Message.PROPERTY_NOT_FOUND,
          this._tokenizer.getText(),
          type.getFullQualifiedName()
        )
      }
      pathSegments.push(this._createPropertyResource(property))
    }
    if (pathSegments[pathSegments.length - 1].isCollection()) {
      throw new UriQueryOptionSemanticError(UriQueryOptionSemanticError.Message.COLLECTION)
    }
    if (!pathSegments.length) this._tokenizer.requireNext(TokenKind.ODataIdentifier) // for the error message
    // TODO: Generalize to more than one segment and to other than structural properties.
    if (pathSegments.length === 1 && pathSegments[0].getProperty()) {
      referencedType.protectProperty(pathSegments[0].getProperty().getName())
    }
    return pathSegments
  }

  /**
   * Parse the path prefix and a following OData identifier as one path, deviating from the ABNF.
   * @param {?(TransientStructuredType|EdmEntityType|EdmComplexType)} referencedType type that the path references
   * @returns {UriResource[]} path segments
   * @private
   */
  _parsePathPrefix (referencedType) {
    let pathSegments = []
    let type = referencedType
    if (this._tokenizer.next(TokenKind.QualifiedName)) {
      const typeCast = this._parseTypeCast(type)
      pathSegments.push(new UriResource().setKind(ResourceKind.TYPE_CAST).setTypeCast(typeCast))
      this._tokenizer.requireNext(TokenKind.SLASH)
      type = typeCast
    }
    let hasSlash
    do {
      hasSlash = false
      if (this._tokenizer.next(TokenKind.ODataIdentifier)) {
        const property = type.getProperty(this._tokenizer.getText())
        if (property && (property.getEntityType || property.getType().getKind() === EdmTypeKind.COMPLEX)) {
          pathSegments.push(this._createPropertyResource(property))
          type = property.getType ? property.getType() : property.getEntityType()
          if (this._tokenizer.next(TokenKind.SLASH)) {
            hasSlash = true
            if (this._tokenizer.next(TokenKind.QualifiedName)) {
              type = this._parseTypeCast(type)
              pathSegments.push(new UriResource().setKind(ResourceKind.TYPE_CAST).setTypeCast(type))
              hasSlash = false
            }
          }
        } else {
          pathSegments.push(new UriResource())
          break
        }
      } else {
        break
      }
    } while (hasSlash || this._tokenizer.next(TokenKind.SLASH))
    return pathSegments
  }

  /**
   * Parse type cast.
   * @param {?(TransientStructuredType|EdmEntityType|EdmComplexType)} referencedType type that the type cast references
   * @returns {?(EdmEntityType|EdmComplexType)} the type of the cast
   * @private
   */
  _parseTypeCast (referencedType) {
    const qualifiedName = this._tokenizer.getText()
    const fqn = FullQualifiedName.createFromNameSpaceAndName(qualifiedName)
    const compareType =
      referencedType instanceof TransientStructuredType ? referencedType.getBaseType() : referencedType
    const isEntityType = compareType.getKind() === EdmTypeKind.ENTITY
    const type = isEntityType ? this._edm.getEntityType(fqn) : this._edm.getComplexType(fqn)
    if (!type) {
      throw new UriQueryOptionSemanticError(
        isEntityType
          ? UriSemanticError.Message.ENTITY_TYPE_NOT_FOUND
          : UriQueryOptionSemanticError.Message.COMPLEX_TYPE_NOT_FOUND,
        qualifiedName
      )
    }
    if (!type.compatibleTo(compareType)) {
      throw new UriQueryOptionSemanticError(
        UriSemanticError.Message.INCOMPATIBLE_TYPE,
        qualifiedName,
        referencedType.getFullQualifiedName()
      )
    }

    // Type casts are explicitly not supported (although the parser can parse them).
    FeatureSupport.failUnsupported(FeatureSupport.features.TypeCast, qualifiedName, this._tokenizer.getPosition())
    return type
  }

  /**
   * Create a property-resource segment.
   * @param {EdmProperty|EdmNavigationProperty} property the structural or navigation property
   * @returns {UriResource} the property resource segment
   * @private
   */
  _createPropertyResource (property) {
    const isCollection = property.isCollection()
    const isNavigation = property.getEntityType !== undefined
    let kind
    if (isNavigation) {
      kind = isCollection ? ResourceKind.NAVIGATION_TO_MANY : ResourceKind.NAVIGATION_TO_ONE
    } else if (property.getType().getKind() === EdmTypeKind.COMPLEX) {
      kind = isCollection ? ResourceKind.COMPLEX_COLLECTION_PROPERTY : ResourceKind.COMPLEX_PROPERTY
    } else {
      kind = isCollection ? ResourceKind.PRIMITIVE_COLLECTION_PROPERTY : ResourceKind.PRIMITIVE_PROPERTY
    }
    return new UriResource()
      .setProperty(isNavigation ? null : property)
      .setNavigationProperty(isNavigation ? property : null)
      .setIsCollection(isCollection)
      .setKind(kind)
  }

  /**
   * Parse a custom-function transformation.
   * @param {?TransientStructuredType} referencedType type that the transformation references
   * @returns {CustomFunctionTransformation} the parsed transformation
   * @throws {UriSyntaxError}
   * @throws {UriQueryOptionSemanticError}
   * @private
   */
  _parseCustomFunction (referencedType) {
    const fullQualifiedName = FullQualifiedName.createFromNameSpaceAndName(this._tokenizer.getText())
    const bindingParameterType = referencedType.getBaseType()

    let visitedParameters = new Map()
    let names = []
    this._tokenizer.requireNext(TokenKind.OPEN)
    if (!this._tokenizer.next(TokenKind.CLOSE)) {
      do {
        this._tokenizer.requireNext(TokenKind.ODataIdentifier)
        const name = this._tokenizer.getText()
        if (visitedParameters.has(name)) {
          throw new UriQueryOptionSemanticError(UriQueryOptionSemanticError.Message.DUPLICATE_PARAMETER, name)
        }
        this._tokenizer.requireNext(TokenKind.EQ)
        const expression = this._expressionParser.parse(
          this._tokenizer,
          referencedType,
          this._crossjoinEntitySets,
          this._aliases
        )
        visitedParameters.set(name, expression)
        names.push(name)
      } while (this._tokenizer.next(TokenKind.COMMA))
      this._tokenizer.requireNext(TokenKind.CLOSE)
    }

    const func = this._edm.getBoundFunction(fullQualifiedName, bindingParameterType.getFullQualifiedName(), true, names)
    if (!func) {
      throw new UriQueryOptionSemanticError(
        UriSemanticError.Message.FUNCTION_NOT_FOUND,
        fullQualifiedName.toString(),
        names.join(', ')
      )
    }

    // The parameters can only be validated after determining which of the overloaded functions we have.
    const parameters = this._expressionParser.getValidatedParameters(func, visitedParameters)

    // The binding parameter and the return type must be of type complex or entity collection.
    const bindingParameter = func
      .getParameters()
      .values()
      .next().value
    const returnType = func.getReturnType()
    if (
      (bindingParameter.getType().getKind() !== EdmTypeKind.ENTITY &&
        bindingParameter.getType().getKind() !== EdmTypeKind.COMPLEX) ||
      !bindingParameter.isCollection() ||
      (returnType.getType().getKind() !== EdmTypeKind.ENTITY &&
        returnType.getType().getKind() !== EdmTypeKind.COMPLEX) ||
      !returnType.isCollection()
    ) {
      throw new UriQueryOptionSemanticError(
        UriQueryOptionSemanticError.Message.FUNCTION_MUST_USE_COLLECTIONS,
        fullQualifiedName.toString()
      )
    }

    // TODO: What if the referenced type has been changed by previous transformations?

    // Set referenced type to result type of the function.
    referencedType.deleteProperties()
    for (const property of returnType
      .getType()
      .getProperties()
      .values()) {
      referencedType.addProperty(property)
    }

    return new CustomFunctionTransformation().setFunction(func).setParameters(parameters)
  }

  /**
   * Parse a partial-aggregation transformation.
   * @param {?(TransientStructuredType|EdmEntityType|EdmComplexType)} referencedType type that the transformation references
   * @returns {BottomTopTransformation} the parsed transformation
   * @throws {UriSyntaxError}
   * @throws {UriQueryOptionSemanticError}
   * @private
   */
  _parseBottomTop (referencedType) {
    let bottomTop = new BottomTopTransformation()

    if (this._tokenizer.next(TokenKind.BottomCountTrafo)) {
      bottomTop.setMethod(BottomTopTransformation.Method.BOTTOM_COUNT)
    } else if (this._tokenizer.next(TokenKind.BottomPercentTrafo)) {
      bottomTop.setMethod(BottomTopTransformation.Method.BOTTOM_PERCENT)
    } else if (this._tokenizer.next(TokenKind.BottomSumTrafo)) {
      bottomTop.setMethod(BottomTopTransformation.Method.BOTTOM_SUM)
    } else if (this._tokenizer.next(TokenKind.TopCountTrafo)) {
      bottomTop.setMethod(BottomTopTransformation.Method.TOP_COUNT)
    } else if (this._tokenizer.next(TokenKind.TopPercentTrafo)) {
      bottomTop.setMethod(BottomTopTransformation.Method.TOP_PERCENT)
    } else if (this._tokenizer.next(TokenKind.TopSumTrafo)) {
      bottomTop.setMethod(BottomTopTransformation.Method.TOP_SUM)
    } else {
      throw new UriSyntaxError(UriSyntaxError.Message.WRONG_OPTION_VALUE, QueryOption.APPLY)
    }

    const number = this._expressionParser.parse(
      this._tokenizer,
      referencedType,
      this._crossjoinEntitySetNames,
      this._aliases
    )
    this._expressionParser.checkIntegerType(number)
    bottomTop.setNumber(number)
    this._tokenizer.requireNext(TokenKind.COMMA)

    const value = this._expressionParser.parse(
      this._tokenizer,
      referencedType,
      this._crossjoinEntitySetNames,
      this._aliases
    )
    this._expressionParser.checkNumericType(value)
    bottomTop.setValue(value)

    this._tokenizer.requireNext(TokenKind.CLOSE)
    return bottomTop
  }
}

module.exports = ApplyParser
