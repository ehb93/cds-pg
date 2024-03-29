const cds = require('../../../cds')
// requesting logger without module on purpose!
const LOG = cds.log()

const { DRAFT_COLUMNS_UNION } = require('../../../common/constants/draft')

/**
 * This method gets all columns for an entity.
 * It includes the generated foreign keys from managed associations, structured elements and complex and custom types.
 * As well, it provides the annotations starting with '@' for each column.
 *
 * @param {import('@sap/cds-compiler/lib/api/main').CSN} entity - the csn entity
 * @param {object} [options]
 * @param [options.onlyNames=false] - decides if the column name or the csn representation of the column should be returned
 * @param [options.filterDraft=false] - indicates whether the draft columns should be filtered if the entity is draft enabled
 * @param [options.removeIgnore=false]
 * @param [options.filterVirtual=false]
 * @returns {Array<object>} - array of columns
 */
const getColumns = (entity, { onlyNames = false, removeIgnore = false, filterDraft = true, filterVirtual = false }) => {
  const skipDraft = filterDraft && entity._isDraftEnabled
  const columns = []
  const elements = entity.elements

  for (const each in elements) {
    const element = elements[each]
    if (element.isAssociation) continue
    if (filterVirtual && element.virtual) continue
    if (removeIgnore && element['@cds.api.ignore']) continue
    if (skipDraft && DRAFT_COLUMNS_UNION.includes(each)) continue
    columns.push(onlyNames ? each : element)
  }

  return columns
}

const getSearchableColumns = entity => {
  const columnsOptions = { removeIgnore: true, filterVirtual: true }
  const columns = getColumns(entity, columnsOptions)
  const cdsSearchTerm = '@cds.search'
  const cdsSearchKeys = Object.keys(entity).filter(key => key.startsWith(cdsSearchTerm))
  const cdsSearchColumnMap = new Map()
  let atLeastOneColumnIsSearchable = false

  // build a map of columns annotated with the @cds.search annotation
  for (const key of cdsSearchKeys) {
    const columnName = key.split(cdsSearchTerm + '.').pop()

    // REVISIT: for now, exclude search using path expression, as deep search is not currently
    // supported
    if (columnName.includes('.')) {
      continue
    }

    const annotationKey = cdsSearchTerm + '.' + columnName
    const annotationValue = entity[annotationKey]
    if (annotationValue) atLeastOneColumnIsSearchable = true
    cdsSearchColumnMap.set(columnName, annotationValue)
  }

  // For performance reasons, by default, only elements typed as strings are searchable unless
  // the @cds.search annotation is specified.
  const defaultSearchableType = 'cds.String'
  const searchableColumns = columns.filter(column => {
    const annotatedColumnValue = cdsSearchColumnMap.get(column.name)

    // A column is searchable if one of the following conditions evaluates to true.
    //
    // The @cds.search annotation is provided, and the column is annotated as searchable, e.g.:
    // @cds.search { column1: true } or just @cds.search { column1 }
    if (annotatedColumnValue) return true

    // If at least one column is explicitly annotated as searchable, e.g.:
    // @cds.search { column1: true } or just @cds.search { column1 }
    // and it is not the current column name, then it must be excluded from the search
    if (atLeastOneColumnIsSearchable) return false

    // - The @cds.search annotation is provided, the column name is not included, and the column
    // is typed as string.
    // - The @cds.search annotation is not provided, and the column is typed as string
    return annotatedColumnValue === undefined && column.type === defaultSearchableType
  })

  // if the @cds.search annotation is provided -->
  // Early return to ignore the interpretation of the @Search.defaultSearchElement
  // annotation when an entity is annotated with the @cds.search annotation.
  // The @cds.search annotation overrules the @Search.defaultSearchElement annotation.
  if (cdsSearchKeys.length > 0) {
    return searchableColumns.map(column => column.name)
  }

  // REVISIT: deprecated behavior => remove interpretation of the @Search.defaultSearchElement
  // annotation after grace period
  //
  // For performance reasons, by default, only elements typed as strings are searchable unless
  // the @cds.search annotation is specified, which at this point, we know that the @cds.search
  // annotation is not specified.
  const defaultSearchElementTerm = '@Search.defaultSearchElement'
  const defaultSearchFilteredColumns = searchableColumns.filter(column => column[defaultSearchElementTerm])

  if (defaultSearchFilteredColumns.length > 0) {
    if (!cds._deprecationWarningForDefaultSearchElement) {
      LOG._warn &&
        LOG.warn(
          'Annotation "@Search.defaultSearchElement" is deprecated and will be removed in an upcoming release. Use "@cds.search" instead.'
        )
      cds._deprecationWarningForDefaultSearchElement = true
    }

    return defaultSearchFilteredColumns.map(column => column.name)
  }

  return searchableColumns.map(column => column.name)
}

/**
 * @returns {import('../../../types/api').ColumnRefs}
 */
const computeColumnsToBeSearched = (cqn, entity = { _searchableColumns: [] }) => {
  // if there is a group by clause, only columns in it may be searched
  let toBeSearched = [...entity._searchableColumns]
  if (cqn.SELECT.groupBy) toBeSearched = toBeSearched.filter(tbs => cqn.SELECT.groupBy.some(gb => gb.ref[0] === tbs))
  toBeSearched = toBeSearched.map(c => ({ ref: [c] }))

  // add aggregations
  cqn.SELECT.columns &&
    cqn.SELECT.columns.forEach(column => {
      if (column.func) {
        // exclude $count by SELECT of number of Items in a Collection
        if (
          cqn.SELECT.columns.length === 1 &&
          column.func === 'count' &&
          (column.as === '_counted_' || column.as === '$count')
        )
          return
        toBeSearched.push(column)
        return
      }

      const columnRef = column.ref
      if (columnRef) {
        const columnName = columnRef[columnRef.length - 1]
        const csnColumn = entity.elements[columnName]
        if (!csnColumn) toBeSearched.push({ ref: [columnName] })
      }
    })

  return toBeSearched
}

module.exports = {
  getColumns,
  getSearchableColumns,
  computeColumnsToBeSearched
}
