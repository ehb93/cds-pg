'use strict'

const EdmTypeKind = require('../edm/EdmType').TypeKind
const EdmPrimitiveTypeKind = require('../edm/EdmPrimitiveTypeKind')

const REGEXP_SINGLE_QUOTE = new RegExp("'", 'g')
const REGEXP_TWO_SINGLE_QUOTES = new RegExp("''", 'g')

/**
 * UriHelper has utility methods for reading and constructing URIs.
 */
class UriHelper {
  /**
   * Build the normalized string literal form of a value according to its edm type.
   *
   * @param {string} uriLiteral The current uri literal
   * @param {EdmType} edmType The current edm type for converting the literal into
   * @returns {?string} the converted string or null if uriLiteral is null
   */
  static fromUriLiteral (uriLiteral, edmType) {
    if (edmType === EdmPrimitiveTypeKind.String) {
      return uriLiteral.substring(1, uriLiteral.length - 1).replace(REGEXP_TWO_SINGLE_QUOTES, "'")
    }

    if (
      edmType === EdmPrimitiveTypeKind.Duration ||
      edmType === EdmPrimitiveTypeKind.Binary ||
      edmType.getKind() === EdmTypeKind.ENUM ||
      edmType.getName().startsWith('Geo')
    ) {
      return uriLiteral.substring(uriLiteral.indexOf("'") + 1, uriLiteral.length - 1)
    }

    if (edmType.getKind() === EdmTypeKind.DEFINITION) {
      return UriHelper.fromUriLiteral(uriLiteral, edmType.getUnderlyingType())
    }

    return uriLiteral
  }

  /**
   * Build the URI string literal form of a value given as string according to its EDM type.
   *
   * @param {string} value the value
   * @param {EdmType} edmType the EDM type of the value
   * @returns {string} the converted string
   */
  static toUriLiteral (value, edmType) {
    if (value === null) return 'null'
    if (edmType === EdmPrimitiveTypeKind.String) return "'" + value.replace(REGEXP_SINGLE_QUOTE, "''") + "'"
    if (edmType === EdmPrimitiveTypeKind.Duration) return "duration'" + value + "'"
    if (edmType === EdmPrimitiveTypeKind.Binary) return "binary'" + value + "'"
    if (edmType.getKind() === EdmTypeKind.DEFINITION) {
      return UriHelper.toUriLiteral(value, edmType.getUnderlyingType())
    }
    if (edmType.getKind() === EdmTypeKind.ENUM) return edmType.getFullQualifiedName() + "'" + value + "'"
    if (edmType.getName().startsWith('Geography')) return "geography'" + value + "'"
    if (edmType.getName().startsWith('Geometry')) return "geometry'" + value + "'"
    return value
  }
}

module.exports = UriHelper
