const cds = require('../../cds')

const { ensureNoDraftsSuffix } = require('../../common/utils/draft.js')

const _convertDateTimeElement = (value, element) => {
  value = new Date(value).toISOString()
  if (element.type === 'cds.DateTime') value = value.replace(/\.\d\d\d/, '')
  return value
}

const _isToConvert = type => type === 'cds.DateTime' || type === 'cds.Timestamp'

const _convertDateTimeEntry = (entry, element, model) => {
  const { name, type, _target } = element
  if (!(entry[name] === undefined || entry[name] === null)) {
    if (_isToConvert(type) && entry[name] !== '$now') {
      entry[name] = _convertDateTimeElement(entry[name], element)
    }

    if (element.isComposition) {
      _normalize({ target: _target, data: entry[name] }, model)
    }
  }
}

const _convertEntries = (data, elements, model) => {
  // check all entries
  for (const entry of data) {
    for (const column in entry) {
      // skip unknown columns
      if (!elements[column]) continue
      _convertDateTimeEntry(entry, elements[column], model)
    }
  }
}

const _convertColumns = (data, elements, model, queryColumns) => {
  // check all columns
  for (let i = 0, length = queryColumns.length; i < length; i++) {
    const col = queryColumns[i]
    if (elements[col] && _isToConvert(elements[col].type)) {
      const dataArray = Array.isArray(data[0]) ? data : [data]
      for (const d of dataArray) {
        const elementValue = d[i]
        if (elementValue != null && elementValue !== '$now') {
          d[i] = _convertDateTimeElement(elementValue, elements[col])
        }
      }
    }
  }
}

/**
 * This method finds and converts the cds.DateTime and cds.Timestamp types to UTC.
 * HANA stores date time values without timezone.
 * Compiler v2 uses TIMESTAMP_TEXT (instead of TIMESTAMP) on SQLite.
 *
 * @param req - cds.Request
 * @param model
 * @returns {undefined}
 */
const _normalize = function (req, model) {
  if (
    !req.data ||
    (Array.isArray(req.data) && req.data.length === 0) ||
    (typeof req.data === 'object' && Object.keys(req.data).length === 0)
  ) {
    // > nothing to convert (e.g., in case of insert as select)
    return
  }

  // for recursion
  if (!model) model = this.model
  if (!model) return

  let elements = req.target.elements
  if (req.target._unresolved) {
    const activeName = req.target.name && ensureNoDraftsSuffix(req.target.name)
    if (!model.definitions[activeName]) return

    elements = model.definitions[activeName].elements
  }

  const data = Array.isArray(req.data) ? req.data : [req.data]
  if (req.query && req.query.INSERT && req.query.INSERT.columns) {
    if (!cds.env.features.preserve_timestamps) {
      _convertColumns(data, elements, model, req.query.INSERT.columns)
    }
  } else {
    _convertEntries(data, elements, model)
  }
}

module.exports = _normalize
