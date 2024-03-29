'use strict'

const crypto = require('crypto')

const cds = require('../../../../../../cds')
const DEBUG = cds.debug('odata', '[odata] -')

const CACHE_LIMIT_KB = (cds.env.odata && cds.env.odata.metadataCacheLimit) || 10240 // 10 Megabyte cache limit per mimeType

/**
 * Cache for metadata documents.
 * Metadata documents are stored in a map where the keys are the different locales as strings
 * and the values are objects that look like that:
 *     { time: timestamp, size: sizeInKB, metadata: 'metadata as string' }
 */
class MetadataCache {
  constructor () {
    this._cachedMetadata = new Map()
  }

  /**
   * Retrieves a cached metadata document for a specific mimeType and locale
   * @param {string} mimeType The mimeType the metadata should be retrieved for
   * @param {string} locale The locale the metadata should be retrieved for
   * @returns {?Object} The cached metadata or null, if none was found in the cache
   */
  get (mimeType, locale) {
    const metadataInformation = this._getMimeTypeCache(mimeType).get(locale)
    if (metadataInformation) metadataInformation.time = Date.now()
    return metadataInformation || null
  }

  /**
   * Sets a metadata-document for the given mimeType and locale in the cache
   * @param {string} mimeType The mimeType of the metadata-document
   * @param {string} locale The locale of the metadata-document
   * @param {string} metadata The metadata-document to be cached
   */
  set (mimeType, locale, metadata) {
    const size = this._getStringSizeKilobyte(metadata)
    const etag = this._getEtag(metadata)
    const metadataInformation = { time: Date.now(), size, etag, metadata }
    const mimeTypeCache = this._getMimeTypeCache(mimeType)
    // Set the newest entry
    mimeTypeCache.set(locale, metadataInformation)

    // Remove items as long as the boundary is exceeded.
    while (this._exceedsBoundary(mimeTypeCache)) this._clear(mimeType, this._invalidateItem(mimeTypeCache))

    return etag
  }

  /**
   * Clears a single cache entry for a given mimeType and locale.
   * @param {string} mimeType The mimeType of the entry that shall be deleted
   * @param {string} locale The locale of the entry that shall be deleted
   */
  _clear (mimeType, locale) {
    this._getMimeTypeCache(mimeType).delete(locale)
  }

  /**
   * (Creates) and returns the Map that holds locale specific for the requested mimeType
   * @param {string} mimeType The mimeType the Map should be retrieved for
   * @returns {Map.<string, Object>} Map that holds locale-specific metadata documents
   * @private
   */
  _getMimeTypeCache (mimeType) {
    let cacheByMimeType = this._cachedMetadata.get(mimeType)
    if (!cacheByMimeType) {
      cacheByMimeType = new Map()
      this._cachedMetadata.set(mimeType, cacheByMimeType)
    }
    return cacheByMimeType
  }

  /**
   * Calculates the kibibyte size of the metadata string.
   * @param {string} string the metadata string
   * @returns {number} the size in kibibyte
   * @private
   */
  _getStringSizeKilobyte (string) {
    return Buffer.byteLength(string, 'utf8') / 1024
  }

  /**
   * @param {Map.<string, Object>} cacheEntries the entries of the cache as map
   * @returns {boolean} true if cache exceeds boundaries
   */
  _exceedsBoundary (cacheEntries) {
    const totalCacheSize = Array.from(cacheEntries.values()).reduce((size, cacheEntry) => size + cacheEntry.size, 0)
    const result = totalCacheSize > CACHE_LIMIT_KB
    if (result) {
      DEBUG &&
        DEBUG(
          'Metadata size exceeds cache boundary. Use cds option odata.metadataCacheLimit to increase the cache size.'
        )
    }

    return result
  }

  /**
   * Invalidate a cache item.
   * @param {Map} cacheEntries the entries of the cache as map
   * @returns {string} the key of the item that should be cleared
   * @private
   */
  _invalidateItem (cacheEntries) {
    let oldestTime = Date.now()
    let oldestKey
    for (const [key, value] of Array.from(cacheEntries)) {
      if (value.time < oldestTime) {
        oldestKey = key
        oldestTime = value.time
      }
    }
    return oldestKey
  }

  /**
   * Calculates the ETag of the metadata string.
   * @param {string} metadata the metadata
   * @returns {string} the ETag
   * @private
   */
  _getEtag (metadata) {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(metadata))
      .digest('base64')
  }
}

module.exports = MetadataCache
