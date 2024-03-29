'use strict'

//  [Multipurpose Internet Mail Extensions Chapter 5.1 (rfc2046)](https://www.ietf.org/rfc/rfc2046.txt)
//  boundary := 0*69<bchars> bcharsnospace
//
//  bchars := bcharsnospace / " "
//
//  bcharsnospace := DIGIT / ALPHA / "'" / "(" / ")" /
//      "+" / "_" / "," / "-" / "." /
//      "/" / ":" / "=" / "?"
//
//  Overall, the body of a "multipart" entity may be specified as
//  follows:
//
//  dash-boundary := "--" boundary
//      ; boundary taken from the value of
//      ; boundary parameter of the
//      ; Content-Type field.
//
//  multipart-body := [preamble CRLF]
//      dash-boundary transport-padding CRLF
//      body-part *encapsulation
//      close-delimiter transport-padding
//      [CRLF epilogue]
//
//  transport-padding := *LWSP-char
//      ; Composers MUST NOT generate
//      ; non-zero length transport
//      ; padding, but receivers MUST
//      ; be able to handle padding
//      ; added by message transports.
//
//  encapsulation := delimiter transport-padding
//      CRLF body-part
//
//  delimiter := CRLF dash-boundary
//
//  close-delimiter := delimiter "--"
//
//  preamble := discard-text
//
//  epilogue := discard-text
//
//  discard-text := *(*text CRLF) *text
//      ; May be ignored or discarded.
//
//  body-part := MIME-part-headers [CRLF *OCTET]
//      ; Lines in a body-part must not start
//      ; with the specified dash-boundary and
//      ; the delimiter must not appear anywhere
//      ; in the body part.  Note that the
//      ; semantics of a body-part differ from
//      ; the semantics of a message, as
//      ; described in the text.
//
//  OCTET := <any 0-255 octet value>
//

const HttpHeaderReader = require('../../odata-commons').http.HttpHeaderReader
const Reader = require('./Reader')
const DataReader = require('./DataReader')
const PartReader = require('./PartReader')
const DeserializationError = require('../errors/DeserializationError')

const CRLF = '\r\n'
const DELIM = 45

/**
 * States
 * @enum {number}
 * @readonly
 */
const STATES = {
  MORE_DATA: 0,
  READ_NEXT_PREAMBLE: 1,
  READ_NEXT_BOUNDARY: 2,
  READ_NEXT_PART: 3,
  READ_NEXT_PART_RETURN: 4,
  READ_NEXT_CRLF_BOUNDARY: 5,
  READ_NEXT_LAST_BOUNDARY: 6,
  READ_NEXT_EPILOGUE: 7,
  READ_NEXT_EPILOGUE_RETURN: 8,
  FINISHED: 9
}

/**
 * Events
 * @enum {string}
 * @readonly
 */
const EVENTS = {
  START: 'multipart.start',
  PREAMBLE_START: 'multipart.preamble.start',
  PREAMBLE: 'multipart.preamble.data',
  PREAMBLE_END: 'multipart.preamble.end',

  EPILOGUE_START: 'multipart.epilogue.start',
  // EPILOGUE: 'multipart.epilog',
  // EPILOGUE_END: 'multipart.epilogEnd',
  END: 'multipart.end'
}

/**
 * Reads a Multipart request from the Cache.
 * @extends Reader
 */
class MultipartParser extends Reader {
  /**
   * Factory for automatic creation depending on content-type
   * @param {ContentTypeInfo} contentTypeInfo content-type info
   * @param {Object} headers - Header information (currently only the content-type header is evaluated)
   * @returns {MultipartParser} a new instance of MultipartParser
   */
  static createInstance (contentTypeInfo, headers) {
    return new MultipartParser(headers)
  }

  /**
   * @param {Object} [headers] Header information, keys are header-names, values are header value string or objects of type
   *  {ContentTypeInfo}. Used to determine the multipart boundary.
   */
  constructor (headers) {
    super()

    if (headers) {
      const contentType = headers['content-type']

      if (!contentType) {
        throw new DeserializationError('missing content type')
      }

      if (typeof contentType === 'string') {
        const contentTypeInfo = new HttpHeaderReader(Buffer.from(contentType)).readContentType()
        this._stringBoundary = contentTypeInfo.getParameter('boundary')
      } else {
        this._stringBoundary = contentType.getParameter('boundary')
      }
    }

    if (this._stringBoundary === null || this._stringBoundary === undefined) {
      // '' is a valid boundary
      throw new DeserializationError('No boundary found while processing header/request')
    }

    this._boundary = Buffer.from('--' + this._stringBoundary, 'utf8')
    this._crlfBoundary = Buffer.from(CRLF + '--' + this._stringBoundary, 'utf8')

    this._state = STATES.READ_NEXT_PREAMBLE

    this._partReader = null

    this._emittedPreambleStart = false
    this._emittedEpilogueStart = false
    this._emittedStart = false

    this._stopPattern = null
  }

  /**
   * Sets the stop pattern(boundary), which is used if this multipart is a nested multipart (e.g. an OData change set).
   * The epilogue of this multipart is then read up to this pattern.
   * @param {string} stopPattern the stop pattern
   */
  setStopPattern (stopPattern) {
    this._stopPattern = stopPattern
  }

  /**
   * Read cache, if the cache contains processable data, then the data is processed (e.g. boundaries), if the cache
   * contains incomplete data (e.g. the first half of a boundary) then more data is requested. The attribute _state
   * ensures a correct re-entry
   *
   * @param {ContentDeserializer} reader - Reader instance containing the cache
   * @param {Cache} cache - Cache to read bytes from
   * @param {boolean} last - Last call, no more data available
   * @returns {boolean}
   *      this: this reader needs more data and caller should call this method again with more data in cache
   *      false: this reader is finished caller should pop this reader from stack
   *      null:  new sub reader is on stack, call this method again after the sub reader is finished
   */
  readCache (reader, cache, last) {
    let needMoreData = false

    if (!this._emittedStart) {
      this.emit(EVENTS.START, this._stringBoundary)
      this._emittedStart = true
    }

    while (needMoreData === false && this._state !== STATES.FINISHED) {
      switch (this._state) {
        case STATES.READ_NEXT_PREAMBLE:
          needMoreData = this.readPreamble(reader, cache, last)
          break

        case STATES.READ_NEXT_BOUNDARY:
          needMoreData = this.readReadFirstBoundary(reader, cache, last)
          break

        case STATES.READ_NEXT_CRLF_BOUNDARY:
          needMoreData = this.readCrlfBoundary(reader, cache, last)
          break

        case STATES.READ_NEXT_PART:
          this._partReader = new PartReader(this._crlfBoundary).setEmitter(this._emitter)
          reader.pushReader(this._partReader)

          this._state = STATES.READ_NEXT_PART_RETURN
          needMoreData = null
          break

        case STATES.READ_NEXT_PART_RETURN:
          this._state = STATES.READ_NEXT_CRLF_BOUNDARY
          break

        case STATES.READ_NEXT_EPILOGUE:
          needMoreData = this.readReadNextEpilogue(reader, cache)
          break

        case STATES.READ_NEXT_EPILOGUE_RETURN:
          this._state = STATES.FINISHED
          needMoreData = false
          break

        default:
          throw new DeserializationError('Internal parser error')
      }
    }

    if (this._state === STATES.FINISHED) {
      this.emit(EVENTS.END)
      return false
    }

    return needMoreData
  }

  readReadNextEpilogue (reader, cache) {
    // Special handling for nested multipart requests
    // After a '--boundary--' a epilogue may be there. ABNF : ... [CRLF epilogue]
    // But for nested parts we have also a stop pattern, e.g. --boundary_outer'.
    // The there may '--boundary--'[CRLF]'--boundary_outer'[*.] and boundary_outer MUST
    // no detected as epilogue. So we check here if the stop pattern is there and if yes
    // the nested multipart is finished.

    if (this._stopPattern) {
      if (cache.length - cache.getReadPos() < this._stopPattern.length) {
        return true
      }
      if (cache.indexOf(this._stopPattern, cache.getSearchPosition()) === cache.getSearchPosition()) {
        this._state = STATES.FINISHED
        return null
      }
    }

    cache.advance(CRLF.length) // because it is not read by the closing boundary

    if (!this._emittedEpilogueStart) {
      this.emit(EVENTS.EPILOGUE_START)
      this._emittedEpilogueStart = true
    }

    // Epilogue can read like data till the outer stop pattern occures or there is no input
    this.dataReader = new DataReader(this._emitter).setEmitter(this._emitter, 'multipart.epilogue')

    if (this._stopPattern) {
      this.dataReader.setStopPattern(this._stopPattern)
    }

    reader.pushReader(this.dataReader)
    this._state = STATES.READ_NEXT_EPILOGUE_RETURN
    return null
  }

  /**
   * Read a first boundary from the cache.
   * Update getReadPos, searchPos, consumedBytes accordingly
   *
   * @param {Reader} reader - The reader
   * @param {Cache} cache - The readers cache
   * @returns {boolean} - returns true if more data is required, otherwise false
   * @throws {Error} - Throws and error if boundary is not found
   */
  readReadFirstBoundary (reader, cache) {
    // required data available
    if (cache.getLength() - cache.getReadPos() < this._boundary.length + 2) {
      return true
    }

    // boundary MUST be at searchPos
    const check = cache.indexOf(this._boundary, cache.getSearchPosition())
    if (check !== cache.getSearchPosition()) {
      throw new DeserializationError(`Boundary expected at position ${cache.getReadPos()}`)
    }
    cache.advanceSearchPosition(this._boundary.length)

    // boundary MAY contain trialing spaces before CRLF
    const pos = cache.indexOf(CRLF, cache.getSearchPosition())

    if (pos === -1) {
      // no CRLF found
      return true
    }
    this._state = STATES.READ_NEXT_PART

    // consume boundary
    cache.advance(pos - cache.getReadPos() + CRLF.length)

    return false
  }

  /**
   * Read a non first boundary from the cache and consume boundary.
   * @param {Reader} reader - The reader
   * @param {Cache} cache - The readers cache
   * @param {boolean} last - Last call, no more data available
   * @returns {boolean} - returns true if more data is required, otherwise false
   */
  readCrlfBoundary (reader, cache, last) {
    // required data available
    if (cache.getLength() - cache.getReadPos() < this._crlfBoundary.length + 2) {
      return true
    }

    // boundary MUST be at searchPos
    const check = cache.indexOf(this._crlfBoundary, cache.getSearchPosition())
    if (check !== cache.getSearchPosition()) {
      throw new DeserializationError(`Boundary expected at position ${cache.getReadPos()}`)
    }

    // boundary MAY contain trialing spaces before CRLF
    const pos = cache.indexOf(CRLF, cache.getSearchPosition() + this._crlfBoundary.length)

    if (pos === -1) {
      // no CRLF found
      if (last) {
        // last boundary's CRLF is optional, but trailing -- is a MUST
        if (
          cache.getByte(this._crlfBoundary.length) === DELIM &&
          cache.getByte(this._crlfBoundary.length + 1) === DELIM
        ) {
          cache.advance(this._crlfBoundary.length + 2)
          this._state = STATES.FINISHED
          return false
        }

        throw new DeserializationError(
          `Last boundary of multipart must end with '--' at position ${cache.getReadPos()}`
        )
      } else {
        // request more data
        return true
      }
    }

    // CRLF found
    if (cache.getByte(this._crlfBoundary.length) === DELIM && cache.getByte(this._crlfBoundary.length + 1) === DELIM) {
      // is last boundary
      this._state = STATES.READ_NEXT_EPILOGUE
      cache.advance(pos - cache.getReadPos()) // keep the CLRF it is parsed in the READ_NEXT_EPILOGUE step
    } else {
      this._state = STATES.READ_NEXT_PART
      cache.advance(pos + CRLF.length - cache.getReadPos())
    }

    // consume boundary
    return false
  }

  /**
   * Read preamble.
   * @param {Reader} reader - The reader
   * @param {Cache} cache - The readers cache
   * @returns {boolean} - returns true if more data is required, otherwise false
   */
  readPreamble (reader, cache) {
    // required data available
    if (cache.getLength() - cache.getReadPos() < this._boundary.length) {
      // min a boundary is required
      return true // need more data
    }

    // the preamble is optional, check if cache starts with boundary
    if (this._boundary.compare(cache._cache, cache.getReadPos(), cache.getReadPos() + this._boundary.length) === 0) {
      // cache starts with boundary, no preamble defined
      this._state = STATES.READ_NEXT_BOUNDARY // as next step consume the boundary
      return false
    }

    // preamble found

    if (!this._emittedPreambleStart) {
      this.emit(EVENTS.PREAMBLE_START)
      this._emittedPreambleStart = true
    }

    // search for next boundary (now with leading space)
    const pos = cache.indexOf(this._crlfBoundary, cache.getSearchPosition())
    if (pos === -1) {
      // boundary not found in cache, emit the first bytes from the cache where it is
      // guaranteed that there is no part fo the boundary  inside
      const readUpTo =
        cache.getLength() - this._crlfBoundary.length < cache.getReadPos()
          ? cache.getReadPos()
          : cache.getLength() - this._crlfBoundary.length
      this.emitAndConsume(cache, readUpTo - cache.getReadPos(), EVENTS.PREAMBLE)
      return true
    }

    this.emitAndConsume(cache, pos - cache.getReadPos(), EVENTS.PREAMBLE)

    this.emit(EVENTS.PREAMBLE_END)
    this._state = STATES.READ_NEXT_CRLF_BOUNDARY
    return false
  }
}

MultipartParser.EVENTS = EVENTS

module.exports = MultipartParser
