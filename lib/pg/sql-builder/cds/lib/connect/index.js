const cds = require('..'), {one_model} = cds.env.features, LOG = cds.log('cds.connect')
const factory = require('../serve/factory')
const _pending = cds.services._pending || {} // used below to chain parallel connect.to(<same>)

/**
 * Connect to a service as primary datasource, i.e. cds.db.
 */
const connect = module.exports = async function cds_connect (options) {
  if (typeof options === 'object' && cds.db) throw cds.error (
    `You need to disconnect before creating a new primary connection with different options!`
  )
  if (typeof options === 'string') cds.db = await connect.to (options)
  else await connect.to ('db',options)
  return cds
}

/**
 * Connect to a specific service, either served locally, with ad-hoc options
 * or with options configured in cds.env.requires.<datasource>.
 * @param {string} [datasource]
 * @param {{ kind?:String, impl?:String }} [options]
 * @returns { Promise<import('../serve/Service-api')> }
 */
connect.to = async (datasource, options) => {
  let Service = factory, _done = x=>x
  if (typeof datasource === 'object') [options,datasource] = [datasource]
  else if (datasource) {
    if (datasource._is_service_class) [ Service, datasource ] = [ datasource, datasource.name ]
    if (!options) { //> specifying ad-hoc options disallows caching
      if (datasource in cds.services) return cds.services[datasource]
      if (datasource in _pending) return _pending[datasource]
    }
    // queue parallel requests to a single promise, to avoid creating multiple services
    _pending[datasource] = new Promise (r=>_done=r).finally(()=>{ delete _pending[datasource] })
  }
  const o = Service === factory ? options4 (datasource, options) : {}
  const m = await model4 (o)
  // check if required service definition exists
  const required = cds.requires[datasource]
  if (required && required.model && datasource !== 'db' && !m.definitions[required.service||datasource]) {
    LOG.error (`No service definition found for '${required.service || datasource}', as required by 'cds.requires.${datasource}':`, required)
    throw new Error (`No service definition found for '${required.service || datasource}'`)
  }
  // construct new service instance
  const srv = new Service (datasource,m,o)
  await srv.prepend (srv.init, srv.options.impl)
  if (datasource === 'db') cds.db = srv
  _done (cds.services[datasource] = srv)
  if (!o.silent) cds.emit ('connect',srv)
  return srv
}

function options4 (name, _o) {
  const [, kind=_o && _o.kind, url] = /^(\w+):(.*)/.exec(name) || []
  const conf = cds.requires[name] || cds.requires[kind]
  const o = { kind, ...conf, ..._o }
  if (!o.kind && !o.impl && !o.silent) throw cds.error(
    conf ? `Configuration for 'cds.requires.${name}' lacks mandatory property 'kind' or 'impl'` :
      name ? `Didn't find a configuration for 'cds.requires.${name}'` :
        `Provided options object lacks mandatory property 'kind' or 'impl'`
  )
  if (url) o.credentials = { ...o.credentials, url }
  return o
}

function model4 (o) {
  if (o.model && o.model.definitions) return o.model
  if (one_model && cds.model) return cds.model
  else return o.model && cds.load(o.model)
}
