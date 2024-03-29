'use strict'

const { big } = require('@sap/cds-foss')
const IllegalArgumentError = require('../errors/IllegalArgumentError')

const YEAR_RE = '(?:-?(?:(?:(?:0\\d{3})|(?:[1-9]\\d{3,}))))'
const MONTH_RE = '(?:(?:0[1-9])|(?:1[012]))'
const DAY_RE = '(?:(?:0[1-9])|(?:[12]\\d)|(?:3[01]))'
const HOURS_RE = '(?:(?:[01]\\d)|(?:2[0-3]))'
const MINUTES_RE = '[0-5]\\d'
const SECONDS_RE = MINUTES_RE
const FRACT_SECONDS_RE = '(\\d{1,12})'
const TIME_ZONE_RE = '(?:Z|(?:[+-]' + HOURS_RE + ':' + MINUTES_RE + '))'

// RegExp for Edm.Date values
const DATE_REG_EXP = new RegExp('^(?:' + YEAR_RE + '-' + MONTH_RE + '-' + DAY_RE + ')$')

// RegExp for Edm.DateTimeOffset values
const DATETIME_OFFSET_REG_EXP = new RegExp(
  '^(?:' +
    YEAR_RE +
    '-' +
    MONTH_RE +
    '-' +
    DAY_RE +
    'T' +
    HOURS_RE +
    ':' +
    MINUTES_RE +
    '(?::' +
    SECONDS_RE +
    '(?:\\.' +
    FRACT_SECONDS_RE +
    ')?)?' +
    TIME_ZONE_RE +
    ')$'
)

// RegExp for Edm.TimeOfDay values
const TIME_OF_DAY_REG_EXP = new RegExp(
  '^(?:' + HOURS_RE + ':' + MINUTES_RE + '(?::' + SECONDS_RE + '(?:\\.' + FRACT_SECONDS_RE + ')?)?)$'
)

const DURATION_TIME_RE =
  '(?:T(?:(?:(?:\\d+H)(?:\\d+M)?(?:\\d+(?:\\.(\\d+))?S)?)|(?:(?:\\d+M)(?:\\d+' +
  '(?:\\.(\\d+))?S)?)|(?:(?:\\d+(?:\\.(\\d+))?S))))'

// RegExp for Edm.Duration values
const DURATION_REG_EXP = new RegExp('^(?:-?P(?:(?:(?:\\d+D)' + DURATION_TIME_RE + '?)|' + DURATION_TIME_RE + '))$')

// RegExp for Edm.Guid values
const HEX_DIG = '[A-Fa-f0-9]'
const GUID_REG_EXP = new RegExp(
  '^(?:' + HEX_DIG + '{8}-' + HEX_DIG + '{4}-' + HEX_DIG + '{4}-' + HEX_DIG + '{4}-' + HEX_DIG + '{12})$'
)

// RegExp for valid names of EPSG-defined coordinate reference systems used in geography/geometry values
const GEO_CRS_NAME_REG_EXP = new RegExp('^EPSG:\\d{1,8}$')

// RegExp for ETag values
const ETAG_VALUE_REG_EXP = new RegExp('^[!#-~\\x80-\\xFF]*$') // %x21 / %x23-7E / obs-text

// max value for Edm.Int64
const INT64_MAX = new big('9223372036854775807')

// min value for Edm.Int64
const INT64_MIN = new big('-9223372036854775808')

// min value for IEEE 754 binary32 (i.e. Edm.Single)
const SINGLE_MIN = 1.401298464324817e-45

// max value for IEEE 754 binary32  (i.e. Edm.Single)
const SINGLE_MAX = 3.4028234663852886e38

/**
 * Validator of values according to the OData ABNF Construction Rules.
 */
class ValueValidator {
  /**
   * Constructor
   * @param {string} [mode] the usage mode
   */
  constructor (mode) {
    this._mode = mode
  }

  /**
   * Validates value of Edm.Binary type.
   * @param {Buffer} value - Edm.Binary value
   * @param {number} maxLength - value of MaxLength facet
   */
  validateBinary (value, maxLength) {
    if (!Buffer.isBuffer(value)) throw this._valueError(value, 'Edm.Binary', 'Buffer instance')
    this._checkMaxLength(value, maxLength, 'Edm.Binary')
  }

  /**
   * Validates value of Edm.Boolean type.
   * @param {boolean} value - Edm.Boolean value
   */
  validateBoolean (value) {
    if (typeof value !== 'boolean') throw this._valueError(value, 'Edm.Boolean', 'boolean value')
  }

  /**
   * Validates value of Edm.Byte type.
   * @param {number} value - Edm.Byte value
   */
  validateByte (value) {
    this._validateIntegerValue(value, 'Edm.Byte', 0, 255)
  }

  /**
   * Returns true if value is of type Byte.
   * @param {number} value the value to check
   * @returns {boolean} true if value is Byte, else false
   */
  isByte (value) {
    return Number.isInteger(value) && value >= 0 && value <= 255
  }

  /**
   * Validates value of Edm.SByte type.
   * @param {number} value - Edm.SByte value
   */
  validateSByte (value) {
    this._validateIntegerValue(value, 'Edm.SByte', -128, 127)
  }

  /**
   * Returns true if value is of type SByte.
   * @param {number} value the value to check
   * @returns {boolean} true if value is SByte, else false
   */
  isSByte (value) {
    return Number.isInteger(value) && value >= -128 && value <= 127
  }

  /**
   * Validates value of Edm.Int16 type.
   * @param {number} value - Edm.Int16 value
   */
  validateInt16 (value) {
    this._validateIntegerValue(value, 'Edm.Int16', -32768, 32767)
  }

  /**
   * Returns true if value is of type Int16.
   * @param {number} value the value to check
   * @returns {boolean} true if value is Int16, else false
   */
  isInt16 (value) {
    return Number.isInteger(value) && value >= -32768 && value <= 32767
  }

  /**
   * Validates value of Edm.Int32 type.
   * @param {number} value - Edm.Int32 value
   */
  validateInt32 (value) {
    this._validateIntegerValue(value, 'Edm.Int32', -2147483648, 2147483647)
  }

  /**
   * Returns true if value is of type Int32.
   * @param {number} value the value to check
   * @returns {boolean} true if value is Int32, else false
   */
  isInt32 (value) {
    return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
  }

  /**
   * Validates value of Edm.Int64 type.
   * @param {number|string} value - Edm.Int64 value. Values in exponential notation are also supported.
   */
  validateInt64 (value) {
    if (!this.isInt64(value)) {
      throw this._valueError(
        value,
        'Edm.Int64',
        'number without decimals in the range from -9223372036854775808 to 9223372036854775807'
      )
    }
  }

  /**
   * Returns true if value is of type Int64.
   * @param {number|string} value the value to check
   * @returns {boolean} true if value is Int64, else false
   */
  isInt64 (value) {
    const bigValue = this._createBig(value)
    return (
      !Number.isNaN(bigValue) && bigValue.round(0).eq(bigValue) && bigValue.gte(INT64_MIN) && bigValue.lte(INT64_MAX)
    )
  }

  /**
   * Validates, whether the value is an integer value and in the specified value range, defined via 'from'
   * and 'to' input parameters.
   *
   * @param {number} value - Any value, which should be validated
   * @param {string} edmType - name of the EDM type for which the value is validated
   * @param {number} from - beginning of the valid value range, which the value must belong to
   * @param {number} to - end of the valid value range, which the value must belong to
   * @private
   */
  _validateIntegerValue (value, edmType, from, to) {
    if (!Number.isInteger(value)) throw this._valueError(value, edmType, 'number without decimals')
    if (value < from || value > to) {
      throw this._valueError(value, edmType, 'number in the range from ' + from + ' to ' + to)
    }
  }

  /**
   * Create a big.js instance for a value.
   * @param {number|string} value the value
   * @returns {Big|number} the created big.js instance or Number.NaN in case of error
   * @private
   */
  _createBig (value) {
    try {
      return new big(value)
    } catch (e) {
      // Big constructor throws NaN if the input is not a number.
      // Return NaN here to avoid yet another try-catch block in the calling function
      return Number.NaN
    }
  }

  /**
   * Validates value of Edm.String type.
   * @param {string} value - Edm.String value
   * @param {number} maxLength - value of MaxLength facet
   */
  validateString (value, maxLength) {
    if (typeof value !== 'string') throw this._valueError(value, 'Edm.String', 'string value')
    this._checkMaxLength(value, maxLength, 'Edm.String')
  }

  /**
   * Checks that the value is not longer than the specified maximum length.
   * @param {string} value value to be checked
   * @param {number} maxLength value of the MaxLength facet for the property, which has the specified value
   * @param {string} typeName name of the type of the value
   * @throws {Error} if the condition is not met
   * @private
   */
  _checkMaxLength (value, maxLength, typeName) {
    // consider only integer maxLength values, ignoring both unspecified and the special 'max' value
    if (Number.isInteger(maxLength) && value.length > maxLength) {
      throw new IllegalArgumentError(
        'Invalid value ' +
          value +
          ' (JavaScript ' +
          typeof value +
          '). The length of the ' +
          typeName +
          ' value must not be greater than the MaxLength facet value (' +
          maxLength +
          ').'
      )
    }
  }

  /**
   * Validates value of Edm.Date type.
   * @param {string} value - Edm.Date value
   */
  validateDate (value) {
    if (typeof value !== 'string' || !DATE_REG_EXP.test(value)) {
      throw this._valueError(value, 'Edm.Date', 'string value in the format YYYY-MM-DD')
    }
  }

  /**
   * Validates value of Edm.DateTimeOffset type.
   * @param {string} value - Edm.DateTimeOffset value
   * @param {number|string} [precision] - value of Precision facet
   */
  validateDateTimeOffset (value, precision) {
    let result = DATETIME_OFFSET_REG_EXP.exec(value)

    if (typeof value !== 'string' || !result) {
      throw this._valueError(value, 'Edm.DateTimeOffset', 'string value in the format YYYY-MM-DDThh:mm:ss.sTZD')
    }

    const milliseconds = result[1]
    this._checkMillisecondsPrecision(value, milliseconds, precision)
  }

  /**
   * Validates value of Edm.TimeOfDay type.
   * @param {string} value - Edm.TimeOfDay value
   * @param {number|string} [precision] - value of Precision facet
   */
  validateTimeOfDay (value, precision) {
    let result = TIME_OF_DAY_REG_EXP.exec(value)

    if (typeof value !== 'string' || !result) {
      throw this._valueError(value, 'Edm.TimeOfDay', 'string value in the format hh:mm:ss.s')
    }

    const milliseconds = result[1]
    this._checkMillisecondsPrecision(value, milliseconds, precision)
  }

  /**
   * Validates value of Edm.Duration type.
   * @param {string} value - Edm.Duration value
   * @param {number|string} [precision] - value of Precision facet
   */
  validateDuration (value, precision) {
    let result = DURATION_REG_EXP.exec(value)

    if (typeof value !== 'string' || !result) {
      throw this._valueError(value, 'Edm.Duration', 'string value in the format PnDTnHnMn.nS')
    }

    // Because of the different combinations of the duration parts (HS, MS, S) we have 6 places (i.e. matching
    // groups) in the regular expression, which match milliseconds. Therefore slice() is called on the result
    // array to "extract" only these 6 matches and find the one that matches, i.e., is not empty.
    const milliseconds = result.slice(1, 7).find(match => match !== undefined)

    this._checkMillisecondsPrecision(value, milliseconds, precision)
  }

  /**
   * Checks whether the milliseconds satisfy the specified precision for the value.
   * @param {string} value - temporal value, which can contain milliseconds
   * @param {string} milliseconds - part of the value, representing milliseconds
   * @param {number} precision - value of the Precision facet for the property, which has the specified value
   * @throws {Error} if the conditions are not met
   * @private
   */
  _checkMillisecondsPrecision (value, milliseconds, precision) {
    // milliseconds is a string value, so just check its length
    if (milliseconds && precision !== null && precision !== undefined && milliseconds.length > precision) {
      throw new IllegalArgumentError(
        'Invalid value ' +
          value +
          ' (JavaScript ' +
          typeof value +
          '). ' +
          'The number of milliseconds does not correspond to the Precision facet value (' +
          precision +
          ').'
      )
    }
  }

  /**
   * Validates value of Edm.Decimal type.
   * @param {number|string} value - Edm.Decimal value. Values in exponential notation are also supported.
   * @param {number|string} [precision] - value of Precision facet
   * @param {number|string} [scale] - value of Scale facet
   */
  validateDecimal (value, precision, scale) {
    // Precision and scale values are not validated assuming that the metadata validation is done before calling
    // the serializer.

    const bigValue = this._createBig(value)

    // Check that the value represents a number.
    if (Number.isNaN(bigValue)) {
      throw this._valueError(value, 'Edm.Decimal', 'number or a string representing a number')
    }

    // check that the value has no more digits than specified for precision
    if (precision !== null && precision !== undefined && bigValue.c.length > precision) {
      throw new IllegalArgumentError(
        'Invalid value ' +
          value +
          ' (JavaScript ' +
          typeof value +
          '). ' +
          'The specified Edm.Decimal value does not correspond to the Precision facet value (' +
          precision +
          ').'
      )
    }

    if (scale === null || scale === undefined || scale === 'variable') {
      return
    }

    // Specify 0 as the rounding mode to simply truncate the number wihout any sort of rounding.
    const integerPart = bigValue.round(0, 0)

    if (precision === scale) {
      if (!integerPart.eq(0)) {
        throw new IllegalArgumentError(
          'Invalid value ' +
            value +
            ' (JavaScript ' +
            typeof value +
            '). ' +
            'If Precision is equal to Scale, a single zero must precede the decimal point ' +
            'in the Edm.Decimal value.'
        )
      }

      return
    }

    // Validate number of digits in the integer (i.e., left) part of the value.
    if (precision !== null && precision !== undefined && integerPart.c.length > precision - scale) {
      throw new IllegalArgumentError(
        'Invalid value ' +
          value +
          ' (JavaScript ' +
          typeof value +
          '). ' +
          'The number of digits to the left of the decimal point must not be greater than ' +
          'Precision minus Scale, i.e., ' +
          (precision - scale) +
          '.'
      )
    }

    // Validate number of digits in the decimal (i.e., right) part of the value.
    const decimalPart = bigValue.minus(integerPart)
    if (decimalPart.c.length > scale && !decimalPart.eq(0)) {
      throw new IllegalArgumentError(
        'Invalid value ' +
          value +
          ' (JavaScript ' +
          typeof value +
          '). ' +
          'The specified Edm.Decimal value has more digits to the right of the decimal point ' +
          'than allowed by the Scale facet value (' +
          scale +
          ').'
      )
    }
  }

  /**
   * Validates value of Edm.Single type.
   * @param {number} value - Edm.Single value
   */
  validateSingle (value) {
    if (!this.isSingle(value)) {
      throw this._valueError(
        value,
        'Edm.Single',
        'number having absolute value in the range from ' + SINGLE_MIN + ' to ' + SINGLE_MAX
      )
    }
  }

  /**
   * Returns true if the provided value is a single precision float number
   * @param {number} value - Any value to check
   * @returns {boolean} True if the value is a valid single precision float number, else false
   */
  isSingle (value) {
    if (typeof value === 'number') {
      const absValue = Math.abs(value)
      return absValue === 0 || (absValue >= SINGLE_MIN && absValue <= SINGLE_MAX)
    }
    return false
  }

  /**
   * Validates value of Edm.Double type.
   * @param {number} value - Edm.Double value
   */
  validateDouble (value) {
    if (typeof value !== 'number') throw this._valueError(value, 'Edm.Double', 'number value')
  }

  /**
   * Validates value of Edm.Guid type.
   * @param {string} value - Edm.Guid value
   */
  validateGuid (value) {
    if (typeof value !== 'string' || !GUID_REG_EXP.test(value)) {
      throw this._valueError(value, 'Edm.Guid', 'string value in the format 8HEXDIG-4HEXDIG-4HEXDIG-4HEXDIG-12HEXDIG')
    }
  }

  /**
   * Validates value of Edm.GeographyPoint or Edm.GeometryPoint type.
   * @param {{ type: string, coordinates: number[] }} value the value
   * @param {?(number|string)} [srid] value of SRID facet
   */
  validateGeoPoint (value, srid) {
    if (!this._isGeoJsonObject('Point', 'coordinates', value, srid) || !this._isGeoPosition(value.coordinates)) {
      throw this._valueError(
        value,
        'Edm.GeographyPoint or Edm.GeometryPoint',
        'JavaScript object with type and coordinates'
      )
    }
  }

  /**
   * Validates value of Edm.GeographyLineString or Edm.GeometryLineString type.
   * @param {{ type: string, coordinates: Array.<number[]> }} value the value
   * @param {?(number|string)} [srid] value of SRID facet
   */
  validateGeoLineString (value, srid) {
    if (
      !this._isGeoJsonObject('LineString', 'coordinates', value, srid) ||
      !value.coordinates.every(this._isGeoPosition, this)
    ) {
      throw this._valueError(
        value,
        'Edm.GeographyLineString or Edm.GeometryLineString',
        'JavaScript object with type and coordinates'
      )
    }
  }

  /**
   * Validates value of Edm.GeographyPolygon or Edm.GeometryPolygon type.
   * @param {{ type: string, coordinates: Array.<Array.<number[]>> }} value the value
   * @param {?(number|string)} [srid] value of SRID facet
   */
  validateGeoPolygon (value, srid) {
    if (!this._isGeoJsonObject('Polygon', 'coordinates', value, srid) || !this._isGeoPolygon(value.coordinates)) {
      throw this._valueError(
        value,
        'Edm.GeographyPolygon or Edm.GeometryPolygon',
        'JavaScript object with type and coordinates'
      )
    }
  }

  /**
   * Validates value of Edm.GeographyMultiPoint or Edm.GeometryMultiPoint type.
   * @param {{ type: string, coordinates: Array.<number[]> }} value the value
   * @param {?(number|string)} [srid] value of SRID facet
   */
  validateGeoMultiPoint (value, srid) {
    if (
      !this._isGeoJsonObject('MultiPoint', 'coordinates', value, srid) ||
      !value.coordinates.every(this._isGeoPosition, this)
    ) {
      throw this._valueError(
        value,
        'Edm.GeographyMultiPoint or Edm.GeometryMultiPoint',
        'JavaScript object with type and coordinates'
      )
    }
  }

  /**
   * Validates value of Edm.GeographyMultiLineString or Edm.GeometryMultiLineString type.
   * @param {{ type: string, coordinates: Array.<Array.<number[]>> }} value the value
   * @param {?(number|string)} [srid] value of SRID facet
   */
  validateGeoMultiLineString (value, srid) {
    if (
      !this._isGeoJsonObject('MultiLineString', 'coordinates', value, srid) ||
      !value.coordinates.every(linestring => Array.isArray(linestring) && linestring.every(this._isGeoPosition, this))
    ) {
      throw this._valueError(
        value,
        'Edm.GeographyMultiLineString or Edm.GeometryMultiLineString',
        'JavaScript object with type and coordinates'
      )
    }
  }

  /**
   * Validates value of Edm.GeographyMultiPolygon or Edm.GeometryMultiPolygon type.
   * @param {{ type: string, coordinates: Array.<Array.<Array.<number[]>>> }} value the value
   * @param {?(number|string)} [srid] value of SRID facet
   */
  validateGeoMultiPolygon (value, srid) {
    if (
      !this._isGeoJsonObject('MultiPolygon', 'coordinates', value, srid) ||
      !value.coordinates.every(this._isGeoPolygon, this)
    ) {
      throw this._valueError(
        value,
        'Edm.GeographyMultiPolygon or Edm.GeometryMultiPolygon',
        'JavaScript object with type and coordinates'
      )
    }
  }

  /**
   * Validates value of Edm.GeographyCollection or Edm.GeometryCollection type.
   * @param {{ type: string, geometries: Array.<Object> }} value the value
   * @param {?(number|string)} [srid] value of SRID facet
   */
  validateGeoCollection (value, srid) {
    if (
      !this._isGeoJsonObject('GeometryCollection', 'geometries', value, srid) ||
      !value.geometries.every(
        geoObject =>
          (this._isGeoJsonObject('Point', 'coordinates', geoObject) && this._isGeoPosition(geoObject.coordinates)) ||
          (this._isGeoJsonObject('LineString', 'coordinates', geoObject) &&
            geoObject.coordinates.every(this._isGeoPosition, this)) ||
          (this._isGeoJsonObject('Polygon', 'coordinates', geoObject) && this._isGeoPolygon(geoObject.coordinates)) ||
          (this._isGeoJsonObject('MultiPoint', 'coordinates', geoObject) &&
            geoObject.coordinates.every(this._isGeoPosition, this)) ||
          (this._isGeoJsonObject('MultiLineString', 'coordinates', geoObject) &&
            geoObject.coordinates.every(
              linestring => Array.isArray(linestring) && linestring.every(this._isGeoPosition, this)
            )) ||
          (this._isGeoJsonObject('MultiPolygon', 'coordinates', geoObject) &&
            geoObject.coordinates.every(this._isGeoPolygon, this))
      )
    ) {
      throw this._valueError(
        value,
        'Edm.GeographyCollection or Edm.GeometryCollection',
        'JavaScript object with type and geometries'
      )
    }
  }

  /**
   * Returns true if the value is a GeoJSON object of the correct type, otherwise false.
   * @param {string} type name of the type
   * @param {string} content the name of the property with content ("coordinates" or "geometries")
   * @param {Object} value the value to be checked
   * @param {?(number|string)} [srid] value of SRID facet
   * @returns {boolean} whether the value is a GeoJSON object of the correct type
   * @private
   */
  _isGeoJsonObject (type, content, value, srid) {
    return (
      typeof value === 'object' &&
      Object.keys(value).length === (srid === 'variable' ? 3 : 2) &&
      value.type === type &&
      Array.isArray(value[content]) &&
      (srid !== 'variable' ||
        (value.crs &&
          value.crs.type === 'name' &&
          value.crs.properties &&
          typeof value.crs.properties.name === 'string' &&
          GEO_CRS_NAME_REG_EXP.test(value.crs.properties.name)))
    )
  }

  /**
   * Returns true if the position is a GeoJSON position array, otherwise false.
   * @param {number[]} position the value to be checked
   * @returns {boolean} whether the position is a GeoJSON position array
   * @private
   */
  _isGeoPosition (position) {
    return (
      Array.isArray(position) &&
      (position.length === 2 || position.length === 3) &&
      typeof position[0] === 'number' &&
      typeof position[1] === 'number' &&
      (position[2] === undefined || typeof position[2] === 'number')
    )
  }

  /**
   * Returns true if the value is an array of coordinates for a GeoJSON polygon, otherwise false.
   * @param {Array.<Array.<number[]>>} polygon the value to be checked
   * @returns {boolean} whether the value is an array of coordinates for a GeoJSON polygon
   * @private
   */
  _isGeoPolygon (polygon) {
    return (
      polygon.length &&
      polygon.every(
        ring =>
          Array.isArray(ring) &&
          ring.length >= 4 &&
          ring.every(this._isGeoPosition, this) &&
          ring[ring.length - 1][0] === ring[0][0] &&
          ring[ring.length - 1][1] === ring[0][1] &&
          ring[ring.length - 1][2] === ring[0][2]
      )
    )
  }

  /**
   * Validates if the provided ETag value matches the expected format.
   * The value must be a string of allowed characters as described in RFC 7232
   * (see https://tools.ietf.org/html/rfc7232#section-2.3 for details).
   *
   * @param {string} value the provided etag value to validate
   * @returns {string} the provided value
   * @throws {IllegalArgumentError} if the etag value doesn't match the required format
   */
  validateEtagValue (value) {
    if (value === undefined) throw new IllegalArgumentError('Invalid undefined ETag value')
    if (value === null) throw new IllegalArgumentError('Invalid null ETag value')
    if (typeof value !== 'string') throw new IllegalArgumentError('Invalid ETag value; it must be type of string')
    if (!ETAG_VALUE_REG_EXP.test(value)) throw new IllegalArgumentError('Invalid ETag value')

    return value
  }

  /**
   * Returns an error instance describing the failed value validation.
   * @param {?(string|number|boolean|Buffer|Object)} value the wrong value
   * @param {string} typeName the name of the EDM type
   * @param {string} requiredText the text describing the requirements for the value
   * @returns {IllegalArgumentError} the error instance
   * @private
   */
  _valueError (value, typeName, requiredText) {
    const property =
      this._mode === 'decode' &&
      this._valueConverter._propertyOrReturnType &&
      this._valueConverter._propertyOrReturnType.getName()

    const msg =
      'Invalid value ' +
      (typeName.includes('Geo') ? JSON.stringify(value) : value) +
      ' (JavaScript ' +
      typeof value +
      ')' +
      (property ? ' for property "' + property + '"' : '') +
      '. ' +
      'A ' +
      requiredText +
      ' must be specified as value for type ' +
      typeName +
      '.'

    return new IllegalArgumentError(msg)
  }
}

module.exports = ValueValidator
