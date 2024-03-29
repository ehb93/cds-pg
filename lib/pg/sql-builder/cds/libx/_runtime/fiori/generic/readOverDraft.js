const cds = require('../../cds')
const { SELECT } = cds.ql
const { getEnrichedCQN, hasDraft, ensureDraftsSuffix } = require('../utils/handler')
const { readAndDeleteKeywords } = require('../utils/where')
const { cqn2cqn4sql } = require('../../common/utils/cqn2cqn4sql')

const _modifyCQN = (cqnDraft, where, context) => {
  const whereDraft = [...where]
  const result = readAndDeleteKeywords(['IsActiveEntity'], whereDraft)
  cqnDraft.where(whereDraft)

  if (result && result.value.val === false) {
    cqnDraft.SELECT.from.ref[cqnDraft.SELECT.from.ref.length - 1] = ensureDraftsSuffix(
      cqnDraft.SELECT.from.ref[cqnDraft.SELECT.from.ref.length - 1]
    )
  }

  for (let i = 0; i < cqnDraft.SELECT.where.length; i++) {
    const element = cqnDraft.SELECT.where[i]

    if (element.SELECT) {
      const subCqnDraft = SELECT.from(
        {
          ref: [...element.SELECT.from.ref],
          as: element.SELECT.from.as
        },
        [1]
      )

      cqnDraft.SELECT.where[i] = subCqnDraft
      _modifyCQN(subCqnDraft, element.SELECT.where, context)
    }
  }
}

/**
 * Generic Handler for READ requests.
 *
 * @param req
 * @returns {Promise<Array>}
 */
const _handler = async function (req) {
  if (req.query.SELECT.limit && req.query.SELECT.limit.rows && req.query.SELECT.limit.rows.val === 0) {
    return Promise.resolve([])
  }

  // REVISIT DRAFT HANDLING: cqn2cqn4sql must not be called here
  const sqlQuery = cqn2cqn4sql(req.query, this.model, { draft: true })
  if (req.query._streaming) {
    sqlQuery._streaming = true
  }

  const hasDraftEntity = hasDraft(this.model.definitions, sqlQuery)

  if (hasDraftEntity && sqlQuery.SELECT.where && sqlQuery.SELECT.where.length !== 0) {
    // REVISIT
    delete req.query._validationQuery

    let cqnDraft = SELECT.from({
      ref: [...sqlQuery.SELECT.from.ref],
      as: sqlQuery.SELECT.from.as
    })
    cqnDraft.SELECT.columns = sqlQuery.SELECT.columns

    _modifyCQN(cqnDraft, sqlQuery.SELECT.where, req)
    cqnDraft = getEnrichedCQN(cqnDraft, sqlQuery.SELECT, [])
    return cds.tx(req).run(cqnDraft)
  }

  return cds.tx(req).run(sqlQuery)
}

module.exports = cds.service.impl(function () {
  for (const entity of Object.values(this.entities).filter(e => !e._isDraftEnabled)) {
    this.on('READ', entity, _handler)
  }
})
