const cds = require('../../cds')

const BaseBuilder = require('./BaseBuilder')
const { flattenStructuredWhereHaving } = require('../../common/utils/structured')

const SQLITE_DATETIME_FUNCTIONS = new Set(['year', 'month', 'day', 'second', 'hour', 'minute'])
const OPERATORS = new Set(['=', '!=', '<>', '<', '>', '<=', '>='])

function _fillAfterDot(val) {
  const [beforeDot, afterDot = ''] = val.split('.')
  return `${beforeDot}.${afterDot.padEnd(3, '0')}`
}

/**
 * ExpressionBuilder is used to take a part of a CQN object as an input and to build an object representing an expression
 * with SQL string and values to be used with a prepared statement.
 * The outer property 'xpr' can be omitted.
 *
 * @example <caption>Example of xpr part of CQN </caption>
 * {
 *  xpr: [{ref: ['x']}, '<', {val: 9}]
 * }
 *
 * Each operand of the xpr can be a nested xpr.
 */
class ExpressionBuilder extends BaseBuilder {
  /**
   * The constructor of the ExpressionBuilder.
   * If the options parameter is not specified, " are used as delimiter and ? as placeholders.
   *
   * @param {object} obj - Part of the CQN object that represents an expression
   * @param {object} [options] - The configuration object.
   * @param {string} [options.delimiter] - The delimiter string.
   * @param {string} [options.placeholder] - The placeholder for prepared statement.
   * @param {string} [options.objectKey] - The object key for the expression. It can be either "xpr" or empty string.
   * @param {object} csn - The csn object
   * Default is an empty string.
   */
  constructor(obj, options, csn) {
    super(obj, options, csn)
    this._options = Object.assign({ objectKey: '' }, this._options)
  }

  get SelectBuilder() {
    const SelectBuilder = require('./SelectBuilder')
    Object.defineProperty(this, 'SelectBuilder', { value: SelectBuilder })
    return SelectBuilder
  }

  get ReferenceBuilder() {
    const ReferenceBuilder = require('./ReferenceBuilder')
    Object.defineProperty(this, 'ReferenceBuilder', { value: ReferenceBuilder })
    return ReferenceBuilder
  }

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
   *    sql: '"X" < ?',
   *    values: [1]
   * }
   *
   * @throws Error if the input object is invalid
   * @returns {{sql: string, values: Array}} Object with two properties.
   * SQL string for prepared statement and array of values to replace the placeholders.
   */
  build() {
    this._outputObj = {
      sql: [],
      values: []
    }

    this._expressionObjectsToSQL(
      this._options.objectKey && this._obj[this._options.objectKey] ? this._obj[this._options.objectKey] : this._obj
    )

    this._outputObj.sql = this._outputObj.sql.join(' ')
    return this._outputObj
  }

  _isStructured(op1, comp, op2) {
    if (op1.ref && comp === '=' && op2.val && typeof op2.val === 'object') {
      return true
    }
    // also check reverse
    if (op1.val && typeof op1.val === 'object' && comp === '=' && op2.ref) {
      return true
    }

    return false
  }

  _expressionObjectsToSQL(objects) {
    const length = objects.length
    let i = 0

    while (i < length) {
      // Some keywords need to be process as a block, while others can be treated one at a time
      const reserved = this._reseverdKeyWords(objects, i)
      if (reserved) {
        i = i + reserved
      } else {
        if (this._isStructured(objects[i], objects[i + 1], objects[i + 2])) {
          // this is a special case where we detect structured and convert it to flat expression
          const entity = this._csn && this._csn.definitions[this._options.entityName]
          const flattenedStructExpression = flattenStructuredWhereHaving(
            [objects[i], '=', objects[i + 2]],
            entity,
            this._csn
          )
          this._expressionObjectsToSQL(flattenedStructExpression)
          i += 3
          continue
        }
        this._expressionElementToSQL(objects[i])
        i++
      }
    }
  }

  /**
   * Some values and operators need to be treated in a non standard way.
   * Those are:
   * (NOT) NULL
   * (NOT) IN
   *
   * @param {Array} objects
   * @param {number} i
   * @returns {number}
   * @private
   */
  // eslint-disable-next-line complexity
  _reseverdKeyWords(objects, i) {
    if (objects[i] === 'not' && objects[i + 1].func) {
      objects[i + 1].func = `not ${objects[i + 1].func}`
      return 1
    }
    if (objects[i].func || (objects[i + 2] && objects[i + 2].func)) {
      // sqlite requires leading 0 for numbers in datetime functions
      const f = objects[i].func ? i : OPERATORS.has(objects[i + 1]) ? i + 2 : i - 2
      const v = objects[i].val ? i : OPERATORS.has(objects[i + 1]) ? i + 2 : i - 2
      if (objects[f] && SQLITE_DATETIME_FUNCTIONS.has(objects[f].func) && cds.db && cds.db.kind === 'sqlite') {
        if (objects[v] && objects[v].val !== undefined && typeof objects[v].val === 'number') {
          objects[v] = { val: `${objects[v].val < 10 ? 0 : ''}${objects[v].val}` }
          if (objects[f].func === 'second') objects[v].val = _fillAfterDot(objects[v].val)
        }
      }
      // odata indexof function returns the zero-based character position of the first occurrence
      if (this._options._4odata && objects[i].func && objects[i].func === 'indexof') {
        if (objects[i + 2] && objects[i + 2].val !== undefined) objects[i + 2].val++
        else if (objects[i - 2] && objects[i - 2].val !== undefined) this._outputObj.sql[i - 2]++
      }
      return 0
    }

    if ((objects[i + 1] === '=' || objects[i + 1] === '!=') && objects[i + 2] && objects[i + 2].val === null) {
      this._addNullOrNotNull(objects[i], objects[i + 1])
      return 3
    }

    if (objects[i].val === null && (objects[i + 1] === '=' || objects[i + 1] === '!=') && objects[i + 2]) {
      this._addNullOrNotNull(objects[i + 2], objects[i + 1])
      return 3
    }

    if (/^(not )?in+/i.test(objects[i + 1])) {
      if (objects[i + 2] !== '(') {
        this._addInOrNotIn(objects[i], objects[i + 1].toUpperCase(), objects[i + 2])
        return 3
      }

      // map other notation to current notation
      const arr = []
      let skip = 3
      for (let j = i + 3; j < objects.length; j++) {
        skip++
        if (objects[j] === ')') {
          break
        } else if (objects[j].val) {
          arr.push(objects[j].val)
        }
      }
      this._addInOrNotIn(objects[i], objects[i + 1].toUpperCase(), { val: arr })
      return skip
    }

    return 0
  }

  /**
   * In case the value is null, SQL with reserved keywords and without a placeholder is required.
   *
   * @param reference
   * @param operator
   * @returns {boolean}
   * @private
   */
  _addNullOrNotNull(reference, operator) {
    if (reference.ref) {
      this._addToOutputObj(new this.ReferenceBuilder(reference, this._options, this._csn).build(), false)
    } else {
      this._outputObj.sql.push(this._options.placeholder)
      // convert to String, otherwise hdb driver complains because of type conversion issues
      this._outputObj.values.push(reference.val === null ? reference.val : reference.val + '')
    }

    this._outputObj.sql.push('IS', `${operator !== '=' ? 'NOT ' : ''}NULL`)

    return true
  }

  /**
   * (NOT) IN can have an Array or sub select instance as value.
   *
   * @param reference
   * @param operator
   * @param values
   * @returns {boolean}
   * @private
   */
  _addInOrNotIn(reference, operator, values) {
    if (values.val === null) {
      this._addToOutputObj(new this.ReferenceBuilder(reference, this._options, this._csn).build(), false)
      this._outputObj.sql.push('is null')
      return true
    }

    if (Array.isArray(values.val)) {
      this._addArrayForInQuery(reference, operator, values.val)
      return true
    }

    if (Array.isArray(values.list)) {
      this._addToOutputObj(new this.ReferenceBuilder(reference, this._options, this._csn).build(), false)
      this._outputObj.sql.push(operator)
      this._addListToOutputObj(values.list)
      return true
    }

    this._addSubQueryForInQuery(reference, operator, values)
    return true
  }

  _addArrayForInQuery(reference, operator, values) {
    this._addToOutputObj(new this.ReferenceBuilder(reference, this._options, this._csn).build(), false)

    const placeholders = []

    for (let i = 0, length = values.length; i < length; i++) {
      placeholders.push(this._options.placeholder)
    }

    this._outputObj.sql.push(operator, '(', `${placeholders.join(', ')}`, ')')

    this._outputObj.values = this._outputObj.values.concat(values)
  }

  _addSubQueryForInQuery(reference, operator, subQuery) {
    if (this._options.objectKey) {
      delete this._options.objectKey
    }

    if (reference.list) {
      this._addListToOutputObj(reference.list)
    } else {
      this._addToOutputObj(new this.ReferenceBuilder(reference, this._options, this._csn).build(), false)
    }

    this._outputObj.sql.push(operator)

    const entityName = subQuery.SELECT.from.ref && subQuery.SELECT.from.ref[0]
    this._addToOutputObj(
      new this.SelectBuilder(subQuery, { ...this._options, entityName }, this._csn).build(true),
      true
    )
  }

  _addListToOutputObj(list) {
    this._outputObj.sql.push('(')

    for (let i = 0, len = list.length; i < len; i++) {
      this._expressionElementToSQL(list[i])

      if (len > 1 && i + 1 < len) {
        this._outputObj.sql.push(',')
      }
    }

    this._outputObj.sql.push(')')
  }

  /**
   * Handles one expression element at a time.
   *
   * @param {string | object} element expression element
   * @private
   */
  _expressionElementToSQL(element) {
    if (typeof element === 'string') {
      this._outputObj.sql.push(element.toUpperCase())
      return
    }

    if (element instanceof String) {
      this._outputObj.sql.push(element.toString().toUpperCase())
      return
    }

    for (const key in element) {
      switch (key) {
        case 'xpr':
          return this._xprOutputFromElement(element)
        case 'ref':
          return this._refOutputFromElement(element)
        case 'val':
          return this._valOutputFromElement(element)
        case 'SELECT':
          return this._addToOutputObj(
            new this.SelectBuilder(
              element,
              { ...this._options, entityName: element.SELECT.from.ref && element.SELECT.from.ref[0] },
              this._csn
            ).build(true),
            true
          )
        case 'func':
          return this._addToOutputObj(new this.FunctionBuilder(element, this._options, this._csn).build(), false)
        case 'list':
          return this._addListToOutputObj(element.list)
      }
    }

    throw new Error(`Cannot build SQL. Invalid CQN object provided: ${JSON.stringify(element)}`)
  }

  _xprOutputFromElement(element) {
    this._options.objectKey = 'xpr'
    // new instance of subclass builder
    this._addToOutputObj(new this.constructor(element, this._options, this._csn).build(), true)
  }

  /**
   * Columns come as an Object with a ref property.
   *
   * @param {object} element reference object
   * @param {object} value only defined for structured
   * @private
   */
  _refOutputFromElement(element) {
    this._addToOutputObj(new this.ReferenceBuilder(element, this._options, this._csn).build(), false)
  }

  /**
   * Instead of adding the value to the SQL via string literal or string concat, add a placeholder instead.
   * The placeholder is than used by a db driver and prepared statements to defend against injections.
   *
   * @param {object} element
   * @private
   */
  _valOutputFromElement(element) {
    if (typeof element.val === 'number' && !this._parameterizedNumbers) {
      this._outputObj.sql.push(element.val)
    } else {
      this._outputObj.sql.push(this._options.placeholder)
      this._outputObj.values.push(element.val)
    }
  }

  _addToOutputObj({ sql, values }, addBrackets) {
    this._outputObj.sql.push(addBrackets ? `( ${sql} )` : sql)
    this._outputObj.values.push(...values)
  }
}

module.exports = ExpressionBuilder
