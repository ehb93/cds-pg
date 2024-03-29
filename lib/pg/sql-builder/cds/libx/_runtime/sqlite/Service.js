const cds = require('../cds')

const DatabaseService = require('../db/Service')

let _sqlite

/*
 * sqlite-specific handlers
 */
const localized = require('./localized')
const convertAssocToOneManaged = require('./convertAssocToOneManaged')

/*
 * sqlite-specific execution
 */
const execute = require('./execute')

const _new = url => {
  if (url && url !== ':memory:') url = cds.utils.path.resolve(cds.root, url)
  if (!_sqlite) _sqlite = require('sqlite3')
  return new Promise((resolve, reject) => {
    const dbc = new _sqlite.Database(url, err => {
      err ? reject(err) : resolve(dbc)
    })
  })
}

/*
 * the service
 */
module.exports = class SQLiteDatabase extends DatabaseService {
  constructor(...args) {
    super(...args)

    // REVISIT: official db api
    this._execute = execute

    // REVISIT: official db api
    this._insert = this._queries.insert(execute.insert)
    this._read = this._queries.read(execute.select, execute.stream)
    this._update = this._queries.update(execute.update, execute.select)
    this._delete = this._queries.delete(execute.delete)
    this._run = this._queries.run(this._insert, this._read, this._update, this._delete, execute.cqn, execute.sql)

    this.dbcs = new Map()
  }

  set model(csn) {
    const m = csn && 'definitions' in csn ? cds.linked(cds.compile.for.odata(csn)) : csn
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
    this.on(['BEGIN', 'COMMIT', 'ROLLBACK'], function (req) {
      return this._run(this.model, this.dbc, req.event)
    })

    // REVISIT: register only if needed?
    this.before('COMMIT', this._integrity.performCheck)

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
    this.before(['CREATE', 'READ', 'UPDATE', 'DELETE'], '*', this._rewrite)

    this.before('READ', '*', convertAssocToOneManaged)
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
  async acquire(arg) {
    // REVISIT: remove fallback arg.user.tenant with cds^6
    const tenant = (typeof arg === 'string' ? arg : arg.tenant || (arg.user && arg.user.tenant)) || 'anonymous'

    let dbc = this.dbcs.get(tenant)
    if (!dbc) {
      const credentials = this.options.credentials || this.options || {}
      let dbUrl = credentials.database || credentials.url || credentials.host || ':memory:'

      if (this.options.multiTenant && dbUrl.endsWith('.db')) {
        dbUrl = dbUrl.split('.db')[0] + '_' + tenant + '.db'
      }

      dbc = await _new(dbUrl)

      dbc._queued = []
      dbc._tenant = tenant

      if (cds.env.features._foreign_key_constraints) {
        await new Promise((resolve, reject) => {
          dbc.exec('PRAGMA foreign_keys = ON', err => {
            if (err) reject(err)
            resolve()
          })
        })
      }

      this.dbcs.set(tenant, dbc)
    }

    if (dbc._busy) await new Promise(resolve => dbc._queued.push(resolve))
    else dbc._busy = true

    return dbc
  }

  release(dbc) {
    if (dbc._queued.length) dbc._queued.shift()()
    else dbc._busy = false
  }

  /*
   * deploy
   */
  // REVISIT: make tenant aware
  async deploy(model, options = {}) {
    const createEntities = cds.compile.to.sql(model, options)
    if (!createEntities || createEntities.length === 0) return // > nothing to deploy

    const dropViews = []
    const dropTables = []
    for (const each of createEntities) {
      const [, table, entity] = each.match(/^\s*CREATE (?:(TABLE)|VIEW)\s+"?([^\s"(]+)"?/im) || []
      if (table) dropTables.push({ DROP: { entity } })
      else dropViews.push({ DROP: { view: entity } })
    }

    // H2 is picky on the order
    dropTables.reverse()
    dropViews.reverse()

    if (options.dry) {
      // do not use cds.log() here!
      const log = console.log // eslint-disable-line no-console
      for (const {
        DROP: { view }
      } of dropViews) {
        log('DROP VIEW IF EXISTS ' + view + ';')
      }
      log()
      for (const {
        DROP: { entity }
      } of dropTables) {
        log('DROP TABLE IF EXISTS ' + entity + ';')
      }
      log()
      for (const each of createEntities) log(each + '\n')
      return
    }

    const tx = this.transaction()
    await tx.run(dropViews)
    await tx.run(dropTables)
    await tx.run(createEntities)
    await tx.commit()

    return true
  }
}
