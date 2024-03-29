const ReferenceBuilder = require('../../db/sql-builder').ReferenceBuilder

class CustomReferenceBuilder extends ReferenceBuilder {
  get FunctionBuilder() {
    const FunctionBuilder = require('./CustomFunctionBuilder')
    Object.defineProperty(this, 'FunctionBuilder', { value: FunctionBuilder })
    return FunctionBuilder
  }

  _parseReference(ref) {
    if (ref[0].id && ref[0].args) {
      const dbName = this._getDatabaseName(ref[0].id)
      this._outputObj.sql.push(this._quoteElement(dbName))

      const args = Object.keys(ref[0].args)
        .map(argKey => {
          this._outputObj.values.push(ref[0].args[argKey].val)
          return `${argKey} => ${this._options.placeholder}`
        })
        .join(', ')

      this._outputObj.sql.push('(', args, ')')
    } else {
      if (this._handleStructuredIfExists(ref)) {
        return
      }

      this._outputObj.sql.push(ref.map(el => this._quoteElement(el)).join('.'))
    }
  }

  _isToOneManaged() {
    return false
  }
}

module.exports = CustomReferenceBuilder
