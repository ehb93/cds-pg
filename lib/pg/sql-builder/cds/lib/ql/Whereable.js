const { error } = require ('../index')
const cds = require('../index')
const parse = require('./parse')

class Whereable extends require('./Query') {

  where(...x) { return this._where (x,'and','where') }
  and(...x) {  return this._where (x,'and') }
  or(...x) { return this._where (x,'or') }
  _where (args, and_or, _clause) {
    let pred = predicate4(args, _clause)
    if (pred && pred.length > 0) {
      let _ = this[this.cmd]
      if (!_clause) _clause = (
        _.having ? 'having' :
        _.where ? 'where' :
        _.from && _.from.on ? 'on' :
        error (`Invalid attempt to call '${this.cmd}.${and_or}()' before a prior call to '${this.cmd}.where()'`)
      )
      if (_clause === 'on') _ = _.from
      let left = this._own(_clause,_)
      if (!left) {
        if (pred.includes('or')) Object.defineProperty(pred,'_includes_or__',{value:1})
        _[_clause] = pred
      } else {
        if (and_or === 'and') {
          if (left._includes_or__) left = [{xpr:left}]
          if (pred.includes('or')) pred = [{xpr:pred}]
        }
        _[_clause] = [ ...left, and_or, ...pred ]
      }
    }
    return this
  }

  byKey(key) {
    if (typeof key !== 'object') key = { [Object.keys(this._target.keys||{ID:1})[0]]: key }
    if (this.SELECT) this.SELECT.one = true
    if (cds.env.features.keys_into_where) return this.where(key)
    if (this.UPDATE) { this.UPDATE.entity = { ref: [{ id: this.UPDATE.entity, where: predicate4([key]) }] }; return this }
    if (this.SELECT) { this.SELECT.from.ref[this.SELECT.from.ref.length-1] = { id: this.SELECT.from.ref[this.SELECT.from.ref.length-1], where: predicate4([key]) }; return this }
    if (this.DELETE) { this.DELETE.from = { ref: [{ id: this.DELETE.from, where: predicate4([key]) }] }; return this }
    return this.where(key)
  }
}

const predicate4 = (args, _clause) => {
  if (args.length === 0) return; const x = args[0]
  if (x.raw) return parse.CXL(...args).xpr
  if (args.length === 1 && typeof x === 'object') {
    if (is_array(x)) return x
    if (is_cqn(x)) return args
    else return _object_predicate(args,_clause)
  }
  else return _fluid_predicate(args)
}

const _object_predicate = ([arg], _clause) => { // e.g. .where ({ID:4711, stock: {'>=':1})
  const pred = []
  for (const k in arg) {
    const x = arg[k]
    if (k === 'and') {
      if (x.or) pred.push('and', {xpr:predicate4([x],_clause)})
      else pred.push('and', ...predicate4([x],_clause))
      continue
    }
    if (k === 'or') {
      pred.push('or', ...predicate4([x],_clause))
      continue
    }
    if (k === 'exists') {
      pred.push(null, 'exists', ...predicate4([x],_clause))
      continue
    }
    else pred.push('and', parse.expr(k))
    if (!x || x==='*') pred.push('=', {val:x})
    else if (x.SELECT || x.list) pred.push('in', x)
    else if (is_array(x)) pred.push('in', {list:x.map(val)})
    else if (is_cqn(x)) pred.push('=', x)
    else if (x instanceof RegExp) pred.push('like', {val:x})
    else if (typeof x === 'object') for (let op in x) pred.push(op, val(x[op]))
    else if (_clause === 'on' && typeof x === 'string') pred.push('=', { ref: x.split('.') })
    else pred.push('=', {val:x})
  }
  return pred.slice(1)
}

const _fluid_predicate = (args) => { // e.g. .where ('ID=',4711, 'and stock >=',1)
  if (args.length === 3 && args[1] in operators) return [ ref(args[0]), args[1], val(args[2]) ] // REVISIT: Legacy!
  if (args.length % 2 === 0) args.push('')
  const expr = args.filter((_, i) => i % 2 === 0).join(' ? ')
  const vals = args.filter((_, i) => i % 2 === 1)
  const {xpr} = parse.expr(expr)
  ;(function _fill_in_vals_into (xpr) { xpr.forEach ((x,i) => {
    if (x.xpr) _fill_in_vals_into (x.xpr)
    if (x.param) xpr[i] = val(vals.shift())
  })})(xpr)
  return xpr
}

const ref = x => is_cqn(x) ? x : {ref:x.split('.')}
const val = x => !x ? {val:x} : is_array(x) ? {list:x.map(val)} : is_cqn(x) ? x : {val:x}
const is_cqn = x => x.val !== undefined || x.xpr || x.ref || x.list || x.func || x.SELECT
const is_array = Array.isArray
const operators = { '=':1, '<':2, '<=':2, '>':2, '>=':2, '!=':3, '<>':3, in:4, like:4, IN:4, LIKE:4 }

module.exports = Object.assign (Whereable, { predicate4, parse })
