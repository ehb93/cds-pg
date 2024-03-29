const { EXT_BACK_PACK, hasExtendedEntity, getTargetRead } = require('../utils')

const getTemplate = require('../../../common/utils/template')
const templateProcessor = require('../../../common/utils/templateProcessor')

const _pick = element => {
  return element['@cds.extension']
}

const _processorFn = ({ row, key }) => {
  if (row[EXT_BACK_PACK]) {
    const extensions = JSON.parse(row[EXT_BACK_PACK])
    Object.keys(extensions).forEach(field => {
      row[field] = extensions[field]
    })

    delete row[EXT_BACK_PACK]
  }

  if (row[key] === undefined) {
    row[key] = null
  }
}

function transformExtendedFieldsRESULT(result, req) {
  if (!result || !hasExtendedEntity(req, this.model)) return

  const template = getTemplate('transform-result', this, getTargetRead(req), {
    pick: _pick
  })

  if (template.elements.size > 0) {
    const result_ = Array.isArray(result) ? result : [result]
    for (const row of result_) {
      const args = { processFn: _processorFn, row, template }
      templateProcessor(args)
    }
  }
}

module.exports = {
  transformExtendedFieldsRESULT
}
