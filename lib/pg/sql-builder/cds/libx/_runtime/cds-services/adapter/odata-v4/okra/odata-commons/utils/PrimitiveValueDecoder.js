'use strict'

const cds = require('../../../../../../cds')

const EdmTypeKind = require('../edm/EdmType').TypeKind
const EdmPrimitiveTypeKind = require('../edm/EdmPrimitiveTypeKind')
const ValueConverter = require('./ValueConverter')
const ValueValidator = require('../validator/ValueValidator')
const JsonContentTypeInfo = require('../format/JsonContentTypeInfo')
const IllegalArgumentError = require('../errors/IllegalArgumentError')

const V2_DATE_TIME_OFFSET_REGEXP = new RegExp('^/Date\\((-?\\d{1,15})(?:(\\+|-)(\\d{4}))?\\)/$')
const V2_TIME_OF_DAY_REGEXP = new RegExp('^PT(?:(\\d{1,2})H)?(?:(\\d{1,4})M)?(?:(\\d{1,5})(\\.\\d+)?S)?$')
const V2_DOUBLE_REGEXP = new RegExp('^-?(?:\\d{1,17}|\\d\\.\\d{1,16}(?:[Ee]-?\\d{1,3})?)$')

const INTEGER_VALIDATION = new RegExp('^[-+]?\\d{1,10}$')
const NUMBER = '[-+]?\\d+(?:\\.\\d+)?(?:[Ee][-+]?\\d+)?'
const NUMBER_VALIDATION = new RegExp('^' + NUMBER + '$')

// Definitions for geo well-known-text literals
const SRID = 'SRID=(\\d{1,8});'
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
// Only the coordinates are grouped with a RegExp group; the code below relies on this fact.
const POINT_VALIDATION = new RegExp('^' + SRID + 'Point\\((' + POSITION + ')\\)$', 'i')
const LINE_STRING_VALIDATION = new RegExp('^' + SRID + 'LineString\\((' + LINE + ')\\)$', 'i')
const POLYGON_VALIDATION = new RegExp('^' + SRID + 'Polygon\\((' + MULTI_LINE + ')\\)$', 'i')
const MULTI_POINT_VALIDATION = new RegExp('^' + SRID + 'MultiPoint\\((' + MULTI_POSITION + ')\\)$', 'i')
const MULTI_LINE_STRING_VALIDATION = new RegExp('^' + SRID + 'MultiLineString\\((' + MULTI_LINE + ')\\)$', 'i')
const MULTI_POLYGON_VALIDATION = new RegExp('^' + SRID + 'MultiPolygon\\((' + MULTI_POLYGON + ')\\)$', 'i')
const COLLECTION_VALIDATION = new RegExp('^' + SRID + 'Collection\\((' + MULTI_GEO_LITERAL + ')\\)$', 'i')

/**
 * The primitive-value decoder decodes primitive values, using OData V4 primitive types.
 * The following mapping of V2 and V4 primitive types is assumed:
 *         V4        |        V2
 * ------------------|------------------
 *  Date             | DateTime
 *  DateTimeOffset   | DateTimeOffset
 *  Duration         | String
 *  TimeOfDay        | Time
 */
class PrimitiveValueDecoder {
  /**
   * Constructor
   * @param {string} [version = '4.0'] the OData version
   */
  constructor (version = '4.0') {
    this._version = version
    this._formatParameters =
      version === '2.0'
        ? new JsonContentTypeInfo().addParameter(JsonContentTypeInfo.FormatParameter.IEEE754, 'true')
        : null
    this._validator = new ValueValidator('decode')
    this._converter = new ValueConverter(this._validator, this._formatParameters)
  }

  /**
   * Set optional JSON formatting parameters.
   * @param {?JsonContentTypeInfo} formatParameters JSON serializing options
   * @returns {PrimitiveValueEncoder} this instance
   */
  setJsonFormatParameters (formatParameters) {
    this._formatParameters = formatParameters
    this._converter = new ValueConverter(this._validator, formatParameters)
    return this
  }

  /**
   * Decode an OData JSON representation of a primitive-type value into its JavaScript value.
   * @param {?(string|number|boolean|Object)} value the JSON value
   * @param {EdmProperty|EdmReturnType|EdmTerm} propertyOrReturnType the EDM property, return type, or term
   * @returns {?(string|number|boolean|Buffer|Object)} the JavaScript value
   */
  decodeJson (value, propertyOrReturnType) {
    if (value === undefined) throw new IllegalArgumentError('Missing value')
    if (value === null) {
      if (propertyOrReturnType.isNullable()) return null
      throw new IllegalArgumentError(
        'Value ' +
          (propertyOrReturnType.getName ? "for '" + propertyOrReturnType.getName() + "' " : '') +
          'must not be null'
      )
    }
    return this._version === '2.0'
      ? this._decodeV2Json(propertyOrReturnType, value)
      : this._decodeV4Json(propertyOrReturnType, value)
  }

  /**
   * Decode an OData plain-text representation of a primitive-type value into its JavaScript value.
   * @param {string} value the plain-text value
   * @param {EdmProperty|EdmReturnType|EdmTerm} propertyOrReturnType the EDM property, return type, or term
   * @returns {?(string|number|boolean|Buffer|Object)} the JavaScript value
   */
  decodeText (value, propertyOrReturnType) {
    if (value === null || value === undefined) throw new IllegalArgumentError('Missing value')
    return this._version === '2.0'
      ? this._decodeV2Text(propertyOrReturnType, value)
      : this._decodeV4Text(propertyOrReturnType, value)
  }

  /**
   * Decode an OData V2 JSON representation of a primitive-type value into its JavaScript value.
   * @param {EdmProperty|EdmReturnType|EdmTerm} propertyOrReturnType the EDM property, return type, or term
   * @param {string|number|boolean} jsonValue the JSON value
   * @returns {string|number|boolean|Buffer} the JavaScript value
   * @private
   */
  _decodeV2Json (propertyOrReturnType, jsonValue) {
    const type = propertyOrReturnType.getType()

    if (type === EdmPrimitiveTypeKind.Binary) {
      return this._decodeBinary(jsonValue, propertyOrReturnType.getMaxLength())
    }

    let value = jsonValue
    if (type === EdmPrimitiveTypeKind.Int64 || type === EdmPrimitiveTypeKind.Decimal) {
      if (typeof value !== 'string') {
        throw new IllegalArgumentError(
          'Invalid value ' +
            value +
            ' (JavaScript ' +
            typeof value +
            '). ' +
            'A JSON string must be specified as value for type ' +
            type.getFullQualifiedName() +
            '.'
        )
      }
    } else if (type === EdmPrimitiveTypeKind.DateTimeOffset) {
      const match = V2_DATE_TIME_OFFSET_REGEXP.exec(value)
      if (!match) {
        throw new IllegalArgumentError(
          'Invalid value ' +
            value +
            ' (JavaScript ' +
            typeof value +
            ') ' +
            'as value for type ' +
            type.getFullQualifiedName() +
            '.'
        )
      }
      value = new Date(0)
      value.setUTCMilliseconds(parseInt(match[1], 10))
      value = value.toISOString().replace(new RegExp('\\.?0*Z'), '')
      if (match[2]) {
        const offsetMinutes = parseInt(match[3], 10)
        value +=
          match[2] +
          Math.trunc(offsetMinutes / 600) +
          Math.trunc((offsetMinutes % 600) / 60) +
          ':' +
          Math.trunc((offsetMinutes % 60) / 10) +
          (offsetMinutes % 10)
      } else {
        value += 'Z'
      }
    } else if (type === EdmPrimitiveTypeKind.Date) {
      const match = V2_DATE_TIME_OFFSET_REGEXP.exec(value)
      if (!match || parseInt(match[1], 10) % (24 * 60 * 60 * 1000) !== 0) {
        throw new IllegalArgumentError(
          'Invalid value ' +
            value +
            ' (JavaScript ' +
            typeof value +
            ') ' +
            'as value for type ' +
            type.getFullQualifiedName() +
            '.'
        )
      }
      value = new Date(0)
      value.setUTCMilliseconds(parseInt(match[1], 10))
      value = value.toISOString().substring(0, 10)
    } else if (type === EdmPrimitiveTypeKind.TimeOfDay) {
      const match = V2_TIME_OF_DAY_REGEXP.exec(value)
      if (!match) {
        throw new IllegalArgumentError(
          'Invalid value ' +
            value +
            ' (JavaScript ' +
            typeof value +
            ') ' +
            'as value for type ' +
            type.getFullQualifiedName() +
            '.'
        )
      }
      value = new Date(0)
      value.setUTCMilliseconds(
        (match[1] ? parseInt(match[1], 10) : 0) * 3600000 +
          (match[2] ? parseInt(match[2], 10) : 0) * 60000 +
          (match[3] ? parseInt(match[3], 10) : 0) * 1000
      )
      // Remove '1970-01-01T' from the front and '.000Z' from the end; add fractional seconds.
      value = value.toISOString().substr(11, 8) + (match[4] || '')
    } else if (type === EdmPrimitiveTypeKind.Single || type === EdmPrimitiveTypeKind.Double) {
      if (typeof value !== 'string') {
        throw new IllegalArgumentError(
          'Invalid value ' +
            value +
            ' (JavaScript ' +
            typeof value +
            '). A JSON string must be specified ' +
            'as value for type ' +
            type.getFullQualifiedName() +
            '.'
        )
      }
      if (value === 'INF') return Number.POSITIVE_INFINITY
      if (value === '-INF') return Number.NEGATIVE_INFINITY
      if (value === 'Nan') return Number.NaN
      if (!V2_DOUBLE_REGEXP.test(value)) {
        throw new IllegalArgumentError(
          'Invalid value ' +
            value +
            ' (JavaScript ' +
            typeof value +
            ') ' +
            'as value for type ' +
            type.getFullQualifiedName() +
            '.'
        )
      }
      value = Number(value)
    }

    // The value converter also asserts maxLength, scale, precision, srid facets.
    return this._converter.convert(propertyOrReturnType, value)
  }

  /**
   * Decode an OData V4 JSON representation of a primitive-type value into its JavaScript value.
   * @param {EdmProperty|EdmReturnType|EdmTerm} propertyOrReturnType the EDM property, return type, or term
   * @param {string|number|boolean|Object} value the JSON value
   * @returns {string|number|boolean|Buffer|Object} the JavaScript value
   * @private
   */
  _decodeV4Json (propertyOrReturnType, value) {
    let type = propertyOrReturnType.getType()
    if (type.getKind() === EdmTypeKind.DEFINITION) type = type.getUnderlyingType()

    if (type === EdmPrimitiveTypeKind.Stream) {
      throw new IllegalArgumentError('Stream properties do not have a JSON representation.')
    }

    if (type === EdmPrimitiveTypeKind.Binary) {
      const maxLength =
        propertyOrReturnType.getMaxLength() ||
        (propertyOrReturnType.getType().getKind() === EdmTypeKind.DEFINITION &&
          propertyOrReturnType.getType().getMaxLength()) ||
        null
      return this._decodeBinary(value, maxLength)
    }

    if (type === EdmPrimitiveTypeKind.Int64 || type === EdmPrimitiveTypeKind.Decimal) {
      if (cds.env.features.strict_numbers) {
        const kind = this._formatParameters.getIEEE754Setting() ? 'string' : 'number'
        // We don't allow JSON numbers as decimal values because there is no way to tell how
        // they looked like originally; JSON.parse() rounds all numbers to 64-bit floating-point numbers.
        if (type === EdmPrimitiveTypeKind.Decimal && kind === 'number') {
          throw new IllegalArgumentError('A JSON number is not supported as Edm.Decimal value.')
        }
        // eslint-disable-next-line valid-typeof
        if (kind !== typeof value) {
          throw new IllegalArgumentError(
            'Invalid value ' +
              value +
              ' (JavaScript ' +
              typeof value +
              '). A JSON ' +
              kind +
              ' must be specified as value.'
          )
        }
      }
      return String(this._converter.convert(propertyOrReturnType, value))
    }

    if (type.getKind() === EdmTypeKind.ENUM) {
      if (typeof value !== 'string') {
        throw new IllegalArgumentError('A JSON string must be specified as value for an enumeration type.')
      }
      let enumValue = null
      for (const flagValue of value.split(',')) {
        let memberValue = null
        for (const [name, member] of type.getMembers()) {
          if (flagValue === name || flagValue === member.getValue().toString()) {
            memberValue = member.getValue()
            break
          }
        }
        if (memberValue === null || (enumValue !== null && !type.isFlags())) {
          throw new IllegalArgumentError(
            'Invalid value ' +
              value +
              ' (JavaScript ' +
              typeof value +
              ') for enumeration type ' +
              type.getFullQualifiedName() +
              '.'
          )
        }
        // Use bitwise OR operator to set the member-value bits in the enumeration value.
        enumValue = enumValue === null ? memberValue : enumValue | memberValue
      }
      return enumValue
    }

    // The value converter also asserts maxLength, scale, precision, srid facets.
    return this._converter.convert(propertyOrReturnType, value)
  }

  /**
   * Decode an OData V4 plain-text representation of a primitive-type value into its JavaScript value.
   * @param {EdmProperty|EdmReturnType|EdmTerm} propertyOrReturnType the EDM property, return type, or term
   * @param {string} valueString the string value of the EDM property or of the return type
   * @returns {string|number|boolean|Buffer|Object} the JavaScript value
   * @private
   */
  _decodeV4Text (propertyOrReturnType, valueString) {
    let type = propertyOrReturnType.getType()
    if (type.getKind() === EdmTypeKind.DEFINITION) type = type.getUnderlyingType()

    if (type === EdmPrimitiveTypeKind.Binary) {
      const valueBuffer = Buffer.from(valueString)
      const maxLength =
        propertyOrReturnType.getMaxLength() ||
        (propertyOrReturnType.getType().getKind() === EdmTypeKind.DEFINITION &&
          propertyOrReturnType.getType().getMaxLength()) ||
        null
      this._validator.validateBinary(valueBuffer, maxLength)
      return valueBuffer
    }

    let decoded
    let value
    switch (type) {
      case EdmPrimitiveTypeKind.Boolean:
        if (valueString === 'true') value = true
        if (valueString === 'false') value = false
        break

      case EdmPrimitiveTypeKind.Int16:
      case EdmPrimitiveTypeKind.Int32:
      case EdmPrimitiveTypeKind.Byte:
      case EdmPrimitiveTypeKind.SByte:
        if (!INTEGER_VALIDATION.test(valueString)) {
          throw new IllegalArgumentError(
            'Wrong value' + (propertyOrReturnType.getName ? " for '" + propertyOrReturnType.getName() + "'" : '')
          )
        }
        value = Number(valueString)
        break

      case EdmPrimitiveTypeKind.Single:
      case EdmPrimitiveTypeKind.Double:
        if (valueString === 'NaN') return Number.NaN
        if (valueString === '-INF') return Number.NEGATIVE_INFINITY
        if (valueString === 'INF') return Number.POSITIVE_INFINITY
        if (!NUMBER_VALIDATION.test(valueString)) {
          throw new IllegalArgumentError(
            'Wrong value' + (propertyOrReturnType.getName ? " for '" + propertyOrReturnType.getName() + "'" : '')
          )
        }
        value = Number(valueString)
        break

      case EdmPrimitiveTypeKind.GeographyPoint:
      case EdmPrimitiveTypeKind.GeometryPoint:
        decoded = this._decodeGeoValue(propertyOrReturnType, valueString, POINT_VALIDATION)
        value = this._decodePoint(decoded.values)
        if (decoded.crs) value.crs = decoded.crs
        break

      case EdmPrimitiveTypeKind.GeographyLineString:
      case EdmPrimitiveTypeKind.GeometryLineString:
        decoded = this._decodeGeoValue(propertyOrReturnType, valueString, LINE_STRING_VALIDATION)
        value = this._decodeLineString(decoded.values)
        if (decoded.crs) value.crs = decoded.crs
        break

      case EdmPrimitiveTypeKind.GeographyPolygon:
      case EdmPrimitiveTypeKind.GeometryPolygon:
        decoded = this._decodeGeoValue(propertyOrReturnType, valueString, POLYGON_VALIDATION)
        value = this._decodePolygon(decoded.values)
        if (decoded.crs) value.crs = decoded.crs
        break

      case EdmPrimitiveTypeKind.GeographyMultiPoint:
      case EdmPrimitiveTypeKind.GeometryMultiPoint:
        decoded = this._decodeGeoValue(propertyOrReturnType, valueString, MULTI_POINT_VALIDATION)
        value = this._decodeMultiPoint(decoded.values)
        if (decoded.crs) value.crs = decoded.crs
        break

      case EdmPrimitiveTypeKind.GeographyMultiLineString:
      case EdmPrimitiveTypeKind.GeometryMultiLineString:
        decoded = this._decodeGeoValue(propertyOrReturnType, valueString, MULTI_LINE_STRING_VALIDATION)
        value = this._decodeMultiLineString(decoded.values)
        if (decoded.crs) value.crs = decoded.crs
        break

      case EdmPrimitiveTypeKind.GeographyMultiPolygon:
      case EdmPrimitiveTypeKind.GeometryMultiPolygon:
        decoded = this._decodeGeoValue(propertyOrReturnType, valueString, MULTI_POLYGON_VALIDATION)
        value = this._decodeMultiPolygon(decoded.values)
        if (decoded.crs) value.crs = decoded.crs
        break

      case EdmPrimitiveTypeKind.GeographyCollection:
      case EdmPrimitiveTypeKind.GeometryCollection:
        decoded = this._decodeGeoValue(propertyOrReturnType, valueString, COLLECTION_VALIDATION)
        value = { type: 'GeometryCollection' }
        // Split at commas that are followed by first letters of type names.
        value.geometries = decoded.values.split(/,(?=[LMP])/i).map(geoLiteral => {
          const content = geoLiteral.slice(geoLiteral.indexOf('(') + 1, -1)
          if (/^Point/i.test(geoLiteral)) return this._decodePoint(content)
          if (/^LineString/i.test(geoLiteral)) return this._decodeLineString(content)
          if (/^Polygon/i.test(geoLiteral)) return this._decodePolygon(content)
          if (/^MultiPoint/i.test(geoLiteral)) return this._decodeMultiPoint(content)
          if (/^MultiLineString/i.test(geoLiteral)) return this._decodeMultiLineString(content)
          if (/^MultiPolygon/i.test(geoLiteral)) return this._decodeMultiPolygon(content)
          throw new IllegalArgumentError('Unknown content in geometry collection ' + geoLiteral)
        })
        if (decoded.crs) value.crs = decoded.crs
        break

      default:
        value = valueString
    }

    // The value converter asserts maxLength, scale, precision facets and performs additional checks for geo types.
    try {
      // The input is a string, so the parameter to expect the format according to IEEE754
      // can be set unconditionally.  This is needed, e.g., for large Int64 values.
      return new ValueConverter(
        this._validator,
        new JsonContentTypeInfo().addParameter(JsonContentTypeInfo.FormatParameter.IEEE754, 'true')
      ).convert(propertyOrReturnType, value)
    } catch (error) {
      throw new IllegalArgumentError(
        'Wrong value' + (propertyOrReturnType.getName ? " for '" + propertyOrReturnType.getName() + "'" : ''),
        error
      )
    }
  }

  /**
   * Decode an OData V2 plain-text representation of a primitive-type value into its JavaScript value.
   * @param {EdmProperty|EdmReturnType|EdmTerm} propertyOrReturnType the EDM property, return type, or term
   * @param {string} valueString the string value of the EDM property or of the return type
   * @returns {string|number|boolean|Buffer} the JavaScript value
   * @private
   */
  _decodeV2Text (propertyOrReturnType, valueString) {
    switch (propertyOrReturnType.getType()) {
      case EdmPrimitiveTypeKind.Single:
      case EdmPrimitiveTypeKind.Double:
        if (valueString === 'Nan') return Number.NaN
        if (valueString === 'NaN') {
          throw new IllegalArgumentError(
            'Wrong value' + (propertyOrReturnType.getName ? " for '" + propertyOrReturnType.getName() + "'" : '')
          )
        }
        return this._decodeV4Text(propertyOrReturnType, valueString) // This also checks the value.

      case EdmPrimitiveTypeKind.Date:
        return this._decodeV4Text(
          propertyOrReturnType, // This also checks the value.
          valueString.endsWith('T00:00:00') ? valueString.substring(0, valueString.length - 9) : valueString
        )

      case EdmPrimitiveTypeKind.TimeOfDay: {
        this._validator.validateDuration(valueString, propertyOrReturnType.getPrecision())
        if (!valueString.startsWith('PT')) {
          throw new IllegalArgumentError(
            'Wrong value' + (propertyOrReturnType.getName ? " for '" + propertyOrReturnType.getName() + "'" : '')
          )
        }
        const result =
          valueString.substring(2, valueString.indexOf('H')) +
          ':' +
          valueString.substring(valueString.indexOf('H') + 1, valueString.indexOf('M')) +
          ':' +
          valueString.substring(valueString.indexOf('M') + 1, valueString.indexOf('S'))
        this._validator.validateTimeOfDay(result, propertyOrReturnType.getPrecision())
        return result
      }

      default:
        return this._decodeV4Text(propertyOrReturnType, valueString) // This also checks the value.
    }
  }

  /**
   * Decodes a geo value.
   * @param {EdmProperty|EdmReturnType|EdmTerm} propertyOrReturnType the corresponding EDM property or return type
   * @param {string} valueString the string value of the EDM property or of the return type
   * @param {RegExp} validationRegExp regular expression that must match
   * @returns {{ values: string, crs: ?Object }} a JavaScript object with values as string and CRS information
   * @throws {IllegalArgumentError} if parsing was not successful
   * @private
   */
  _decodeGeoValue (propertyOrReturnType, valueString, validationRegExp) {
    const edmSrid = this._determineSrid(propertyOrReturnType)
    const match = validationRegExp.exec(valueString)
    if (match && (edmSrid === 'variable' || match[1] === String(edmSrid))) {
      let value = { values: match[2] }
      if (edmSrid === 'variable') value.crs = { type: 'name', properties: { name: 'EPSG:' + match[1] } }
      return value
    }
    throw new IllegalArgumentError(
      'Wrong value' + (propertyOrReturnType.getName ? " for '" + propertyOrReturnType.getName() + "'" : '')
    )
  }

  /**
   * Returns value of the SRID facet or the default value (4326 for geography, 0 for geometry).
   * If the specified type is a TypeDefinition, then take also the type definition's facet into account.
   *
   * @param {EdmProperty|EdmReturnType|EdmTerm} propertyOrReturnType object containing SRID facet
   * @returns {?(number|string)} value of SRID facet
   * @private
   */
  _determineSrid (propertyOrReturnType) {
    let srid = propertyOrReturnType.getSrid()
    let type = propertyOrReturnType.getType()
    if (srid === null && type.getKind() === EdmTypeKind.DEFINITION) {
      srid = type.getSrid()
      type = type.getUnderlyingType()
    }
    if (srid === null) srid = type.getName().startsWith('Geography') ? 4326 : 0
    return srid
  }

  /**
   * Decodes point values into a GeoJSON point object.
   * @param {string} content point values in well-known text format
   * @returns {{ type: string, coordinates: number[] }} a GeoJSON point object
   * @private
   */
  _decodePoint (content) {
    return { type: 'Point', coordinates: content.split(' ').map(Number) }
  }

  /**
   * Decodes linestring values into a GeoJSON linestring object.
   * @param {string} content linestring values in well-known text format
   * @returns {{ type: string, coordinates: Array.<number[]> }} a GeoJSON linestring object
   * @private
   */
  _decodeLineString (content) {
    return {
      type: 'LineString',
      coordinates: content.split(',').map(position => position.split(' ').map(Number))
    }
  }

  /**
   * Decodes polygon values into a GeoJSON polygon object.
   * @param {string} content polygon values in well-known text format
   * @returns {{ type: string, coordinates: Array.<Array.<number[]>> }} a GeoJSON polygon object
   * @private
   */
  _decodePolygon (content) {
    return {
      type: 'Polygon',
      coordinates: content
        .slice(1, -1)
        .split('),(')
        .map(ring => ring.split(',').map(position => position.split(' ').map(Number)))
    }
  }

  /**
   * Decodes multipoint values into a GeoJSON multipoint object.
   * @param {string} content multipoint values in well-known text format
   * @returns {{ type: string, coordinates: Array.<number[]> }} a GeoJSON multipoint object
   * @private
   */
  _decodeMultiPoint (content) {
    return {
      type: 'MultiPoint',
      coordinates: content
        .slice(1, -1)
        .split('),(')
        .map(position => position.split(' ').map(Number))
    }
  }

  /**
   * Decodes multilinestring values into a GeoJSON multilinestring object.
   * @param {string} content multilinestring values in well-known text format
   * @returns {{ type: string, coordinates: Array.<Array.<number[]>> }} a GeoJSON multilinestring object
   * @private
   */
  _decodeMultiLineString (content) {
    return {
      type: 'MultiLineString',
      coordinates: content
        .slice(1, -1)
        .split('),(')
        .map(line => line.split(',').map(position => position.split(' ').map(Number)))
    }
  }

  /**
   * Decodes multipolygon values into a GeoJSON multipolygon object.
   * @param {string} content multipolygon values in well-known text format
   * @returns {{ type: string, coordinates: Array.<Array.<Array.<number[]>>> }} a GeoJSON multipolygon object
   * @private
   */
  _decodeMultiPolygon (content) {
    return {
      type: 'MultiPolygon',
      coordinates: content
        .slice(2, -2)
        .split(')),((')
        .map(polygon =>
          polygon.split('),(').map(line => line.split(',').map(position => position.split(' ').map(Number)))
        )
    }
  }

  /**
   * Decode an OData JSON representation of a binary value into its JavaScript value.
   * @param {string} value the JSON value
   * @param {?(number|string)} maxLength the value of the Maxlength facet
   * @returns {Buffer} the JavaScript value
   * @private
   */
  _decodeBinary (value, maxLength) {
    const valueBuffer = Buffer.from(value, 'base64')
    // The method Buffer.from(...) does not throw an error on invalid input;
    // it simply returns the result of the conversion of the content up to the first error.
    // So we check if the length is correct, taking padding characters into account (see RFC 4648).
    // Newline or other whitespace characters are not allowed according to the OData JSON format specification.
    let length = (value.length * 3) / 4 // Four base64 characters result in three octets.
    if (value.length % 4) {
      // The length is not a multiple of four as it should be.
      length =
        3 * Math.floor(value.length / 4) +
        // The remainder (due to missing padding characters) will result in one or two octets.
        Math.ceil((value.length % 4) / 2)
    } else {
      // Padding characters reduce the amount of expected octets.
      if (value.endsWith('==')) length--
      if (value.endsWith('=')) length--
    }
    if (valueBuffer.length < length) {
      throw new IllegalArgumentError('The value for Edm.Binary is not valid base64 content.')
    }
    this._validator.validateBinary(valueBuffer, maxLength)
    return valueBuffer
  }
}

module.exports = PrimitiveValueDecoder
