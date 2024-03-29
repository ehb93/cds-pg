const cds = require('../../cds')
const LOG = cds.log('hana|db|sql')

const SelectBuilder = require('../../db/sql-builder').SelectBuilder

class CustomSelectBuilder extends SelectBuilder {
  get FunctionBuilder() {
    const FunctionBuilder = require('./CustomFunctionBuilder')
    Object.defineProperty(this, 'FunctionBuilder', { value: FunctionBuilder })
    return FunctionBuilder
  }

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

  _val(obj) {
    if (typeof obj.val === 'boolean') return { sql: obj.val ? 'true' : 'false', values: [] }
    return super._val(obj)
  }

  getParameters() {
    // REVISIT: remove skipWithParameters after grace period
    if (
      (cds.env.features && cds.env.features.with_parameters === false) ||
      (cds.env.runtime && cds.env.runtime.skipWithParameters)
    ) {
      return ''
    }

    // REVISIT: remove feature flag skip_with_parameters after grace period of at least two months (> June release)
    if (cds.env.features && cds.env.features.skip_with_parameters === false) {
      return this._options.locale ? `with parameters ('LOCALE' = '${this._options.locale}')` : ''
    }

    // skip with parameters if all orderby columns are not strings
    let skip
    if (this._csn && this._csn.definitions) {
      // REVISIT: remove try catch with new sql factory
      try {
        const select = this._obj.SELECT
        const entity =
          select.from.ref &&
          select.from.ref.length === 1 &&
          // REVISIT this does not work with join and draft!
          this._csn.definitions[select.from.ref[0]]
        // TODO FIXME
        skip =
          !select.orderBy ||
          (entity &&
            select.orderBy.every(o => {
              const k = o.ref && o.ref.length === 1 && o.ref[0]
              const element = (k && entity.elements[k]) || {}
              return element.type !== 'cds.String'
            }))
      } catch (e) {
        if (LOG._warn) {
          e.message =
            'Unable to determine whether the "with parameters" clause can be skipped due to error: ' +
            e.message +
            '. Please report this warning.'
          e.query = this._obj
          LOG.warn(e)
        }
      }
    }
    if (skip) return ''

    return this._options.locale ? `with parameters ('LOCALE' = '${this._options.locale}')` : ''
  }
}

if (cds.env.sql.names === 'plain') {
  CustomSelectBuilder.prototype._buildRefElement = function (col, res, noQuoting) {
    res = new this.ReferenceBuilder(col, this._options, this._csn).build()

    if (!noQuoting && !col.as && res.sql && !res.sql.match(/\sas\s/i)) {
      res.sql += ` AS ${this._options.delimiter}${col.ref[col.ref.length - 1]}${this._options.delimiter}`
    }

    return res
  }
}

module.exports = CustomSelectBuilder
