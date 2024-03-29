'use strict'

const UriSyntaxError = require('../errors/UriSyntaxError')

const IDENTIFIER =
  '(?:(?:_|\\p{Letter}|\\p{Letter_Number})' +
  '(?:_|\\p{Letter}|\\p{Letter_Number}|\\p{Decimal_Number}' +
  '|\\p{Nonspacing_Mark}|\\p{Spacing_Mark}|\\p{Connector_Punctuation}|\\p{Format}){0,127})'
const IDENTIFIER_REGEXP = new RegExp('^' + IDENTIFIER, 'u')
const QUALIFIED_NAME_REGEXP = new RegExp('^' + IDENTIFIER + '(?:\\.' + IDENTIFIER + ')+', 'u')
const PARAMETER_ALIAS_NAME_REGEXP = new RegExp('^@' + IDENTIFIER, 'u')

const BOOLEAN_VALUE_REGEXP = new RegExp('^(?:true|false)', 'i')

const STRING_REGEXP = new RegExp("^'(?:''|[^'])*'")

const HEX_DIGIT = '[A-Fa-f0-9]'
const GUID_VALUE_REGEXP = new RegExp(
  '^(?:' + HEX_DIGIT + '{8}-' + HEX_DIGIT + '{4}-' + HEX_DIGIT + '{4}-' + HEX_DIGIT + '{4}-' + HEX_DIGIT + '{12})'
)

const BASE64 = '[-_A-Za-z0-9]'
const BASE64B16 = BASE64 + '{2}[AEIMQUYcgkosw048]=?'
const BASE64B8 = BASE64 + '[AQgw](?:==)?'
const BINARY = '(?:' + BASE64 + '{4})*(?:' + BASE64B16 + '|' + BASE64B8 + ')?'
const BINARY_VALUE_REGEXP = new RegExp("^[Bb][Ii][Nn][Aa][Rr][Yy]'" + BINARY + "'")

const UNSIGNED_INTEGER_VALUE_REGEXP = new RegExp('^\\d+')
const INTEGER_VALUE_REGEXP = new RegExp('^[-+]?\\d+')
const DECIMAL_VALUE_REGEXP = new RegExp('^[-+]?\\d+\\.\\d+')
const DOUBLE_VALUE_REGEXP = new RegExp('^(?:(?:[-+]?\\d+(?:\\.\\d+)?[Ee][-+]?\\d+)|NaN|-?INF)')

const DURATION_REGEXP = new RegExp("^duration'[-+]?P(?:\\d+D)?(?:T(?:\\d+H)?(?:\\d+M)?(?:\\d+(?:\\.\\d+)?S)?)?'", 'i')

const YEAR = '-?(?:0\\d{3}|[1-9]\\d{3,})'
const MONTH = '(?:0[1-9]|1[012])'
const DAY = '(?:0[1-9]|[12]\\d|3[01])'
const HOUR = '(?:[01]\\d|2[0123])'
const MINUTE = '[012345]\\d'
const SECOND = '[012345]\\d'
const DATE = YEAR + '-' + MONTH + '-' + DAY
const TIME = HOUR + ':' + MINUTE + '(?::' + SECOND + '(?:\\.\\d{1,12})?)?'
const DATE_REGEXP = new RegExp('^' + DATE)
const TIME_OF_DAY_REGEXP = new RegExp('^' + TIME)
const DATE_TIME_OFFSET_REGEXP = new RegExp('^' + DATE + 'T' + TIME + '(?:Z|[-+]' + HOUR + ':' + MINUTE + ')', 'i')

const SRID = 'SRID=(\\d{1,8});'
const NUMBER = '[-+]?\\d+(?:\\.\\d+)?(?:[Ee][-+]?\\d+)?'
// A geo position is given by two space-separated numbers, like "1.23 4.56E-1".
const POSITION = '(?:' + NUMBER + ' ' + NUMBER + ')'
// A geo line is a comma-separated list of positions, like "1 2,3 4,5 6".
const LINE = '(?:' + POSITION + '?(?:,' + POSITION + ')*)'
// A geo multiposition is a comma-separated list of positions, each in parentheses, like "(1 2),(3 4),(5 6)".
const MULTI_POSITION = '(?:(?:\\(' + POSITION + '\\))?(?:,\\(' + POSITION + '\\))*)'
// A geo multiline is a comma-separated list of lines, each in parentheses, like "(1 1,2 2),(3 3,4 4)".
// A geo polygon has exactly the same coordinate representation as a geo multiline.
const MULTI_LINE = '(?:(?:\\(' + LINE + '\\))?(?:,\\(' + LINE + '\\))*)'
// A geo multipolygon is a comma-separated list of multilines, each in parentheses, like
// "((-1 -2,1 -2,1 2,-1 2,-1 -2),(-5 -10,-5 10,5 10,5 -10,-5 -10)),((-1 -2,-3 -4,-5 -6,-1 -2))".
const MULTI_POLYGON = '(?:(?:\\(' + MULTI_LINE + '\\))?(?:,\\(' + MULTI_LINE + '\\))*)'
// A geo literal is one of position, line, multiposition, multiline, multipolygon,
// enclosed in parentheses and prefixed with a type name.
const GEO_LITERAL =
  '(?:(?:Point\\(' +
  POSITION +
  '\\))' +
  '|(?:LineString\\(' +
  LINE +
  '\\))' +
  '|(?:Polygon\\(' +
  MULTI_LINE +
  '\\))' +
  '|(?:MultiPoint\\(' +
  MULTI_POSITION +
  '\\))' +
  '|(?:MultiLineString\\(' +
  MULTI_LINE +
  '\\))' +
  '|(?:MultiPolygon\\(' +
  MULTI_POLYGON +
  '\\)))'
// A multigeoliteral (used for a collection) is a comma-separated list of geo literals.
const MULTI_GEO_LITERAL = '(?:' + GEO_LITERAL + '?(?:,' + GEO_LITERAL + ')*)'
// The validation regular expressions for geo literals must be all case-insensitive.
// They are built as sequence of an SRID definition, a type name, and the coordinates;
// the coordinates are enclosed in parentheses.
const GEO_POINT_REGEXP = new RegExp('^' + SRID + 'Point\\(' + POSITION + '\\)', 'i')
const GEO_LINE_STRING_REGEXP = new RegExp('^' + SRID + 'LineString\\(' + LINE + '\\)', 'i')
const GEO_POLYGON_REGEXP = new RegExp('^' + SRID + 'Polygon\\(' + MULTI_LINE + '\\)', 'i')
const GEO_MULTI_POINT_REGEXP = new RegExp('^' + SRID + 'MultiPoint\\(' + MULTI_POSITION + '\\)', 'i')
const GEO_MULTI_LINE_STRING_REGEXP = new RegExp('^' + SRID + 'MultiLineString\\(' + MULTI_LINE + '\\)', 'i')
const GEO_MULTI_POLYGON_REGEXP = new RegExp('^' + SRID + 'MultiPolygon\\(' + MULTI_POLYGON + '\\)', 'i')
const GEO_COLLECTION_REGEXP = new RegExp('^' + SRID + 'Collection\\(' + MULTI_GEO_LITERAL + '\\)', 'i')

const JSON_STRING_REGEXP = new RegExp('^"(?:(?:\\\\(?:[btnfr"/\\\\]|u' + HEX_DIGIT + '{4}))|[^\\\\"])*"')

// A search word is a sequence of one or more non-whitespace characters, excluding
// parentheses, double-quotes, and semicolons. It must not start with a single quote.
const WORD_REGEXP = new RegExp('^[^\\s()";\'][^\\s()";]*', 'u')
// A search phrase is a doublequoted string with backslash-escaped backslashes and doublequotes.
const PHRASE_REGEXP = new RegExp('^"(?:[^\\\\"]|\\\\[\\\\"])*"')

/**
 * <p>Simple OData URI tokenizer that works on a given string by keeping an index.</p>
 * <p>As far as feasible, it tries to work on regular-expression basis,
 * assuming this to be faster than character operations.
 * Since only the index is 'moved', backing out while parsing a token is easy and used throughout.
 * There is intentionally no method to push back tokens
 * (although it would be easy to add such a method)
 * because this tokenizer should behave like a classical token-consuming tokenizer.
 * There is, however, the possibility to save the current state and return to it later.</p>
 * <p>Whitespace is not an extra token but consumed with the tokens that require whitespace.
 * Optional whitespace is not supported.</p>
 */
class UriTokenizer {
  /**
   * Constructor which accepts the URI string.
   * @param {string} parseString the URI string
   */
  constructor (parseString) {
    this._index = 0
    this._parseString = parseString || ''
    this._startIndex = 0
    this._savedStartIndex = null
    this._savedIndex = null
  }

  /**
   * Save the current state.
   *
   * @see #returnToSavedState()
   */
  saveState () {
    this._savedStartIndex = this._startIndex
    this._savedIndex = this._index
  }

  /**
   * Return to the previously saved state.
   *
   * @see #saveState()
   */
  returnToSavedState () {
    this._startIndex = this._savedStartIndex
    this._index = this._savedIndex
  }

  /**
   * Return the whole parse string.
   * @returns {string} the parse string
   */
  getParseString () {
    return this._parseString
  }

  /**
   * Return the current position in the parse string.
   * @returns {number} position, starting at 1
   */
  getPosition () {
    return this._index + 1
  }

  /**
   * Return the string value corresponding to the last successful {@link #next(TokenKind)} call.
   * @returns {string} the token text
   */
  getText () {
    return this._parseString.substring(this._startIndex, this._index)
  }

  /**
   * Try to find a token of the given token kind at the current index.
   * The order in which this method is called with different token kinds is important,
   * not only for performance reasons but also if tokens can start with the same characters
   * (e.g., a qualified name starts with an OData identifier).
   * The index is advanced to the end of this token if the token is found.
   *
   * @param {UriTokenizer.TokenKind} allowedTokenKind the kind of token to expect
   * @returns {boolean} <code>true</code> if the token is found; <code>false</code> otherwise
   * @see #getText()
   */
  next (allowedTokenKind) {
    if (!allowedTokenKind) {
      return false
    }

    const previousIndex = this._index

    let found = false
    switch (allowedTokenKind) {
      case UriTokenizer.TokenKind.EOF:
        found = this._nextEOF()
        break

      // Constants
      case UriTokenizer.TokenKind.REF:
        found = this._nextConstant('$ref')
        break
      case UriTokenizer.TokenKind.VALUE:
        found = this._nextConstant('$value')
        break
      case UriTokenizer.TokenKind.COUNT:
        found = this._nextConstant('$count')
        break
      case UriTokenizer.TokenKind.METADATA:
        found = this._nextConstant('$metadata')
        break
      case UriTokenizer.TokenKind.BATCH:
        found = this._nextConstant('$batch')
        break
      case UriTokenizer.TokenKind.CROSSJOIN:
        found = this._nextConstant('$crossjoin')
        break
      case UriTokenizer.TokenKind.ALL:
        found = this._nextConstant('$all')
        break
      case UriTokenizer.TokenKind.ENTITY:
        found = this._nextConstant('$entity')
        break
      case UriTokenizer.TokenKind.ROOT:
        found = this._nextConstant('$root')
        break
      case UriTokenizer.TokenKind.IT:
        found = this._nextConstant('$it')
        break

      case UriTokenizer.TokenKind.APPLY:
        found = this._nextConstant('$apply')
        break
      case UriTokenizer.TokenKind.EXPAND:
        found = this._nextConstant('$expand')
        break
      case UriTokenizer.TokenKind.FILTER:
        found = this._nextConstant('$filter')
        break
      case UriTokenizer.TokenKind.LEVELS:
        found = this._nextConstant('$levels')
        break
      case UriTokenizer.TokenKind.ORDERBY:
        found = this._nextConstant('$orderby')
        break
      case UriTokenizer.TokenKind.SEARCH:
        found = this._nextConstant('$search')
        break
      case UriTokenizer.TokenKind.SELECT:
        found = this._nextConstant('$select')
        break
      case UriTokenizer.TokenKind.SKIP:
        found = this._nextConstant('$skip')
        break
      case UriTokenizer.TokenKind.TOP:
        found = this._nextConstant('$top')
        break

      case UriTokenizer.TokenKind.LAMBDA_ANY:
        found = this._nextConstant('any')
        break
      case UriTokenizer.TokenKind.LAMBDA_ALL:
        found = this._nextConstant('all')
        break

      case UriTokenizer.TokenKind.OPEN:
        found = this._nextCharacter('(')
        break
      case UriTokenizer.TokenKind.CLOSE:
        found = this._nextCharacter(')')
        break
      case UriTokenizer.TokenKind.COMMA:
        found = this._nextCharacter(',')
        break
      case UriTokenizer.TokenKind.SEMI:
        found = this._nextCharacter(';')
        break
      case UriTokenizer.TokenKind.COLON:
        found = this._nextCharacter(':')
        break
      case UriTokenizer.TokenKind.DOT:
        found = this._nextCharacter('.')
        break
      case UriTokenizer.TokenKind.SLASH:
        found = this._nextCharacter('/')
        break
      case UriTokenizer.TokenKind.EQ:
        found = this._nextCharacter('=')
        break
      case UriTokenizer.TokenKind.STAR:
        found = this._nextCharacter('*')
        break
      case UriTokenizer.TokenKind.PLUS:
        found = this._nextCharacter('+')
        break

      case UriTokenizer.TokenKind.NULL:
        found = this._nextConstant('null')
        break
      case UriTokenizer.TokenKind.MAX:
        found = this._nextConstant('max')
        break

      case UriTokenizer.TokenKind.AVERAGE:
        found = this._nextConstant('average')
        break
      case UriTokenizer.TokenKind.COUNTDISTINCT:
        found = this._nextConstant('countdistinct')
        break
      case UriTokenizer.TokenKind.IDENTITY:
        found = this._nextConstant('identity')
        break
      case UriTokenizer.TokenKind.MIN:
        found = this._nextConstant('min')
        break
      case UriTokenizer.TokenKind.SUM:
        found = this._nextConstant('sum')
        break

      // Identifiers
      case UriTokenizer.TokenKind.ODataIdentifier:
        found = this._nextWithRegularExpression(IDENTIFIER_REGEXP)
        break
      case UriTokenizer.TokenKind.QualifiedName:
        found = this._nextWithRegularExpression(QUALIFIED_NAME_REGEXP)
        break
      case UriTokenizer.TokenKind.ParameterAliasName:
        found = this._nextWithRegularExpression(PARAMETER_ALIAS_NAME_REGEXP)
        break

      // Primitive Values
      case UriTokenizer.TokenKind.BooleanValue:
        found = this._nextWithRegularExpression(BOOLEAN_VALUE_REGEXP)
        break
      case UriTokenizer.TokenKind.StringValue:
        found = this._nextWithRegularExpression(STRING_REGEXP)
        break
      case UriTokenizer.TokenKind.IntegerValue:
        found = this._nextIntegerValue()
        break
      case UriTokenizer.TokenKind.UnsignedIntegerValue:
        found = this._nextWithRegularExpression(UNSIGNED_INTEGER_VALUE_REGEXP)
        break
      case UriTokenizer.TokenKind.GuidValue:
        found = this._nextWithRegularExpression(GUID_VALUE_REGEXP)
        break
      case UriTokenizer.TokenKind.DateValue:
        found = this._nextWithRegularExpression(DATE_REGEXP)
        break
      case UriTokenizer.TokenKind.DateTimeOffsetValue:
        found = this._nextWithRegularExpression(DATE_TIME_OFFSET_REGEXP)
        break
      case UriTokenizer.TokenKind.TimeOfDayValue:
        found = this._nextWithRegularExpression(TIME_OF_DAY_REGEXP)
        break
      case UriTokenizer.TokenKind.DecimalValue:
        found = this._nextDecimalValue()
        break
      case UriTokenizer.TokenKind.DoubleValue:
        found = this._nextDoubleValue()
        break
      case UriTokenizer.TokenKind.DurationValue:
        found = this._nextWithRegularExpression(DURATION_REGEXP)
        break
      case UriTokenizer.TokenKind.BinaryValue:
        found = this._nextWithRegularExpression(BINARY_VALUE_REGEXP)
        break
      case UriTokenizer.TokenKind.EnumValue:
        found = this._nextEnumValue()
        break

      // Geo Values
      case UriTokenizer.TokenKind.GeographyPoint:
        found = this._nextGeoValue(true, GEO_POINT_REGEXP)
        break
      case UriTokenizer.TokenKind.GeometryPoint:
        found = this._nextGeoValue(false, GEO_POINT_REGEXP)
        break
      case UriTokenizer.TokenKind.GeographyLineString:
        found = this._nextGeoValue(true, GEO_LINE_STRING_REGEXP)
        break
      case UriTokenizer.TokenKind.GeometryLineString:
        found = this._nextGeoValue(false, GEO_LINE_STRING_REGEXP)
        break
      case UriTokenizer.TokenKind.GeographyPolygon:
        found = this._nextGeoValue(true, GEO_POLYGON_REGEXP)
        break
      case UriTokenizer.TokenKind.GeometryPolygon:
        found = this._nextGeoValue(false, GEO_POLYGON_REGEXP)
        break
      case UriTokenizer.TokenKind.GeographyMultiPoint:
        found = this._nextGeoValue(true, GEO_MULTI_POINT_REGEXP)
        break
      case UriTokenizer.TokenKind.GeometryMultiPoint:
        found = this._nextGeoValue(false, GEO_MULTI_POINT_REGEXP)
        break
      case UriTokenizer.TokenKind.GeographyMultiLineString:
        found = this._nextGeoValue(true, GEO_MULTI_LINE_STRING_REGEXP)
        break
      case UriTokenizer.TokenKind.GeometryMultiLineString:
        found = this._nextGeoValue(false, GEO_MULTI_LINE_STRING_REGEXP)
        break
      case UriTokenizer.TokenKind.GeographyMultiPolygon:
        found = this._nextGeoValue(true, GEO_MULTI_POLYGON_REGEXP)
        break
      case UriTokenizer.TokenKind.GeometryMultiPolygon:
        found = this._nextGeoValue(false, GEO_MULTI_POLYGON_REGEXP)
        break
      case UriTokenizer.TokenKind.GeographyCollection:
        found = this._nextGeoValue(true, GEO_COLLECTION_REGEXP)
        break
      case UriTokenizer.TokenKind.GeometryCollection:
        found = this._nextGeoValue(false, GEO_COLLECTION_REGEXP)
        break

      // Complex or Collection Value
      case UriTokenizer.TokenKind.jsonArrayOrObject:
        found = this._nextJsonArrayOrObject()
        break

      // Search
      case UriTokenizer.TokenKind.Word:
        found = this._nextWord()
        break
      case UriTokenizer.TokenKind.Phrase:
        found = this._nextWithRegularExpression(PHRASE_REGEXP)
        break

      // Operators in Search Expressions
      case UriTokenizer.TokenKind.OrOperatorSearch:
        found = this._nextBinaryOperator('OR')
        break
      case UriTokenizer.TokenKind.AndOperatorSearch:
        found = this._nextAndOperatorSearch()
        break
      case UriTokenizer.TokenKind.NotOperatorSearch:
        found = this._nextUnaryOperator('NOT')
        break

      // Operators
      case UriTokenizer.TokenKind.OrOperator:
        found = this._nextBinaryOperator('or')
        break
      case UriTokenizer.TokenKind.AndOperator:
        found = this._nextBinaryOperator('and')
        break
      case UriTokenizer.TokenKind.EqualsOperator:
        found = this._nextBinaryOperator('eq')
        break
      case UriTokenizer.TokenKind.NotEqualsOperator:
        found = this._nextBinaryOperator('ne')
        break
      case UriTokenizer.TokenKind.GreaterThanOperator:
        found = this._nextBinaryOperator('gt')
        break
      case UriTokenizer.TokenKind.GreaterThanOrEqualsOperator:
        found = this._nextBinaryOperator('ge')
        break
      case UriTokenizer.TokenKind.LessThanOperator:
        found = this._nextBinaryOperator('lt')
        break
      case UriTokenizer.TokenKind.LessThanOrEqualsOperator:
        found = this._nextBinaryOperator('le')
        break
      case UriTokenizer.TokenKind.HasOperator:
        found = this._nextBinaryOperator('has')
        break
      case UriTokenizer.TokenKind.AddOperator:
        found = this._nextBinaryOperator('add')
        break
      case UriTokenizer.TokenKind.SubOperator:
        found = this._nextBinaryOperator('sub')
        break
      case UriTokenizer.TokenKind.MulOperator:
        found = this._nextBinaryOperator('mul')
        break
      case UriTokenizer.TokenKind.DivOperator:
        found = this._nextBinaryOperator('div')
        break
      case UriTokenizer.TokenKind.ModOperator:
        found = this._nextBinaryOperator('mod')
        break
      case UriTokenizer.TokenKind.MinusOperator:
        found = this._nextMinusOperator()
        break
      case UriTokenizer.TokenKind.NotOperator:
        found = this._nextUnaryOperator('not')
        break

      // Operators for the aggregation extension
      case UriTokenizer.TokenKind.AsOperator:
        found = this._nextBinaryOperator('as')
        break
      case UriTokenizer.TokenKind.FromOperator:
        found = this._nextBinaryOperator('from')
        break
      case UriTokenizer.TokenKind.WithOperator:
        found = this._nextBinaryOperator('with')
        break

      // Methods
      case UriTokenizer.TokenKind.CastMethod:
        found = this._nextMethod('cast')
        break
      case UriTokenizer.TokenKind.CeilingMethod:
        found = this._nextMethod('ceiling')
        break
      case UriTokenizer.TokenKind.ConcatMethod:
        found = this._nextMethod('concat')
        break
      case UriTokenizer.TokenKind.ContainsMethod:
        found = this._nextMethod('contains')
        break
      case UriTokenizer.TokenKind.DateMethod:
        found = this._nextMethod('date')
        break
      case UriTokenizer.TokenKind.DayMethod:
        found = this._nextMethod('day')
        break
      case UriTokenizer.TokenKind.EndswithMethod:
        found = this._nextMethod('endswith')
        break
      case UriTokenizer.TokenKind.FloorMethod:
        found = this._nextMethod('floor')
        break
      case UriTokenizer.TokenKind.FractionalsecondsMethod:
        found = this._nextMethod('fractionalseconds')
        break
      case UriTokenizer.TokenKind.GeoDistanceMethod:
        found = this._nextMethod('geo.distance')
        break
      case UriTokenizer.TokenKind.GeoIntersectsMethod:
        found = this._nextMethod('geo.intersects')
        break
      case UriTokenizer.TokenKind.GeoLengthMethod:
        found = this._nextMethod('geo.length')
        break
      case UriTokenizer.TokenKind.HourMethod:
        found = this._nextMethod('hour')
        break
      case UriTokenizer.TokenKind.IndexofMethod:
        found = this._nextMethod('indexof')
        break
      case UriTokenizer.TokenKind.IsofMethod:
        found = this._nextMethod('isof')
        break
      case UriTokenizer.TokenKind.LengthMethod:
        found = this._nextMethod('length')
        break
      case UriTokenizer.TokenKind.MaxdatetimeMethod:
        found = this._nextMethod('maxdatetime')
        break
      case UriTokenizer.TokenKind.MindatetimeMethod:
        found = this._nextMethod('mindatetime')
        break
      case UriTokenizer.TokenKind.MinuteMethod:
        found = this._nextMethod('minute')
        break
      case UriTokenizer.TokenKind.MonthMethod:
        found = this._nextMethod('month')
        break
      case UriTokenizer.TokenKind.NowMethod:
        found = this._nextMethod('now')
        break
      case UriTokenizer.TokenKind.RoundMethod:
        found = this._nextMethod('round')
        break
      case UriTokenizer.TokenKind.SecondMethod:
        found = this._nextMethod('second')
        break
      case UriTokenizer.TokenKind.StartswithMethod:
        found = this._nextMethod('startswith')
        break
      case UriTokenizer.TokenKind.SubstringMethod:
        found = this._nextMethod('substring')
        break
      case UriTokenizer.TokenKind.TimeMethod:
        found = this._nextMethod('time')
        break
      case UriTokenizer.TokenKind.TolowerMethod:
        found = this._nextMethod('tolower')
        break
      case UriTokenizer.TokenKind.TotaloffsetminutesMethod:
        found = this._nextMethod('totaloffsetminutes')
        break
      case UriTokenizer.TokenKind.TotalsecondsMethod:
        found = this._nextMethod('totalseconds')
        break
      case UriTokenizer.TokenKind.ToupperMethod:
        found = this._nextMethod('toupper')
        break
      case UriTokenizer.TokenKind.TrimMethod:
        found = this._nextMethod('trim')
        break
      case UriTokenizer.TokenKind.YearMethod:
        found = this._nextMethod('year')
        break

      // Method for the aggregation extension
      case UriTokenizer.TokenKind.IsDefinedMethod:
        found = this._nextMethod('isdefined')
        break

      // Transformations for the aggregation extension
      case UriTokenizer.TokenKind.AggregateTrafo:
        found = this._nextMethod('aggregate')
        break
      case UriTokenizer.TokenKind.BottomCountTrafo:
        found = this._nextMethod('bottomcount')
        break
      case UriTokenizer.TokenKind.BottomPercentTrafo:
        found = this._nextMethod('bottompercent')
        break
      case UriTokenizer.TokenKind.BottomSumTrafo:
        found = this._nextMethod('bottomsum')
        break
      case UriTokenizer.TokenKind.ComputeTrafo:
        found = this._nextMethod('compute')
        break
      case UriTokenizer.TokenKind.ExpandTrafo:
        found = this._nextMethod('expand')
        break
      case UriTokenizer.TokenKind.FilterTrafo:
        found = this._nextMethod('filter')
        break
      case UriTokenizer.TokenKind.GroupByTrafo:
        found = this._nextMethod('groupby')
        break
      case UriTokenizer.TokenKind.OrderByTrafo:
        found = this._nextMethod('orderby')
        break
      case UriTokenizer.TokenKind.SearchTrafo:
        found = this._nextMethod('search')
        break
      case UriTokenizer.TokenKind.SkipTrafo:
        found = this._nextMethod('skip')
        break
      case UriTokenizer.TokenKind.TopTrafo:
        found = this._nextMethod('top')
        break
      case UriTokenizer.TokenKind.TopCountTrafo:
        found = this._nextMethod('topcount')
        break
      case UriTokenizer.TokenKind.TopPercentTrafo:
        found = this._nextMethod('toppercent')
        break
      case UriTokenizer.TokenKind.TopSumTrafo:
        found = this._nextMethod('topsum')
        break

      // Roll-up specification for the aggregation extension
      case UriTokenizer.TokenKind.RollUpSpec:
        found = this._nextMethod('rollup')
        break

      // Suffixes
      case UriTokenizer.TokenKind.AscSuffix:
        found = this._nextSuffix('asc')
        break
      case UriTokenizer.TokenKind.DescSuffix:
        found = this._nextSuffix('desc')
        break

      default:
    }

    if (found) {
      this._startIndex = previousIndex
    } else {
      this._index = previousIndex
    }
    return found
  }

  /**
   * Determine whether the index is at the end of the string to be parsed; leave the index unchanged.
   * @returns {boolean} whether the current index is at the end of the string to be parsed
   * @private
   */
  _nextEOF () {
    return this._index >= this._parseString.length
  }

  /**
   * Move past the given string constant if found; otherwise leave the index unchanged.
   * @param {string} constant the string constant
   * @returns {boolean} whether the constant has been found at the current index
   * @private
   */
  _nextConstant (constant) {
    if (this._parseString.startsWith(constant, this._index)) {
      this._index += constant.length
      return true
    }
    return false
  }

  /**
   * Move past the given regular expression, if found; otherwise leave the index unchanged.
   * @param {RegExp} regexp the regular expression
   * @returns {boolean} whether the regular expression has been found at the current index
   * @private
   */
  _nextWithRegularExpression (regexp) {
    const parsed = regexp.exec(this._parseString.substring(this._index))
    if (!parsed) return false
    this._index += parsed[0].length
    return true
  }

  /**
   * Move past the given character if found; otherwise leave the index unchanged.
   * @param {string} character the character
   * @returns {boolean} whether the given character has been found at the current index
   * @private
   */
  _nextCharacter (character) {
    if (this._index < this._parseString.length && this._parseString.charAt(this._index) === character) {
      this._index++
      return true
    }
    return false
  }

  /**
   * Move past a digit character ('0' to '9') if found; otherwise leave the index unchanged.
   * @returns {boolean} whether a digit character has been found at the current index
   * @private
   */
  _nextDigit () {
    if (this._index < this._parseString.length) {
      const code = this._parseString.charAt(this._index)
      if (code >= '0' && code <= '9') {
        this._index++
        return true
      }
    }
    return false
  }

  /**
   * Move past whitespace (space or horizontal tabulator) characters if found; otherwise leave the index unchanged.
   * @returns {boolean} whether whitespace characters have been found at the current index
   * @private
   */
  _nextWhitespace () {
    let count = 0
    while (this._nextCharacter(' ') || this._nextCharacter('\t')) count++
    return count > 0
  }

  /**
   * Move past the given whitespace-surrounded operator constant if found.
   * @param {string} operator the name of the operator
   * @returns {boolean} whether the operator has been found at the current index
   * @private
   */
  _nextBinaryOperator (operator) {
    return this._nextWhitespace() && this._nextConstant(operator) && this._nextWhitespace()
  }

  /**
   * Move past the given whitespace-suffixed operator constant if found.
   * @param {string} operator the name of the operator
   * @returns {boolean} whether the operator has been found at the current index
   * @private
   */
  _nextUnaryOperator (operator) {
    return this._nextConstant(operator) && this._nextWhitespace()
  }

  /**
   * Move past the minus operator if found.
   * @returns {boolean} whether the operator has been found at the current index
   * @private
   */
  _nextMinusOperator () {
    // In order to avoid unnecessary minus operators for negative numbers,
    // we have to check what follows the minus sign.
    return this._nextCharacter('-') && !this._nextDigit() && !this._nextConstant('INF')
  }

  /**
   * Move past the given method name and its immediately following opening parenthesis if found.
   * @param {string} methodName the name of the method
   * @returns {boolean} whether the method has been found at the current index
   * @private
   */
  _nextMethod (methodName) {
    return this._nextConstant(methodName) && this._nextCharacter('(')
  }

  /**
   * Move past (required) whitespace and the given suffix name if found.
   * @param {string} suffixName the name of the suffix
   * @returns {boolean} whether the suffix has been found at the current index
   * @private
   */
  _nextSuffix (suffixName) {
    return this._nextWhitespace() && this._nextConstant(suffixName)
  }

  /**
   * Move past an integer value if found; otherwise leave the index unchanged.
   * @returns {boolean} whether an integer value has been found at the current index
   * @private
   */
  _nextIntegerValue () {
    return this._nextWithRegularExpression(INTEGER_VALUE_REGEXP)
  }

  /**
   * Move past a decimal value with a fractional part if found; otherwise leave the index unchanged.
   * Whole numbers must be found with {@link #nextIntegerValue()}.
   *
   * @returns {boolean} whether a decimal value has been found at the current index
   * @private
   */
  _nextDecimalValue () {
    return this._nextWithRegularExpression(DECIMAL_VALUE_REGEXP)
  }

  /**
   * Move past a floating-point-number value with an exponential part
   * or one of the special constants 'NaN', '-INF', and 'INF' if found;
   * otherwise leave the index unchanged.
   * Whole numbers must be found with {@link #nextIntegerValue()}.
   * Decimal numbers must be found with {@link #nextDecimalValue()}.
   *
   * @returns {boolean} whether a double value has been found at the current index
   * @private
   */
  _nextDoubleValue () {
    return this._nextWithRegularExpression(DOUBLE_VALUE_REGEXP)
  }

  /**
   * Move past an enumeration-type value if found; otherwise leave the index unchanged.
   * @returns {boolean} whether an enumeration-type value has been found at the current index
   * @private
   */
  _nextEnumValue () {
    const lastGoodIndex = this._index
    if (this._nextWithRegularExpression(QUALIFIED_NAME_REGEXP) && this._nextCharacter("'")) {
      do {
        if (!(this._nextWithRegularExpression(IDENTIFIER_REGEXP) || this._nextIntegerValue(true))) {
          this._index = lastGoodIndex
          return false
        }
      } while (this._nextCharacter(','))
      if (this._nextCharacter("'")) return true
    }
    this._index = lastGoodIndex
    return false
  }

  /**
   * Move past a geography or geometry value if found.
   * @param {boolean} isGeography if true the suffix must be 'geography', if false it must be 'geometry'
   * @param {RegExp} regexp the regular expression for the value within the quotes
   * @returns {boolean} whether a geography/geometry value has been found at the current index
   * @private
   */
  _nextGeoValue (isGeography, regexp) {
    const prefix = isGeography ? 'geography' : 'geometry'
    if (
      this._index + prefix.length - 1 < this._parseString.length &&
      this._parseString.substring(this._index, this._index + prefix.length).toLowerCase() === prefix
    ) {
      this._index += prefix.length
    } else {
      return false
    }
    return this._nextCharacter("'") && this._nextWithRegularExpression(regexp) && this._nextCharacter("'")
  }

  /**
   * Move past a JSON string if found; otherwise leave the index unchanged.
   * @returns {boolean} whether a JSON string has been found at the current index
   * @private
   */
  _nextJsonString () {
    return this._nextWithRegularExpression(JSON_STRING_REGEXP)
  }

  /**
   * Move past a JSON value if found; otherwise leave the index unchanged.
   * @returns {boolean} whether a JSON value has been found at the current index
   * @private
   */
  _nextJsonValue () {
    return (
      this._nextConstant('null') ||
      this._nextConstant('true') ||
      this._nextConstant('false') ||
      this._nextDoubleValue() ||
      this._nextDecimalValue() ||
      this._nextIntegerValue() ||
      this._nextJsonString() ||
      this._nextJsonArrayOrObject()
    )
  }

  /**
   * Move past a JSON object member if found; otherwise leave the index unchanged.
   * @returns {boolean} whether a JSON object member has been found at the current index
   * @private
   */
  _nextJsonMember () {
    const lastGoodIndex = this._index
    if (this._nextJsonString() && this._nextCharacter(':') && this._nextJsonValue()) {
      return true
    }
    this._index = lastGoodIndex
    return false
  }

  /**
   * Move past a JSON array or object if found; otherwise leave the index unchanged.
   * @returns {boolean} whether a JSON array or object has been found at the current index
   * @private
   */
  _nextJsonArrayOrObject () {
    const lastGoodIndex = this._index
    if (this._nextCharacter('[')) {
      if (this._nextJsonValue()) {
        while (this._nextCharacter(',')) {
          if (!this._nextJsonValue()) {
            this._index = lastGoodIndex
            return false
          }
        }
      }
      if (this._nextCharacter(']')) return true
      this._index = lastGoodIndex
      return false
    } else if (this._nextCharacter('{')) {
      if (this._nextJsonMember()) {
        while (this._nextCharacter(',')) {
          if (!this._nextJsonMember()) {
            this._index = lastGoodIndex
            return false
          }
        }
      }
      if (this._nextCharacter('}')) return true
      this._index = lastGoodIndex
      return false
    }

    return false
  }

  /**
   * Move past a search operator AND if found.
   * @returns {boolean} whether the search operator AND has been found at the current index
   * @private
   */
  _nextAndOperatorSearch () {
    if (this._nextWhitespace()) {
      const lastGoodIndex = this._index
      if (this._nextUnaryOperator('OR')) return false
      if (!this._nextUnaryOperator('AND')) this._index = lastGoodIndex // implicit AND
      return true
    }
    return false
  }

  /**
   * Move past a search word if found.
   * @returns {boolean} whether a search word has been found at the current index
   * @private
   */
  _nextWord () {
    const lastGoodIndex = this._index
    if (this._nextWithRegularExpression(WORD_REGEXP)) {
      const word = this._parseString.substring(lastGoodIndex, this._index)
      if (word !== 'OR' && word !== 'AND' && word !== 'NOT') return true
    }
    this._index = lastGoodIndex
    return false
  }

  /**
   * Require the next requested token. If the next token is not of the requested kind an exception is thrown.
   * @param {UriTokenizer.TokenKind} tokenKind next token
   * @returns {boolean} true if reading next token was successful
   * @throws {UriSyntaxError} if the token has not been found
   */
  requireNext (tokenKind) {
    if (this.next(tokenKind)) return true
    throw new UriSyntaxError(UriSyntaxError.Message.TOKEN_REQUIRED, tokenKind, this._parseString, this.getPosition())
  }
}

UriTokenizer.TokenKind = {
  EOF: 'EOF', // signals the end of the string to be parsed

  // constant-value tokens (convention: uppercase)
  REF: 'REF',
  VALUE: 'VALUE',
  COUNT: 'COUNT',
  METADATA: 'METADATA',
  BATCH: 'BATCH',
  CROSSJOIN: 'CROSSJOIN',
  ALL: 'ALL',
  ENTITY: 'ENTITY',
  ROOT: 'ROOT',
  IT: 'IT',

  APPLY: 'APPLY', // for the aggregation extension
  EXPAND: 'EXPAND',
  FILTER: 'FILTER',
  LEVELS: 'LEVELS',
  ORDERBY: 'ORDERBY',
  SEARCH: 'SEARCH',
  SELECT: 'SELECT',
  SKIP: 'SKIP',
  TOP: 'TOP',

  LAMBDA_ANY: 'LAMBDA_ANY',
  LAMBDA_ALL: 'LAMBDA_ALL',

  OPEN: 'OPEN',
  CLOSE: 'CLOSE',
  COMMA: 'COMMA',
  SEMI: 'SEMI',
  COLON: 'COLON',
  DOT: 'DOT',
  SLASH: 'SLASH',
  EQ: 'EQ',
  STAR: 'STAR',
  PLUS: 'PLUS',

  NULL: 'NULL',
  MAX: 'MAX',

  AVERAGE: 'AVERAGE', // for the aggregation extension
  COUNTDISTINCT: 'COUNTDISTINCT', // for the aggregation extension
  IDENTITY: 'IDENTITY', // for the aggregation extension
  MIN: 'MIN', // for the aggregation extension
  SUM: 'SUM', // for the aggregation extension

  // variable-value tokens (convention: mixed case)
  ODataIdentifier: 'ODataIdentifier',
  QualifiedName: 'QualifiedName',
  ParameterAliasName: 'ParameterAliasName',

  BooleanValue: 'BooleanValue',
  StringValue: 'StringValue',
  UnsignedIntegerValue: 'UnsignedIntegerValue',
  IntegerValue: 'IntegerValue',
  GuidValue: 'GuidValue',
  DateValue: 'DateValue',
  DateTimeOffsetValue: 'DateTimeOffsetValue',
  TimeOfDayValue: 'TimeOfDayValue',
  DecimalValue: 'DecimalValue',
  DoubleValue: 'DoubleValue',
  DurationValue: 'DurationValue',
  BinaryValue: 'BinaryValue',
  EnumValue: 'EnumValue',

  GeographyPoint: 'GeographyPoint',
  GeometryPoint: 'GeometryPoint',
  GeographyLineString: 'GeographyLineString',
  GeometryLineString: 'GeometryLineString',
  GeographyPolygon: 'GeographyPolygon',
  GeometryPolygon: 'GeometryPolygon',
  GeographyMultiPoint: 'GeographyMultiPoint',
  GeometryMultiPoint: 'GeometryMultiPoint',
  GeographyMultiLineString: 'GeographyMultiLineString',
  GeometryMultiLineString: 'GeometryMultiLineString',
  GeographyMultiPolygon: 'GeographyMultiPolygon',
  GeometryMultiPolygon: 'GeometryMultiPolygon',
  GeographyCollection: 'GeographyCollection',
  GeometryCollection: 'GeometryCollection',

  jsonArrayOrObject: 'jsonArrayOrObject',

  Word: 'Word',
  Phrase: 'Phrase',

  OrOperatorSearch: 'OrOperatorSearch',
  AndOperatorSearch: 'AndOperatorSearch',
  NotOperatorSearch: 'NotOperatorSearch',

  OrOperator: 'OrOperator',
  AndOperator: 'AndOperator',
  EqualsOperator: 'EqualsOperator',
  NotEqualsOperator: 'NotEqualsOperator',
  GreaterThanOperator: 'GreaterThanOperator',
  GreaterThanOrEqualsOperator: 'GreaterThanOrEqualsOperator',
  LessThanOperator: 'LessThanOperator',
  LessThanOrEqualsOperator: 'LessThanOrEqualsOperator',
  HasOperator: 'HasOperator',
  AddOperator: 'AddOperator',
  SubOperator: 'SubOperator',
  MulOperator: 'MulOperator',
  DivOperator: 'DivOperator',
  ModOperator: 'ModOperator',
  MinusOperator: 'MinusOperator',
  NotOperator: 'NotOperator',

  AsOperator: 'AsOperator', // for the aggregation extension
  FromOperator: 'FromOperator', // for the aggregation extension
  WithOperator: 'WithOperator', // for the aggregation extension

  CastMethod: 'CastMethod',
  CeilingMethod: 'CeilingMethod',
  ConcatMethod: 'ConcatMethod',
  ContainsMethod: 'ContainsMethod',
  DateMethod: 'DateMethod',
  DayMethod: 'DayMethod',
  EndswithMethod: 'EndswithMethod',
  FloorMethod: 'FloorMethod',
  FractionalsecondsMethod: 'FractionalsecondsMethod',
  GeoDistanceMethod: 'GeoDistanceMethod',
  GeoIntersectsMethod: 'GeoIntersectsMethod',
  GeoLengthMethod: 'GeoLengthMethod',
  HourMethod: 'HourMethod',
  IndexofMethod: 'IndexofMethod',
  IsofMethod: 'IsofMethod',
  LengthMethod: 'LengthMethod',
  MaxdatetimeMethod: 'MaxdatetimeMethod',
  MindatetimeMethod: 'MindatetimeMethod',
  MinuteMethod: 'MinuteMethod',
  MonthMethod: 'MonthMethod',
  NowMethod: 'NowMethod',
  RoundMethod: 'RoundMethod',
  SecondMethod: 'SecondMethod',
  StartswithMethod: 'StartswithMethod',
  SubstringMethod: 'SubstringMethod',
  TimeMethod: 'TimeMethod',
  TolowerMethod: 'TolowerMethod',
  TotaloffsetminutesMethod: 'TotaloffsetminutesMethod',
  TotalsecondsMethod: 'TotalsecondsMethod',
  ToupperMethod: 'ToupperMethod',
  TrimMethod: 'TrimMethod',
  YearMethod: 'YearMethod',

  IsDefinedMethod: 'IsDefinedMethod', // for the aggregation extension

  AggregateTrafo: 'AggregateTrafo', // for the aggregation extension
  BottomCountTrafo: 'BottomCountTrafo', // for the aggregation extension
  BottomPercentTrafo: 'BottomPercentTrafo', // for the aggregation extension
  BottomSumTrafo: 'BottomSumTrafo', // for the aggregation extension
  ComputeTrafo: 'ComputeTrafo', // for the aggregation extension
  ExpandTrafo: 'ExpandTrafo', // for the aggregation extension
  FilterTrafo: 'FilterTrafo', // for the aggregation extension
  GroupByTrafo: 'GroupByTrafo', // for the aggregation extension
  OrderByTrafo: 'OrderByTrafo', // for the aggregation extension
  SearchTrafo: 'SearchTrafo', // for the aggregation extension
  SkipTrafo: 'SkipTrafo', // for the aggregation extension
  TopTrafo: 'TopTrafo', // for the aggregation extension
  TopCountTrafo: 'TopCountTrafo', // for the aggregation extension
  TopPercentTrafo: 'TopPercentTrafo', // for the aggregation extension
  TopSumTrafo: 'TopSumTrafo', // for the aggregation extension

  RollUpSpec: 'RollUpSpec', // for the aggregation extension

  AscSuffix: 'AscSuffix',
  DescSuffix: 'DescSuffix'
}

module.exports = UriTokenizer
