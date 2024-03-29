const { ensureUnlocalized } = require('../common/utils/draft')
const { redirect } = require('../db/utils/localized')
const cds = require('../cds')
const LOG = cds.log('sqlite|db|sql')

if (cds.env.i18n && Array.isArray(cds.env.i18n.for_sqlite) && !cds.env.i18n.for_sqlite.length) {
  LOG._warn && LOG.warn('No language configuration found in cds.env.i18n.for_sqlite')
}

// REVISIT: this is actually configurable
// there is no localized.en.<name>
const getLocalize = (locale, model) => name => {
  if (name.endsWith('_drafts')) return name

  // if we get here via onReadDraft, target is already localized
  // because of subrequest using SELECT.from as new target
  const target = model.definitions[ensureUnlocalized(name)]
  const localizedView =
    target &&
    target['@cds.localized'] !== false &&
    model.definitions[`localized.${locale !== 'en' ? locale + '.' : ''}${name}`]

  return localizedView ? localizedView.name : name
}

const _handler = function (req) {
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

  // suppress localization in "select for update" n/a for sqlite

  redirect(query.SELECT, getLocalize(req.locale, this.model))
}

_handler._initial = true

module.exports = _handler
