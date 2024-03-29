const BaseBuilder = require('./BaseBuilder')
const getAnnotatedColumns = require('./annotations')
const dollar = require('./dollar')
const { stringifyIfArrayedElement, isArrayedElement } = require('./arrayed')

/**
 * UpdateBuilder is used to take a CQN object as an input and to build an object representing an update operation
 * with SQL string and values to be used with a prepared statement.
 * The SQL object can only be built if properties 'entity' and 'with' are available.
 * The property 'where' is optional.
 *
 * @example <caption>Example of CQN </caption>
 * {
 *  UPDATE = {UPDATE:{
 *  entity: entity | string,
 *  data: { ...column:any },
 *  where: _xpr,
 *  }}
 * }
 */
class UpdateBuilder extends BaseBuilder {
  constructor(obj, options, csn) {
    super(obj, options)
    this._options.typeConversion = this._options.typeConversion || new Map()
    this._csn = csn
  }

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

  /**
   * Builds an Object based on the properties of the CQN object.
   *
   * @example <caption>Example output</caption>
   * {
   *    sql: 'UPDATE "T" SET "a" = ?, "b" = ?, "c" = ? WHERE "x" < ? ',
   *    values: [1, 2, "'asd'", 9]
   * }
   *
   * @returns {{sql: string, values: Array}} Object with two properties.
   * SQL string for prepared statement and array of values to replace the placeholders.
   */
  build() {
    this._outputObj = {
      sql: ['UPDATE'],
      values: []
    }

    // replace $ values
    // REVISIT: better
    if (this._obj.UPDATE.data) {
      dollar.data(this._obj.UPDATE.data, this._options.user, this._options.now)
    }

    const entityName = this._entity()
    this._options.entityName = entityName

    const entity = this._csn && this._csn.definitions && this._csn.definitions[entityName]
    this._data(getAnnotatedColumns(entityName, this._csn), entity)
    if (Array.isArray(this._obj.UPDATE.where) && this._obj.UPDATE.where.length > 0) {
      this._where()
    }

    this._outputObj.sql = this._outputObj.sql.join(' ')

    return this._outputObj
  }

  _entity() {
    if (typeof this._obj.UPDATE.entity === 'string') {
      const dbName = this._getDatabaseName(this._obj.UPDATE.entity)
      this._outputObj.sql.push(this._quoteElement(dbName))
      return this._obj.UPDATE.entity
    } else if (this._obj.UPDATE.entity.name) {
      const dbName = this._getDatabaseName(this._obj.UPDATE.entity.name)
      this._outputObj.sql.push(this._quoteElement(dbName))
      return this._obj.UPDATE.entity.name
    } else {
      // entity = { ref: ['entityName'], as: 'T1'} alias is optional
      const dbName = this._getDatabaseName(this._obj.UPDATE.entity.ref[0])
      this._outputObj.sql.push(this._quoteElement(dbName))

      if (this._obj.UPDATE.entity.as) {
        this._outputObj.sql.push('AS')
        this._outputObj.sql.push(this._quoteElement(this._obj.UPDATE.entity.as))
      }
      return this._obj.UPDATE.entity.ref[0]
    }
  }

  _data(annotatedColumns, entity) {
    const sql = []
    const data = this._obj.UPDATE.data || {}
    const withObj = this._obj.UPDATE.with || {}
    const dataObj = Object.assign({}, data, withObj) // with overwrites data, save in new object so CQN still looks the same
    const resMap = this._getFlattenColumnValues(dataObj)
    this._removeAlreadyExistingUpdateAnnotatedColumnsFromMap(annotatedColumns, resMap)

    this._addAnnotatedUpdateColumns(resMap, annotatedColumns)

    if (entity && entity.keys) {
      resMap.forEach((value, key, map) => {
        if (key in entity.keys) map.delete(key)
      })
    }

    resMap.forEach((value, key, map) => {
      if (value && value.sql) {
        sql.push(`${this._quoteElement(key)} = ${value.sql}`)
        this._outputObj.values.push(...value.values)
      } else {
        sql.push(`${this._quoteElement(key)} = ?`)
        this._outputObj.values.push(stringifyIfArrayedElement(value))
      }
    })

    this._outputObj.sql.push(`SET ${sql.join(', ')}`)
  }

  _removeAlreadyExistingUpdateAnnotatedColumnsFromMap(annotatedColumns, resMap) {
    if (!annotatedColumns) {
      return
    }

    for (const columnName of annotatedColumns.updateAnnotatedColumns.keys()) {
      if (resMap.has(columnName)) {
        annotatedColumns.updateAnnotatedColumns.delete(columnName)
      }
    }
  }

  _getFlattenColumnValues(data, prefix) {
    const res = new Map()
    Object.keys(data).forEach(key => {
      const prefixKey = prefix ? `${prefix}_${key}` : key
      const value = data[key]
      if (typeof value === 'object' && !Buffer.isBuffer(value) && value !== null && typeof value.pipe !== 'function') {
        if (isArrayedElement(value)) {
          res.set(key, JSON.stringify(value))
        } else if ('xpr' in value && Array.isArray(value.xpr)) {
          const xpr = new this.ExpressionBuilder(value.xpr, this._options, this._csn).build()
          res.set(key, xpr)
        } else if ('ref' in value && Array.isArray(value.ref)) {
          // ref can be structured property
          const ref = new this.ReferenceBuilder(value, this._options, this._csn).build()
          res.set(key, ref)
        } else if (
          'val' in value &&
          (value.val === null || typeof value.val !== 'object' || Buffer.isBuffer(value.val))
        ) {
          res.set(key, value.val)
        } else if ('func' in value && 'args' in value && Array.isArray(value.args)) {
          const func = new this.FunctionBuilder(value, this._options, this._csn).build()
          res.set(key, func)
        } else {
          const resInternal = this._getFlattenColumnValues(value, prefixKey)
          Array.from(resInternal.keys()).forEach(keyInternal => {
            res.set(`${key}_${keyInternal}`, resInternal.get(keyInternal))
          })
        }
      } else {
        res.set(key, value)
      }
    })

    return res
  }

  _addAnnotatedUpdateColumns(resMap, annotatedColumns) {
    if (!annotatedColumns) return

    for (const col of annotatedColumns.updateAnnotatedColumns.keys()) {
      const symbol = annotatedColumns.updateAnnotatedColumns.get(col).symbol
      const annotatedValue = this._options[symbol]
      if (typeof annotatedValue === 'object') annotatedValue.values = []
      resMap.set(col, annotatedValue)
    }
  }

  _where(entityName) {
    const where = new this.ExpressionBuilder(this._obj.UPDATE.where, this._options, this._csn).build()
    this._outputObj.sql.push('WHERE', where.sql)
    this._outputObj.values = this._outputObj.values.concat(where.values)
  }
}

module.exports = UpdateBuilder
