const cds = require('../cds')
const LOG = cds.log('hana|db|sql')

const DatabaseService = require('../db/Service')
const pool = require('./pool')

/*
 * hana-specific handlers
 */
const localized = require('./localized')
const search = require('./search')

/*
 * hana-specific execution
 */
const execute = require('./execute')

/*
 * helpers
 */
const _setSessionContext = (dbc, property, value) => {
  if (dbc._connection) {
    // Works, but bad practice to access an internal scope
    dbc._connection.getClientInfo().setProperty(property, value)
  } else {
    dbc.setClientInfo(property, value)
  }
}

/*
 * the service
 */
class HanaDatabase extends DatabaseService {
  constructor(...args) {
    super(...args)

    // REVISIT: official db api
    this._execute = execute

    // REVISIT: db api
    this._insert = this._queries.insert(execute.insert)
    this._read = this._queries.read(execute.select, execute.stream)
    this._update = this._queries.update(execute.update, execute.select)
    this._delete = this._queries.delete(execute.delete)
    this._run = this._queries.run(this._insert, this._read, this._update, this._delete, execute.cqn, execute.sql)
  }

  set model(csn) {
    const m = csn && 'definitions' in csn ? cds.linked(cds.compile.for.odata(csn)) : csn
    // with compiler v2 we always need to localized the csn
    cds.alpha_localized(m)
    super.model = m
  }

  init() {
    this._registerBeforeHandlers()
    this._registerOnHandlers()
    this._registerAfterHandlers()

    /*
     * tx
     */
    this.on('BEGIN', async function (req) {
      this.dbc.setAutoCommit(false)
      return 'dummy'
    })

    // REVISIT: register only if needed?
    this.before('COMMIT', this._integrity.performCheck)

    this.on(['COMMIT', 'ROLLBACK'], function (req) {
      return new Promise((resolve, reject) => {
        this.dbc[req.event.toLowerCase()](async err => {
          try {
            this.dbc.setAutoCommit(true)
          } catch (e) {
            // REVISIT: what to do?
            return reject(e)
          }
          if (err) return reject(err)
          resolve('dummy')
        })
      })
    })

    /*
     * generic
     */
    // all others, i.e. CREATE, DROP table, ...
    this.on('*', function (req) {
      return this._run(this.model, this.dbc, req.query || req.event, req, req.data)
    })
  }

  _registerBeforeHandlers() {
    this._ensureModel && this.before('*', this._ensureModel)
    this.before(['CREATE', 'UPDATE'], '*', this._input) // > has to run before rewrite
    this.before('READ', '*', search) // > has to run before rewrite
    this.before(['CREATE', 'READ', 'UPDATE', 'DELETE'], '*', this._rewrite)

    this.before('READ', '*', localized) // > has to run after rewrite
    this.before('READ', '*', this._virtual)

    // REVISIT: get data to be deleted for integrity check
    this.before('DELETE', '*', this._integrity.beforeDelete)
  }

  _registerOnHandlers() {
    this.on('CREATE', '*', this._CREATE)
    this.on('READ', '*', this._READ)
    this.on('UPDATE', '*', this._UPDATE)
    this.on('DELETE', '*', this._DELETE)
  }

  _registerAfterHandlers() {
    // REVISIT: after phase runs in parallel -> side effects possible!
    const { effective } = cds.env

    if (effective.odata.structs) {
      // REVISIT: only register for entities that contain structured or navigation to it
      this.after(['READ'], '*', this._structured)
    }

    if (effective.odata.version !== 'v2') {
      // REVISIT: only register for entities that contain arrayed or navigation to it
      this.after(['READ'], '*', this._arrayed)
    }
  }

  /*
   * connection
   */
  // eslint-disable-next-line complexity
  async acquire(arg) {
    // REVISIT: remove fallback arg.user.tenant with cds^6
    const tenant = (typeof arg === 'string' ? arg : arg.tenant || (arg.user && arg.user.tenant)) || 'anonymous'
    const dbc = await pool.acquire(tenant, this.options.credentials)

    if (typeof arg !== 'string') {
      _setSessionContext(dbc, 'APPLICATIONUSER', arg.user.id || 'ANONYMOUS')
      // REVISIT: remove fallback arg.user.locale with cds^6
      _setSessionContext(dbc, 'LOCALE', arg.locale || (arg.user && arg.user.locale) || 'en')
      // REVISIT: stable access
      const validFrom = (arg.context && arg.context._ && arg.context._['VALID-FROM']) || (arg._ && arg._['VALID-FROM'])
      const validto = (arg.context && arg.context._ && arg.context._['VALID-TO']) || (arg._ && arg._['VALID-TO'])
      if (validFrom)
        _setSessionContext(
          dbc,
          'VALID-FROM',
          validFrom instanceof Date ? validFrom.toISOString().replace('T', ' ') : validFrom.replace('T', ' ')
        )
      if (validto)
        _setSessionContext(
          dbc,
          'VALID-TO',
          validto instanceof Date ? validto.toISOString().replace('T', ' ') : validto.replace('T', ' ')
        )
    }

    dbc._tenant = tenant

    return dbc
  }

  release(dbc) {
    if (dbc) return pool.release(dbc)
    // should not happen, but just in case
    LOG._warn && LOG.warn(new Error('Release called without client. Please report this warning.'))
  }

  // REVISIT: should happen automatically after a configurable time
  // poolOnly: private param for mtx
  async disconnect(tenant, poolOnly) {
    tenant = tenant || 'anonymous'
    await pool.drain(tenant)
    if (!poolOnly) super.disconnect(tenant)
  }
}

module.exports = HanaDatabase
