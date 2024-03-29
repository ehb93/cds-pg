class Axios {

  get axios() {
    return super.axios = require('axios').default.create ({
      headers: { 'Content-Type': 'application/json' },
      baseURL: this.url,
    })
  }
  get     (..._) { return this.axios.get     (..._args(_)) .catch(_error) }
  put     (..._) { return this.axios.put     (..._args(_)) .catch(_error) }
  post    (..._) { return this.axios.post    (..._args(_)) .catch(_error) }
  patch   (..._) { return this.axios.patch   (..._args(_)) .catch(_error) }
  delete  (..._) { return this.axios.delete  (..._args(_)) .catch(_error) }
  options (..._) { return this.axios.options (..._args(_)) .catch(_error) }

  /** @type typeof _.get     */ get GET()     { return this.get     .bind (this) }
  /** @type typeof _.put     */ get PUT()     { return this.put     .bind (this) }
  /** @type typeof _.post    */ get POST()    { return this.post    .bind (this) }
  /** @type typeof _.patch   */ get PATCH()   { return this.patch   .bind (this) }
  /** @type typeof _.delete  */ get DELETE()  { return this.delete  .bind (this) }
  /** @type typeof _.delete  */ get DEL()     { return this.delete  .bind (this) } //> to avoid conflicts with cds.ql.DELETE
  /** @type typeof _.options */ get OPTIONS() { return this.options .bind (this) }

}

const _args = (args) => {
  const first = args[0], last = args[args.length-1]
  if (first.raw) {
    if (first[first.length-1] === '' && typeof last === 'object')
      return [ String.raw(...args.slice(0,-1)), last ]
    return [ String.raw(...args) ]
  }
  else if (typeof first !== 'string')
    throw new Error (`Argument path is expected to be a string but got ${typeof first}`)
  return args
}

const _error = (e) => {
  if (e.code === 'ECONNREFUSED' && e.port === 80 /*unchanged default port*/) {
    // retain original error properties (code,...)
    e = Object.assign(new Error(e.message +
      '\nIt seems that the server was not started. Make sure to call \'cds.test(...)\' or \'cds.test.run(...)\'.'),e)
    e.stack = null // stack is just clutter here
    throw e
  }
  if (!e.response)  throw e
  if (!e.response.data)  throw e
  if (!e.response.data.error)  throw new Error(e.message + '\n\n' + e.response.data)
  const { code, message } = e.response.data.error
  throw new Error (code && code !== 'null' ? `${code} - ${message}` : message)
}

const _ = Axios.prototype // eslint-disable-line no-unused-vars
module.exports = Axios
