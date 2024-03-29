const { isfile, fs } = require('../utils')
const DEFAULTS = require('./defaults'), defaults = require.resolve ('./defaults')
const os_user_home = require('os').homedir()
const compat = require('./compat')
const path = require('path')

/**
 * Both a config inctance as well as factory for.
 */
class Config {

  /**
   * This is the one and only way to construct new instances.
   * Public API is through `cds.env.for (<context>)`
   * @param context - the app context, like 'cds' or 'your-app'
   * @returns {Config & typeof DEFAULTS}
   */
  for (context, cwd, _defaults=true) {
    if (!cwd) cwd = global.cds && global.cds.root || process.cwd()
    return new Config (context, cwd, _defaults)
  }


  /**
   * Only used internally, i.e. through cds.env.for(<context>)
   */
  constructor (_context, _home, _defaults=true) {
    Object.assign (this, { _context, _home, _sources:[] })
    this._profiles = _determineProfilesFrom (process.env)
    this._profiles._defined = new Set()

    // 1. set compat requires default values
    if (_context === 'cds' && _defaults)  this.add (DEFAULTS, defaults)
    if (_context === 'cds' && _defaults)  compat (this)
    if (!_home)  return

    // fill-in defaults to process.env, unless already defined => 4.
    this._add_to_process_env (_home, 'default-env.json')

    // additional env for dev => 4.
    if (process.env.NODE_ENV !== 'production') {
      this._add_to_process_env (_home, '.env')
    }

    const sources = Config.sources(_home, _context)

    // 2. read config sources in defined order
    for (const source of sources) {
      this._load(source.path, source.file, source.mapper, this._profiles, false)
    }

    // 3. read important (!) profiles from config sources in defined order
    const overwriteProfiles = new Set(this.profiles.map( profile => `${profile}!` ).filter( profile => this._profiles._defined.has( profile ) ));
    if (overwriteProfiles.size > 0) {
      for (const source of sources) {
        this._load(source.path, source.file, source.mapper, overwriteProfiles, true)
      }
    }

    // 4. add process env
    this._add_process_env(_context, _home)

    // 6. link dependant services (through kind/use)
    this._link_required_services()
    // 7. complete service configurations from VCAP
    this._add_vcap_services (process.env.VCAP_SERVICES)

    // 8. Add compatibility for mtx
    if (this.requires && this.requires.db) {
      if (this.requires.multitenancy !== undefined) {
        Object.defineProperty(this.requires.db, 'multiTenant', { value: !!this.requires.multitenancy })
      }
      else if (this.requires.db.multiTenant !== undefined) this.requires.multitenancy = this.requires.db.multiTenant
    }

    // Only if feature is enabled
    this._emulate_vcap_services()
  }

  /**
   * Get configuration sources
   *
   * @param {string} home Project home
   * @param {string} context configuration context literal
   */
  static sources(home, context = 'cds', ) {
    if (!home) throw new Error('Missing parameter "home".')
    const user_home = process.env.CDS_USER_HOME || os_user_home

    let sources = [
      { name: 'USER_HOME', path: user_home, file: '.cdsrc.json' },
      { name: 'PROJECT', path: home, file: '.cdsrc.json' },
      { name: 'PACKAGE', path: home, file: 'package.json', mapper: p => p[context] },
      { name: 'PRIVATE', path: home, file: '.cdsrc-private.json' }
    ]

    if (context !== 'cds') sources = sources.filter( source => source.name === 'PACKAGE' )
    return sources
  }

  /**
   * This is `this.requires` plus additional entries for all cds.required.<name>.service
   */
  get required_services_or_defs() {
    const dict = Object.create (this.requires)
    for (let [name,e] of Object.entries (this.requires)) if (e.service) {
      if (e.service in dict && e.service !== name) {
        console.error (`Datasource name '${e.service}' conflicts with 'service' definition referred to in 'cds.requires.${name}':`, e)
        throw new Error (`Datasource name '${e.service}' conflicts with service definition`)
      }
      else dict[e.service] = { ...e, name }
    }
    return super.required_services_or_defs = dict
  }

  set roots(v) { set (this, 'roots', v) }
  get roots() {
    return this.roots = Object.values(this.folders) .concat ([ 'schema', 'services' ])
  }

  get tmp() {
    return set (this, 'tmp', require('os').tmpdir())
  }

  /**
   * Retrieves the value for a config option, specified as a property path.
   */
  get (option) {
    if (!option)  return
    return option.split('.').reduce ((p,n)=> p && p[n], this)
  }

  /**
   * Provides access to system defaults for cds env.
   */
  get defaults() { return DEFAULTS }

  /**
   * Get effective options for .odata
   */
  get effective(){
    return super.effective = require('..').compiler._options.for.env()
  }

  /**
   * For BAS only: to find out whether this is a Java or Node.js project
   */
  get "project-nature" () {
    const has_pom_xml = [this.folders.srv,'.'] .some (
      f => isfile (path.join (this._home, f, 'pom.xml'))
    )
    return has_pom_xml ? 'java' : 'nodejs'
  }

  /**
   * For BAS only: get all defined profiles (could include some from the defaults)
   */
  get "defined-profiles" () {
    return Array.from (new Set(Array.from(this._profiles._defined).map( profile => profile.endsWith("!") ? profile.slice(0, -1) : profile)))
  }

  get profiles() {
    return super.profiles = Array.from (this._profiles)
  }


//////////////////////////////////////////////////////////////////////////
//
//    DANGER ZONE!
//    The following are internal APIs which can always change!
//


/**
 * Load from JSON file or directory
 *
 * No profile support!
 */
_loadFromPath (_path, _basePath) {
    if (_basePath && !path.isAbsolute(_path)) _path = path.join(_basePath, _path)
    const json = _readJson (_path) || _readFromDir (_path)
    if (json) this.add (json, _path, new Set())
  }

  _load (cwd, file, _conf=o=>o, profiles, profiles_only) {
    const json = _readJson (file = path.join(cwd, file))  // only support JSON
    if (json) this.add (_conf (json), file, profiles, profiles_only)
  }

  add (conf, /*from:*/ _src, profiles = this._profiles, profiles_only = false) {
    if (!conf)  return this
    if (_src)  this._sources.push (_src)
    _merge (this, conf, profiles, undefined, profiles_only)
    return this
  }

  _add_to_process_env (cwd, filename) {
    const file = path.resolve (cwd,filename)
    try {
      const all = require('../compile/etc/properties').read(file)
      for (const key in all) {
        if (key in process.env) continue // do not change existing env vars
        const val = all[key]
        process.env[key] = typeof val === 'string' ? val : JSON.stringify(val)
      }
      this._sources.push (file)
    } catch (e) {
      if (e instanceof SyntaxError)  console.error(`Error parsing '${file}': ${e.message}`)
      else if (e.code !== 'MODULE_NOT_FOUND')  console.error(e.message)
    }
  }


  _add_process_env (prefix, basePath) {
    const {env} = process
    const PREF = prefix.toUpperCase(), my = { CONFIG: PREF+'_CONFIG', ENV: PREF+'_ENV' }
    const configEnvValue = env[my.CONFIG]
    let config
    try {
      // CDS_CONFIG={ /* json */}
      config = JSON.parse (configEnvValue)
    } catch (e) {
      // CDS_CONFIG=/path/to/config.json *OR* CDS_CONFIG=/path/to/config/dir
      if (configEnvValue && typeof configEnvValue === "string") this._loadFromPath (configEnvValue, basePath)
    }

    if (!config) config = {}
    const pref_ = RegExp('^'+prefix+'[._]','i')
    for (let p in env) if (!(p in my) && pref_.test(p)) {
      const key = /[a-z]/.test(p) ? p : p.toLowerCase() //> CDS_FOO_BAR -> cds_foo_bar
      const path = key.slice(prefix.length+1) .split (key[prefix.length]) //> ['foo','bar']
      for (var o=config,next;;) {
        next = path.shift()
        if (!path.length) break
        o = o[next] || (o[next] = {})
      }
      o[next] = _value4(env[p])
    }

    this.add(config, '{process.env}')
  }

  _link_required_services () {
    const { requires } = this, protos = requires && requires._prototypes || {}
    for (let each in requires) {
      requires[each] = _merged (each)
      // if we got an invalid value, remove it (would anyways cause trouble down the road)
      if (!requires[each])  delete requires[each]
    }
    function _merged (key) {
      const entry = requires[key] || protos[key]
      if (!entry || entry._is_merged || entry.kind === key || !(entry.kind in requires) && !(entry.kind in protos)) return entry
      const clone = _merge ({}, _merged (entry.kind))        // first apply inherited data
      _merge (clone, entry, false, false) // then apply overridden data
      return Object.defineProperty (clone, '_is_merged', {value:true})
    }
  }

  _add_vcap_services (VCAP_SERVICES) {
    if (this.features && this.features.vcaps === false)  return
    if (!this.requires)  return
    if (!VCAP_SERVICES) return
    try {
      const vcaps = JSON.parse (VCAP_SERVICES)
      const any = _add_vcap_services_to (this, vcaps)
      if (any)  this._sources.push ('{VCAP_SERVICES}')
    } catch(e) {
      throw new Error ('[cds.env] - failed to parse VCAP_SERVICES:\n  '+ e.message)
    }
  }

  /**
   * Build VCAP_SERVICES for compatibility (for example for CloudSDK) or for running
   * locally with credentials (hybrid mode).
   */
  _emulate_vcap_services() {
    if (!(this.features && this.features.emulate_vcap_services)) return
    process.env.VCAP_SERVICES = JSON.stringify(build_vcap_services(this))
  }

//////////////////////////////////////////////////////////////////////////
//
//    FORBIDDEN ZONE!
//    The following are hacks for tests which should not exist!
//    Tests should test public APIs, not internal ones.
//    Tests should even less intrude hacks to core components
//


  // FOR TESTS ONLY! --> PLEASE: tests should test public APIs (only)
  _for_tests (...conf) {
    const env = new Config('cds')
    this._for_tests.vcaps = (vcaps) => { _add_vcap_services_to (env, vcaps)}
    // merge all configs, then resolve profiles (same as in 'for' function above)
    for (let c of [...conf].reverse())  _merge(env, c, env._profiles)
    return env
  }
  // FOR TESTS ONLY! --> PLEASE: tests should test public APIs (only)
  _merge_with (src) {
    _merge (this, src, this._profiles)
    return this
  }
}




//////////////////////////////////////////////////////////////////////////
//
//    Local Helpers...
//

/**
 * @returns {Config} dst
 */
function _merge (dst, src, _profiles, _cloned, _profiles_only = false) {
  const profiled = [], descr = Object.getOwnPropertyDescriptors(src)
  for (let p in descr) {
    const pd = descr[p]

    if ('get' in pd || !pd.enumerable) {
      Object.defineProperty(dst,p,pd)
      continue
    }

    if (_profiles && p[0] === '[') {
      if (_profiles._defined)  _profiles._defined.add (p.slice(1,-1))
      if (_profiles.has(p.slice(1,-1)))
        profiled.push (()=> _merge (dst, src[p], _profiles, _cloned, false))
      continue
    }

    const v = pd.value
    if (typeof v === 'object' && !Array.isArray(v)) {
      if (!dst[p]) dst[p] = {}; else if (_cloned)  dst[p] = _cloned(dst[p])
      _merge (dst[p], v, _profiles, _cloned, _profiles_only)
      continue
    }

    if (!_profiles_only && v !== undefined) dst[p] = v
  }
  for (let each of profiled) each()
  return dst
}

function _readFromDir (p, isDir) {
  if (typeof isDir === "undefined") {
    try {
      const entry = fs.statSync(p)
      if (entry.isDirectory()) {
        isDir = true
      } else if (isFile(p, entry)) {
        isDir = false
      } else {
        return undefined
      }
    } catch (e) {
      return undefined
    }
  }
  if (isDir) {
    const result = {}
    const entries = fs.readdirSync(p, {withFileTypes: true})
    for (let entry of entries) {
      const entryPath = path.join(p, entry.name)
      if (entry.isDirectory()) {
        result[entry.name] = _readFromDir(entryPath, true)
      } else if (isFile(entryPath, entry)) {
        result[entry.name] = _readFromDir(entryPath, false)
      }
    }
    return result
  } else {
    return _value4(fs.readFileSync(p, "utf-8"))
  }
}

function isFile(p, entry) {
  if (entry.isFile()) return true
  if (entry.isSymbolicLink()) {
    // Kubernetes credentials use symlinks
    const target = fs.realpathSync(p)
    const targetStat = fs.statSync(target)

    if (targetStat.isFile()) return true
  }
  return false
}

function _value4 (val) {
  if (val && val[0] === '{') try { return JSON.parse(val) } catch(e) {/* ignored */}
  if (val && val[0] === '[') try { return JSON.parse(val) } catch(e) {/* ignored */}
  if (val === 'true')  return true
  if (val === 'false')  return false
  if (!isNaN(val))  return parseFloat(val)
  return val
}


function _add_vcap_services_to (env, vcaps={}) {
  let any
  for (let service in env.requires) {
    const conf = env.requires [service]
    if (!conf) continue
    const { credentials } = (
      conf.vcap && _fetch (conf.vcap) ||  //> alternatives, e.g. { name:'foo', tag:'foo' }
      _fetch ({ name: service })  ||
      _fetch ({ tag: env._context+':'+service }) ||
      _fetch ({ tag: conf.dialect || conf.kind }) || // important for hanatrial, labeled 'hanatrial', tagged 'hana'
      _fetch ({ label: conf.dialect || conf.kind }) ||
      {/* not found */}
    )
    // Merge `credentials`.  Needed because some app-defined things like `credentials.destination` must survive.
    if (credentials)  {
      any = conf.credentials = Object.assign ({}, conf.credentials, credentials)
    }
  }
  return any

  function _fetch (predicate) {
    for (let k of Object.keys(predicate).reverse()) {
      const v = predicate[k]; if (!v) continue
      const filter = k === 'tag' ? e => _array(e,'tags').includes(v) : e => e[k] === v
      for (let stype in vcaps) {
        const found = _array(vcaps,stype) .find (filter)
        if (found)  return found
      }
    }
  }

  function _array(o,p) {
    const v = o[p]
    if (!v) return []
    if (Array.isArray(v)) return v
    throw new Error(`Expected VCAP entry '${p}' to be an array, but was: ${require('util').inspect(vcaps)}`)
  }

}

function _readJson (file) {
  try {
    const src = fs.readFileSync (require.resolve (file))
    return JSON.parse (src)
  } catch (e) {
    if (e instanceof SyntaxError)  console.error(`Error parsing '${file}': ${e.message}`)
    else if (e.code !== 'MODULE_NOT_FOUND')  console.error(e.message)
  }
}

function _determineProfilesFrom (env = process.env) {
  if (env.NODE_ENV !== 'production' && !/\bdevelopment\b/.test(env.CDS_ENV)) {
    if (env.CDS_ENV)  env.CDS_ENV += ',development'
    else  env.CDS_ENV = 'development'
  }
  const split = (x) => env[x] ? env[x].split (/\s*,\s*/) : []
  const profiles = [ ...split ('NODE_ENV'), ...split ('CDS_ENV') ]
  return new Set (profiles)
}


function set (o,p,value) {
  Object.defineProperty (o, p, {value,configurable:true,writable:true})
  return value
}

function build_vcap_services(env) {
  let v = {}
  let names = new Set()

  for (const service in env.requires) {
    let { vcap, credentials, binding } = env.requires[service]
    // "binding.vcap" is chosen over "vcap" because it is meta data resolved from the real service (-> cds bind)
    if (binding && binding.vcap) vcap = binding.vcap
    if (vcap && vcap.label && credentials && Object.keys(credentials).length > 0) {
      // Only one entry for a (instance) name. Generate name from label and plan if not given.
      const { label, plan } = vcap
      const name = vcap.name || `instance:${label}:${plan || ""}`
      if (names.has(name)) continue
      names.add(name)

      if (!v[label]) v[label] = []
      v[label].push(Object.assign({ name }, vcap, { credentials }))
    }
  }

  return v
}

/** @type Config & typeof DEFAULTS */
module.exports = Config.prototype.for('cds')
/* eslint no-console:0 */
