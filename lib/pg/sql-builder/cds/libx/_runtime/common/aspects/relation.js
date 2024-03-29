const { getOnCond } = require('../utils/generateOnCond')

let initializing = false

module.exports = class Relation {
  constructor(csn, path = []) {
    if (!initializing) throw new Error(`Do not new a relation, use 'Relation.to()' instead`)
    Object.defineProperty(this, 'csn', { get: () => csn })
    Object.defineProperty(this, 'path', {
      get: () => path,
      set: _ => {
        path = _
      }
    })
    if (csn.target) Object.defineProperty(this, 'target', { get: () => csn.target })
    initializing = false
  }

  static to(from, name) {
    initializing = true
    if (!name) return new Relation(from)
    return from._elements[name] && new Relation(from._elements[name], [...from.path, name])
  }

  _has(prop) {
    return Reflect.has(this, prop) && !this._elements[prop]
  }

  get _elements() {
    if (this.csn.elements) return this.csn.elements
    if (this.csn._target && this.csn._target.elements) return this.csn._target.elements
    // if (csn.targetAspect) relation.elements = model.definitions[csn.targetAspect].elements
    // if (csn.kind = 'type') relation.elements = model.definitions[csn.type].element
    return {}
  }

  join(fromAlias = '', toAlias = '') {
    return getOnCond(this.csn, this.path, { select: fromAlias, join: toAlias })
  }
}
