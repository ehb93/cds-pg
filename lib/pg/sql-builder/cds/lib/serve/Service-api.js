const add_methods_to = require ('./Service-methods')
const cds = require('..')


class Service extends require('./Service-handlers') {

  constructor (name, model, o={}) {
    super (name || new.target.name) .options = o
    if (o.kind) this.kind = o.kind // shortcut
    if (model) this.model = model
  }

  /**
   * Subclasses may override this to prepare the given model appropriately
   */
  set model(m) {
    super.model = m && cds.linked(m)
    if (m) add_methods_to (this)
  }

  /**
   * Messaging API to emit asynchronous event messages, i.e. instances of `cds.Event`.
   */
  emit (event, data, headers) {
    const res = this._compat_sync (event, data, headers); if (res) return res
    const eve = cds.Event.for(event) || new cds.Event({ event, data, headers })
    return this.dispatch (eve)
  }

  /**
   * REST-style API to send synchronous requests...
   */
  send (method, path, data, headers) {
    const req = cds.Request.for(method) || (
      typeof path === 'object' ? new cds.Request({ method, data:path, headers:data }) :
      new cds.Request({ method, path, data, headers })
    )
    return this.dispatch (req)
  }
  get    (path, data) { return is_rest(path) ? this.send('GET',   path,data) : this.read   (path, data) }
  put    (path, data) { return is_rest(path) ? this.send('PUT',   path,data) : this.update (path, data) }
  post   (path, data) { return is_rest(path) ? this.send('POST',  path,data) : this.create (path, data) }
  patch  (path, data) { return is_rest(path) ? this.send('PATCH', path,data) : this.update (path, data) }
  delete (path, data) { return is_rest(path) ? this.send('DELETE',path,data) : DELETE.from (path, data).bind(this) }

  /**
   * Querying API to send synchronous requests...
   */
  run (query, data) {
    const req = new cds.Request ({ query, data })
    return this.dispatch (req)
  }
  read   (...args) { return is_query(args[0]) ? this.run(...args) : SELECT(...args).bind(this) }
  insert (...args) { return INSERT(...args).bind(this) }
  create (...args) { return INSERT.into(...args).bind(this) }
  update (...args) { return UPDATE.entity(...args).bind(this) }
  exists (...args) { return SELECT.one([1]).from(...args).bind(this) }

  /**
   * Streaming API variant of .run(). Subclasses should override this to support real streaming.
   * The default implementation doesn't stream, but simply invokes the callback on each row.
   * The callback function is invoked with (row, index).
   */
  foreach (query, data, callback) {
    if (!callback)  [ data, callback ] = [ undefined, data ]
    return this.run (query, data) .then (rows => rows.forEach(callback) || rows)
  }

  /**
   * Model Reflection API...
   */
  get definition() {
    const defs = this.model && this.model.definitions, o = this.options
    return super.definition = defs && (o && defs[o.service] || defs[this.name] )
  }

  get namespace()  {
    return super.namespace  = this.definition && this.definition.name
    || this.model && this.model.namespace
    || !(this instanceof cds.DatabaseService) && !/\W/.test(this.name) && this.name || undefined
  }

  get operations() { return super.operations = _reflect (this, d => d.kind === 'action' || d.kind === 'function') }
  get entities()   { return super.entities   = _reflect (this, d => d.kind === 'entity') }
  get events()     { return super.events     = _reflect (this, d => d.kind === 'event') }
  get types()      { return super.types      = _reflect (this, d => !d.kind || d.kind === 'type') }

  /**
   * Subclasses may override this to free private resources
   */
  disconnect (tenant) { // eslint-disable-line no-unused-vars
    if (this === cds.db) cds.db = undefined //> REVISIT: should go into DatabaseService
    delete cds.services[this.name]
  }

}

const { dispatch, handle } = require('./Service-dispatch')
Service.prototype.dispatch = dispatch
Service.prototype.handle = handle
Service.prototype.transaction = Service.prototype.tx = require('./Transaction')
Service.prototype._compat_sync = require('./Service-compat')
Service.prototype._implicit_next = cds.env.features.implicit_next
Service.prototype._is_service_instance = Service._is_service_class = true //> for factory
module.exports = Service

// Helpers...
const _reflect = (srv,filter) => !srv.model ? [] : srv.model.childrenOf (srv.namespace,filter)
const is_rest = x => x && typeof x === 'string' && x[0] === '/'
const is_query = x => x && x.bind || is_array(x) && !x.raw
const is_array = (x) => Array.isArray(x) && !x.raw
