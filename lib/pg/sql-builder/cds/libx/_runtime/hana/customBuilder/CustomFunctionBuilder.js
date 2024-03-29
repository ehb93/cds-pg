const FunctionBuilder = require('../../db/sql-builder').FunctionBuilder

class CustomFunctionBuilder extends FunctionBuilder {
  get ReferenceBuilder() {
    const ReferenceBuilder = require('./CustomReferenceBuilder')
    Object.defineProperty(this, 'ReferenceBuilder', { value: ReferenceBuilder })
    return ReferenceBuilder
  }

  get ExpressionBuilder() {
    const ExpressionBuilder = require('./CustomExpressionBuilder')
    Object.defineProperty(this, 'ExpressionBuilder', { value: ExpressionBuilder })
    return ExpressionBuilder
  }

  get SelectBuilder() {
    const SelectBuilder = require('./CustomSelectBuilder')
    Object.defineProperty(this, 'SelectBuilder', { value: SelectBuilder })
    return SelectBuilder
  }

  _handleContains(args) {
    // fuzzy search has three arguments, must not be converted to like expressions
    if (args.length > 2 || args._$search) {
      this._outputObj.sql.push('CONTAINS')
      this._addFunctionArgs(args, true)
    } else {
      super._handleContains(args)
    }
  }
}

module.exports = CustomFunctionBuilder
