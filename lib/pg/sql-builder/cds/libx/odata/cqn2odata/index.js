const { formatVal } = require('../utils')

const OPERATORS = {
  '=': 'eq',
  '!=': 'ne',
  '<>': 'ne',
  '<': 'lt',
  '>': 'gt',
  '<=': 'le',
  '>=': 'ge'
}

const LAMBDA_VARIABLE = 'd'

const needArrayProps = Object.fromEntries(
  ['where', 'search', 'xpr', 'columns', 'orderBy', 'ref', 'args'].map(propName => [
    propName,
    cur => Array.isArray(cur) && (cur.length !== 0 || propName === 'expand' || propName === 'ref')
  ])
)

const validators = {
  SELECT: SELECT => SELECT && SELECT.from,
  INSERT: INSERT => {
    if (INSERT.rows || INSERT.values) {
      throw new Error('Feature not supported: INSERT statement with .values or .rows')
    }
    return INSERT && INSERT.into
  },
  UPDATE: UPDATE => UPDATE && UPDATE.entity,
  DELETE: DELETE => DELETE && DELETE.from,
  from: any => (typeof any === 'string' && any) || any.ref,
  into: any => (typeof any === 'string' && any) || any.ref,
  entity: any => (typeof any === 'string' && any) || any.ref,
  id: id => typeof id === 'string',
  val: val => typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' || val === null,
  count: count => typeof count === 'boolean',
  limit: limit => limit && (limit.rows || limit.offset),
  rows: rows => rows && rows.val && typeof rows.val === 'number',
  offset: offset => offset && offset.val && typeof offset.val === 'number',
  sort: sort => sort === 'asc' || sort === 'desc',
  func: func => typeof func === 'string',
  one: count => typeof count === 'boolean',
  as: any => typeof any === 'string',
  expand: any => any === '*' || Array.isArray(any),
  ...needArrayProps
}

// strip service & namespace prefixes
const _entityUrl = path => path.match(/^(\w*\.)*(.*)$/)[2]

function getProp(obj, propName) {
  const validate = validators[propName]
  const isValid = validate && validate(obj[propName])
  if (isValid) {
    return obj[propName]
  }

  throw new Error(`Invalid property '${propName}' provided`)
}

function hasValidProps(obj, ...names) {
  for (const propName of names) {
    const validate = validators[propName]
    const isValid = validate && validate(obj[propName])

    if (!isValid) {
      return false
    }
  }

  return true
}

function _args(args) {
  const res = []

  for (const cur of args) {
    if (typeof cur === 'string') {
      res.push(cur)
      continue
    }

    if (hasValidProps(cur, 'func', 'args')) {
      res.push(`${cur.func}(${_args(cur.args)})`)
    }

    if (hasValidProps(cur, 'ref')) {
      res.push(cur.ref.join('/'))
    }

    if (hasValidProps(cur, 'val')) {
      res.push(formatVal(cur.val))
    }
  }

  return res.join(',')
}

const _in = (column, /* in */ collection, target, kind, isLambda) => {
  const ref = isLambda ? [LAMBDA_VARIABLE, ...column.ref].join('/') : column.ref.join('/')
  // { val: [ 1, 2, 3 ] } or { list: [ { val: 1}, { val: 2}, { val: 3} ] }
  const values = collection.val || collection.list
  if (values && values.length) {
    // REVISIT: what about OData `in` operator?
    const expressions = values.map(value => `${ref} eq ${_format(value, ref, target, kind, isLambda)}`)
    return expressions.join(' or ')
  }
}

const _odataV2Func = (func, args) => {
  switch (func) {
    case 'contains':
      // this doesn't support the contains signature with two collections as args, introduced in odata v4.01
      return `substringof(${_args([args[1], args[0]])})`
    default:
      return `${func}(${_args(args)})`
  }
}

const _format = (cur, element, target, kind, isLambda) => {
  if (typeof cur !== 'object') return formatVal(cur, element, target, kind)
  if (hasValidProps(cur, 'ref')) return isLambda ? [LAMBDA_VARIABLE, ...cur.ref].join('/') : cur.ref.join('/')
  if (hasValidProps(cur, 'val')) return formatVal(cur.val, element, target, kind)
  if (hasValidProps(cur, 'xpr')) return `(${_xpr(cur.xpr, target, kind, isLambda)})`
  // REVISIT: How to detect the types for all functions?
  if (hasValidProps(cur, 'func', 'args')) {
    return kind === 'odata-v2' ? _odataV2Func(cur.func, cur.args) : `${cur.func}(${_args(cur.args)})`
  }
}

const _isLambda = (cur, next) => {
  if (cur !== 'exists') return
  const last = Array.isArray(next.ref) && next.ref.slice(-1)[0]
  return last && hasValidProps(last, 'id')
}

function _xpr(expr, target, kind, isLambda) {
  const res = []
  const openBrackets = []

  for (let i = 0; i < expr.length; i++) {
    const cur = expr[i]

    if (typeof cur === 'string') {
      // REVISIT: will it be fixed with a new odata2cqn and follow-ups?
      const isOrIsNotValue = cur.match(/^is\s(not)?\s*(.+)$/)

      if (cur === '(') {
        openBrackets.push(res.length)
        continue
      } else if (cur === ')') {
        const startIdx = openBrackets.pop()
        res[startIdx] = `(${res[startIdx]}`
        res[res.length - 1] = `${res[res.length - 1]})`
      } else if (isOrIsNotValue) {
        // REVISIT: "is" only used for null values?
        const operator = isOrIsNotValue[1] /* 'is not' */ ? 'ne' : 'eq'
        res.push(...[operator, formatVal(isOrIsNotValue[2])])
      } else if (cur === 'between') {
        // ref gt low.val and ref lt high.val
        const between = [expr[i - 1], 'gt', expr[i + 1], 'and', expr[i - 1], 'lt', expr[i + 3]]
        // cleanup previous ref
        res.pop()
        res.push(`(${_xpr(between, target, kind, isLambda)})`)
        i += 3
      } else if (cur === 'in') {
        const inExpr = _in(expr[i - 1], expr[i + 1], target, kind, isLambda)
        // cleanup previous ref
        res.pop()
        // when sending a where clause with "col in []" we currently ignore the where clause
        // analog to interpretation for sql generation
        // double check if this is the intended behavior
        if (inExpr) res.push(`(${inExpr})`)
        i += 1
      } else if (_isLambda(cur, expr[i + 1])) {
        const { where, id } = expr[i + 1].ref.slice(-1)[0]
        const nav = [...expr[i + 1].ref.slice(0, -1), id].join('/')
        if (!where) res.push(`${nav}/any()`)
        else res.push(`${nav}/any(${LAMBDA_VARIABLE}:${_xpr(where, target, kind, true)})`)
        i++
      } else {
        res.push(OPERATORS[cur] || cur.toLowerCase())
      }
    } else {
      const formatted = _format(cur, res[res.length - 2], target, kind, isLambda)
      if (formatted !== undefined) res.push(formatted)
    }
  }

  return res.join(' ')
}

const _keysOfWhere = (where, kind, target) => {
  if (!Array.isArray(where) || !where.length) return ''

  if (kind === 'rest') {
    const keys = where.length === 1 ? getProp(where[0], 'val') : getProp(where[2], 'val')
    return `/${keys}`
  }

  const res = []
  for (const cur of where) {
    if (hasValidProps(cur, 'ref')) {
      res.push(cur.ref.join('/'))
    } else if (hasValidProps(cur, 'val')) {
      // find previous ref
      const element = res[res.length - 2]
      res.push(formatVal(cur.val, element, target, kind))
    } else if (cur === 'and') {
      res.push(',')
    } else {
      res.push(cur)
    }
  }

  return `(${res.join('')})`
}

function _getQueryTarget(entity, propOrEntity, model) {
  if (!entity) {
    // if there is no entity yet, we need to look it up in the model
    return model.definitions[propOrEntity]
  }

  if (entity && entity.elements[propOrEntity]) {
    // structured type
    if (entity.elements[propOrEntity].elements) return entity.elements[propOrEntity]
    // assoc or comp
    return entity && entity.elements[propOrEntity] && model.definitions[entity.elements[propOrEntity].target]
  }
}

function _from(from, kind, model) {
  if (typeof from === 'string') {
    return { url: _entityUrl(from), queryTarget: model && model.definitions[from] }
  }

  let ref = getProp(from, 'ref')
  ref = (Array.isArray(ref) && ref) || [ref]

  const path = []
  let queryTarget

  for (const curRef of ref) {
    if (hasValidProps(curRef, 'where', 'id')) {
      const { where, id } = curRef
      queryTarget = model && _getQueryTarget(queryTarget, id, model)
      const keys = _keysOfWhere(where, kind, queryTarget)
      path.push(`${id}${keys}`)
    } else if (typeof curRef === 'string') {
      queryTarget = model && _getQueryTarget(queryTarget, curRef, model)
      path.push(curRef)
    }
  }

  return { url: _entityUrl(path.join('/')), queryTarget }
}

const _parseColumnsV2 = (columns, prefix = []) => {
  const select = []
  const expand = []

  for (const column of columns) {
    if (hasValidProps(column, 'ref')) {
      const refName = [...prefix, ...column.ref].join('/')

      if (hasValidProps(column, 'expand')) {
        const parsed = _parseColumnsV2(column.expand, [refName])
        expand.push(refName, ...parsed.expand)
        select.push(...parsed.select)
      } else {
        select.push(refName)
      }
    }

    if (column === '*') {
      select.push(`${prefix.join('/')}/*`)
    }
  }

  return { select, expand }
}

const _parseColumns = columns => {
  const select = []
  const expand = []

  for (const column of columns) {
    if (hasValidProps(column, 'ref')) {
      let refName = column.ref.join('/')
      if (hasValidProps(column, 'expand')) {
        // REVISIT: incomplete, see test Foo?$expand=invoices($count=true;$expand=item($search="some"))
        if (!columns.some(c => !c.expand)) select.push(refName)
        const curOptions = getOptions(column).join(';')
        refName += curOptions ? `(${curOptions})` : ''
        expand.push(refName)
        // REVISIT: expand to one & limit in options
        // > const expanded = $expand(col.expand)
        // > expand.push(expanded ? `${ref}(${expanded})` : ref)
        // see xtest('READ with expand'... in custom handler test
      } else {
        select.push(refName)
      }
    } else if (hasValidProps(column, 'expand') && column.expand === '*') {
      expand.push('*')
    }
    if (column === '*') {
      select.push(column)
    }
  }
  // omit '$select' option if contains only '*'
  if (select.length === 1 && (select[0] === '*' || (select[0].ref && select[0].ref[0] === '*'))) {
    select.pop()
  }
  return { select, expand }
}

function $select(columns, kind, separator = '&') {
  const { select, expand } = kind === 'odata-v2' ? _parseColumnsV2(columns) : _parseColumns(columns)
  const res = []
  if (expand.length) res.unshift('$expand=' + expand.join(','))
  if (select.length) res.unshift('$select=' + select.join(','))
  return res.join(separator)
}
const $expand = columns => $select(columns, 'odata', ';')

function $count(count, kind) {
  if (count !== true) return ''
  if (kind === 'odata-v2') return '$inlinecount=allpages'
  return '$count=true'
}

function $limit(limit) {
  const res = []

  if (hasValidProps(limit, 'rows')) {
    res.push('$top=' + getProp(limit.rows, 'val'))
  }

  if (hasValidProps(limit, 'offset')) {
    res.push('$skip=' + getProp(limit.offset, 'val'))
  }

  return res
}

function $orderBy(orderBy) {
  const res = []

  for (const cur of orderBy) {
    if (hasValidProps(cur, 'ref', 'sort')) {
      res.push(cur.ref.join('/') + ' ' + cur.sort)
      continue
    }

    if (hasValidProps(cur, 'ref')) {
      res.push(cur.ref.join('/'))
    }
  }

  return '$orderby=' + res.join(',')
}

function parseSearch(search) {
  const res = []

  for (const cur of search) {
    if (hasValidProps(cur, 'xpr')) {
      // search term must not be formatted
      res.push('(', ...parseSearch(cur.xpr), ')')
    }

    if (hasValidProps(cur, 'val')) {
      // search term must not be formatted
      res.push(`"${cur.val}"`)
    }

    if (typeof cur === 'string') {
      const upperCur = cur.toUpperCase()

      if (upperCur === 'OR' || upperCur === 'AND' || upperCur === 'NOT') {
        res.push(upperCur)
      }
    }
  }

  return res
}

function $search(search, kind) {
  const expr = parseSearch(search).join(' ').replace('( ', '(').replace(' )', ')')

  if (expr) {
    // odata-v2 may support custom query option "search"
    if (kind === 'odata-v2') return `search=${expr}`
    // kind === 'odata-v4'
    return `$search=${expr}`
  }

  return ''
}

function $where(where, target, kind) {
  const expr = _xpr(where, target, kind)
  return expr ? `$filter=${expr}` : ''
}

function $one(one, url, kind) {
  return one && !_isOdataUrlWithKeys(url, kind) && '$top=1'
}

// eslint-disable-next-line no-useless-escape
const _isOdataUrlWithKeys = (url, kind) => kind !== 'rest' && /^[\w\.]+\(.*\)/.test(url)

const parsers = {
  columns: (cqnPart, url, kind, target, isCount) => !isCount && $select(cqnPart, kind),
  expand: (cqnPart, url, kind, target, isCount) => !isCount && $expand(cqnPart),
  // eslint-disable-next-line no-unused-vars
  where: (cqnPart, url, kind, target, isCount) => $where(cqnPart, target, kind),
  // eslint-disable-next-line no-unused-vars
  search: (cqnPart, url, kind, target, isCount) => $search(cqnPart, kind),
  orderBy: (cqnPart, url, kind, target, isCount) => !isCount && $orderBy(cqnPart),
  count: (cqnPart, url, kind, target, isCount) => !isCount && $count(cqnPart, kind),
  limit: (cqnPart, url, kind, target, isCount) => !isCount && $limit(cqnPart),
  one: (cqnPart, url, kind, target, isCount) => !isCount && $one(cqnPart, url, kind)
}

function getOptions(cqnPart, url, kind, target, isCount) {
  const options = []

  for (const opt in cqnPart) {
    const cqnPartOpt = cqnPart[opt]
    if (cqnPartOpt === undefined) continue
    if (!hasValidProps(cqnPart, opt)) throw new Error(`Feature not supported: SELECT statement with .${opt}`)
    const parser = parsers[opt]
    const parsed = parser && parser(cqnPartOpt, url, kind, target, isCount)
    const parsedOpts = (Array.isArray(parsed) && parsed) || (parsed && [parsed]) || []
    options.push(...parsedOpts)
  }

  return options
}

const _isCount = SELECT => {
  if (SELECT.columns) {
    const columns = getProp(SELECT, 'columns')
    return columns.some(c => c.func === 'count' && c.as === '$count')
  }
  return false
}

const _select = (cqn, kind, model) => {
  const SELECT = getProp(cqn, 'SELECT')
  const { url, queryTarget } = _from(getProp(SELECT, 'from'), kind, model)
  const isCount = _isCount(SELECT)
  const queryOptions = getOptions(SELECT, url, kind, queryTarget, isCount).join('&')
  const path = `${url}${isCount ? '/$count' : ''}${queryOptions ? `?${queryOptions}` : ''}`
  return { method: 'GET', path }
}

const _insert = (cqn, kind, model) => {
  const INSERT = getProp(cqn, 'INSERT')
  const { url } = _from(getProp(INSERT, 'into'), kind, model)
  const body = Array.isArray(INSERT.entries) && INSERT.entries.length === 1 ? INSERT.entries[0] : INSERT.entries
  return { method: 'POST', path: url, body }
}

const _copyData = data => {
  // only works on flat structures
  const copied = {}
  for (const property in data) {
    copied[property] =
      data[property] != null && typeof data[property] === 'object' && 'val' in data[property]
        ? data[property].val
        : data[property]
  }
  return copied
}

const _update = (cqn, kind, model) => {
  const UPDATE = getProp(cqn, 'UPDATE')
  const { url, queryTarget } = _from(getProp(UPDATE, 'entity'), kind, model)
  let keys = ''

  if (UPDATE.where) {
    if (_isOdataUrlWithKeys(url, kind)) {
      throw new Error('Cannot generate URL for UPDATE CQN. Conflicting .from and .where')
    }
    keys = _keysOfWhere(getProp(UPDATE, 'where'), kind, queryTarget)
  }

  // TODO: support for .set as well
  const body = _copyData(UPDATE.data)
  return { method: 'PATCH', path: `${url}${keys}`, body }
}

const _delete = (cqn, kind, model) => {
  const DELETE = getProp(cqn, 'DELETE')
  const { url, queryTarget } = _from(getProp(DELETE, 'from'), kind, model)
  let keys = ''

  if (DELETE.where) {
    if (_isOdataUrlWithKeys(url, kind)) {
      throw new Error('Cannot generate URL for DELETE CQN. Conflicting .from and .where')
    }

    keys = _keysOfWhere(getProp(DELETE, 'where'), kind, queryTarget)
  }

  return { method: 'DELETE', path: `${url}${keys}` }
}

function cqn2odata(cqn, kind, model) {
  if (cqn.SELECT) return _select(cqn, kind, model)
  if (cqn.INSERT) return _insert(cqn, kind, model)
  if (cqn.UPDATE) return _update(cqn, kind, model)
  if (cqn.DELETE) return _delete(cqn, kind, model)

  throw new Error('Unknown CQN object cannot be translated to URL: ' + JSON.stringify(cqn))
}

module.exports = cqn2odata
