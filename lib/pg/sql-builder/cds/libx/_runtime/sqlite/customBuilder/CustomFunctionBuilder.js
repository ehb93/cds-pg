const FunctionBuilder = require('../../db/sql-builder').FunctionBuilder

const dateTimeFunctions = new Map([
  ['year', "'%Y'"],
  ['month', "'%m'"],
  ['dayofmonth', "'%d'"],
  ['second', "'%f'"],
  ['hour', "'%H'"],
  ['minute', "'%M'"]
])
const standadFunctions = ['locate', 'substring', 'to_date', 'to_time']

class CustomFunctionBuilder extends FunctionBuilder {
  get ExpressionBuilder() {
    const ExpressionBuilder = require('./CustomExpressionBuilder')
    Object.defineProperty(this, 'ExpressionBuilder', { value: ExpressionBuilder })
    return ExpressionBuilder
  }

  get ReferenceBuilder() {
    const ReferenceBuilder = require('./CustomReferenceBuilder')
    Object.defineProperty(this, 'ReferenceBuilder', { value: ReferenceBuilder })
    return ReferenceBuilder
  }

  get SelectBuilder() {
    const SelectBuilder = require('./CustomSelectBuilder')
    Object.defineProperty(this, 'SelectBuilder', { value: SelectBuilder })
    return SelectBuilder
  }

  _handleFunction() {
    const functionName = this._functionName()
    const args = this._functionArgs()

    if (dateTimeFunctions.has(functionName)) {
      this._timeFunction(functionName, args)
    } else if (standadFunctions.includes(functionName)) {
      this._standardFunction(functionName, args)
    } else if (functionName === 'seconds_between') {
      this._secondsBetweenFunction(args)
    } else {
      super._handleFunction()
    }
  }

  _standardFunction(functionName, args) {
    switch (functionName) {
      case 'locate':
        functionName = 'INSTR'
        break
      case 'substring':
        functionName = 'substr'
        break
      case 'to_date':
        functionName = 'date'
        break
      case 'to_time':
        functionName = 'time'
        break
      default:
        break
    }

    this._outputObj.sql.push(functionName, '(')
    if (typeof args === 'string') {
      this._outputObj.sql.push(args, ')')
    } else {
      this._addFunctionArgs(args)
      this._outputObj.sql.push(')')
    }
  }

  _val(val) {
    this._outputObj.sql.push('?')
    this._outputObj.values.push(val)
  }

  _ref(ref) {
    this._outputObj.sql.push(new this.ReferenceBuilder(ref, this._options, this._csn).build().sql)
  }

  _secondsBetweenFunction(args) {
    this._outputObj.sql.push('strftime(?,')
    this._outputObj.values.push('%s')
    if (args[1].val) {
      this._val(args[1].val)
    } else {
      this._ref(args[1])
    }
    this._outputObj.sql.push(') - strftime(?,')
    this._outputObj.values.push('%s')
    if (args[0].val) {
      this._val(args[0].val)
    } else {
      this._ref(args[0])
    }
    this._outputObj.sql.push(')')
  }

  _timeFunction(functionName, args) {
    this._outputObj.sql.push('strftime(')
    this._outputObj.sql.push(dateTimeFunctions.get(functionName), ',')
    if (typeof args === 'string') {
      this._outputObj.sql.push(args, ')')
    } else {
      this._addFunctionArgs(args)
      this._outputObj.sql.push(')')
    }
  }
}

module.exports = CustomFunctionBuilder
