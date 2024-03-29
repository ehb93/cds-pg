const cds = require('../../../cds')
const LOG = cds.log('app')
const { SELECT } = cds.ql

const { compareJson } = require('./compareJson')
const { selectDeepUpdateData } = require('../../../common/composition')
const { ensureDraftsSuffix } = require('../../../fiori/utils/handler')

const { DRAFT_COLUMNS } = require('../../../common/constants/draft')
const { cqn2cqn4sql, convertPathExpressionToWhere } = require('../../../common/utils/cqn2cqn4sql')
const { revertData } = require('../../../common/utils/resolveView')
const { removeIsActiveEntityRecursively } = require('../../../fiori/utils/where')

module.exports = class {
  constructor(srv) {
    this._srv = srv
  }

  _createSelectColumnsForDelete(entity) {
    const columns = []
    for (const element of Object.values(entity.elements)) {
      if (element.isComposition) {
        if (element._target._hasPersistenceSkip) continue
        columns.push({
          ref: [element.name],
          expand: this._createSelectColumnsForDelete(element._target)
        })
      } else if (!element._isAssociationStrict && !DRAFT_COLUMNS.includes(element.name)) {
        columns.push({ ref: [element.name] })
      }
    }

    return columns
  }

  _diffDelete(req) {
    const { DELETE } = (req._ && req._.query) || req.query
    const query = SELECT.from(DELETE.from).columns(this._createSelectColumnsForDelete(req.target))
    if (DELETE.where) query.where(...DELETE.where)

    return cds
      .tx(req)
      .run(query)
      .then(dbState => compareJson(undefined, dbState, req.target))
  }

  async _addPartialPersistentState(req) {
    const deepUpdateData = await selectDeepUpdateData(
      this._srv.model.definitions,
      req.query,
      req,
      true,
      true,
      this._srv
    )
    req._.partialPersistentState = deepUpdateData
  }

  async _diffUpdate(req, providedData) {
    if (cds.db) {
      try {
        await this._addPartialPersistentState(req)
      } catch (e) {
        LOG._warn && LOG.warn('Unable to calculate diff due to error: ' + e.message, e)
      }
    }
    const newQuery = cqn2cqn4sql(req.query, this._srv.model)
    const combinedData = providedData || Object.assign({}, req.query.UPDATE.data || {}, req.query.UPDATE.with || {})
    const lastTransition = newQuery.UPDATE._transitions[newQuery.UPDATE._transitions.length - 1]
    const revertedPersistent = revertData(req._.partialPersistentState, lastTransition, this._srv)
    return compareJson(combinedData, revertedPersistent, req.target)
  }

  async _diffPatch(req, providedData) {
    if (cds.db) {
      const { target, alias, where = [] } = convertPathExpressionToWhere(req.query.UPDATE.entity, this._srv.model, {})

      const draftRef = { ref: [ensureDraftsSuffix(target)], as: alias }

      // SELECT because req.query in custom handler does not have access to _drafts
      req._.partialPersistentState = await cds
        .tx(req)
        .run(SELECT.from(draftRef).where(removeIsActiveEntityRecursively(where)).limit(1))

      return compareJson(providedData || req.data, req._.partialPersistentState, req.target)
    }
  }

  _diffCreate(req, providedData) {
    const originalData =
      providedData || (req.query.INSERT.entries && req.query.INSERT.entries.length === 1)
        ? req.query.INSERT.entries[0]
        : req.query.INSERT.entries

    return compareJson(originalData, undefined, req.target)
  }

  async calculate(req, providedData) {
    // umbrella calls _calculateDiff with srv as this
    const that = this._differ || this

    if (req.event === 'CREATE') return that._diffCreate(req, providedData)
    if (req.target._hasPersistenceSkip) return
    if (req.event === 'DELETE') return that._diffDelete(req)
    if (req.event === 'UPDATE') return that._diffUpdate(req, providedData)
    if (req.event === 'PATCH') return that._diffPatch(req, providedData)
  }
}
