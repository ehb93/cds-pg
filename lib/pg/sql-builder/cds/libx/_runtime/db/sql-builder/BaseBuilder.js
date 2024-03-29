const cds = require('../../cds')

const quotingStyles = require('../../common/utils/quotingStyles')
const { getArtifactCdsPersistenceName } = require('@sap/cds-compiler')

/**
 * BaseBuilder class should not be instantiated.
 */
class BaseBuilder {
  /**
   * The base class constructor for the builders.
   * If the options parameter is not specified, " are used as delimiter and ? as placeholders.
   *
   * @param {object} obj - The CQN object used for the insert operation
   * @param {object} [options] - The configuration object.
   * @param {string} [options.delimiter] - The delimiter string.
   * @param {string} [options.placeholder] - The placeholder for prepared statement.
   * @param {object} csn - The csn object
   */
  constructor(obj, options, csn) {
    this._obj = obj
    this._csn = csn
    this._options = { ...this.getDefaultOptions(), ...options }

    const { user } = this._options
    Object.defineProperty(this._options, 'user', {
      get: () => {
        if (!user) return 'anonymous'
        if (typeof user === 'string') return user
        return user.sql ? user : user.id
      }
    })

    // REVISIT: This should be private and uses outside (i.e. in SelectBuilder) not necessary
    this._quotingStyle = cds.env.sql.names || 'plain'
    this._quoteElement = quotingStyles[this._quotingStyle]
    this._validateQuotingStyle()

    // NOTE: unofficial feature flag!
    this._parameterizedNumbers =
      'parameterized_numbers' in this._options
        ? this._options.parameterized_numbers
        : cds.env && cds.env.features && cds.env.features.parameterized_numbers
  }

  getDefaultOptions() {
    return {
      placeholder: '?',
      delimiter: '"',
      user: { id: 'ANONYMOUS' },
      now: { sql: 'NOW ()' }
    }
  }

  // TODO: add caching
  _getDatabaseName(entity) {
    return this._quotingStyle === 'plain'
      ? entity
      : getArtifactCdsPersistenceName(entity, this._quotingStyle, this._csn)
  }

  _validateQuotingStyle() {
    let type = typeof this._quotingStyle
    if (type !== 'string' || !Object.prototype.hasOwnProperty.call(quotingStyles, this._quotingStyle)) {
      type = type !== 'string' ? `Type ${type}` : `"${this._quotingStyle}"`
      throw new Error(`Quoting style: ${type} is not supported. Allowed strings: "quoted", "plain".`)
    }
  }
}

module.exports = BaseBuilder
