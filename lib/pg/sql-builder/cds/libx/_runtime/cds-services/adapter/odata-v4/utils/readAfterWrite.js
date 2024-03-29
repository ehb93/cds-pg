const cds = require('../../../../cds')
const { SELECT } = cds.ql

const { getDeepSelect } = require('../../../services/utils/handlerUtils')
const { DRAFT_COLUMNS } = require('../../../../common/constants/draft')
const { filterKeys } = require('../../../../fiori/utils/handler')

const _getColumns = target => {
  const columns = []
  for (const k in target.elements) {
    if (!target.elements[k].isAssociation && !DRAFT_COLUMNS.includes(k)) columns.push(k)
  }
  return columns
}

module.exports = async (req, srv) => {
  let deepSelect
  if (req.event === 'draftActivate') {
    const where = filterKeys(req.target.keys).reduce((w, k) => {
      w[k] = req.data[k]
      return w
    }, {})
    deepSelect = SELECT.from(req.target).columns(_getColumns(req.target)).where(where)
  } else if (req.event === 'UPDATE') {
    deepSelect = SELECT.from(req.query.UPDATE.entity, _getColumns(req.target))
  } else {
    deepSelect = getDeepSelect(req)
  }
  const result = await cds.tx(req).run(deepSelect)
  return result
}
