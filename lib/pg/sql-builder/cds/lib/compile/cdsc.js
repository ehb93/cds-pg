const {cdsc,odata,sql,hana} = require ('../index').env
const compile = require ('@sap/cds-compiler')
const _4cdsc = Symbol('_4cdsc')

/**
 * Returns a copy of the given options object, which all mappings applied and
 * finally overridden with entries from cds.env.cdsc. That is, the equivalent
 * of {...o, ...[...mappings], ...cds.env.cdsc }.
 * @type <T> (src:T,...mappings:{}[]) => T
 */
function _options4 (src, ...mappings) {
  if (src[_4cdsc]) return src //> already prepared for cdsc
  // Create a derivate of given src options object
  const dst = Object.defineProperty({__proto__:src},_4cdsc,{value:true}) // NOTE: {__proto__:src} not possible due to compiler obviously cloning options
  // Apply mappings in order of appearance -> latter ones override formers
  for (let map of mappings) for (let k in map) {
    let v = dst[k];  if (v === undefined) continue
    let m = map[k];  if (typeof m === 'function') m(dst,v); else dst[m] = v
  }
  // Optionally add .messages array to avoid compiler writing messages to stderr
  dst.messages = dst.messages || []
  // Finally override with options from cds.env.cdsc
  return Object.assign(dst,cdsc)
}


/**
 * Decorates the _options4 function with individual options mapping functions
 * for use in respective calls to cdsc functions. Can be used as follows:
 *
 *     const {_options} = require(<this module>)   // from external
 *     _options.for.odata({...})                   // same in here
 */
const _options = {for: Object.assign (_options4, {

  odata(o,_more) {
    if (o && o[_4cdsc]) return o
    let f = o && o.flavor || odata.flavor || o, flavor = odata.flavors && odata.flavors[f] || {}
    let v = o && o.version || flavor.version || odata.version   //> env.odata.flavors.version overrides env.odata.version!
    let o2 = { ...flavor, ...odata, ...o, version:v }
    if (o2.refs && o2.proxies === undefined) o2.proxies = true  //> o.proxies follows o.refs
    o2.names = this.sql().names
    return _options4 (o2, {
      version     : 'odataVersion',
      structs     : (o,v) => o.odataFormat = v ? 'structured' : 'flat',
      refs        : (o,v) => o.odataForeignKeys = !v,
      xrefs       : 'odataXServiceRefs',
      proxies     : 'odataProxies',
      containment : 'odataContainment',
      // IMPORTANT: as a matter of fact we need the below not only for .to.sql tasks
      sql_mapping  : 'names', //> legacy
      names        : (o,v) => v !== 'plain' ? o.sqlMapping = v : undefined,
    }, _more)
  },

  edm(o) {
    return this.odata (o, {
      version : 'odataVersion',
      service : 'service',
    })
  },

  sql(o,_env) {
    return _options4 ({ ..._env||sql, ...o }, {
      sql_mapping  : 'names', //> legacy
      sqlDialect   : 'dialect', //> legacy
      sqlMapping  : 'names',
      dialect      : 'sqlDialect',
      names        : (o,v) => v !== 'plain' ? o.sqlMapping = v : undefined,
    })
  },

  hana(o) {
    let cdsc = this.sql (o,hana)
    return cdsc
  },

  env() {
    const odata = this.edm()
    const sql   = this.sql()
    const hana  = this.hana()
    const env = {
      odata: odata.__proto__,
      sql:   sql.__proto__,
      hana:  hana.__proto__,
      cdsc: { ...odata, ...sql, ...hana }
    }
    delete env.odata.flavors
    return env
  },

})}

/**
 * Return a derivate of cdsc, with the most prominent
 */
module.exports = exports = {__proto__:compile, _options,
  for: {__proto__: compile.for,
    odata: (csn,o) => compile.for.odata  (csn, _options.for.odata(o)),
  },
  to: {__proto__: compile.to,
    edmx: Object.assign ((csn,o) => compile.to.edmx (csn, _options.for.edm(o)), {
      all: (csn,o) => compile.to.edmx.all (csn, _options.for.edm(o))
    }),
    edm: Object.assign ((csn,o) => compile.to.edm (csn, _options.for.edm(o)), {
      all: (csn,o) => compile.to.edm.all (csn, _options.for.edm(o))
    }),
    hdi: Object.assign ((csn,o) => compile.to.hdi (csn, _options.for.hana(o)), {
      migration: (csn,o,...etc) => {
        o = Object.assign ({...o},_options.for.hana(o)) //> REVISIT: need to flatten as compiler seems to clone options in that impl
        return compile.to.hdi.migration (csn, o, ...etc)
      }
    }),
    hdbcds: (csn,o) => compile.to.hdbcds (csn, _options.for.hana(o) ),
    sql: (csn,o) => compile.to.sql (csn, _options.for.sql(o) ),
    cdl: (csn,o) => compile.to.cdl (csn, _options4(o||{}) ),
  },
}
