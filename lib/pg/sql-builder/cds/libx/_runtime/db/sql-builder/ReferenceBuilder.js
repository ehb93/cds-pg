const { typeConversionMap } = require('./dataTypes')
const BaseBuilder = require('./BaseBuilder')

/**
 * ReferenceBuilder is used to take a part of a CQN object as an input and to build an object representing a reference
 * with SQL string and values.
 *
 * Currently it supports the references like below:
 *
 * @example <caption>Simple ref part of CQN </caption>
 * {ref: ['x']}
 * {ref: ['func_name', { args: [func_args] }]}
 */
class ReferenceBuilder extends BaseBuilder {
  get FunctionBuilder() {
    const FunctionBuilder = require('./FunctionBuilder')
    Object.defineProperty(this, 'FunctionBuilder', { value: FunctionBuilder })
    return FunctionBuilder
  }

  /**
   * Builds an Object based on the properties of the input object in the constructor.
   *
   * @example <caption>Example output</caption>
   * {
   *    sql: '"X"',
   *    values: []
   * }
   * {
   *    sql: '"func_name(?,?)"',
   *    values: [1, 'a']
   * }
   *
   * @returns {{sql: string, values: Array}} Object with two properties.
   * SQL string for prepared statement and an empty array of values.
   */
  build() {
    this._outputObj = {
      sql: [],
      values: []
    }

    if (this._isFunction()) {
      const { sql, values } = new this.FunctionBuilder(this._obj, this._options, this._csn).build()
      this._outputObj.sql.push(sql)
      this._outputObj.values.push(...values)
    } else if (this._obj.ref) {
      // reference

      if (this._obj._cast4func) {
        this._outputObj.sql.push('CAST', '(')
      }

      // REVISIT: compat for legacy ref: "['foo as bar']" -> remove with cds^6
      if (this._obj.ref.length === 1 && typeof this._obj.ref[0] === 'string') {
        const matched = this._obj.ref[0].match(/(\S*)\s{1,}as\s{1,}(\S*)/i)
        if (matched) {
          this._obj.ref = [matched[1]]
          this._obj.as = matched[2].replace(/^"/, '').replace(/"$/, '')
        }
      }

      if (this._obj.param) {
        this._parseParamReference(this._obj.ref)
      } else {
        this._parseReference(this._obj.ref)
      }

      if (this._obj._cast4func) {
        this._outputObj.sql.push('AS', typeConversionMap.get(this._obj._cast4func.type), ')')
      }
    } else {
      this._outputObj.sql.push(this._obj)
    }

    this._sortOrder()
    this._outputObj.sql = this._outputObj.sql.join(' ')
    return this._outputObj
  }

  _sortOrder() {
    if (!Object.prototype.hasOwnProperty.call(this._obj, 'sort')) {
      return
    }

    if (this._options.collate) {
      this._outputObj.sql.push(this._options.collate)
    }

    this._outputObj.sql.push(this._obj.sort === 'desc' ? 'DESC' : 'ASC')
  }

  _isFunction() {
    return (this._obj.ref && this._obj.ref.length > 1 && this._obj.ref[1].args) || (this._obj.func && this._obj.args)
  }

  _parseReference(ref) {
    if (ref[0].id) {
      throw new Error(`${ref[0].id}: Views with parameters supported only on HANA`)
    }

    if (this._handleStructuredIfExists(ref)) {
      return
    }

    this._outputObj.sql.push(ref.map(el => this._quoteElement(el)).join('.'))
  }

  _handleStructured(ref, element) {
    // REVISIT we assume that structured elements are already unfolded here
    if (ref[0] === element.name) {
      this._outputObj.sql.push(ref.join('_'))
      return
    }
    // we have an alias before
    this._outputObj.sql.push(this._quoteElement(ref[0]) + '.' + ref.slice(1, ref.length).join('_'))
  }

  _isToOneManaged(element) {
    return element.is2one && !element.on
  }

  _handleStructuredIfExists(ref) {
    const entity = this._csn && this._csn.definitions[this._options.entityName]
    const element = entity && (entity.elements[ref[0]] || entity.elements[ref[1]])
    if (element) {
      if (element._isStructured || this._isToOneManaged(element)) {
        this._handleStructured(ref, element)
        return true
      }
    }
  }

  _parseParamReference(refArray) {
    if (refArray[0] === '?') {
      this._outputObj.sql.push(this._options.placeholder)
    } else {
      this._outputObj.sql.push(this._options.placeholder)
      this._outputObj.values.push(refArray[0])
    }
  }
}

module.exports = ReferenceBuilder
