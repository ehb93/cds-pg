const Whereable = require('./Whereable')
const { parse } = require('../index')

module.exports = class UPDATE extends Whereable {

  static _api() {
    return Object.assign ((..._) => (new this).entity(..._), {
      entity: (..._) => (new this).entity(..._),
    })
  }

  entity (e, key) {
    this.UPDATE.entity = this._target_name4 (...arguments) // supporting tts
    if (key) this.byKey(key)
    return this
  }

  data (d) {
    this.UPDATE.data = d
    return this
  }

  set (...args) { // .set() is an alias for .with()
    return this.with (...args)
  }

  with (...args) {
    if (args.length === 0) return this

    // A tagged template string with a single expression, e.g. .with `my.stock -= 1`
    if (args[0].raw) {
      let [lhs,op,...rhs] = parse.CXL(...args).xpr || this._expected `${{args}} to contain expressions of form 'column = <expr>'`
      _add (this, lhs.ref.join('.'), op, ...rhs)
    }

    // Alternating expr fragment / values args, e.g. .with ('my.stock -=',1, 'lastOrder =', '$now')
    else if (args.length > 1) {
      for (let i = 0; i < args.length; ++i) {
        const [, col, op] = /\s*([\w.]+)\s*([%*+-]?=)/.exec(args[i])
        _add (this, col, op, { val: args[++i] })
      }
    }

    // A single string with comma-separated expressions, e.g. .with ('my.stock -= 1, lastOrder = $now')
    else if (typeof args[0] === 'string') {
      for (let each of _comma_separated_exprs(args[0])) {
        let [lhs,op,...rhs] = parse.expr(each).xpr || this._expected `${{args}} to contain expressions of form 'column = <expr>'`
        _add (this, lhs.ref.join('.'), op, ...rhs)
      }
    }

    // A column - value / expr object, e.g. .with ({ stock:{'-=':1}, lastOrder:{'=':'$now'} })
    else if (typeof args[0] === 'object') {
      const o = args[0]
      for (let col in o) {
        let op = '=', v = o[col]
        if (typeof v === 'object' && !(v === null || v.map || v.pipe || v instanceof Buffer || v instanceof Date)) {
          let o = Object.keys(v)[0] || this._expected `${{v}} to be an object with an operator as single key`
          if (o in operators) v = v[op=o]
        }
        _add (this, col, op, v && (v.val !== undefined || v.ref || v.xpr || v.func || v.SELECT) ? v : {val:v})
      }
    }

    return this
  }
}


const _add = (q, col, op, ...xpr) => {
  const {UPDATE} = q, v =
    op === '=' ? xpr.length === 1 ? xpr[0] : { xpr } :
    op in operators ? { xpr: [ {ref:[col]}, op[0], ...xpr] } :
    q._expected `${{op}} to be one of ${Object.keys(operators)}`
  if ('val' in v) (UPDATE.data || (UPDATE.data={}))[col] = v.val
  else (UPDATE.with || (UPDATE.with={}))[col] = v
}

const _comma_separated_exprs = (s) => {
  let all=[], start=0, scope=0, close, stack = [close]
  for (let i=0; i < s.length; ++i) {
    const c = s[i]
    if (c === "'") while (i < s.length) { if (s[++i] === "'") {
      if (s[i+1] === "'") ++i // double '' is a quoted '
      else break
    }}
    else if (c === ',' && scope === 0) { all.push(s.slice(start,i)); start = i+1 }
    else if (c === '(') { scope++; stack.unshift(close = ')') }
    else if (c === '[') { scope++; stack.unshift(close = ']') }
    else if (c === '{') { scope++; stack.unshift(close = '}') }
    else if (c === close) { scope--; stack.shift(); close = stack[0] }
  }
  all.push(s.slice(start))
  return all
}

const operators = { '=':1, '-=':2, '+=':2, '*=':2, '/=':2, '%=':2 }
