const cds = require('../index')

class DataUtil {

  async delete(db) {
    if (!db)  db = await cds.connect.to('db')
    if (!this._deletes) {
      this._deletes = []
      for (const entity of db.model.each('entity')) {
        if (!entity.query && entity['@cds.persistence.skip'] !== true) {
          this._deletes.push(cds.ql.DELETE.from(entity))
        }
      }
    }
    if (this._deletes.length > 0) {
      const log = cds.log('deploy')
      if (log._info)  log.info('Deleting all data in', this._deletes)
      await db.run(this._deletes)
    }
  }

  /* delete + new deploy from csv */
  async reset(db) {
    if (!db)  db = await cds.connect.to('db')
    await this.delete(db)
    await cds.deploy(db.model).to(db, {ddl:false})
  }

  autoReset(enabled) { this._autoReset = enabled; return this }

}

module.exports = DataUtil

/* eslint no-console: off */
