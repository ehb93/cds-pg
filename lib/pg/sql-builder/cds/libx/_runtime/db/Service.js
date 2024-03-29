const cds = require('../cds')
const { SELECT } = cds.ql
const { Transform } = require('stream')

/*
 * generic queries
 */
const queries = require('./query')

/*
 * generic handlers
 */
const generic = require('./generic')

class DatabaseService extends cds.Service {
  constructor(...args) {
    super(...args)

    // REVISIT: official db api
    this._queries = queries

    // REVISIT: official db api
    for (const each in generic) {
      this[`_${each}`] = generic[each]
    }

    // REVISIT: ensures tenant-aware this.model if this is a transaction -> this should be fixed in mtx integration, not here
    this._ensureModel = function (req) {
      if (this.context) {
        // if the tx was initiated in messaging, then this.context._model is not unfolded
        //   -> use this.context._model._4odata if present
        const { _model } = this.context
        this.model = (_model && _model._4odata) || _model || req._model
      }
    }
    this._ensureModel._initial = true

    // REVISIT: how to generic handler registration?
  }

  set model(m) {
    // Ensure the model we get has unfolded entities for localized data, drafts, etc.
    // Note: cds.deploy and some tests set the model of cds.db outside the constructor
    super.model = m && 'definitions' in m ? cds.compile.for.odata(m) : m
  }

  /*
   * tx
   */
  async begin() {
    const tx = this.context ? this : this.tx()
    tx.dbc = await tx.acquire(tx.context)
    try {
      await tx.send('BEGIN')
    } catch (e) {
      tx.release(tx.dbc)
      throw e
    }
    return tx
  }

  async commit() {
    // only release on successful commit as otherwise released on rollback
    await this.send('COMMIT')
    this.release(this.dbc)
  }

  async rollback() {
    if (this.dbc) {
      try {
        await this.send('ROLLBACK')
      } finally {
        this.release(this.dbc)
      }
    }
  }

  /*
   * streaming
   */
  _runStream(streamQuery, result) {
    this.run(streamQuery).then(stream => {
      if (!stream) {
        result.push(null)
      } else {
        stream.value.pipe(result)
      }
    })
  }

  stream(query) {
    // aynchronous API: cds.stream(query)
    if (typeof query === 'object') {
      // eslint-disable-next-line no-async-promise-executor
      return new Promise(async (resolve, reject) => {
        try {
          const res = await this.run(Object.assign(query, { _streaming: true }))
          resolve((res && res.value) || res)
        } catch (e) {
          reject(e)
        }
      })
    }

    // synchronous API: cds.stream('column').from(entity).where(...)
    return {
      from: (...args) => {
        const streamQuery = SELECT.from(...args)
        if (query && (!streamQuery.SELECT.columns || streamQuery.SELECT.columns.length !== 0)) {
          streamQuery.columns([query])
        }

        delete streamQuery.SELECT.one
        streamQuery._streaming = true

        const result = new Transform({
          transform(chunk, encoding, callback) {
            this.push(chunk)
            callback()
          }
        })

        if (
          !streamQuery.SELECT.where &&
          !(
            streamQuery.SELECT.from &&
            streamQuery.SELECT.from.ref &&
            streamQuery.SELECT.from.ref[streamQuery.SELECT.from.ref.length - 1].where
          )
        ) {
          return {
            where: (...args) => {
              streamQuery.where(...args)
              this._runStream(streamQuery, result)
              return result
            }
          }
        }

        this._runStream(streamQuery, result)

        return result
      }
    }
  }
}

module.exports = DatabaseService
