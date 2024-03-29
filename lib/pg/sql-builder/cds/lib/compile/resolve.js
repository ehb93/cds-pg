const { resolve, join, sep } = require('path')
const { readdirSync } = require('fs')
const suffixes = [ '.csn', '.cds', sep+'index.csn', sep+'index.cds', sep+'csn.json' ]

/**
* Resolves given model references to an array of absolute filenames.
* For the model references, all these are accepted:
* - with suffix or without → will append `.csn|cds`, `/index.csn|cds`
* - absolute refs like `@sap/cds/common`
* - local refs with leading `.` or without, e.g. `srv/cat-service`
* - directory names → will fetch all contained `.csn` and `.cds` files
* - arrays of any of the above
* @returns and array of absolute filenames
*/
module.exports = exports = function cds_resolve (model, o={}) { // NOSONAR

  if (!model || model === '--') return
  if (model._resolved) return model
  if (model === '*') return exports.cache['*'] || _resolve_all(this,o)
  if (Array.isArray(model)) return _resolved (
    [... new Set(model)] .reduce ((prev,next) => prev.concat (this.resolve(next,o)||[]), [])
  )

  const cwd = o.root || global.cds && global.cds.root, local = resolve (cwd,model)
  const context = _paths(cwd), {cached} = context
  const id = model.startsWith('.') ? local : model
  if (id in cached && !o.skipModelCache)  return cached[id]

  // fetch file with .cds/.csn suffix as is
  if (/\.(csn|cds)$/.test(id)) try {
    return cached[id] = _resolved ([ _resolve (id,context) ])
  } catch(e) {/* ignored */}

  // try to resolve file with one of the suffixes
  for (let tail of o.suffixes || suffixes) try {
    return cached[id] = _resolved ([ _resolve (id+tail,context) ])
  } catch(e) {/* ignored */}

  // fetch all in a directory
  if (o.all !== false) try {
    const files = readdirSync(local), all=[], unique={}
    for (let f of files) if (f.endsWith('.csn')) {
      all.push (unique[f.slice(0,-4)] = join(local,f))
    }
    for (let f of files) if (f.endsWith('.cds')) {
      unique[f.slice(0,-4)] || all.push (join(local,f))
    }
    return cached[id] = _resolved (all)
  } catch(e) {/* ignored */}

  // fetch file without suffix
  if (o.any !== false && !id.endsWith('/')) try { // NOTE: this also finds .js files!
    return cached[id] = _resolved ([ _resolve (id,context) ])
  } catch(e) {/* ignored */}

}

exports.cache = {}


const _resolve = require('module')._resolveFilename

function _resolve_all (cds,o) {
  const {roots,requires} = cds.env, {cache} = exports
  const required = Object.values(requires) .map (r => r.model) .filter(x=>x)
  if (o.dry || o === false)  return [ ...roots, ...required ]
  cache['*'] = [] // important to avoid endless recursion on '*'
  const resolved = cds.resolve (roots,o) || []
  if (!(resolved.length === 1 && resolved[0].endsWith('csn.json')))
  resolved.push (...cds.resolve (required,o)||[])
  return cache['*'] = _resolved ([ ...new Set (resolved) ])
}

function _paths (dir) {
  const {cache} = exports; if (dir in cache)  return cache[dir]
  const a = dir.split(sep), n = a.length, nm = sep+'node_modules'
  const paths = [ dir, ...a.map ((_,i,a)=> a.slice(0,n-i).join(sep)+nm) ]
  return cache[dir] = { paths, cached:{} }
}

function _resolved (array) {
  if (!array || !array.length)  return
  return Object.defineProperty ([...new Set (array)], '_resolved', {value:true})
}
