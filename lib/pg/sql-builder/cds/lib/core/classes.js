const { extend } = require('../lazy')

class any {

  constructor(...aspects) { Object.assign (this,...aspects) }
  set name(n) { this.set('name', n, false) }
  set kind(k) { this.set('kind', k, true) }
  get kind() { return this.set('kind', this.parent ? 'element' : 'type') }
  is (kind) { return this.kind === kind || kind === 'any' }
  valueOf() { return this.name }

  own (property) {
    const pd = Reflect.getOwnPropertyDescriptor (this, property)
    if (pd) return pd.value //|| pd.get(this)
  }

  set (property, value, enumerable = false) {
    Reflect.defineProperty (this, property, { value, enumerable, writable:1, configurable:1 })
    return value
  }
}

class type extends any {}
class action extends any {}
class context extends any {}
class service extends context {}

class array extends type { is(kind) { return kind === 'array' || super.is(kind) }}
class aspect extends type { is(kind) { return kind === 'aspect' || super.is(kind) }}
class struct extends aspect { is(kind) { return kind === 'struct' || super.is(kind) }}
class event extends aspect{}

/**
 * Export is a dictionary of all builtin classes
 */
module.exports = {

  any,
  type,
  array,
  aspect,
  struct,
  context,
  service,
  action,
  event,

  /**
   * Allows to mixin functions or properties to several equally named builtin classes
   * @example
   * cds.builtin.classes.mixin (
   *  	class any { foo(){} },
   *  	class entity { bar(){} }
   * )
   */
  mixin(...classes) { for (let each of classes) {
    const clazz = this[each.name]
    if (!clazz) throw new Error(`unknown class '${each.name}'`)
    extend(clazz).with(each)
  }},
}
