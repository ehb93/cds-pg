/** @type <T> (target:T) => ({
  with <X,Y,Z> (x:X, y:Y, z:Z): ( T & X & Y & Z )
  with <X,Y> (x:X, y:Y): ( T & X & Y )
  with <X> (x:X): ( T & X )
}) */
const extend = (target) => ({
  with(...aspects) {
    const excludes = _excludes[typeof target] || {}
    for (let each of aspects) {
      for (let p of Reflect.ownKeys(each)) {
        if (p in excludes) continue
        define (target,p, describe(each,p))
      }
      if (is_class(target) && is_class(each)) {
        extend(target.prototype).with(each.prototype)
      }
    }
    return target
  },
})

const _excludes = {
  function: Object.assign(Object.create(null),{ name: 1, length: 2, arguments: 3, caller: 4, prototype: 5 }),
  object: Object.assign(Object.create(null),{ constructor: 1 }),
}

/** @type <T>(target:T) => T */
const lazify = (o) => {
  if (o.constructor === module.constructor) return lazify_module(o)
  for (let p of Reflect.ownKeys(o)) {
    const d = describe(o,p)
    if (is_lazy(d.value)) define (o,p,{
      set(v) { define (this,p,{value:v,__proto__:d}) },
      get() { return this[p] = d.value(p,this) },
      configurable: true,
    })
  }
  return o
}

const lazify_module = (module) => {
  extend(module).with({ set exports(all) {
    extend(module).with({ exports: lazify(all) })
  }})
  return (id) => (lazy) => module.require(id)
}

const is_lazy = (x) => typeof x === 'function' && /^\(?lazy[,)\t =]/.test(x)
const is_class = (x) => typeof x === 'function' && x.prototype && /^class\b/.test(x)
const describe = Reflect.getOwnPropertyDescriptor
const define = Reflect.defineProperty

module.exports = { extend, lazify, lazified:lazify }
