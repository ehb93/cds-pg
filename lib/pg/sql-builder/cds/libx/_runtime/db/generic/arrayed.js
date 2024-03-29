const { getEntityFromCQN } = require('../../common/utils/entityFromCqn')
const getTemplate = require('../../common/utils/template')
const templateProcessor = require('../../common/utils/templateProcessor')

const _pick = element => {
  if (element.kind === 'element' && element.items) return 'arrayed'
}

const _processFn = ({ row, key, plain }) => {
  if (plain === 'arrayed' && row && row[key]) row[key] = JSON.parse(row[key])
}

/**
 * Formats JSON Strings to arrayed data
 *
 * @param result - the result of the DB query
 * @param req - the context object
 * @returns {Promise}
 */
module.exports = function (result, req) {
  if (!this.model) return

  const entity = getEntityFromCQN(req, this)
  if (!entity) return

  const template = getTemplate('db-arrayed', this, entity, { pick: _pick })
  if (template.elements.size === 0) return

  for (const row of Array.isArray(result) ? result : [result])
    templateProcessor({ processFn: _processFn, row, template })
}
