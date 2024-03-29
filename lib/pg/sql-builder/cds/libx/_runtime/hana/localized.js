const { ensureUnlocalized } = require('../common/utils/draft')
const { redirect } = require('../db/utils/localized')

const getLocalize = (locale, model) => name => {
  if (name.endsWith('_drafts')) return name

  // if we get here via onReadDraft, target is already localized
  // because of subrequest using SELECT.from as new target
  const target = model.definitions[ensureUnlocalized(name)]
  const localizedView = target && target['@cds.localized'] !== false && model.definitions[`localized.${name}`]

  return localizedView ? localizedView.name : name
}

const localizedHandler = function (req) {
  const { query } = req

  // do simple checks upfront and exit early
  if (!query || typeof query === 'string') return
  if (!query.SELECT) return
  if (!this.model) return
  if (!req.locale) return

  // suppress localization by instruction
  if (query._suppressLocalization) return

  // suppress localization for pure counts
  const columns = query.SELECT.columns
  if (columns && columns.length === 1 && columns[0].func === 'count') return

  // suppress localization in "select for update"
  if (query.SELECT.forUpdate) return

  redirect(query.SELECT, getLocalize(req.locale, this.model))
}

localizedHandler._initial = true
module.exports = localizedHandler
