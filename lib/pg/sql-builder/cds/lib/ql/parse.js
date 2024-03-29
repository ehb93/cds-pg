// please keep all comments!

const cds = require('../index')
module.exports = {
  column:(x) => _simple(x) /* || _parse('column',x) */ || cds.parse.column(x),
  expr:(x) => _simple(x) /* || _parse('expr',x) */ || cds.parse.expr(x),
  CQL: (..._) => cds.parse.CQL (..._),
  CXL: (..._) => cds.parse.CXL (..._),
  cql: (..._) => cds.parse.cql (..._),
}

const _simple = (x) => {
  if (typeof x !== 'string') return {val:x}
  const t = /^\s*([\w.'?]+)(?:\s*([!?\\/:=\-+<~>]+|like)\s*([\w.'?]+))?\s*$/.exec(x); if (!t) return
  const [,lhs,op,rhs] = t
  return op ? {xpr:[_rv(lhs),op,_rv(rhs)]} : _rv(lhs)
}

const _rv = (x) => {
  if (x[0] === '?')  return { param: true, ref: x }
  if (x[0] === "'")  return { val: x.slice(1,-1).replace(/''/g, "'") }
  if (x === 'null')  return { val: null }
  if (x === 'true')  return { val: true }
  if (x === 'false') return { val: false }
  if (!isNaN(x))     return { val: Number(x) }
  else               return { ref: x.split('.') }
}

// const _parse = (startRule,x) => {
//   try {
//     return parser.parse(x,{startRule})
//     // } catch (e) { e.message += ' in: \n' + x;  throw e }
//   }  catch {/* ignored */}
// }
// const parser = require('./parser')
