const cds = require('../../cds')

const BaseBuilder = require('./BaseBuilder')
const SelectBuilder = require('./SelectBuilder')
const getAnnotatedColumns = require('./annotations')
const dollar = require('./dollar')
const { stringifyIfArrayedElement, isArrayedElement } = require('./arrayed')

/**
 * InsertBuilder is used to take a CQN object as an input and to build an object representing an insert operation
 * with SQL string and values to be inserted with the prepared statement.
 * The SQL object can only be built if one of the properties 'entries', 'values' or 'rows' is available.
 *
 * @example <caption>Example of CQN </caption>
 * {
 *  INSERT = {INSERT:{
 *  into: entity | string,
 *  columns: [ ...string ],
 *  values: [ ...any ],
 *  rows: [ ...[ ...any ] ],
 *  entries: [ ...{ ...column:any } ]
 *  }}
 * }
 */
class InsertBuilder extends BaseBuilder {
  /**
   * Base constructor with additionally provided csn
   *
   * @param {object} obj
   * @param {object} options
   * @param {object} csn
   */
  constructor(obj, options, csn) {
    super(obj, options)
    this._options.typeConversion = this._options.typeConversion || new Map()
    this._csn = csn
  }

  /**
   * Builds an Object based on the properties of the CQN object.
   *
   * @example <caption>Example output</caption>
   * {
   *    sql: 'INSERT INTO "T" ("a", "b", "c") VALUES (?, ?, ?)',
   *    values: [1, 2, '\'asd\'']
   * }
   *
   * @returns {{sql: string, values: Array}} Object with two properties.
   * SQL string for prepared statement and array of values to replace the placeholders.
   * Property values can be an Array of Arrays for Batch insert of multiple rows.
   */
  build() {
    this._outputObj = {
      sql: ['INSERT', 'INTO'],
      values: []
    }

    // replace $ values
    // REVISIT: better
    if (this._obj.INSERT.entries) {
      dollar.entries(this._obj.INSERT.entries, this._options.user, this._options.now)
    } else if (this._obj.INSERT.values) {
      dollar.values(this._obj.INSERT.values, this._options.user, this._options.now)
    } else if (this._obj.INSERT.rows) {
      dollar.rows(this._obj.INSERT.rows, this._options.user, this._options.now)
    }

    const entityName = this._into()

    // side effect: sets this.uuidKeys if found any
    this._findUuidKeys(entityName)

    this._columnIndexesToDelete = []
    const annotatedColumns = getAnnotatedColumns(entityName, this._csn)

    if (this._obj.INSERT.columns) {
      this._removeAlreadyExistingInsertAnnotatedColumnsFromMap(annotatedColumns)
      this._columns(annotatedColumns)
    }

    if (this._obj.INSERT.values || this._obj.INSERT.rows) {
      if (annotatedColumns && !this._obj.INSERT.columns) {
        // if columns not provided get indexes from csn
        this._getAnnotatedColumnIndexes(annotatedColumns)
      }

      this._values(annotatedColumns)
    } else if (this._obj.INSERT.entries && this._obj.INSERT.entries.length !== 0) {
      this._entries(annotatedColumns)
    }

    if (this._obj.INSERT.as) {
      this._as(this._obj.INSERT.as)
    }

    this._outputObj.sql = /** @type {string} */ this._outputObj.sql.join(' ')
    return this._outputObj
  }

  _removeAlreadyExistingInsertAnnotatedColumnsFromMap(annotatedColumns) {
    if (!annotatedColumns) {
      return
    }

    for (const columnName of annotatedColumns.insertAnnotatedColumns.keys()) {
      if (this._obj.INSERT.columns && this._obj.INSERT.columns.includes(columnName)) {
        annotatedColumns.insertAnnotatedColumns.delete(columnName)
      }
    }
  }

  _into() {
    if (typeof this._obj.INSERT.into === 'string') {
      const dbName = this._getDatabaseName(this._obj.INSERT.into)
      this._outputObj.sql.push(this._quoteElement(dbName))
      return this._obj.INSERT.into
    }

    const dbName = this._getDatabaseName(this._obj.INSERT.into.name)
    this._outputObj.sql.push(this._quoteElement(dbName))
    return this._obj.INSERT.into.name
  }

  _as(element) {
    const { sql, values } = new SelectBuilder(element, this._options, this._csn).build()
    this._outputObj.sql.push(sql)
    this._outputObj.values.push(...values)
  }

  _columnAnnotatedAdded(annotatedColumns) {
    const annotatedInsertColumnNames = this._getAnnotatedInsertColumnNames(annotatedColumns)

    if (annotatedInsertColumnNames && annotatedInsertColumnNames.length !== 0) {
      this._outputObj.sql.push(',', annotatedInsertColumnNames.map(col => this._quoteElement(col)).join(', '))
    }
  }

  _findUuidKeys(entityName) {
    const uuidKeys = []
    if (this._csn && this._csn.definitions[entityName] && this._csn.definitions[entityName].keys) {
      for (const key of Object.values(this._csn.definitions[entityName].keys)) {
        if (key.type === 'cds.UUID') {
          uuidKeys.push(key.name)
        }
      }
    }

    if (uuidKeys.length > 0) {
      this.uuidKeys = uuidKeys
    }
  }

  _columns(annotatedColumns) {
    this._outputObj.sql.push('(')

    const insertColumns = [...this._obj.INSERT.columns.map(col => this._quoteElement(col))]

    if (this.uuidKeys) {
      for (const key of this.uuidKeys) {
        if (!this._obj.INSERT.columns.includes(key)) {
          insertColumns.unshift(this._quoteElement(key))
        }
      }
    }

    this._outputObj.sql.push(insertColumns.join(', '))

    if (annotatedColumns) {
      // add insert annotated columns
      this._columnAnnotatedAdded(annotatedColumns)
    }

    this._outputObj.sql.push(')')
  }

  _valuesAnnotatedValues(annotatedInsertColumnValues, values) {
    this._spliceArray(values) // remove all annotated

    if (annotatedInsertColumnValues.values && annotatedInsertColumnValues.values.length !== 0) {
      values.push(...annotatedInsertColumnValues.values) // add insert annotated
    }
  }

  _values(annotatedColumns) {
    let placeholderNum = 0
    const annotatedInsertColumnValues = annotatedColumns ? this._getAnnotatedInsertColumnValues(annotatedColumns) : []

    if (this._obj.INSERT.values) {
      this._outputObj.values = this._obj.INSERT.values.map(stringifyIfArrayedElement)

      placeholderNum = this._outputObj.values.length

      this._valuesAnnotatedValues(annotatedInsertColumnValues, this._outputObj.values)
    } else {
      this._outputObj.values = this._obj.INSERT.rows.map(r => r.map(stringifyIfArrayedElement))

      placeholderNum = this._outputObj.values[0].length

      this._outputObj.values.forEach(values => {
        this._valuesAnnotatedValues(annotatedInsertColumnValues, values)
      })
    }

    if (this.uuidKeys && this._obj.INSERT.columns) {
      for (const key of this.uuidKeys) {
        if (!this._obj.INSERT.columns.includes(key)) {
          placeholderNum += 1
          this._obj.INSERT.values
            ? this._outputObj.values.unshift(cds.utils.uuid())
            : this._outputObj.values.forEach(arr => arr.unshift(cds.utils.uuid()))
        }
      }
    }

    this._outputObj.sql.push(
      ...this._createPlaceholderString(placeholderNum, annotatedInsertColumnValues.valuesAndSQLs)
    )
  }

  _addUuidToColumns(columns, flattenColumnMap) {
    if (this.uuidKeys) {
      for (const key of this.uuidKeys) {
        if (!flattenColumnMap.get(key)) {
          columns.push(...this.uuidKeys.map(key => this._quoteElement(key)))
        }
      }
    }
  }

  _getSubstituteForUndefined(column, insertAnnotatedColumns) {
    const annotatedColumn = insertAnnotatedColumns.get(column)
    const symbol = annotatedColumn && annotatedColumn.symbol
    const option = symbol && this._options[symbol]
    return typeof option === 'string' ? option : null
  }

  _traverseValue(key, val) {
    // preserve val[key] === undefined for managed data
    return val == null ? null : val[key]
  }

  _getValue(column, { entry, flattenColumn, insertAnnotatedColumns }) {
    let val = entry
    if (!flattenColumn && this.uuidKeys.includes(column)) {
      val = cds.utils.uuid()
    } else {
      for (const key of flattenColumn) {
        val = this._traverseValue(key, val)
      }
    }
    return val === undefined ? this._getSubstituteForUndefined(column, insertAnnotatedColumns) : val
  }

  _addEntries(valuesArray, { columns, flattenColumnMap, purelyManagedColumnValues, insertAnnotatedColumns }) {
    const checkerForInconsistentColumns = this._checkerForInconsistentColumns(insertAnnotatedColumns)
    for (const entry of this._obj.INSERT.entries) {
      const values = []

      const flattenEntryColumns = this._getFlattenEntryColumns(entry)
      checkerForInconsistentColumns(flattenEntryColumns)

      for (const column of columns) {
        const flattenColumn = flattenColumnMap.get(column)
        const val = this._getValue(column, { entry, flattenColumn, insertAnnotatedColumns })
        values.push(isArrayedElement(val) ? JSON.stringify(val) : val)
      }

      // insert values for insert annotated columns
      values.push(...purelyManagedColumnValues.values)

      valuesArray.push(values)
    }
  }

  /**
   * This method creates insert statement in case of multiple entries.
   *
   * @param annotatedColumns
   * @example:
   * [{a: {b: 1, c: 2}}, {a: {b: 2, c: 3}}, {a: {b: 3, c: 4}}]
   *
   * @private
   */
  _entries(annotatedColumns) {
    const columns = []
    const valuesArray = []
    const insertAnnotatedColumns = (annotatedColumns && annotatedColumns.insertAnnotatedColumns) || []
    const flattenColumnMap = this._getFlattenColumnMap(this._obj.INSERT.entries, { annotatedColumns })
    const purelyManagedColumns = this._getAnnotatedInsertColumnNames(annotatedColumns).filter(
      colName => !flattenColumnMap.has(colName)
    )

    const purelyManagedColumnValues = this._getAnnotatedInsertColumnValues(annotatedColumns, purelyManagedColumns)

    this._addUuidToColumns(columns, flattenColumnMap)
    columns.push(...flattenColumnMap.keys())

    this._addEntries(valuesArray, { columns, flattenColumnMap, purelyManagedColumnValues, insertAnnotatedColumns })

    // add insert annotated columns
    const placeholderNum = columns.length
    columns.push(...purelyManagedColumns)

    this._outputObj.sql.push(
      ...this._entriesSqlString(columns, placeholderNum, purelyManagedColumnValues.valuesAndSQLs)
    )
    this._outputObj.values = valuesArray
  }

  _isAnnotatedColumnsWithSQLFunction(annotatedColumnValue) {
    const symbol = annotatedColumnValue.symbol
    const option = symbol && this._options[symbol]
    return option && option.sql
  }

  _getAnnotatedColumnsWithSQLFunction(insertAnnotatedColumns) {
    const res = []
    for (const [insertAnnotatedColumnKey, insertAnnotatedColumnValue] of insertAnnotatedColumns) {
      if (this._isAnnotatedColumnsWithSQLFunction(insertAnnotatedColumnValue)) {
        res.push(insertAnnotatedColumnKey)
      }
    }
    return res
  }

  _checkerForInconsistentColumns(insertAnnotatedColumns) {
    const annotatedValuesWithSqlFunctions =
      (insertAnnotatedColumns && this._getAnnotatedColumnsWithSQLFunction(insertAnnotatedColumns)) || []

    let usedAnnotatedValuesWithSqlFunctions

    return columns => {
      if (!annotatedValuesWithSqlFunctions) return
      const ownAnnotatedValuesWithSqlFunctions = columns.filter(key => annotatedValuesWithSqlFunctions.includes(key))
      if (!usedAnnotatedValuesWithSqlFunctions) {
        usedAnnotatedValuesWithSqlFunctions = ownAnnotatedValuesWithSqlFunctions
      } else {
        const ownInconsistentColumns = ownAnnotatedValuesWithSqlFunctions.filter(
          key => !usedAnnotatedValuesWithSqlFunctions.includes(key)
        )
        const otherInconsistentColumns = usedAnnotatedValuesWithSqlFunctions.filter(
          key => !ownAnnotatedValuesWithSqlFunctions.includes(key)
        )
        const inconsistentColumns = ownInconsistentColumns.concat(otherInconsistentColumns)
        if (inconsistentColumns.length) {
          throw new Error(
            `NOT SUPPORTED: Entries of INSERT have columns with both values and SQL function delegations (${inconsistentColumns.join(
              ' '
            )})`
          )
        }
      }
    }
  }

  _getFlattenEntryColumns(entry, prefix) {
    const res = []
    this._getFlattenEntryColumnsRecursion(res, entry, prefix)
    return res
  }

  _isSubObject(key, entry) {
    return (
      typeof entry[key] === 'object' &&
      entry[key] !== null &&
      !Buffer.isBuffer(entry[key]) &&
      typeof entry[key].pipe !== 'function'
    )
  }

  _getFlattenEntryColumnsRecursion(res, entry, prefix) {
    Object.keys(entry).forEach(key => {
      const prefixKey = prefix ? `${prefix}_${key}` : key
      if (this._isSubObject(key, entry) && !isArrayedElement(entry[key])) {
        this._getFlattenEntryColumnsRecursion(res, entry[key], prefixKey)
      } else {
        res.push(prefixKey)
      }
    })
  }

  _getFlattenColumnMap(entries, { prefix, annotatedColumns } = {}) {
    const res = new Map()

    entries.forEach(entry => {
      Object.keys(entry).forEach(key => {
        const prefixKey = prefix ? `${prefix}_${key}` : key
        if (this._isSubObject(key, entry) && !isArrayedElement(entry[key])) {
          const resInternal = this._getFlattenColumnMap([entry[key]], { prefix: prefixKey, annotatedColumns })

          Array.from(resInternal.keys()).forEach(keyInternal => {
            const arrInternal = resInternal.get(keyInternal)
            arrInternal.unshift(key)
            res.set(`${key}_${keyInternal}`, arrInternal)
          })
        } else {
          res.set(key, [key])
        }
      })
    })

    return res
  }

  _entriesSqlString(columns, placeholderNum, valuesAndSQLs) {
    return [
      '(',
      columns.map(column => this._quoteElement(column)).join(', '),
      ')',
      ...this._createPlaceholderString(placeholderNum, valuesAndSQLs)
    ]
  }

  _createPlaceholderString(placeholderNum, valuesAndSQLs = []) {
    const placeholders = []

    for (let i = 0, length = placeholderNum - this._columnIndexesToDelete.length; i < length; i++) {
      placeholders.push(this._options.placeholder)
    }

    for (const val of valuesAndSQLs) {
      placeholders.push(val && val.sql ? val.sql : this._options.placeholder)
    }

    return ['VALUES', '(', placeholders.join(', '), ')']
  }

  _getAnnotatedColumnIndexes(annotatedColumns) {
    annotatedColumns.insertAnnotatedColumns.forEach(col => {
      if (col.indexNo) {
        this._columnIndexesToDelete.push(col.indexNo)
      }
    })
    annotatedColumns.updateAnnotatedColumns.forEach(col => {
      if (col.indexNo) {
        this._columnIndexesToDelete.push(col.indexNo)
      }
    })
  }

  _getAnnotatedInsertColumnNames(annotatedColumns) {
    return annotatedColumns ? [...annotatedColumns.insertAnnotatedColumns.keys()] : []
  }

  _getAnnotatedInsertColumnValues(annotatedColumns, annotatedInsertColumnNames) {
    const res = {}
    res.values = []
    res.valuesAndSQLs = []

    if (!annotatedColumns) return res

    const columnsToBeChecked = annotatedInsertColumnNames || annotatedColumns.insertAnnotatedColumns.keys()

    for (const col of columnsToBeChecked) {
      const symbol = annotatedColumns.insertAnnotatedColumns.get(col).symbol
      const annotatedValue = this._options[symbol]
      if (!annotatedValue || !annotatedValue.sql) res.values.push(annotatedValue)
      res.valuesAndSQLs.push(annotatedValue)
    }

    return res
  }

  _spliceArray(values) {
    for (let i = this._columnIndexesToDelete.length - 1; i >= 0; i--) {
      values.splice(this._columnIndexesToDelete[i], 1)
    }
  }
}

module.exports = InsertBuilder
