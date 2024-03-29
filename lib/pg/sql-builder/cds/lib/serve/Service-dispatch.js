const cds = require ('../index')

/**
 * The default implementation of the `srv.dispatch(req)` ensures everything
 * is prepared before calling `srv.handle(req)`
 * @typedef {import('./Service-api')} Service
 * @typedef {import('../req/request')} Request
 * @this {Service}
 * @param {Request} req
 * @returns {Promise} resolving to the outcome/return value of last .on handler
 */
exports.dispatch = async function dispatch (req) { //NOSONAR

  // Ensure we are in a proper transaction
  if (!this.context) {
    const txc = cds.context //> join an outer tx.context, if any, with a nested tx
    if (txc && !txc._done) return this.tx(txc).dispatch(req)
    else try {    //>  start a new top-level tx, which we need to commit/rollback
      const tx = cds.context = this.tx(req)
      return tx.dispatch(req) .then (tx.commit, tx.rollback)
    } finally { cds.context = txc }
  }
  // `this` is a tx from now on...
  if (!req._tx) req._tx = this

  // Inform potential listeners // REVISIT: -> this should move into protocol adapters
  if (_is_root(req)) req._.req.emit ('dispatch',req)

  // Handle batches of queries
  if (_is_array(req.query))
    return Promise.all (req.query.map (q => this.dispatch ({query:q,__proto__:req})))

  // Ensure target and fqns
  if (!req.target) _ensure_target (this,req)
  if (typeof req.query === 'object') {
    if (req.query._target !== req.target) Object.defineProperty (req.query,'_target',{ value:req.target, configurable:true, writable:true })
    if (!req.query._srv) Object.defineProperty (req.query,'_srv',{ value:this, configurable:true, writable:true })
  }

  // REVISIT: Ensure req._.req and req._.res in case of srv.run(query)?!
  /*
  if (this instanceof cds.ApplicationService && !req._.req) {
    // TODO: add req and res to req._ from tx
  }
  */

  return this.handle(req)
}


/**
 * The default implementation of the `srv.handle(req)` method dispatches
 * requests through registered event handlers.
 * Subclasses should overload this method instead of `srv.dispatch`.
 * @param {Request} req
 * @this {Service}
 */
exports.handle = async function handle (req) {
  const srv=this; let handlers //...

  // ._initial handlers run in sequence
  handlers = this._handlers._initial.filter (h => h.for(req))
  if (handlers.length) {
    for (const each of handlers) await each.handler.call (this,req)
    if (req.errors) throw req.errors.throwable()
  }

  // .before handlers run in parallel
  handlers = this._handlers.before.filter (h => h.for(req))
  if (handlers.length) {
    await Promise.all (handlers.map (each => each.handler.call (this,req)))
    if (req.errors) throw req.errors.throwable()
  }

  // .on handlers run in parallel for async events, and as interceptors stack for sync requests
  handlers = this._handlers.on.filter (h => h.for(req))
  if (handlers.length) {
    if (!req.reply) await Promise.all (handlers.map (each => each.handler.call (this,req,_dummy)))
    else await async function next (r=req) { //> handlers may pass a new req object into next()
      const each = handlers.shift(); if (!each) return //> unhandled silently
      const x = await each.handler.call (srv,r,next)
      if (x !== undefined)      return r.reply(x)
      if (r.results)            return r.results
      if (srv._implicit_next)   return next()
    }()
    if (req.errors) throw req.errors.throwable()
  }
  else if (req.query) throw _unhandled (this,req)

  // .after handlers run in parallel
  handlers = this._handlers.after.filter (h => h.for(req))
  if (handlers.length) {
    const results = cds.env.features.arrayed_after && req.event === 'READ' && !_is_array(req.results) ? [req.results] : req.results // REVISIT: remove this in a future release after some grace period
    await Promise.all (handlers.map (each => each.handler.call (this, results, req)))
    if (req.errors) throw req.errors.throwable()
  }

  return req.results //> done
}


const _is_root = (req) => /OData|REST/i.test(req.constructor.name)
const _is_array = Array.isArray
const _dummy = ()=>{} // REVISIT: required for some messaging tests which obviously still expect and call next()

const _ensure_target = (srv,req) => {
  const q = req.query, p = req._.path; if (!q && !p) return
  if (srv.namespace) { // ensure fully-qualified names
    if (p) _ensure_fqn (req,'path',srv, p.startsWith('/') ? p.slice(1) : p)
    else if (q.SELECT) _ensure_fqn (q.SELECT,'from',srv)
    else if (q.INSERT) _ensure_fqn (q.INSERT,'into',srv)
    else if (q.UPDATE) _ensure_fqn (q.UPDATE,'entity',srv)
    else if (q.DELETE) _ensure_fqn (q.DELETE,'from',srv)
  }
  if (typeof q === 'object') {
    const m = srv.model, defs = m && m.definitions || {}
    req.target = cds.infer(q,defs)
  }
}

const _ensure_fqn = (x,p,srv, name = x[p]) => {
  if (typeof name === 'string') {
    if (srv.model && name in srv.model.definitions) return
    if (name.startsWith(srv.namespace)) return
    if (name.endsWith('_drafts')) return // REVISIT: rather fix test/fiori/localized-draft.test.js ?
    else x[p] = `${srv.namespace}.${name}`
  } else if (name.ref) {
    const [head] = name.ref
    head.id ? _ensure_fqn(head,'id',srv) : _ensure_fqn(name.ref,0,srv)
    if (x.where) for (let y of x.where) if (y.SELECT) _ensure_fqn(y.SELECT,'from',srv)
  }
}

const _unhandled = (srv,req) => {
  const event = req.event + (req.path ? ' ' + req.path : '')
  return req.reject (501, `Service "${srv.name}" has no handler for "${event}".`)
}
