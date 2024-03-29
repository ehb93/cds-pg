const cds = require ('../index')
const cdsc = require ('./cdsc')
const {lazified} = require ('../lazy'); require = lazified (module)  // eslint-disable-line


/**
 * This is the central API facade to call compiler functions.
 */
const compile = module.exports = Object.assign (cds_compile, {

  for: lazified ({
    odata: require('./for/odata'),
    sql: require('./for/sql'),
  }),

  to: lazified ({
    csn: cds_compile,
    cdl: require('./to/cdl'),
    yml: require('./to/yaml'),
    yaml: require('./to/yaml'),
    json: require('./to/json'),
    edm: require('./to/edm'), edmx: lazy => compile.to.edm.x,
    sql: require('./to/sql'),
    hdbcds: lazy => compile.to.sql.hdbcds,
    hdbtable: lazy => compile.to.sql.hdbtable,
    serviceinfo: require('./to/srvinfo'), //> REVISIT: move to CLI
  }),

})


/**
 * This is the central frontend function to compile sources to CSN.
 * @param {string|string[]|{}} model one of:
 * - a single filename starting with 'file:'
 * - a single CDL source string
 * - an object with multiple CDL or CSN sources
 * - an array of one or more filenames
 * @param { _flavor | {flavor:_flavor, ...}} options
 * - an options object or a string specifying the flavor of CSN to generate
 * @param { 'inferred'|'xtended'|'parsed' } _flavor - for internal use only(!)
 * @returns {{ namespace?:string, definitions:{}, extensions?:[], meta:{ flavor:_flavor }}} CSN
 */
function cds_compile (model, options, _flavor) {
  if (!model) throw cds.error (`Argument 'model' must be specified`)
  if (_is_csn(model) && _assert_flavor(model,_flavor,options)) return _fluent(model)   //> already parsed csn
  const o = _options4 (options,_flavor)
  const files = _is_files (model)
  const cwd = o.cwd || cds.root
  if (files) {
    if (o.sync) return _fluent (_finalize (cdsc.compileSync(files,cwd,o)))  //> compile files synchroneously
    else return _fluent (cdsc.compile(files,cwd,o) .then (_finalize))       //> compile files asynchroneously
  }
  else return _fluent (_finalize (cdsc.compileSources(model,o)))              //> compile CDL sources
  function _finalize (csn) {
    if (o.min) csn = cds.linked(csn).minified()
    // REVISIT: experimental implementation to detect external APIs
    for (let each in csn.definitions) {
      const d = csn.definitions[each]
      if (d.kind === 'service' && cds.requires[each] && (!o.mocked || cds.requires[each].credentials)) {
        Object.defineProperty (d,'@cds.external', { value: cds.requires[each].kind || true })
      }
    }
    if (!csn.meta) csn.meta = {}
    csn.meta.flavor = o.flavor
    return csn
  }
}


const _is_csn = (x) => (x.definitions || x.extensions) && !x.$builtins
const _is_files = m => {
  if (Array.isArray(m) || /file:/.test(m) && (m = m.slice(5)))
    return cds.resolve(m) || cds.error ( `Couldn't find a CDS model for '${m}' in ${cds.root}`,{ code:'MODEL_NOT_FOUND', model: m })
}
const _assert_flavor = (m,_flavor,options) => {
  if (!m.meta) return true; const f = _flavor || _flavor4 (options)
  return !f || f === m.meta.flavor || cds.error (`cds.compile(...,{flavor:'${f}'}) called on csn with different meta.flavor='${m.meta.flavor}'`)
}

const _flavors = {
  'parsed':   { level:1, cdsc_options: { parseCdl:true } },
  'xtended':  { level:2, cdsc_options: { toCsn:{flavor:'gensrc'} } },
  'inferred': { level:3 },
}
const _flavor4 = (o) => {
  const f = typeof o === 'string' ? o : o && o.flavor
  return !f || f in _flavors ? f : cds.error (`Option 'flavor' must be one of ${Object.keys(_flavors)}; got: '${f}'`)
}
const _options4 = (_o, _flavor) => {
  const flavor = _flavor ? _flavor4(_flavor) : _flavor4(_o) || 'inferred'
  const spec = _flavors[flavor]
  const o = { ..._o, flavor, ...spec.cdsc_options, ...cds.env.cdsc }
  if (o.docs) o.docComment = true
  if (o.locations) o.withLocations = true
  if (!o.messages) o.messages = []
  return o
}

const _fluent = (x) => Object.defineProperties (x, {
  'for' : {configurable:true, get:()=> new Proxy ({api:compile.for,x},_handlers)},
  'to'  : {configurable:true, get:()=> new Proxy ({api:compile.to, x},_handlers)},
})
const _handlers = {
  ownKeys: ({api}) => Reflect.ownKeys (api),
  get: ({api,x},p) => {
    let fn = api[p]; if (!fn) return
    delete x.for; delete x.to //> cleanup the decorated CSN or Promise
    return o => 'then' in x ? x.then(m => api[p](m,o)) : api[p](x,o)
  }
}
