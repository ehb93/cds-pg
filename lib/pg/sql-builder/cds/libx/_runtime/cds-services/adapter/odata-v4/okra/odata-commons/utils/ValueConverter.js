'use strict'

const { big } = require('@sap/cds-foss')

const EdmTypeKind = require('../edm/EdmType').TypeKind
const EdmPrimitiveTypeKind = require('../edm/EdmPrimitiveTypeKind')
const JsonContentTypeInfo = require('../format/JsonContentTypeInfo')
const IllegalArgumentError = require('../errors/IllegalArgumentError')

const PLUS_REGEXP = new RegExp('\\+', 'g')
const SLASH_REGEXP = new RegExp('/', 'g')

/**
 * Converter of JavaScript values to the values of OData EDM types. The values are converted according to the OData
 * ABNF Construction Rules.
 */
class ValueConverter {
  /**
   * @param {ValueValidator} valueValidator - validator to be used to validate the values before they are converted
   * @param {JsonContentTypeInfo} formatParams JSON serializing options
   */
  constructor (valueValidator, formatParams = new JsonContentTypeInfo()) {
    this._valueValidator = valueValidator
    this._formatParams = formatParams

    // for better error message
    this._valueValidator._valueConverter = this
  }

  /**
   * Converts value to OData format. The method converts values of EDM primitive or TypeDefinition types.
   * @param {(EdmProperty|EdmTerm|EdmReturnType)} propertyOrReturnType - object containing metadata (e.g., type information) about the
   * value to be converted; it can be an instance of EdmProperty, EdmTerm, or EdmReturnType (its type can be an EdmPrimitiveType or an EdmTypeDefinition)
   * @param {(string|number|boolean|Buffer|Object)} value - value to be converted
   * @returns {(string|number|boolean|Object)} converted value
   */
  convert (propertyOrReturnType, value) {
    // for better error message
    this._propertyOrReturnType = propertyOrReturnType

    const type = this._getPrimitiveType(propertyOrReturnType.getType())
    switch (type) {
      case EdmPrimitiveTypeKind.Binary:
        return this.convertBinary(value, this._getMaxLength(propertyOrReturnType))
      case EdmPrimitiveTypeKind.Boolean:
        return this.convertBoolean(value)
      case EdmPrimitiveTypeKind.Byte:
        return this.convertByte(value)
      case EdmPrimitiveTypeKind.SByte:
        return this.convertSByte(value)
      case EdmPrimitiveTypeKind.Date:
        return this.convertDate(value)
      case EdmPrimitiveTypeKind.DateTimeOffset:
        return this.convertDateTimeOffset(value, this._getPrecision(propertyOrReturnType) || 0)
      case EdmPrimitiveTypeKind.TimeOfDay:
        return this.convertTimeOfDay(value, this._getPrecision(propertyOrReturnType) || 0)
      case EdmPrimitiveTypeKind.Duration:
        return this.convertDuration(value, this._getPrecision(propertyOrReturnType) || 0)
      case EdmPrimitiveTypeKind.Decimal:
        return this.convertDecimal(
          value,
          this._getPrecision(propertyOrReturnType),
          this._getScale(propertyOrReturnType) || 0
        )
      case EdmPrimitiveTypeKind.Single:
        return this.convertSingle(value)
      case EdmPrimitiveTypeKind.Double:
        return this.convertDouble(value)
      case EdmPrimitiveTypeKind.Guid:
        return this.convertGuid(value)
      case EdmPrimitiveTypeKind.Int16:
        return this.convertInt16(value)
      case EdmPrimitiveTypeKind.Int32:
        return this.convertInt32(value)
      case EdmPrimitiveTypeKind.Int64:
        return this.convertInt64(value)
      case EdmPrimitiveTypeKind.String:
        return this.convertString(value, this._getMaxLength(propertyOrReturnType))
      case EdmPrimitiveTypeKind.GeographyPoint:
      case EdmPrimitiveTypeKind.GeometryPoint:
        return this.convertGeoPoint(value, this._getSrid(propertyOrReturnType))
      case EdmPrimitiveTypeKind.GeographyLineString:
      case EdmPrimitiveTypeKind.GeometryLineString:
        return this.convertGeoLineString(value, this._getSrid(propertyOrReturnType))
      case EdmPrimitiveTypeKind.GeographyPolygon:
      case EdmPrimitiveTypeKind.GeometryPolygon:
        return this.convertGeoPolygon(value, this._getSrid(propertyOrReturnType))
      case EdmPrimitiveTypeKind.GeographyMultiPoint:
      case EdmPrimitiveTypeKind.GeometryMultiPoint:
        return this.convertGeoMultiPoint(value, this._getSrid(propertyOrReturnType))
      case EdmPrimitiveTypeKind.GeographyMultiLineString:
      case EdmPrimitiveTypeKind.GeometryMultiLineString:
        return this.convertGeoMultiLineString(value, this._getSrid(propertyOrReturnType))
      case EdmPrimitiveTypeKind.GeographyMultiPolygon:
      case EdmPrimitiveTypeKind.GeometryMultiPolygon:
        return this.convertGeoMultiPolygon(value, this._getSrid(propertyOrReturnType))
      case EdmPrimitiveTypeKind.GeographyCollection:
      case EdmPrimitiveTypeKind.GeometryCollection:
        return this.convertGeoCollection(value, this._getSrid(propertyOrReturnType))
      default:
        if (type.getKind() === EdmTypeKind.ENUM) return this.convertEnum(type, value)
        throw new IllegalArgumentError(
          `Properties of '${type.getFullQualifiedName().toString()}' type are not supported`
        )
    }
  }

  /**
   * Return the "real" primitive type.
   * If type is a type definition, then the underlying primitive type is returned.
   *
   * @param {EdmPrimitiveType|EdmEnumType|EdmTypeDefinition} type - EDM type
   * @returns {EdmPrimitiveType} primitive type
   * @private
   */
  _getPrimitiveType (type) {
    const typeKind = type.getKind()
    if (typeKind === EdmTypeKind.PRIMITIVE || typeKind === EdmTypeKind.ENUM) return type
    if (typeKind === EdmTypeKind.DEFINITION) return type.getUnderlyingType()
    throw new IllegalArgumentError(`Conversion of properties of ${typeKind} type kind is not supported`)
  }

  /**
   * Return value of the MaxLength facet if specified.
   * If the specified type is a TypeDefinition, then take also the type definition's facet into account.
   *
   * @param {(EdmProperty|EdmTerm|EdmReturnType)} propertyOrReturnType - object containing metadata (e.g., facets)
   * @returns {?(number|string)} value of MaxLength facet
   * @private
   */
  _getMaxLength (propertyOrReturnType) {
    const maxLength = propertyOrReturnType.getMaxLength()
    if (maxLength !== null && maxLength !== undefined) return maxLength
    const type = propertyOrReturnType.getType()
    if (type.getKind() === EdmTypeKind.DEFINITION) return type.getMaxLength()
    return null
  }

  /**
   * Returns value of the Precision facet if specified.
   * If the specified type is a TypeDefinition, then take also the type definition's facet into account.
   *
   * @param {(EdmProperty|EdmTerm|EdmReturnType)} propertyOrReturnType - object containing metadata (e.g., facets)
   * @returns {?number} value of Precision facet
   * @private
   */
  _getPrecision (propertyOrReturnType) {
    const precision = propertyOrReturnType.getPrecision()
    if (precision !== null && precision !== undefined) return precision
    const type = propertyOrReturnType.getType()
    if (type.getKind() === EdmTypeKind.DEFINITION) return type.getPrecision()
    return null
  }

  /**
   * Returns value of the Scale facet if specified.
   * If the specified type is a TypeDefinition, then take also the type definition's facet into account.
   *
   * @param {(EdmProperty|EdmTerm|EdmReturnType)} propertyOrReturnType - object containing metadata (e.g., facets)
   * @returns {?(number|string)} value of Scale facet
   * @private
   */
  _getScale (propertyOrReturnType) {
    const scale = propertyOrReturnType.getScale()
    if (scale !== null && scale !== undefined) return scale
    const type = propertyOrReturnType.getType()
    if (type.getKind() === EdmTypeKind.DEFINITION) return type.getScale()
    return null
  }

  /**
   * Returns value of the SRID facet if specified.
   * If the specified type is a TypeDefinition, then take also the type definition's facet into account.
   *
   * @param {(EdmProperty|EdmTerm|EdmReturnType)} propertyOrReturnType - object containing metadata (e.g., facets)
   * @returns {?(number|string)} value of SRID facet
   * @private
   */
  _getSrid (propertyOrReturnType) {
    const srid = propertyOrReturnType.getSrid()
    if (srid !== null && srid !== undefined) return srid
    const type = propertyOrReturnType.getType()
    if (type.getKind() === EdmTypeKind.DEFINITION) return type.getSrid()
    return null
  }

  /**
   * Converts value to the value of Edm.Binary type.
   * @param {Buffer} value - value, which should be converted
   * @param {number} [maxLength] - value of MaxLength facet
   * @returns {string} Base64 string
   */
  convertBinary (value, maxLength) {
    this._valueValidator.validateBinary(value, maxLength)
    return (
      value
        .toString('base64')
        // Convert the standard base64 encoding to the URL-safe variant.
        .replace(PLUS_REGEXP, '-')
        .replace(SLASH_REGEXP, '_')
    )
  }

  /**
   * Converts value to the value of Edm.Boolean type.
   * @param {boolean} value - value, which should be converted
   * @returns {boolean} converted value
   */
  convertBoolean (value) {
    this._valueValidator.validateBoolean(value)
    return value
  }

  /**
   * Converts value to the value of Edm.Byte type.
   * @param {number} value - value, which should be converted
   * @returns {number} converted value
   */
  convertByte (value) {
    this._valueValidator.validateByte(value)
    return value
  }

  /**
   * Converts value to the value of Edm.SByte type.
   * @param {number} value - value, which should be converted
   * @returns {number} converted value
   */
  convertSByte (value) {
    this._valueValidator.validateSByte(value)
    return value
  }

  /**
   * Converts value to the value of Edm.Int16 type.
   * @param {number} value - value, which should be converted
   * @returns {number} converted value
   */
  convertInt16 (value) {
    this._valueValidator.validateInt16(value)
    return value
  }

  /**
   * Converts value to the value of Edm.Int32 type.
   * @param {number} value - value, which should be converted
   * @returns {number} converted value
   */
  convertInt32 (value) {
    this._valueValidator.validateInt32(value)
    return value
  }

  /**
   * Converts value to the value of Edm.Int64 type.
   * @param {number|string} value - value, which should be converted
   * @returns {number|string} converted value. The method returns string value if IEEE754 compatible
   * output is requested in the formatParams parameter of the constructor of this class.
   */
  convertInt64 (value) {
    this._valueValidator.validateInt64(value)

    const bigValue = new big(value)

    if (this._formatParams.getIEEE754Setting()) {
      // serialize the value as string
      return bigValue.toFixed()
    }

    // because the value must be serialized as a number (integer in this case), check whether the value can be
    // correctly represented as an integer in javascript
    if (bigValue.lt(Number.MIN_SAFE_INTEGER) || bigValue.gt(Number.MAX_SAFE_INTEGER)) {
      throw new IllegalArgumentError(
        `The Edm.Int64 value ${value} cannot be correctly serialized as an ` +
          'integer. IEEE754Compatible=true format parameter can be specified to serialize the value as a string'
      )
    }

    return Number.parseInt(bigValue.toFixed(), 10)
  }

  /**
   * Converts value to the value of Edm.String type.
   * @param {string} value - value, which should be converted
   * @param {number} [maxLength] - value of MaxLength facet
   * @returns {string} converted value
   */
  convertString (value, maxLength) {
    this._valueValidator.validateString(value, maxLength)
    return value
  }

  /**
   * Converts value to the value of Edm.Date type.
   * @param {string} date - value, which should be converted
   * @returns {string} converted value
   */
  convertDate (date) {
    this._valueValidator.validateDate(date)
    return date
  }

  /**
   * Converts value to the value of Edm.DateTimeOffset type.
   * @param {string} date - value, which should be converted
   * @param {number|string} precision - value of Precision facet
   * @returns {string} converted value
   */
  convertDateTimeOffset (date, precision) {
    this._valueValidator.validateDateTimeOffset(date, precision)
    return date
  }

  /**
   * Converts value to the value of Edm.TimeOfDay type.
   * @param {string} time - value, which should be converted
   * @param {number|string} precision - value of Precision facet
   * @returns {string} converted value
   */
  convertTimeOfDay (time, precision) {
    this._valueValidator.validateTimeOfDay(time, precision)
    return time
  }

  /**
   * Converts value to the value of Edm.Duration type.
   * @param {string} duration - value, which should be converted
   * @param {number|string} precision - value of Precision facet
   * @returns {string} converted value
   */
  convertDuration (duration, precision) {
    this._valueValidator.validateDuration(duration, precision)
    return duration
  }

  /**
   * Converts value to the value of Edm.Decimal type.
   * @param {number|string} value - value, which should be converted
   * @param {number|string} precision - value of Precision facet
   * @param {number|string} scale - value of Scale facet
   * @returns {number|string} converted value. The method returns string value if IEEE754 compatible
   * output is requested in the formatParams parameter of the constructor of this class.
   */
  convertDecimal (value, precision, scale) {
    this._valueValidator.validateDecimal(value, precision, scale)

    const bigValue = new big(value)

    if (this._formatParams.getIEEE754Setting()) {
      // Serialize the value as string.
      return this._formatParams.getExponentialDecimalsSetting() ? bigValue.toExponential() : bigValue.toFixed()
    }

    // If scale is not specified or is 0 then the value must be serialized as an integer.
    if (scale === null || scale === undefined || scale === 0) {
      // The value has to be a safe integer in javascript, to prevent rounding problems.
      if (bigValue.lt(Number.MIN_SAFE_INTEGER) || bigValue.gt(Number.MAX_SAFE_INTEGER)) {
        throw new IllegalArgumentError(
          `The Edm.Decimal value ${value} cannot be correctly serialized as an ` +
            'integer. IEEE754Compatible=true format parameter can be specified to serialize the ' +
            'value as a string'
        )
      }

      return Number.parseInt(bigValue.toFixed(0), 10)
    }

    const absBigValue = bigValue.abs()
    // Because the value must be serialized as a number,
    // check whether the value can be correctly represented as a number in javascript.
    if ((absBigValue.lt(Number.MIN_VALUE) && absBigValue.gt(0)) || absBigValue.gt(Number.MAX_VALUE)) {
      throw new IllegalArgumentError(
        `The Edm.Decimal value ${value} cannot be correctly serialized as a ` +
          'number. IEEE754Compatible=true format parameter can be specified to serialize the value as a ' +
          'string'
      )
    }

    return Number.parseFloat(bigValue.toFixed())
  }

  /**
   * Converts value to the value of Edm.Single type.
   * @param {number} value - value, which should be converted
   * @returns {number} converted value
   */
  convertSingle (value) {
    const nanOrInfinity = this._getNaNOrInfinity(value)
    if (nanOrInfinity) return nanOrInfinity

    this._valueValidator.validateSingle(value)
    return value
  }

  /**
   * Converts value to the value of Edm.Double type.
   * @param {number} value - value, which should be converted
   * @returns {number} converted value
   */
  convertDouble (value) {
    const nanOrInfinity = this._getNaNOrInfinity(value)
    if (nanOrInfinity) return nanOrInfinity

    this._valueValidator.validateDouble(value)
    return value
  }

  /**
   * Returns 'NaN', 'INF' or '-INF' if the value is not a number or infinity.
   * @param {*} value - value, which potentially can be NaN or infinity
   * @returns {?string} 'NaN', 'INF' or '-INF' if the value is not a number or infinity; otherwise - null
   * @private
   */
  _getNaNOrInfinity (value) {
    if (Number.isNaN(value)) return 'NaN'
    if (value === Number.POSITIVE_INFINITY) return 'INF'
    if (value === Number.NEGATIVE_INFINITY) return '-INF'
    return null
  }

  /**
   * Converts value to the value of Edm.Guid type.
   * @param {string} guid - value, which should be converted
   * @returns {string} converted value
   */
  convertGuid (guid) {
    this._valueValidator.validateGuid(guid)
    return guid
  }

  /**
   * Converts value to the value of geo-point type.
   * @param {{ type: string, coordinates: number[] }} point value, which should be converted
   * @param {?(number|string)} [srid] value of SRID facet
   * @returns {{ type: string, coordinates: number[] }} converted value
   */
  convertGeoPoint (point, srid) {
    this._valueValidator.validateGeoPoint(point, srid)
    return point
  }

  /**
   * Converts value to the value of geo-linestring type.
   * @param {{ type: string, coordinates: Array.<number[]> }} linestring value, which should be converted
   * @param {?(number|string)} [srid] value of SRID facet
   * @returns {{ type: string, coordinates: Array.<number[]> }} converted value
   */
  convertGeoLineString (linestring, srid) {
    this._valueValidator.validateGeoLineString(linestring, srid)
    return linestring
  }

  /**
   * Converts value to the value of geo-polygon type.
   * @param {{ type: string, coordinates: Array.<Array.<number[]>> }} polygon value, which should be converted
   * @param {?(number|string)} [srid] value of SRID facet
   * @returns {{ type: string, coordinates: Array.<Array.<number[]>> }} converted value
   */
  convertGeoPolygon (polygon, srid) {
    this._valueValidator.validateGeoPolygon(polygon, srid)
    return polygon
  }

  /**
   * Converts value to the value of geo-multipoint type.
   * @param {{ type: string, coordinates: Array.<number[]> }} points value, which should be converted
   * @param {?(number|string)} [srid] value of SRID facet
   * @returns {{ type: string, coordinates: Arrayy<number[]> }} converted value
   */
  convertGeoMultiPoint (points, srid) {
    this._valueValidator.validateGeoMultiPoint(points, srid)
    return points
  }

  /**
   * Converts value to the value of geo-multilinestring type.
   * @param {{ type: string, coordinates: Array.<Array.<number[]>> }} linestrings value, which should be converted
   * @param {?(number|string)} [srid] value of SRID facet
   * @returns {{ type: string, coordinates: Array.<Array.<number[]>> }} converted value
   */
  convertGeoMultiLineString (linestrings, srid) {
    this._valueValidator.validateGeoMultiLineString(linestrings, srid)
    return linestrings
  }

  /**
   * Converts value to the value of geo-multipolygon type.
   * @param {{ type: string, coordinates: Array.<Array.<Array.<number[]>>> }} polygons value, which should be converted
   * @param {?(number|string)} [srid] value of SRID facet
   * @returns {{ type: string, coordinates: Array.<Array.<Array.<number[]>>> }} converted value
   */
  convertGeoMultiPolygon (polygons, srid) {
    this._valueValidator.validateGeoMultiPolygon(polygons, srid)
    return polygons
  }

  /**
   * Converts value to the value of geo-collection type.
   * @param {{ type: string, geometries: Object[] }} members value, which should be converted
   * @param {?(number|string)} [srid] value of SRID facet
   * @returns {{ type: string, geometries: Object[] }} converted value
   */
  convertGeoCollection (members, srid) {
    this._valueValidator.validateGeoCollection(members, srid)
    return members
  }

  /**
   * Converts enumeration-type value to OData-formatted string.
   * @param {EdmEnumType} type enumeration type
   * @param {number} value value to be converted
   * @returns {string} converted value
   */
  convertEnum (type, value) {
    // Validate that the value is a number and in the supported range.
    switch (type.getUnderlyingType()) {
      case EdmPrimitiveTypeKind.Byte:
        this._valueValidator.validateByte(value)
        break
      case EdmPrimitiveTypeKind.SByte:
        this._valueValidator.validateSByte(value)
        break
      case EdmPrimitiveTypeKind.Int16:
        this._valueValidator.validateInt16(value)
        break
      case EdmPrimitiveTypeKind.Int32:
        this._valueValidator.validateInt32(value)
        break
      case EdmPrimitiveTypeKind.Int64:
        this._valueValidator.validateInt64(value)
        break
      default:
    }

    let result = []
    let remaining = value
    const flags = type.isFlags()
    for (const [name, member] of type.getMembers()) {
      const memberValue = member.getValue()
      if (flags) {
        // Use bitwise AND operator to check whether all bits of the member value are set.
        if ((memberValue & remaining) === memberValue) {
          result.push(name)
          // Use bitwise XOR operator to remove the member-value bits from the remaining value.
          remaining ^= memberValue
        }
      } else if (value === memberValue) return name
    }
    if (!flags || remaining !== 0) {
      throw new IllegalArgumentError(
        'Invalid value ' +
          value +
          ' (JavaScript ' +
          typeof value +
          ') ' +
          'for enumeration type ' +
          type.getFullQualifiedName()
      )
    }
    return result.join(',')
  }
}

module.exports = ValueConverter
