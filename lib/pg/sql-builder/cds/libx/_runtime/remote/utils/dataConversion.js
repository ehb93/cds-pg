// Code adopted from @sap/cds-odata-v2-adapter-proxy
// https://www.w3.org/TR/xmlschema11-2/#nt-duDTFrag
const DurationRegex = /^P(?:(\d)Y)?(?:(\d{1,2})M)?(?:(\d{1,2})D)?T(?:(\d{1,2})H)?(?:(\d{2})M)?(?:(\d{2}(?:\.\d+)?)S)?$/i
const DataTypeOData = {
  Binary: 'cds.Binary',
  Boolean: 'cds.Boolean',
  Byte: 'cds.Binary',
  DateTime: 'cds.DateTime',
  DateTimeOffset: 'cds.Timestamp',
  Decimal: 'cds.Decimal',
  Double: 'cds.Double',
  Single: 'cds.Double',
  Guid: 'cds.UUID',
  Int16: 'cds.Integer',
  Int32: 'cds.Integer',
  Int64: 'cds.Integer64',
  SByte: 'cds.Integer',
  String: 'cds.String',
  Date: 'cds.Date',
  Time: 'cds.TimeOfDay'
}

const _convertData = (data, target, ieee754Compatible) => {
  if (Array.isArray(data)) {
    return data.map(record => _getConvertRecordFn(target, ieee754Compatible)(record))
  }

  return _getConvertRecordFn(target, ieee754Compatible)(data)
}

const _getConvertRecordFn = (target, ieee754Compatible) => record => {
  for (const key in record) {
    if (key === '__metadata') continue

    const element = target.elements[key]
    if (!element) continue

    const recordValue = record[key]
    const type = _elementType(element)
    const value = (recordValue && recordValue.results) || recordValue

    if (value && (element.isAssociation || Array.isArray(value))) {
      record[key] = _convertData(value, element._target, ieee754Compatible)
    } else {
      record[key] = _convertValue(value, type, ieee754Compatible)
    }
  }

  return record
}

// eslint-disable-next-line complexity
const _convertValue = (value, type, ieee754Compatible) => {
  if (value == null) {
    return value
  }

  if (['cds.Boolean'].includes(type)) {
    if (value === 'true') {
      value = true
    } else if (value === 'false') {
      value = false
    }
  } else if (['cds.Integer'].includes(type)) {
    value = parseInt(value, 10)
  } else if (['cds.Decimal', 'cds.Integer64', 'cds.DecimalFloat'].includes(type)) {
    value = ieee754Compatible ? `${value}` : parseFloat(value)
  } else if (['cds.Double'].includes(type)) {
    value = parseFloat(value)
  } else if (['cds.Time'].includes(type)) {
    const match = value.match(DurationRegex)

    if (match) {
      value = `${match[4] || '00'}:${match[5] || '00'}:${match[6] || '00'}`
    }
  } else if (['cds.Date', 'cds.DateTime', 'cds.Timestamp'].includes(type)) {
    const match = value.match(/\/Date\((.*)\)\//)
    const ticksAndOffset = match && match.pop()

    if (ticksAndOffset) {
      value = new Date(_calculateTicksOffsetSum(ticksAndOffset)).toISOString() // always UTC
    }

    if (['cds.DateTime'].includes(type)) {
      value = value.slice(0, 19) + 'Z' // Cut millis
    } else if (['cds.Date'].includes(type)) {
      value = value.slice(0, 10) // Cut time
    }
  }

  return value
}

const _calculateTicksOffsetSum = text => {
  return (text.replace(/\s/g, '').match(/[+-]?([0-9]+)/g) || []).reduce((sum, value, index) => {
    return sum + parseFloat(value) * (index === 0 ? 1 : 60 * 1000) // ticks are milliseconds (0), offset are minutes (1)
  }, 0)
}

const _elementType = element => {
  let type

  if (element) {
    type = element.type

    if (element['@odata.Type']) {
      const odataType = element['@odata.Type'].match(/\w+$/)
      type = (odataType && DataTypeOData[odataType[0]]) || type
    }

    if (!type && element.items && element.items.type) {
      type = element.items.type
    }
  }

  return type
}

const convertV2ResponseData = (data, target, ieee754Compatible) => {
  if (!target || !target.elements) return data
  return _convertData(data, target, ieee754Compatible)
}

module.exports = {
  convertV2ResponseData
}
