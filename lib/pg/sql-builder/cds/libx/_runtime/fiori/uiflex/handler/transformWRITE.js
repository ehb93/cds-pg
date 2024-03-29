const { EXT_BACK_PACK, getTargetWrite, isExtendedEntity } = require('../utils')

const getTemplate = require('../../../common/utils/template')
const templateProcessor = require('../../../common/utils/templateProcessor')

const _pick = element => {
  return element['@cds.extension']
}

const _processorFn = ({ row, key }) => {
  if (row[key] === undefined) return

  if (!row[EXT_BACK_PACK]) {
    row[EXT_BACK_PACK] = '{}'
  }

  const json = JSON.parse(row[EXT_BACK_PACK])
  json[key] = row[key]
  row[EXT_BACK_PACK] = JSON.stringify(json)
  delete row[key]
}

function transformExtendedFieldsCREATE(req) {
  if (!req.target) return

  const target = getTargetWrite(req.target, this.model)
  const template = getTemplate('transform-write', this, target, { pick: _pick })

  if (template && template.elements.size > 0) {
    for (const row of req.query.INSERT.entries) {
      const args = { processFn: _processorFn, row, template }
      templateProcessor(args)
    }
  }
}

async function transformExtendedFieldsUPDATE(req) {
  if (!req.target || !req.query.UPDATE.where) return

  const target = getTargetWrite(req.target, this.model)
  const template = getTemplate('transform-write', Object.assign(req, { model: this.model }), target, { pick: _pick })

  if (template && template.elements.size > 0) {
    // In patch case we first should obtain backpack from db.
    // Patch can be only applied to the root.
    if (isExtendedEntity(target.name, this.model)) {
      const current = await SELECT.from(req.query.UPDATE.entity).columns([EXT_BACK_PACK]).where(req.query.UPDATE.where)

      if (current[0]) {
        req.data[EXT_BACK_PACK] = JSON.stringify(current[0])
      }
    }

    const args = { processFn: _processorFn, row: req.data, template }
    templateProcessor(args)
  }
}

module.exports = {
  transformExtendedFieldsCREATE,
  transformExtendedFieldsUPDATE
}
