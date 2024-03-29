const cds = require('../index'), { Context } = cds.Request, { cds_tx_protection } = cds.env.features
const _context = Symbol()

/**
 * This is the implementation of the `srv.tx(req)` method. It constructs
 * a new Transaction as a derivate of the `srv` (i.e. {__proto__:srv})
 * @returns { Transaction & import('./Service-api') }
 */
module.exports = function tx (req,fn) { const srv = this
  if (srv.context) return srv
  if (!req) {
    // called as srv.tx() -> new root transaction
    return RootTransaction.for (srv, Context.new())
  }
  if (typeof req === 'function') [ req, fn ] = [ Context.new(), req ]
  if (typeof fn === 'function') {
    // auto-committed transaction, i.e. cds.tx (tx => {...})
    const tx = srv.tx(req)
    return Promise.resolve(tx).then(fn) .then (tx.commit,tx.rollback)
  }
  if (req instanceof Context) {
    // called for a nested req -> nested tx
    if (req.context !== req) return NestedTransaction.for (srv, req.context)
    // called for a req with a root tx -> nested tx
    if (req._tx) return NestedTransaction.for (srv, req)
    // called for a top-level req -> root tx
    else return RootTransaction.for (srv, req)
  }
  if (req[_context]) {
    // called again for an arbitrary context object -> see below
    return NestedTransaction.for (srv, req[_context])
  } else {
    // called first time for an arbitrary context object
    const root = Context.new(req); Object.defineProperty (req, _context, {value:root})
    return RootTransaction.for (srv, root)
  }
}


class Transaction {

  /**
   * Returns an already started tx for given srv, or creates a new instance
   */
  static for (srv,root) {
    let txs = root.transactions
    if (!txs) Object.defineProperty(root, 'transactions', {value: txs = new Map})
    let tx = txs.get (srv)
    if (!tx) txs.set (srv, tx = new this (srv,root))
    return tx
  }

  constructor (srv,root) {
    const tx = _init ({ __proto__:srv, context:root })
    const proto = new.target.prototype
    tx.commit   = proto.commit.bind(tx)
    tx.rollback = proto.rollback.bind(tx)
    return tx
  }

  /**
   * In addition to srv.commit, resets the transaction to initial state,
   * in order to re-start on subsequently dispatched events.
   */
  async commit (res) {
    if (this.ready) { //> nothing to do if no transaction started at all
      if (this.__proto__.commit) await this.__proto__.commit.call (this,res)
      _init(this).ready = 'committed'
    }
    return res
  }

  /**
   * In addition to srv.rollback, resets the transaction to initial state,
   * in order to re-start on subsequently dispatched events.
   */
  async rollback (err) {
    /*
     * srv.on('error', function (err, req) { ... })
     * synchroneous modification of passed error only
     * err is undefined if nested tx (cf. "root.before ('failed', ()=> this.rollback())")
     */
    if (err) for (const each of this._handlers._error) each.handler.call(this, err, this.context)

    if (this.ready) { //> nothing to do if no transaction started at all
      if (this.__proto__.rollback) await this.__proto__.rollback.call (this,err)
      _init(this).ready = 'rolled back'
    }
    if (err) throw err
  }

}


class RootTransaction extends Transaction {

  /**
   * Register the new transaction with the root context.
   */
  static for (srv,root) {
    return root._tx = super.for (srv,root)
  }

  /**
   * In addition to srv.commit, ensures all nested transactions
   * are informed by emitting 'succeesed' event to them all.
   */
  async commit (res) {
    if (cds_tx_protection) this.context._done = 'committed'
    try {
      await this.context.emit ('succeeded',res)
      await super.commit (res)
      await this.context.emit ('done')
    } catch (err) {
      await this.rollback (err)
    }
    return res
  }

  /**
   * In addition to srv.rollback, ensures all nested transactions
   * are informed by emitting 'failed' event to them all.
   */
  async rollback (err) {
    if (cds_tx_protection) this.context._done = 'rolled back'
    try {
      await this.context.emit ('failed',err)
      await super.rollback (err)
    } finally {
      await this.context.emit ('done')
    }
    if (err) throw err
  }
}


class NestedTransaction extends Transaction {

  /**
   * Registers event listeners with the root context, to commit or rollback
   * when the root tx is about to commit or rollback.
   * @param {import ('../req/context')} root
   */
  constructor (srv,root) {
    super (srv,root)
    root.before ('succeeded', ()=> this.commit())
    root.before ('failed', ()=> this.rollback())
    if ('end' in srv) root.once ('done', ()=> srv.end())
  }

}


/**
 * Ensure the service's implementation of .begin is called appropriately
 * before any .dispatch.
 */
const _init = (tx) => {
  if ('begin' in tx) tx.dispatch = _begin
  else tx.ready = true //> to allow subclasses w/o .begin
  return tx
}
const _begin = async function (req) {
  if (!req.query && req.method === 'BEGIN') // IMPORTANT: !req.query is to exclude batch requests
    return this.ready = this.__proto__.dispatch.call (this,req)
  // Protection against unintended tx.run() after tx.commit/rollback()
  if (typeof this.ready === 'string' || !this.ready && this.context._done) {
    if (cds_tx_protection) throw Object.assign(new Error (`Transaction is ${this.ready || this.context._done}, no subsequent .run allowed, without prior .begin`), { code: 'TRANSACTION_CLOSED' })
    else this.ready = this.begin() // compatibiliy to former behavior, which allowed tx.run() after commit/rollback
  }
  else if (!this.ready) this.ready = this.begin()
  await this.ready
  delete this.dispatch
  return this.dispatch (req)
}
