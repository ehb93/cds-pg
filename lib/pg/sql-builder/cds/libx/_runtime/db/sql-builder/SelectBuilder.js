const cds = require('../../cds')

const BaseBuilder = require('./BaseBuilder')
const { DRAFT_COLUMNS } = require('../../common/constants/draft')

/**
 * SelectBuilder is used to take a CQN object as an input and to build a SQL Select string from it.
 *
 * Currently not supported are:
 * - "cast" in "column_expr"
 * - "mixin"
 * - "excluding"
 *
 *  @example <caption>Definition of CQN </caption>
 * {
 *  SELECT = {SELECT:{
 *  distinct: true,
 *  from: source | join,
 *  columns: projection,
 *  where: _xpr,   groupBy: [ ...expr ],
 *  having: _xpr,  orderBy: [ ...ordering_term ],
 *  limit: { rows:expr, offset:expr }
 *  }}
 * }
 *
 * source         =  ( ref | SELECT ) + { as:string }
 * join           =  { join:string, sources:[...source], on:_xpr }
 * projection     =  [ ...column_expr ]
 * column_expr    =  expr + { as:string }
 * ordering_term  =  expr + { sort: 'asc'|'desc' }
 */
class SelectBuilder extends BaseBuilder {
  get ExpressionBuilder() {
    const ExpressionBuilder = require('./ExpressionBuilder')
    Object.defineProperty(this, 'ExpressionBuilder', { value: ExpressionBuilder })
    return ExpressionBuilder
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

  // for customBuilder access
  get SelectBuilder() {
    const SelectBuilder = require('./SelectBuilder')
    Object.defineProperty(this, 'SelectBuilder', { value: SelectBuilder })
    return SelectBuilder
  }

  /**
   * Builds an Object based on the properties of the CQN object.
   *
   * @param noQuoting
   * @example <caption>Example output</caption>
   * {
   *   sql: 'SELECT "a", "b", "c" FROM "T" HAVING "x" < ? ',
   *   values: [9]
   * }
   *
   * @returns {{sql: string, values: Array<string>}} Object with two properties.
   * SQL string for prepared statement and array of values to replace the placeholders.
   */
  build(noQuoting = false) {
    if (this._obj.SELECT._4odata) this._options._4odata = true

    this._outputObj = {
      sql: ['SELECT'],
      values: []
    }

    if (this._obj.SELECT.distinct) {
      this._distinct()
    }

    this._columns(noQuoting)
    this._from()

    if (this._obj.SELECT.where && this._obj.SELECT.where.length) {
      this._where()
    }

    if (this._obj.SELECT.groupBy && this._obj.SELECT.groupBy.length) {
      this._groupBy()
    }

    if (this._obj.SELECT.having && this._obj.SELECT.having.length) {
      this._having()
    }

    if (this._obj.SELECT.orderBy && this._obj.SELECT.orderBy.length) {
      this._orderBy()
    }

    if (this._obj.SELECT.limit || this._obj.SELECT.one) {
      this._limit()
    }

    if (this._obj.SELECT.forUpdate) {
      this._forUpdate()
    }

    this._parameters()
    this._outputObj.sql = /** @type {string} */ this._outputObj.sql.join(' ')
    return this._outputObj
  }

  _forUpdate() {
    this._outputObj.sql.push('FOR UPDATE')
    const sqls = []

    if (this._obj.SELECT.forUpdate.of) {
      for (const element of this._obj.SELECT.forUpdate.of) {
        const { sql } = new this.ReferenceBuilder(element, this._options, this._csn).build()
        sqls.push(sql)
      }

      if (sqls.length > 0) {
        this._outputObj.sql.push('OF', sqls.join(', '))
      }
    }

    if (Number.isInteger(this._obj.SELECT.forUpdate.wait)) {
      this._outputObj.sql.push('WAIT', this._obj.SELECT.forUpdate.wait)
    }
  }

  _distinct() {
    this._outputObj.sql.push('DISTINCT')
  }

  _from() {
    this._outputObj.sql.push('FROM')
    const hasOwnProperty = Object.prototype.hasOwnProperty

    if (hasOwnProperty.call(this._obj.SELECT.from, 'join')) {
      return this._fromJoin(this._obj.SELECT.from)
    }

    if (hasOwnProperty.call(this._obj.SELECT.from, 'SET')) {
      return this._fromUnion(this._obj.SELECT)
    }

    this._fromElement(this._obj.SELECT.from)
  }

  _fromJoin(from) {
    for (let i = 0, len = from.args.length; i < len; i++) {
      if (from.args[i].args) {
        // nested joins
        this._fromJoin(from.args[i])
        // Sub select with Union
      } else if (from.args[i].SELECT && from.args[i].SELECT.from.SET) {
        this._fromUnion(from.args[i].SELECT, from.args[i].as, from, i !== 0)
      } else {
        this._fromElement(from.args[i], from, i)
      }
    }
  }

  _fromUnion({ from: { SET: set, as: fromAs }, as }, alias, parent, notFirst) {
    if (notFirst) {
      // join
      this._outputObj.sql.push(parent.join.toUpperCase(), 'JOIN')
    }

    const selects = []
    const concat = set.all ? ' UNION ALL ' : ' UNION '

    for (const select of set.args) {
      const { sql, values } = new this.SelectBuilder(select, this._options, this._csn).build(true)

      selects.push(sql)
      this._outputObj.values.push(...values)
    }

    this._outputObj.sql.push('(', selects.join(concat), ')')

    if (alias || fromAs || as) {
      this._outputObj.sql.push('AS', this._quoteElement(alias || fromAs || as))
    }

    if (notFirst && parent.on) {
      const { sql, values } = new this.ExpressionBuilder(parent.on, this._options, this._csn).build()

      this._outputObj.sql.push('ON', sql)
      this._outputObj.values.push(...values)
    }
  }

  _fromElement(element, parent, i = 0) {
    let res = {}

    if (element.ref) {
      // view with params
      if (element.ref[element.ref.length - 1].args) {
        res = new this.ReferenceBuilder(element, this._options, this._csn).build()
      } else {
        // ref
        const dbName = this._getDatabaseName(element.ref[0])
        res.sql = this._quoteElement(dbName)
        res.values = []
      }
    } else {
      // select
      res = new this.SelectBuilder(element, this._options, this._csn).build(true)
      res.sql = `(${res.sql})`
    }

    if (element.as) {
      // identifier
      res.sql += ` ${this._quoteElement(element.as)}`
    }

    this._outputObj.values.push(...res.values)

    if (i === 0) {
      // first element
      this._outputObj.sql.push(res.sql)
    } else {
      // join
      this._outputObj.sql.push(parent.join.toUpperCase(), 'JOIN', res.sql)

      if (parent.on) {
        const { sql, values } = new this.ExpressionBuilder(parent.on, this._options, this._csn).build()

        this._outputObj.sql.push('ON', sql)
        this._outputObj.values.push(...values)
      }
    }
  }

  _buildElement(col, noQuoting) {
    let res = {}

    if (col.ref) {
      // ref
      res = this._buildRefElement(col, res, noQuoting)
    } else if (col.func) {
      res = new this.FunctionBuilder(col, this._options, this._csn).build()
    } else if (col.xpr) {
      // xpr
      res = new this.ExpressionBuilder(col, Object.assign({}, this._options, { objectKey: 'xpr' }), this._csn).build()
    } else if (Object.prototype.hasOwnProperty.call(col, 'SELECT')) {
      // SELECT
      res = new this.SelectBuilder(col, this._options, this._csn).build(true)
      res.sql = `( ${res.sql} )`
    } else {
      // val
      res = this._val(col)
    }

    if (col.as) {
      // as is quoted in case of ref, val, xpr or func
      res.sql += this._quoteAlias(col, noQuoting)
    }

    this._outputObj.values.push(...res.values)
    return res.sql
  }

  // this function is overridden in hana in CustomSelectBuilder
  _buildRefElement(col, res, noQuoting) {
    res = new this.ReferenceBuilder(col, this._options, this._csn).build()
    return res
  }

  _quoteAlias(col, noQuoting) {
    if (
      !noQuoting &&
      this._quotingStyle === 'plain' &&
      ('ref' in col || 'val' in col || 'xpr' in col || 'func' in col)
    ) {
      // REVISIT: db cleanup
      // slugify is needed for a unit test. Really required in production?
      const slugifiedAlias = col.as.replace(/\./g, '_')
      return ` AS ${this._quote(slugifiedAlias)}`
    }

    return ` AS ${this._quoteElement(col.as)}`
  }

  _checkForDuplicateColumns(columns) {
    const aliases = columns.map(col => this._getAlias(col)).filter(element => element !== undefined)
    const findDuplicates = aliases.filter((item, index) => aliases.indexOf(item) !== index)

    if (findDuplicates.length > 0) {
      throw new Error(
        `Duplicate column names ${JSON.stringify(findDuplicates)} detected in SELECT statement. Please use aliases.`
      )
    }
  }

  _getAlias(col) {
    if (col.as) return col.as
    if (col.ref) return col.ref[col.ref.length - 1]
  }

  _columns(noQuoting) {
    const columns = this._obj.SELECT.columns
    if (Array.isArray(columns) && columns.length !== 0 && columns[0] !== '*') {
      this._checkForDuplicateColumns(columns)
      this._outputObj.sql.push(columns.map(col => this._buildElement(col, noQuoting)).join(', '))
    } else {
      this._outputObj.sql.push('*')
    }
  }

  _where() {
    const entityName = this._obj.SELECT.from.ref && this._obj.SELECT.from.ref[0]
    const where = new this.ExpressionBuilder(
      this._obj.SELECT.where,
      entityName ? { ...this._options, entityName } : this._options,
      this._csn
    ).build()
    this._outputObj.sql.push('WHERE', where.sql)
    this._outputObj.values.push(...where.values)
  }

  _quote(element) {
    return `${this._options.delimiter}${element}${this._options.delimiter}`
  }

  _quoteDraftSpecificColumns(element) {
    if (this._quotingStyle === 'plain' && element.ref) {
      element.ref = element.ref.map(el => {
        if (DRAFT_COLUMNS.includes(el)) {
          return this._quote(el)
        }

        return el
      })
    }
  }

  _quoteAliases(element) {
    const name = element.as || (element.ref && element.ref.length === 1 && element.ref[0])
    if (this._quotingStyle === 'plain' && name) {
      const columns = this._obj.SELECT.columns
      if (Array.isArray(columns) && columns.length !== 0) {
        for (const col of columns) {
          if (col.as && col.as === name) {
            element.ref = [this._quote(name)]
          }
        }
      }
    }
  }

  _groupBy() {
    const sqls = []
    this._outputObj.sql.push('GROUP BY')
    for (const element of this._obj.SELECT.groupBy) {
      // REVISIT is this really needed? Was removed in orderby
      this._quoteDraftSpecificColumns(element)
      const res = new this.ReferenceBuilder(element, this._options, this._csn).build()
      sqls.push(res.sql)
      this._outputObj.values.push(...res.values)
    }
    this._outputObj.sql.push(sqls.join(', '))
  }

  _having() {
    const { sql, values } = new this.ExpressionBuilder(this._obj.SELECT.having, this._options, this._csn).build()
    this._outputObj.sql.push('HAVING', sql)
    this._outputObj.values.push(...values)
  }

  _orderBy() {
    const sqls = []
    this._outputObj.sql.push('ORDER BY')
    for (const element of this._obj.SELECT.orderBy) {
      // REVISIT: should not be necessary
      // if columns doesn't have matching ref but matching as, then use that as
      const { columns } = this._obj.SELECT
      if (columns) {
        const serialized = JSON.stringify(element.ref)
        if (!columns.find(c => JSON.stringify(c.ref) === serialized)) {
          const toMatch = element.as || (element.ref && element.ref.length === 1 && element.ref[0])
          if (toMatch && columns.find(c => c.as === toMatch)) {
            sqls.push(this._quote(toMatch) + ' ' + (element.sort || 'asc').toUpperCase())
            continue
          }
        }
      }
      const { sql, values } = new this.ReferenceBuilder(
        Object.assign({}, element, {
          sort: Object.prototype.hasOwnProperty.call(element, 'sort') ? element.sort : true
        }),
        this._options,
        this._csn
      ).build()
      sqls.push(sql)
      this._outputObj.values.push(...values)
    }

    this._outputObj.sql.push(sqls.join(', '))
  }

  /**
   * sql limit clause will be generated without placeholders.
   * reason is optimizing paging queries. number of rows does not change.
   *
   * offset will only be added, if <> 0
   * offset will still use placeholders, as it'll change during the paging queries.
   */
  _limit() {
    // limit (no placeholder for statement caching)
    this._outputObj.sql.push('LIMIT', this._obj.SELECT.one ? 1 : this._obj.SELECT.limit.rows.val)
    // offset
    if (this._obj.SELECT.limit && this._obj.SELECT.limit.offset) {
      if (typeof this._obj.SELECT.limit.offset.val === 'number' && !this._parameterizedNumbers) {
        this._outputObj.sql.push('OFFSET', this._obj.SELECT.limit.offset.val)
      } else {
        this._outputObj.sql.push('OFFSET', '?')
        this._outputObj.values.push(this._obj.SELECT.limit.offset.val)
      }
    }
  }

  _parameters() {
    const parameters = this.getParameters()

    if (parameters) {
      this._outputObj.sql.push(this.getParameters())
    }
  }

  _val(obj) {
    let _val = obj.val
    if (typeof _val === 'number' || _val === null) return { sql: _val, values: [] }
    // REVISIT: remove with cds^6
    if (typeof _val === 'string' && cds.env.features.extract_vals !== false) {
      const match = _val.match(/^'(.*)'$/)
      if (match) _val = match[1]
    }
    return { sql: '?', values: [_val] }
  }

  getDefaultOptions() {
    const collate = this.getCollate()
    return { ...super.getDefaultOptions(), ...{ collate } }
  }

  getCollate() {
    return ''
  }

  getParameters() {
    return ''
  }
}

module.exports = SelectBuilder
