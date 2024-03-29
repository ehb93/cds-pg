const cds = require('../../cds')

const keywords = require('../../../../../cds-compiler/lib/base/keywords')
const { smartId } = require('../../../../../cds-compiler/lib/sql-identifier')

let _dialect

const _DEFAULT_RESERVED = new Set(['WHERE', 'GROUP', 'ORDER', 'BY', 'AT', 'NO', 'LIMIT'])
const _COMPILER_RESERVED = {
  hana: new Set(keywords.hana),
  sqlite: new Set(keywords.sqlite)
}
let _reserved = _DEFAULT_RESERVED

const _isTruthy = s => s
const _isQuoted = s => s.match(/^".*"$/)

const _slugify = s => s.replace(/\./g, '_')
const _smartId = s => smartId(_slugify(s), _dialect || 'plain')
const _smartElement = s => {
  if (s === '*' || _isQuoted(s)) return s
  const upper = s.toUpperCase()
  if (_reserved.has(upper)) return upper
  return _smartId(s)
}

module.exports = {
  plain: s => {
    // set _dialect and _reserved once cds.db.kind is set
    if (!_dialect && cds.db && cds.db.kind) {
      _dialect = cds.db.options.dialect || cds.db.kind
      _reserved = _COMPILER_RESERVED[_dialect] || _DEFAULT_RESERVED
    }

    // * or already quoted?
    if (s === '*' || _isQuoted(s)) return s

    // expr or space in name?
    // REVISIT: default behavior in cds^6?
    if (s.match(/\s/) && !cds.env.sql.spaced_columns) {
      return s.split(' ').filter(_isTruthy).map(_smartElement).join(' ')
    }

    return _smartId(s)
  },
  quoted: s => `"${s}"`,
  bracketed: s => `[${s}]`,
  'all-upper': s => `"${_slugify(s.toUpperCase())}"`,
  'all-lower': s => `"${_slugify(s.toLowerCase())}"`
}
