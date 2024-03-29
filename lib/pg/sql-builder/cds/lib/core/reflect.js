const { types, classes:{ service, entity, action, event, any, struct, array, context, annotation } } = require('.')
const _kinds = { annotation, context, service, action, event, entity, view:entity }
const _minified = Symbol('minified')

class LinkedCSN extends any {

  constructor(x) {
    const defs = x.definitions; for (let d in defs) _link (defs[d],d)
    function _link (d, name, parent, _kind) {
      if (name)     _set (d,'name', name)
      if (parent) { _set (d,'parent', parent); if (!d.kind) _set (d,'kind', _kind || 'element') }
      if (d.kind === 'service') { for (let e in defs) if (e.startsWith(name+'.')) _set (defs[e],'_service',d) }
      else if (d.target)          _set (d,'_target', _target(d.target) || _link (d.target,name,d))
      else if (d.projection)      _set (d,'query', {SELECT:d.projection})
      else if (d.returns)         _link (d.returns)
      else if (d.items)           _link (d.items)
      for (let e in d.elements)   _link (d.elements[e],e,d)
      for (let a in d.actions)    _link (d.actions[a],a,d,'action')
      for (let p in d.params)     _link (d.params[p],p,d,'param')
      let p = (                   //> determine the definition's prototype ...
        d.type            ? _typeof (d.type) || _resolve (d.type) :
        d.query           ? _infer (d.query, defs) || _not_inferred :
        d.kind in _kinds  ? _kinds[d.kind].prototype :
        d.elements        ? struct.prototype :
        d.items           ? array.prototype :
        /* else: */         any.prototype
      )
      if (p.key && !d.key && d.kind === 'element') Object.defineProperty (d,'key',{value:undefined})  //> don't propagate .key
      if (d.elements && d.elements.localized) Object.defineProperty (d,'texts',{value: defs [d.elements.localized.target] })
      try { return Object.setPrototypeOf(d,p) }            //> link d to resolved proto
      catch(e) {                                          //> cyclic proto error
        let msg = d.name; for (; p && p.name; p = p.__proto__) msg += ' > '+p.name
        let $ = d.$location; if ($) msg += `\n    at ${$.file}:${$.line}:${$.col}`
        e.message += `: ${msg}`; throw e
      }
    }
    function _resolve(x) { return defs[x] || _builtin(x) || (defs[x] = _unresolved(x)) }
    function _target(x) { return typeof x === 'string' && _resolve(x) }
    function _typeof({ref}) { if (ref) {
      let i=0, n=ref.length, t=defs[ref[0]]
      for (;;) {
        if (++i === n) return t
        if (t.target) t = defs[t.target]
        if (t.elements) t = t.elements[ref[i]]
        if (!t) return
      }
    }}
    return Object.setPrototypeOf (x, new.target.prototype)
  }

  minified (skip = global.cds.env.features.skip_unused) {
    if (!skip) return this
    if (this[_minified]) return this; else _set (this,_minified,true)
    const csn = this, all = csn.definitions, reached = new Set
    const roots = skip === 'all' ? this.services : this.each(_root)
    for (let each of roots) _visit (each)
    function _visit (d) {
      if (reached.has(d)) return; else reached.add(d)
      if (d.kind === 'service') for (let e of csn.childrenOf(d)) _visit(e)
      if (d.includes)  d.includes.forEach(i => _visit(all[i]))  // Note: with delete d.includes, redirects in AFC broke
      if (d.query)     d.query._target && _visit (d.query._target)
      if (d.type)      _builtin(d.type) || _visit (d.__proto__)
      if (d.target)    _visit (d._target) ; else if (d.targetAspect) _visit (typeof d.targetAspect === 'object' ? d.targetAspect : all[d.targetAspect])
      if (d.returns)   _visit (d.returns)
      if (d.items)     _visit (d.items)
      if (d.parent)    _visit (d.parent)
      for (let e in d.elements) _visit (d.elements[e])
      for (let a in d.actions) _visit (d.actions[a])
      for (let p in d.params) _visit (d.params[p])
    }
    for (let n in all) {
      if (n.endsWith('.texts') && reached.has(all[n.slice(0,-6)])) continue
      if (reached.has(all[n])) continue
      else {
        delete all[n]
        // also delete the legacy _texts proxy (not enumerable, installed by _localized.unfold_csn)
        if (n.endsWith('.texts'))  delete all[n.replace('.texts','_texts')]
      }
    }
    return this
  }

  *each (x, defs=this.definitions) {
    const pick=_is(x); for (let d in defs) if (pick(defs[d])) yield defs[d]
  }
  find (x, defs=this.definitions) {
    const pick=_is(x); for (let d in defs) if (pick(defs[d])) return defs[d]
  }
  all (x, defs=this.definitions) {
    return Object.values(defs).filter(_is(x))
  }

  foreach (x, v, defs=this.definitions) {
    const y=_is(x), visit = typeof v !== 'function' ? x : (d,n,p) => y(d) && v(d,n,p)
    for (let name in defs) visit (defs[name],name)
    return this
  }

  forall (x, v, defs=this.definitions) {
    const y=_is(x), visit = typeof v !== 'function' ? x : (d,n,p) => y(d) && v(d,n,p)
    ;(function _recurse (defs,parent) { for (let name in defs) {
      const d = defs[name]; visit (d,name,parent); let y //...
      if ((y = _own(d,'elements'))) _recurse (y,d)
      if ((y = _own(d,'actions'))) _recurse (y,d)
      if ((y = _own(d,'target')) && y.elements) _recurse (y.elements,y)
    }})(defs)
    return this
  }

  childrenOf (x, filter=()=>true, defs = this.definitions) {
    const ns = !x ? false : typeof x === 'string' ? x : x.namespace || x.name, prefix = ns ? ns+'.' : ''
    const children = (ns) => !ns ? children : this.childrenOf (ns,filter)
    for (let fqn in defs) if (fqn.startsWith(prefix)) {
      const d = defs[fqn], name = fqn.slice(prefix.length)
      if (filter(d,name)) { children[name] = d
        if (d.is('entity') && fqn.endsWith('.texts')) { // REVISIT: to bridge transition to cv2 only
          const _texts = defs [fqn.slice(0,-6)+'_texts']
          if (_texts) _set (children, name.slice(0,-6)+'_texts', d) // REVISIT: last arg should be _texts but runtime tests fail with that
        }
      }
    }
    return _set (children, Symbol.iterator, function*(){ for (let e in this) yield this[e] })
  }

  get exports()  { return this.set ('exports',  this.childrenOf (this, (_,rn)=>!rn.includes('.'))) }
  get entities() { return this.set ('entities', this.childrenOf (this, d => d instanceof entity)) }
  get services() { return this.set ('services', this.all('service')) }
}


const _unresolved = (x,unknown=any) => ({name:x, __proto__:unknown.prototype, _unresolved:true})
const _builtin = x => types[x] || typeof x === 'string' && x.startsWith('cds.hana.') && any.prototype
const _infer = require('./infer'), _not_inferred = _unresolved('<query>',entity)
const _root = d => d instanceof service || d instanceof entity && !d.name.endsWith('.texts') && d['@cds.persistence.skip'] !== 'if-unused'
const _set = (o,p,v) => Object.defineProperty (o,p,{value:v,enumerable:false,configurable:1,writable:1})
const _own = (o,p) => { const pd = Reflect.getOwnPropertyDescriptor(o,p); return pd && pd.value }
const _is = x => {
  if (typeof x === 'string')  return x === 'any' ? ()=>true : d => d.is(x)
  if (typeof x === 'function') return x.prototype instanceof any ? d => d instanceof x : x
  throw new Error ('invalid filter for model reflection: '+ x)
}

/** @returns {LinkedCSN} */
module.exports = x => x instanceof any ? x : new LinkedCSN(x)
