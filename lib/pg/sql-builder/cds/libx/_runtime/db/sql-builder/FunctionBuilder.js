const BaseBuilder = require('./BaseBuilder')

const cqn2sqlFunc = {
  toupper: 'upper',
  tolower: 'lower',
  indexof: 'locate',
  day: 'dayofmonth',
  date: 'to_date',
  time: 'to_time',
  average: 'avg'
}

/**
 * FunctionBuilder is used to take a part of a CQN object as an input and to build an object representing a function
 * with SQL string and values.
 *
 */
class FunctionBuilder extends BaseBuilder {
  get ReferenceBuilder() {
    const ReferenceBuilder = require('./ReferenceBuilder')
    Object.defineProperty(this, 'ReferenceBuilder', { value: ReferenceBuilder })
    return ReferenceBuilder
  }

  get ExpressionBuilder() {
    const ExpressionBuilder = require('./ExpressionBuilder')
    Object.defineProperty(this, 'ExpressionBuilder', { value: ExpressionBuilder })
    return ExpressionBuilder
  }

  get SelectBuilder() {
    const SelectBuilder = require('./SelectBuilder')
    Object.defineProperty(this, 'SelectBuilder', { value: SelectBuilder })
    return SelectBuilder
  }

  build() {
    this._outputObj = {
      sql: [],
      values: []
    }

    this._handleFunction()

    this._outputObj.sql = this._outputObj.sql.join(' ')
    return this._outputObj
  }

  _functionName() {
    const funcName = ((this._obj.ref && this._obj.ref[0]) || this._obj.func).toLowerCase()
    return cqn2sqlFunc[funcName] || funcName
  }

  _functionArgs() {
    return (this._obj.func && this._obj.args) || (this._obj.ref && this._obj.ref[1] && this._obj.ref[1].args)
  }

  _escapeLikeParameters(parameters) {
    for (const parameter of parameters) {
      if (parameter.val) parameter.val = parameter.val.replace(/(\^|_|%)/g, '^$1')
      else if (parameter.func) parameter.args = this._escapeLikeParameters(parameter.args)
    }

    return parameters
  }

  _handleFunction() {
    const functionName = this._functionName()
    const args = this._functionArgs()

    if (!args) {
      // > arg-less func such as current_date
      this._outputObj.sql.push(functionName)
      return
    }

    if (functionName.includes('contains')) {
      // this method is overridden in hana custom function builder
      // be careful with renaming or changing signature
      this._handleContains(args)
      return
    }

    if (functionName.includes('startswith') || functionName.includes('endswith')) {
      this._handleLikewiseFunc(args)
      return
    }

    if (functionName === 'concat') {
      this._addFunctionArgs(args, true, ' || ')
      return
    }

    if (functionName === 'countdistinct') {
      this._handleCountdistinct(args)
      return
    }

    this._outputObj.sql.push(functionName, '(')
    if (typeof args === 'string') this._outputObj.sql.push(args)
    else this._addFunctionArgs(args)
    this._outputObj.sql.push(')')
  }

  _handleCountdistinct(args) {
    this._outputObj.sql.push('count', '(', 'DISTINCT')
    if (typeof args === 'string') this._outputObj.sql.push(args)
    else this._addFunctionArgs(args)
    this._outputObj.sql.push(')')
  }

  _handleContains(args) {
    this._handleLikewiseFunc(args)
  }

  _handleLikewiseFunc(args) {
    const functionName = this._functionName()
    const not = functionName.startsWith('not') ? 'NOT ' : ''
    const columns = this._columns(args)
    const params = args.slice(1)
    this._escapeLikeParameters(params)

    const _pattern = (() => {
      if (functionName.includes('contains')) return _ => ["'%'", _, "'%'"]
      if (functionName.includes('startswith')) return _ => [_, "'%'"]
      if (functionName.includes('endswith')) return _ => ["'%'", _]
    })()

    for (const param of params) {
      if (param === 'or' || param === 'and' || param === 'not') {
        this._outputObj.sql.push(param)
      } else {
        this._createLikeComparison(not, columns, _pattern(param))
      }
    }
  }

  _createLikeComparison(not, columns, param) {
    const length = columns.length
    this._outputObj.sql.push('(')

    for (let i = 0; i < length; i++) {
      const { sql, values } = new this.ExpressionBuilder([columns[i]], this._options, this._csn).build()
      if (!sql) continue
      this._outputObj.values.push(...values)
      this._createLikeComparisonForColumn(not, sql, param)
      if (i !== columns.length - 1 && columns[i + 1] !== ')') {
        this._outputObj.sql.push(not ? 'AND' : 'OR')
      }
    }

    this._outputObj.sql.push(')')
  }

  _createLikeComparisonForColumn(not, left, right) {
    if (not) {
      this._outputObj.sql.push('(', left, 'IS NULL', 'OR')
    }

    this._outputObj.sql.push(left, `${not}LIKE`)
    this._addFunctionArgs(right, true, ' || ')
    this._outputObj.sql.push('ESCAPE', "'^'")
    if (not) this._outputObj.sql.push(')')
  }

  _columns(args) {
    return args[0].xpr || args[0].list || [args[0]]
  }

  _addFunctionArgs(args, enclose, sep = ', ') {
    const functionName = this._functionName()
    if (functionName === 'substring') args[1].val++
    if (enclose) this._outputObj.sql.push('(')
    const res = []

    for (const arg of args) {
      if (arg.ref) {
        if (arg.cast && arg.cast.type) arg._cast4func = arg.cast
        const { sql, values } = new this.ReferenceBuilder(arg, this._options, this._csn).build()
        res.push(sql)
        this._outputObj.values.push(...values)
      } else if (arg.func) {
        // new instance of subclass builder
        const { sql, values } = new this.constructor(arg, this._options, this._csn).build()
        res.push(sql)
        this._outputObj.values.push(...values)
      } else if (arg.xpr) {
        const { sql, values } = new this.ExpressionBuilder(arg.xpr, this._options, this._csn).build()
        res.push(sql)
        this._outputObj.values.push(...values)
      } else if (arg.SELECT) {
        const { sql, values } = new this.SelectBuilder(arg, this._options, this._csn).build(true)
        res.push(sql)
        this._outputObj.values.push(...values)
      } else if (Object.prototype.hasOwnProperty.call(arg, 'val')) {
        if (typeof arg.val === 'number' && !this._parameterizedNumbers) {
          res.push(arg.val)
        } else {
          res.push(this._options.placeholder)
          this._outputObj.values.push(arg.val)
        }
      } else if (arg.list) {
        this._addFunctionArgs(arg.list, true)
        // _addFunctionArgs adds the arguments list already to the output object
        // in order to have correct comma separation, we need to add empty string to res
        res.push('')
      } else if (typeof arg === 'string') {
        res.push(arg)
      }
    }

    this._outputObj.sql.push(res.join(sep))
    if (enclose) this._outputObj.sql.push(')')
  }
}

module.exports = FunctionBuilder
