'use strict'

const commons = require('../../odata-commons')
const PreferenceNames = commons.http.Preferences.Names
const PreferenceReturnValues = commons.http.Preferences.ReturnValues
const Preferences = require('./Preferences')
const CustomPreference = require('./CustomPreference')
const HeaderInfo = require('./HeaderInfo')
const AcceptTypeInfo = require('../format/AcceptTypeInfo')
const CharsetInfo = require('../format/CharsetInfo')

const Q_PATTERN = new RegExp('^(?:(?:0(?:\\.\\d{0,3})?)|(?:1(?:\\.0{0,3})?))$')

/**
 * Reads header values as defined in RFCs 7231, 7230, 7240, and 5234.
 * Currently only the headers prefer (only 'odata.continue-on-error', 'odata.maxpagesize', 'return'
 * and everything allowed by http://tools.ietf.org/html/draft-snell-http-prefer-18),
 * content-type and accept are supported.
 *
 * Used syntax:
 *
 * https://tools.ietf.org/html/rfc7230#section-3.2
 * header-field   = field-name ":" OWS field-value OWS
 * field-name     = token
 * field-value    = *( field-content / obs-fold )                   !!! obs-fold is not supported by this parser
 * field-content  = field-vchar [ 1*( SP / HTAB ) field-vchar ]
 * field-vchar    = VCHAR / obs-text
 * obs-fold       = CRLF 1*( SP / HTAB )                            !!! obs-fold is not supported by this parser
 * ; obsolete line folding
 * ; see Section 3.2.4
 *
 * https://tools.ietf.org/html/rfc7231#section-3.1.1.1
 * Content-Type     = media-type
 * media-type       = type "/" subtype *( OWS ";" OWS parameter )
 * parameter        = token "=" ( token / quoted-string )
 * type             = token
 *
 * Accept = #( media-range [ accept-params ] )
 * media-range = ( "&#42;/&#42;"
 *               / ( type "/" "&#42;" )
 *               / ( type "/" subtype )
 *               ) *( OWS ";" OWS parameter )
 * accept-params = weight *( accept-ext )
 * accept-ext = OWS ";" OWS token [ "=" ( token / quoted-string ) ]
 * weight = OWS ";" OWS "q=" qvalue
 * qvalue = ( "0" [ "." 0*3DIGIT ] ) / ( "1" [ "." 0*3("0") ] )
 *
 * https://tools.ietf.org/html/rfc7240#section-2
 * Errata to RFC 7240 (Errata ID: 4439)
 * Prefer     = "Prefer" ":" 1#preference
 * preference = preference-parameter *( OWS ";" [ OWS preference-parameter ] )
 * preference-parameter = parameter / token
 *
 * https://tools.ietf.org/html/rfc7230#section-3.2.6
 * quoted-string    = DQUOTE *( qdtext / quoted-pair ) DQUOTE
 * quoted-pair      = "\" ( HTAB / SP / VCHAR / obs-text )
 * qdtext           = HTAB / SP /%x21 / %x23-5B / %x5D-7E / obs-text
 * obs-text         = %x80-FF
 * token            = 1*tchar
 * tchar            = "!" / "#" / "$" / "%" / "&" / "'" / "*"
 *                       / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~"
 *                       / DIGIT / ALPHA
 *
 *  https://tools.ietf.org/html/rfc5234#appendix-B.1
 *  ALPHA          =  %x41-5A / %x61-7A   ; A-Z / a-z
 *  DIGIT          =  %x30-39
 *  DQUOTE         =  %x22
 *  VCHAR          =  %x21-7E
 */
class HttpHeaderReader extends commons.http.HttpHeaderReader {
  /**
   * Consumes all parameters and increases the read position.
   * Sets 'true' as value for a parameter if it has no specified value.
   * Ignores (Does not throw an error) parameter dividers (';') with no parameter following.
   * @returns {Map.<string, (string|boolean)>} a map of the read parameters
   * @private
   */
  _readPreferenceParameters () {
    let params = new Map()

    this._readOWS()

    while (this._checkChar(';')) {
      this._readOWS()
      const name = this._readToken()
      if (name.length === 0) {
        // Ignore ';' character if no token follows
        continue
      }

      let value = true
      if (this._checkChar('=')) {
        value = this._readParameterValue()
      }
      if (!params.has(name.toLowerCase())) params.set(name.toLowerCase(), value)
      this._readOWS()
    }

    return params
  }

  /**
   * Read the accept header value.
   * @returns {AcceptTypeInfo[]} information about acceptable content types
   */
  readAccept () {
    let result = []
    while (this._index < this._length) {
      const type = this._checkChar('*') ? '*' : this._readToken()
      if (!type) {
        throw new Error('Expected valid type at index ' + this._index + ' but found ' + this._getCurrentChar())
      }

      this._readChar('/')

      let subtype
      if (type === '*') subtype = this._readChar('*')
      if (!subtype) subtype = this._checkChar('*') ? '*' : this._readToken()
      if (!subtype) {
        throw new Error('Expected valid subtype at index ' + this._index + ' but found ' + this._getCurrentChar())
      }

      let acceptTypeInfo = new AcceptTypeInfo(type + '/' + subtype)

      const parameters = this._readParameters()
      for (const parameter of parameters) {
        if (parameter.name === 'q') {
          if (Q_PATTERN.test(parameter.value)) {
            acceptTypeInfo.setQuality(Number(parameter.value))
          } else {
            throw new Error("Invalid q parameter '" + parameter.value + "'")
          }
          // Treat all parameters after "q" as accept extension parameters according to RFC 7231.
          // Those extension parameters are simply discarded.
          break
        } else {
          acceptTypeInfo.addParameter(parameter.name, parameter.value)
        }
      }

      result.push(acceptTypeInfo)

      this._readOWS()
      if (this._index < this._length) this._readChar(',')
      this._readOWS()
    }

    return result
  }

  /**
   * Reads the Accept-Charset header.
   * @returns {CharsetInfo[]} the acceptable character sets
   */
  readAcceptCharset () {
    let result = []

    // *( "," OWS )
    while (this._index < this._length && this._checkChar(',')) {
      this._readOWS()
    }

    // ( ( charset / "*" ) [ weight ] )
    let charsetInfo = this._readCharsetAndParameter()
    if (charsetInfo === null) {
      const c = this._getCurrentChar()
      throw new Error(`Expected token or "*" at position ${this._index} but found ${c}`)
    } else {
      result.push(charsetInfo)
    }

    // *( OWS "," [ OWS ( ( charset / "*" ) [ weight ] ) ] )
    while (this._index < this._length) {
      this._readOWS()
      this._readChar(',')
      this._readOWS()
      charsetInfo = this._readCharsetAndParameter()
      if (charsetInfo) {
        result.push(charsetInfo)
      }
    }

    return result
  }

  /**
   * Reads charset token and parameters.
   * ( charset / "*" ) [ weight ]
   *
   * @returns {?CharsetInfo} the character-set information
   * @private
   */
  _readCharsetAndParameter () {
    const charset = this._checkChar('*') ? '*' : this._readToken()
    let charsetInfo = null
    if (charset) {
      charsetInfo = new CharsetInfo(charset)

      const parameters = this._readParameters()
      for (const parameter of parameters) {
        if (parameter.name === 'q') {
          if (Q_PATTERN.test(parameter.value)) {
            charsetInfo.setQuality(Number(parameter.value))
          } else {
            throw new Error("Invalid q parameter '" + parameter.value + "'")
          }
          // Only the parameter q is allowed for Accept-Charset
        } else {
          throw new Error(`Parameter ${parameter.name} is not allowed for header field accept-charset`)
        }
      }
    }
    return charsetInfo
  }

  /**
   * Parses the prefer header value.
   * Only 'odata.continue-on-error', 'odata.maxpagesize', 'return'
   * and everything allowed by http://tools.ietf.org/html/draft-snell-http-prefer-18 is supported.
   * "ABNF List Extension: #rule" from RFC7230 is applied to the comma separated prefer header.
   * @returns {Preferences} the parsed preference header
   */
  readPrefer () {
    const preferences = new Preferences()
    this._readOWS()
    let hasReadToken = false // At least one token has to be read

    while (this._index < this._length) {
      const token = this._readToken().toLowerCase()

      if (token.length > 0) hasReadToken = true

      switch (token) {
        case PreferenceNames.ALLOW_ENTITYREFERENCES: {
          preferences.setOdataAllowEntityReferences(true)
          break
        }

        case PreferenceNames.CALLBACK: {
          this._readOWS()
          this._readChar(';')
          this._readOWS()
          this._readChar('u')
          this._readChar('r')
          this._readChar('l')
          this._readChar('=')
          this._readChar('"')
          preferences.setOdataCallback(this._readQuotedString()) // URI in final implementation
          break
        }

        case PreferenceNames.CONTINUE_ON_ERROR: {
          preferences.setOdataContinueOnError(true)
          break
        }

        // currently unsupported odata header.
        case PreferenceNames.INCLUDE_ANNOTATIONS: {
          //     includeAnnotationsPreference = "odata.include-annotations" EQ-h DQUOTE annotationsList DQUOTE
          //     annotationsList      = annotationIdentifier *(COMMA annotationIdentifier)
          //     annotationIdentifier = [ excludeOperator ]
          //                            ( STAR
          //                            / namespace "." ( termName / STAR )
          //                            )
          //                            [ "#" odataIdentifier ]
          //     excludeOperator      = "-"
          this._readChar('=')
          this._readChar('"')
          this._readQuotedString()
          preferences.setOdataIncludeAnnotations(null)
          break
        }

        case PreferenceNames.MAXPAGESIZE: {
          this._readChar('=')

          const maxPagesize = this._readUnsignedInteger()
          if (!maxPagesize) {
            throw new Error('the value of odata.maxpagesize must be an unsigned number')
          }
          if (preferences.getOdataMaxPageSize() === null) {
            preferences.setOdataMaxPageSize(parseInt(maxPagesize, 10))
          }
          break
        }

        case PreferenceNames.RESPOND_ASYNC: {
          preferences.setRespondAsync(true)
          break
        }

        case PreferenceNames.RETURN: {
          this._readChar('=')
          const preferenceToken = this._readToken()
          if (
            preferenceToken === PreferenceReturnValues.REPRESENTATION ||
            preferenceToken === PreferenceReturnValues.MINIMAL
          ) {
            if (!preferences.getReturn()) preferences.setReturn(preferenceToken)
          } else {
            throw new Error(`"${preferenceToken}" is not a valid option for prefer header "return"`)
          }
          break
        }

        case PreferenceNames.TRACK_CHANGES: {
          preferences.setOdataTrackChanges(true)
          break
        }

        case PreferenceNames.WAIT: {
          this._readChar('=')
          const wait = this._readUnsignedInteger()
          if (!wait) {
            throw new Error('the value of wait must be an unsigned number')
          }
          if (preferences.getWait() === null) {
            preferences.setWait(parseInt(wait, 10))
          }
          break
        }

        default: {
          // Custom header parser (BWS is not accepted)
          if (token.length > 0) {
            const preferenceName = token

            let value = true
            if (this._checkChar('=')) {
              value = this._readParameterValue()
            }

            const parameters = this._readPreferenceParameters()
            // If any preference is specified more than once,
            // only the first instance is to be considered. (RFC 7240)
            if (!preferences.getCustomPreferenceValue(preferenceName)) {
              const customPreference = new CustomPreference(preferenceName, value, parameters)
              preferences.setCustomPreference(customPreference)
            }
          }
        }
      }

      // White space (OWS) in between preferences is allowed: https://issues.oasis-open.org/browse/ODATA-1152
      this._readOWS()
      if (this._index < this._length) {
        this._readChar(',')
        this._readOWS()
      }
    }

    if (!hasReadToken) throw new Error('Invalid Prefer header, expected at least one token')

    return preferences
  }

  /**
   * Reads the value of a parameter.
   * @returns {string|boolean} the value as a string or true if an empty string value was given
   * @throws {Error} if the read value is not a quoted string and has the length of 0
   * @private
   */
  _readParameterValue () {
    let value
    if (this._checkChar('"')) {
      value = this._readQuotedString()
      if (value.length === 0) value = true
    } else {
      value = this._readToken()
      if (value.length === 0) {
        throw new Error('Expected identifier after character "="')
      }
    }
    return value
  }

  /**
   * Reads the field name.
   * @returns {string} Field name
   * @private
   */
  _readFieldName () {
    const fieldName = this._readToken()
    if (fieldName.length === 0) {
      throw new Error('Expected valid field-name ' + this._index + ' but found ' + this._getCurrentChar())
    }
    return fieldName
  }

  /**
   * Reads a field value.
   * @param {string} fieldName field name
   * @returns {HeaderInfo} Field value
   * @private
   */
  _readFieldValue (fieldName) {
    let fieldValue = ''
    let code = this._source[this._index]
    while (
      (code >= 0x21 && code <= 0x7e) || // VCHAR
      (code >= 0x80 && code <= 0xff) || // obs-text
      code === 0x09 || // HTAB
      code === 0x20
    ) {
      fieldValue += this._source.toString('latin1', this._index, this._index + 1)
      this._index++
      code = this._source[this._index]
    }

    // Check if all chars are consumed.
    if (this._index !== this._length) {
      throw new Error('Illegal character ' + this._getCurrentChar() + ' after field-value at index ' + this._index)
    }

    return new HeaderInfo(fieldName, fieldValue, this._origSource)
  }

  /**
   * Reads an unsigned integer value (maximum of 15 characters) and increases the read position.
   * Returns an empty string if the number is negative or does not start with a digit (0-9).
   * @returns {string} the parsed value as string
   * @private
   */
  _readUnsignedInteger () {
    const maxIntegerLength = 15
    let code = this._source[this._index]
    let startIndex = this._index
    while (code >= 0x30 && code <= 0x39) {
      // digit 0-9
      if (this._index - startIndex + 1 > maxIntegerLength) break
      code = this._source[++this._index]
    }
    return this._source.toString('latin1', startIndex, this._index + 1)
  }

  /**
   * Reads a full header line.
   * @returns {HeaderInfo|ContentTypeInfo} the parsed header line
   */
  readHeaderLine () {
    const fieldName = this._readFieldName()

    this._readChar(':')
    this._readOWS()

    return fieldName.toLowerCase() === 'content-type' ? this.readContentType() : this._readFieldValue(fieldName)
  }
}

module.exports = HttpHeaderReader
