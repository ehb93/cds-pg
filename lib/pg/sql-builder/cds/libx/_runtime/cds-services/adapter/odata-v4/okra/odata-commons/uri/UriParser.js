'use strict'

const ResourcePathParser = require('./ResourcePathParser')
const ExpandParser = require('./ExpandParser')
const FilterParser = require('./FilterParser')
const OrderByParser = require('./OrderByParser')
const SearchParser = require('./SearchParser')
const SelectParser = require('./SelectParser')
const ApplyParser = require('./ApplyParser')
const UriInfo = require('./UriInfo')
const QueryOptions = UriInfo.QueryOptions
const UriSyntaxError = require('../errors/UriSyntaxError')
const UriSemanticError = require('../errors/UriSemanticError')
const UriTokenizer = require('./UriTokenizer')
const TokenKind = UriTokenizer.TokenKind
const FullQualifiedName = require('../FullQualifiedName')
const UriResource = require('./UriResource')
const TransientStructuredType = require('../edm/TransientStructuredType')
const FeatureSupport = require('../FeatureSupport')

const TOKEN = "(?:[-!#$%&'*+.^_`|~A-Za-z0-9]+)"
const FORMAT_REGEXP = new RegExp(
  '^(?:atom|json|xml|' + TOKEN + '/' + TOKEN + '(?:;' + TOKEN + '=(?:' + TOKEN + '|(?:"(?:[^"]|(?:\\\\"))*")))*)$',
  'i'
)

const parseNonNegativeInteger = value => {
  let tokenizer = new UriTokenizer(value)
  if (tokenizer.next(TokenKind.UnsignedIntegerValue) && tokenizer.next(TokenKind.EOF)) {
    const result = Number.parseInt(value, 10)
    if (Number.isSafeInteger(result)) return result
  }
  return null
}

const queryOptionParserMap = new Map()
queryOptionParserMap.set(QueryOptions.TOP, value => {
  const result = parseNonNegativeInteger(value)
  if (result === null) {
    throw new UriSyntaxError(UriSyntaxError.Message.OPTION_NON_NEGATIVE_INTEGER, QueryOptions.TOP)
  }
  return result
})
queryOptionParserMap.set(QueryOptions.SKIP, value => {
  const result = parseNonNegativeInteger(value)
  if (result === null) {
    throw new UriSyntaxError(UriSyntaxError.Message.OPTION_NON_NEGATIVE_INTEGER, QueryOptions.SKIP)
  }
  return result
})
queryOptionParserMap.set(QueryOptions.SKIPTOKEN, value => {
  if (!value) throw new UriSyntaxError(UriSyntaxError.Message.WRONG_OPTION_VALUE, QueryOptions.SKIPTOKEN)
  return value
})
queryOptionParserMap.set(QueryOptions.DELTATOKEN, value => {
  if (!value) throw new UriSyntaxError(UriSyntaxError.Message.WRONG_OPTION_VALUE, QueryOptions.DELTATOKEN)
  return value
})
queryOptionParserMap.set(QueryOptions.COUNT, value => {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new UriSyntaxError(UriSyntaxError.Message.WRONG_COUNT_VALUE)
})
queryOptionParserMap.set(QueryOptions.FORMAT, value => {
  if (FORMAT_REGEXP.test(value)) return value
  throw new UriSyntaxError(UriSyntaxError.Message.WRONG_OPTION_VALUE, QueryOptions.FORMAT)
})
queryOptionParserMap.set(QueryOptions.SEARCH, value => {
  let tokenizer = new UriTokenizer(value)
  const searchOption = new SearchParser().parse(tokenizer)
  tokenizer.requireNext(TokenKind.EOF)
  return searchOption
})
queryOptionParserMap.set(QueryOptions.FILTER, (value, edm, referringType, crossjoinEntitySets, aliases) => {
  let tokenizer = new UriTokenizer(value)
  const filterOption = new FilterParser(edm).parse(tokenizer, referringType, crossjoinEntitySets, aliases)
  tokenizer.requireNext(TokenKind.EOF)
  return filterOption
})
queryOptionParserMap.set(QueryOptions.ORDERBY, (value, edm, referringType, crossjoinEntitySets, aliases) => {
  let tokenizer = new UriTokenizer(value)
  const orderByOption = new OrderByParser(edm).parse(tokenizer, referringType, crossjoinEntitySets, aliases)
  tokenizer.requireNext(TokenKind.EOF)
  return orderByOption
})
queryOptionParserMap.set(
  QueryOptions.SELECT,
  (value, edm, referringType, crossjoinEntitySets, aliases, isCollection) => {
    let tokenizer = new UriTokenizer(value)
    const selectOption = new SelectParser(edm).parse(tokenizer, referringType, isCollection)
    tokenizer.requireNext(TokenKind.EOF)
    return selectOption
  }
)
queryOptionParserMap.set(QueryOptions.EXPAND, (value, edm, referringType, crossjoinEntitySets, aliases) => {
  let tokenizer = new UriTokenizer(value)
  const expandOption = new ExpandParser(edm).parse(tokenizer, referringType, crossjoinEntitySets, aliases)
  tokenizer.requireNext(TokenKind.EOF)
  return expandOption
})

/**
 * The UriParser is the main class to parse an OData URI.
 */
class UriParser {
  /**
   * Creates an instance of UriParser.
   * @param {Edm} edm The current EDM instance
   */
  constructor (edm) {
    this._edm = edm
  }

  /**
   * Sets the performance monitor.
   * @param {PerformanceMonitor} performanceMonitor the performance monitor
   * @returns {UriParser} this instance
   */
  setPerformanceMonitor (performanceMonitor) {
    this._performanceMonitor = performanceMonitor
    return this
  }

  /**
   * Parse the resource-path part of the provided OData URI string.
   * @param {string} uri the resource path
   * @param {Object} queryOptions the query options to parse as key-value pairs (only used for aliases)
   * @returns {UriInfo} the result of parsing
   */
  parseRelativeUri (uri, queryOptions) {
    let uriPathSegments = uri.split('/').map(decodeURIComponent)

    let uriInfo = new UriInfo()

    if (queryOptions) {
      for (const name in queryOptions) if (name[0] === '@') {
        uriInfo.setAlias(name, queryOptions[name])
      }
    }

    const uriResources = this._parseRelativeUri(uriPathSegments, uriInfo.getAliases())
    uriInfo.setPathSegments(uriResources)

    let currentUriSegment = uriPathSegments.shift()
    if (currentUriSegment || currentUriSegment === '') {
      throw new UriSyntaxError(UriSyntaxError.Message.TRAILING_SEGMENT, currentUriSegment, uri)
    }

    return uriInfo
  }

  /**
   * Parses the query options (assumed to be already percent decoded) according to the parser function map.
   * @param {Object} queryOptions the query options to parse as key-value pairs
   * @param {UriInfo} uriInfo the result of parsing
   */
  parseQueryOptions (queryOptions, uriInfo) {
    const lastSegment = uriInfo.getLastSegment()
    const crossjoinEntitySets = lastSegment.getCrossjoinEntitySets()
    const aliases = uriInfo.getAliases()
    const isCollection = lastSegment.isCollection()

    // The referring type could be a primitive type or a structured type.
    // $crossjoin and $all requests don't have a referring type.
    let referringType = uriInfo.getFinalEdmType()

    const parseQueryOptionsPm = this._performanceMonitor
      ? this._performanceMonitor.getChild('Query options parsing')
      : null

    // $apply must be parsed first.
    if (queryOptions[QueryOptions.APPLY] !== undefined) {
      let tokenizer = new UriTokenizer(queryOptions[QueryOptions.APPLY])
      referringType = new TransientStructuredType(referringType)
      const parseApplyQueryOptionPm = parseQueryOptionsPm
        ? parseQueryOptionsPm.createChild('Parse query option $apply').start()
        : null
      uriInfo.setQueryOption(
        QueryOptions.APPLY,
        new ApplyParser(this._edm).parse(tokenizer, referringType, crossjoinEntitySets, aliases)
      )
      tokenizer.requireNext(TokenKind.EOF)
      uriInfo.setFinalEdmType(referringType)
      if (parseApplyQueryOptionPm) parseApplyQueryOptionPm.stop()
    }

    for (const name in queryOptions) {
      if (name.charAt(0) === '$') {
        // $apply has been handled above.
        if (name === QueryOptions.APPLY) continue

        const func = queryOptionParserMap.get(name)
        if (func) {
          const parseSingleQueryOptionPm = parseQueryOptionsPm
            ? parseQueryOptionsPm.createChild('Parse query option ' + name).start()
            : null

          uriInfo.setQueryOption(
            name,
            func(queryOptions[name], this._edm, referringType, crossjoinEntitySets, aliases, isCollection)
          )

          if (parseSingleQueryOptionPm) parseSingleQueryOptionPm.stop()
        } else {
          throw new UriSyntaxError(UriSyntaxError.Message.OPTION_UNKNOWN, name)
        }
      } else {
        uriInfo.setQueryOption(name, queryOptions[name])
      }
    }
  }

  /**
   * Parse the OData ABNF relative URI path.
   * @param {string[]} uriPathSegments the URI segments split at '/'
   * @param {?Object} aliases alias definitions
   * @returns {UriResource[]} an array of resource objects
   * @private
   */
  _parseRelativeUri (uriPathSegments, aliases) {
    let currentUriSegment = uriPathSegments[0]
    let tokenizer = new UriTokenizer(currentUriSegment)

    if (tokenizer.next(TokenKind.EOF)) {
      uriPathSegments.shift()
      return [new UriResource().setKind(UriResource.ResourceKind.SERVICE)]
    } else if (tokenizer.next(TokenKind.METADATA)) {
      tokenizer.requireNext(TokenKind.EOF)
      uriPathSegments.shift()
      return [new UriResource().setKind(UriResource.ResourceKind.METADATA)]
    } else if (tokenizer.next(TokenKind.BATCH)) {
      tokenizer.requireNext(TokenKind.EOF)
      uriPathSegments.shift()
      return [new UriResource().setKind(UriResource.ResourceKind.BATCH)]
    } else if (tokenizer.next(TokenKind.ENTITY)) {
      FeatureSupport.failUnsupported(FeatureSupport.features.Entity_id)
      tokenizer.requireNext(TokenKind.EOF)
      uriPathSegments.shift()
      let pathSegments = [new UriResource().setKind(UriResource.ResourceKind.ENTITY_ID)]
      if (uriPathSegments.length > 0) {
        pathSegments.push(this._parseEntityTypeCast(uriPathSegments[0]))
        uriPathSegments.shift()
      }
      return pathSegments
    }

    return this._parseResourcePath(uriPathSegments, aliases)
  }

  /**
   * Parse a resource path segment supposed to contain an entity type cast.
   * @param {string} uriPathSegment the URI segment
   * @returns {UriResource} The created UriResource from the parsed segment
   * @private
   */
  _parseEntityTypeCast (uriPathSegment) {
    // Type casts are explicitly not supported (although the parser can parse them)
    FeatureSupport.failUnsupported(FeatureSupport.features.TypeCast, uriPathSegment, 0)

    let tokenizer = new UriTokenizer(uriPathSegment)
    tokenizer.requireNext(TokenKind.QualifiedName)
    const qualifiedName = tokenizer.getText()
    const type = this._edm.getEntityType(FullQualifiedName.createFromNameSpaceAndName(qualifiedName))
    if (!type) throw new UriSemanticError(UriSemanticError.Message.ENTITY_TYPE_NOT_FOUND, qualifiedName)
    tokenizer.requireNext(TokenKind.EOF)
    return new UriResource().setKind(UriResource.ResourceKind.TYPE_CAST).setTypeCast(type)
  }

  /**
   * Parse the OData ABNF resource path.
   * @param {string[]} uriPathSegments the URI segments split at '/'
   * @param {?Object} aliases alias definitions
   * @returns {UriResource[]} an array of resource objects
   * @private
   */
  _parseResourcePath (uriPathSegments, aliases) {
    let currentUriSegment = uriPathSegments[0]
    let tokenizer = new UriTokenizer(currentUriSegment)

    if (tokenizer.next(TokenKind.ALL)) {
      FeatureSupport.failUnsupported(FeatureSupport.features.All)
      tokenizer.requireNext(TokenKind.EOF)
      uriPathSegments.shift()
      let pathSegments = [new UriResource().setKind(UriResource.ResourceKind.ALL).setIsCollection(true)]
      if (uriPathSegments.length > 0) {
        pathSegments.push(this._parseEntityTypeCast(uriPathSegments[0]).setIsCollection(true))
        uriPathSegments.shift()
      }
      return pathSegments
    } else if (tokenizer.next(TokenKind.CROSSJOIN)) {
      FeatureSupport.failUnsupported(FeatureSupport.features.CrossJoin)
      let resource = new UriResource().setKind(UriResource.ResourceKind.CROSSJOIN).setIsCollection(true)
      this._parseCrossjoinEntitySetNames(tokenizer, resource)
      tokenizer.requireNext(TokenKind.EOF)
      uriPathSegments.shift()
      return [resource]
    }

    return new ResourcePathParser(this._edm, aliases).parse(uriPathSegments) // TODO give edm plx
  }

  /**
   * Parse the OData ABNF crossjoin URI path.
   * @param {UriTokenizer} tokenizer the current URI tokenizer
   * @param {UriResource} resource the current resource
   * @private
   */
  _parseCrossjoinEntitySetNames (tokenizer, resource) {
    const container = this._edm.getEntityContainer()
    tokenizer.requireNext(TokenKind.OPEN)
    do {
      tokenizer.requireNext(TokenKind.ODataIdentifier)
      const name = tokenizer.getText()
      const entitySet = container.getEntitySet(name)
      if (entitySet) {
        resource.addCrossjoinEntitySet(entitySet)
      } else {
        throw new UriSemanticError(UriSemanticError.Message.ENTITY_SET_NOT_FOUND, name)
      }
    } while (tokenizer.next(TokenKind.COMMA))
    tokenizer.requireNext(TokenKind.CLOSE)
  }
}

module.exports = UriParser
