const { Responses, Errors } = require('./response')

/**
 * Class Request represents requests received via synchronous protocols.
 * It extends its base class Event by methods to return results, errors
 * or info messages.
 */
class Request extends require('./event') {

  set method(m) { if (m) super.method = m }
  get method() {
    return this._set ('method', Crud2Http[this.event] || this.event)
  }

  set event(e) { if (e) super.event = e }
  get event() {
    if (this._.method) return this._set ('event', Http2Crud[this._.method] || this._.method)
    if (this.query) return this._set ('event', Query2Crud(this.query))
    return this._set ('event', undefined)
  }

  set entity(e) { if (e) super.entity = e.name ? (this.target = e).name : e }
  get entity() {
    return this._set ('entity', this.target && this.target.name)
  }

  set params(p) { if (p) super.params = p }
  get params() {
    return this._set ('params', [])
  }

  set path(p) { if (p) super.path = p.startsWith('/') ? p.slice(1) : p }
  get path() {
    const {_} = this
    if (this.query) { // IMPORTANT: Bulk queries don't have a _.query
      const q = this.query
      if (q.SELECT) return this._set ('path', _path4 (q.SELECT,'from'))
      if (q.INSERT) return this._set ('path', _path4 (q.INSERT,'into'))
      if (q.UPDATE) return this._set ('path', _path4 (q.UPDATE,'entity'))
      if (q.DELETE) return this._set ('path', _path4 (q.DELETE,'from'))
    }
    if (_.target) return this._set ('path', _.target.name)
    if (_.entity) return this._set ('path', _.entity.name || _.entity)
    else return this._set ('path', undefined)
  }

  set data(d) { if (d) super.data = d }
  get data() {
    const q = this.query
    if (!q) return this._set ('data', undefined)
    const I = q.INSERT
    if (I) return this._set ('data', I.rows || I.values || I.entries && (I.entries.length > 1 ? I.entries : I.entries[0]) ||{})
    const U = q.UPDATE
    if (U) return this._set ('data', U.data ||{})
    return this._set ('data', {})
  }

  reply  (results) { return this.results = results }
  notify (...args) { return this._messages.add (1, ...args) }
  info   (...args) { return this._messages.add (2, ...args) }
  warn   (...args) { return this._messages.add (3, ...args) }
  error  (...args) { return this._errors.add (4, ...args) }
  reject (...args) {
    const e = this.error(...args)
    throw e.stack ? e : Object.assign(new Error,e)
  }

  // Lazily create message collectors for .errors and .messages
  /** @private */ get _messages() { return this.messages = this._set ('_messages', new Responses) }
  /** @private */ get _errors() { return this.errors = this._set ('_errors', new Errors) }

  // REVISIT: Used for request logging in cds.server
  // REVISIT: _.odataReq stuff should go into subclass ODataRequest
  get _path() { return this._set ('_path', this._.odataReq ? this._.odataReq._url.pathname : this._.req && this._.req.path) }
  get _query() { return this._set ('_query', this._.odataReq ? this._.odataReq._queryOptions : this._.req && this._.req.query) }

}

module.exports = Request


//
//  Helpers...
//

const Crud2Http = {
  READ: 'GET',
  CREATE: 'POST',
  UPDATE: 'PATCH',
  UPSERT: 'PUT',
  DELETE: 'DELETE',
}

const Http2Crud = {
  POST: 'CREATE',
  GET: 'READ',
  PUT: 'UPDATE',
  PATCH: 'UPDATE',
  DELETE: 'DELETE',
}

const SQL2Crud = {
  SELECT:   'READ',
  INSERT:   'CREATE',
  UPDATE:   'UPDATE',
  DELETE:   'DELETE',
  BEGIN:    'BEGIN',
  COMMIT:   'COMMIT',
  ROLLBACK: 'ROLLBACK',
  CREATE:   'CREATE ENTITY',
  DROP:     'DROP ENTITY',
}

const Query2Crud = (q) => {
  if (typeof q === 'string') return SQL2Crud[q] || /^\s*(\w+)/.test(q) && SQL2Crud[RegExp.$1] || q
  else for (let each in q) if (each in SQL2Crud) return SQL2Crud[each]
}

const _path4 = (x,p) => {
  const name = x[p]
  if (typeof name === 'string') return name
  if (name.ref) return name.ref.map(x=>x.id||x).join('/')
  else return '<complex query>'
}


//////////////////////////////////////////////////////////////////////////
//
//  REVISIT: Legacy stuff...
//
Object.defineProperties (Request.prototype, {

  diff: { value: function (...args) {
    const {_service:d} = this.target
    return d ? global.cds.services[d.name]._calculateDiff(this, ...args) : Promise.resolve([])
  }},

})
