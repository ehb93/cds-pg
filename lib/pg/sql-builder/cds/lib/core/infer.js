const { entity } = require('./entities')

/** Lazily resolves a query's _target property */
module.exports = (q,defs) => {
  if (!q._target || q._target.kind !== 'entity') Object.defineProperty (q, '_target', {value:(
    q.SELECT ? _resolve (q.SELECT.from, defs) :
    q.INSERT ? _resolve (q.INSERT.into, defs) :
    q.UPDATE ? _resolve (q.UPDATE.entity, defs) :
    q.DELETE ? _resolve (q.DELETE.from, defs) :
    _resolve (undefined)
  ), configurable:true, writable:true })
  return q._target
}

const _resolve = (from, defs) => {
  if (!from || from.name) return from
  if (from.join || from.set) return //_unresolved()
  if (from.ref) {
    if (from.ref.length === 1) {
      from = from.ref[0]
      if (from.id) from = from.id
    } else {
      let target = {elements:defs}
      for (let each of from.ref) {
        const e = each.id || each
        const a = target.elements[e]; if (!a) return _unresolved (target.name +':'+e)
        target = defs [a.target || a.name]; if (!target) return _unresolved (a.target)
      }
      return target
    }
  }
  return defs[from] || _unresolved(from)
}

const _unresolved = (name) => {
  return { name, __proto__:entity.prototype, _unresolved:true }
}
