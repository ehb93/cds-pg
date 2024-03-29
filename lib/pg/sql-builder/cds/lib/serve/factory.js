const cds = require('..')
const { path, isfile } = cds.utils

/** @typedef {import('./Service-api')} Service @type { (()=>Service) & (new()=>Service) } */
const ServiceFactory = function (name, model, options) { //NOSONAR

  const o = {...options} // avoid changing shared options
  const serve = !cds.requires[name] || o.mocked
  const defs = !model ? {[name]:{}} : model.definitions || cds.error (`Invalid argument for 'model': ${model}`)
  const def = !name || name === 'db' ? {} : defs[name] || {}

  let it /* eslint-disable no-cond-assign */
  if (it = o.with)                 return _use (it) // from cds.serve (<options>)
  if (it = serve && def['@impl'])  return _use (it) // from service definition
  if (it = serve && sibling(def))  return _use (it) // next to <service>.cds
  if (it = o.impl)                 return _use (it) // from cds.connect (<options>)
  return _use (_required())

  function _use (it) {
    if (it._is_service_class)     return new it (name,model,o)
    if (it._is_service_instance)  return it
    if (typeof it === 'function') return _use (_required(), /*with:*/ o.impl = _function(it)) // NOSONAR
    if (typeof it === 'object')   return _use (it && it[name] || _required())
    if (typeof it === 'string')   return Object.assign (_use (_require(it,def)), {_source:it})
    throw cds.error (`Invalid service implementation for ${name}: ${it}`)
  }

  function _required() {
    const kind = o.kind = serve && def['@kind'] || o.kind || 'app-service'
    if (_required[kind]) return _required[kind]
    const {impl} = cds.requires[kind] || cds.error (`No configuration found for 'cds.requires.${kind}'`)
    return _required[kind] = _require (impl || cds.error (`No 'impl' configured for 'cds.requires.${kind}'`))
  }
}

const _require = (it,d) => {
  if (it.startsWith('@sap/cds/')) it = cds.home + it.slice(8)    //> for local tests in @sap/cds dev
  else if (it.startsWith('./')) it = _relative (d, it.slice(2)) //> relative to <service>.cds
  else if (it.startsWith('//')) it = path.resolve (cds.root,it.slice(2)) //> relative to cds.root
  try { var resolved = require.resolve(it) } catch(e) {
    try { resolved = require.resolve(it = path.resolve(cds.root,it)) } catch(e) { // for compatibility
      throw cds.error(`Failed loading service implementation from '${it}'`)
    }
  }
  return require(resolved)
}

const _function = (impl) => !_is_class(impl) ? impl : (srv) => {
  const instance = new impl, skip = {constructor:1,prototype:1}
  for (let each of Reflect.ownKeys (impl.prototype)) {
    each in skip || srv.on (each, (...args) => instance[each](...args))
  }
}

const sibling = (d) => {
  const src = _source(d), home = path.resolve(cds.root,src,'..')
  const file = path.parse(src).name
  for (let each of ['', './lib', './handlers']) {
    let found
    if (process.env.CDS_TYPESCRIPT === 'true') found = isfile(path.join(home, each, file + '.ts'))
    if (!found) found = isfile(path.join(home, each, file + '.js'))
    if (found)  return found
  }
}

// Note: @source has precedence over $location for csn.json cases
const _source = (d) => d['@source'] || (d['@source'] = d.$location && d.$location.file.replace(/\\/g, '/') || '.')
const _relative = (d,x,cwd=cds.root) => typeof x !== 'string' ? x : path.resolve (cwd, _source(d),'..',x)
const _is_class = (impl) => typeof impl === 'function' && impl.prototype && /^class\b/.test(impl)

module.exports = Object.assign (ServiceFactory, { Service: ServiceFactory, resolve:_relative })
