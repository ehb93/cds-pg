const typeConversionMap = new Map()

typeConversionMap.set('cds.UUID', { type: 'NVARCHAR', length: 36 })
typeConversionMap.set('cds.Boolean', 'BOOLEAN')
typeConversionMap.set('cds.Integer', 'INTEGER')
typeConversionMap.set('cds.Integer64', 'BIGINT')
typeConversionMap.set('cds.Decimal', { type: 'DECIMAL' })
typeConversionMap.set('cds.DecimalFloat', { type: 'DECIMAL' })
typeConversionMap.set('cds.Double', 'DOUBLE')
typeConversionMap.set('cds.Date', 'DATE')
typeConversionMap.set('cds.Time', 'TIME')
typeConversionMap.set('cds.DateTime', 'SECONDDATE')
typeConversionMap.set('cds.Timestamp', 'TIMESTAMP')
typeConversionMap.set('cds.String', { type: 'NVARCHAR', length: 5000 })
typeConversionMap.set('cds.Binary', { type: 'VARBINARY', length: 1024 })
typeConversionMap.set('cds.LargeString', 'NCLOB')
typeConversionMap.set('cds.LargeBinary', 'BLOB')

/**
 * Maps cds type to database specific type. Falls back to given cds type if not found in database type map.
 *
 * @param element
 * @param csn
 * @param options
 * @private
 */
const convertDataType = (element, csn, options) => {
  const converted = options.typeConversion.get(element.type)

  if (!converted) {
    // no type in map
    const newType = csn.definitions[element.type]
    return newType ? convertDataType(newType, csn, options) : element.type
  }

  if (typeof converted === 'string') {
    return converted
  }

  if (converted.length) {
    return `${converted.type}(${element.length || converted.length})`
  }

  if (element.precision || converted.precision) {
    const precision = element.precision || converted.precision
    const scale = element.scale || converted.scale

    const args = `(${precision}${scale ? `, ${scale}` : ''})`
    return `${converted.type}${args}`
  }

  return converted.type
}

module.exports = { typeConversionMap, convertDataType }
