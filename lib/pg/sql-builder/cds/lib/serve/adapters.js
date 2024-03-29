const lib = require('../../libx/_runtime')
const registry = {
  rest: lib.to.rest,
  odata: lib.to.odata_v4,
  odata_v2: lib.to.odata_v4,
  odata_v4: lib.to.odata_v4,
  fiori: lib.to.odata_v4,
}


class ProtocolAdapter {

  static at (protocol) {
    const factory = registry[protocol]; if (factory) return factory
    else throw new Error (`Service protocol ${protocol} is not supported`)
  }

  /**
  * Constructs / returns a ProtocolAdapter for the given service and protocol.
  * The constructed adapters are cached per service, so subsequent calls
  * for same service and protocol returns the formerly constructed one.
  * @returns {ProtocolAdapter}
  */
  static serve (srv, protocol = _protocol4(srv)) {
    const cached = (srv._adapters || (srv._adapters={})) [protocol]; if (cached) return cached
    const adapter = Object.defineProperties (this.at (protocol) (srv), _prototype)
    return (adapter.service = srv)._adapters[protocol] = adapter
  }

  /**
  * Mounts the adapter to an express app.
  */
  in (app) {
    const srv = this.service
    if (!app._perf_measured) {
      lib.performanceMeasurement (app)
      app._perf_measured = true
    }
    lib.auth (srv, app, srv.options)
    app.use (srv.path+'/webapp/', (_,res)=> res.sendStatus(404))
    app.use (srv.path, this)
    return srv
  }

  /**
  * Returns a proxy handler function with the specified service
  * as its prototype to allow usages like this:
  *
  *    const { CatalogService } = cds.serve(...)
  *    app.use ('/cats', CatalogService)
  */
  asRouter() {
    let router = this._router
    if (!router) {
      router = this._router = (...args) => this (...args)
      Object.defineProperty (router, 'name', {value: this.service.name})
      Object.setPrototypeOf (router, this.service)
    }
    return router
  }

}

const _protocol4 = (srv) => {
  const {to} = srv.options; if (to) return to
  const def = srv.definition
  return !def ? default_protocol : def['@protocol'] || def['@rest'] && 'rest' || def['@odata'] && 'odata_v4' || default_protocol
}

const default_protocol = 'odata_v4'
const _prototype = Object.getOwnPropertyDescriptors (ProtocolAdapter.prototype)
module.exports = { ProtocolAdapter }
