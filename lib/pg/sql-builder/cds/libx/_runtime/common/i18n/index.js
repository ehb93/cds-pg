const fs = require('fs')
const path = require('path')

const cds = require('../../cds')
const LOG = cds.log('app')

const dirs = (cds.env.i18n && cds.env.i18n.folders) || []

const i18ns = {}

function exists(args, locale) {
  const file = path.join(process.cwd(), ...args, locale ? `messages_${locale}.properties` : 'messages.properties')
  return fs.existsSync(file) ? file : undefined
}

function findFile(locale) {
  // lookup all paths to model files
  const prefixes = new Set()
  if (cds.env.folders && cds.env.folders.srv) prefixes.add(cds.env.folders.srv.replace(/\/$/, ''))
  if (cds.services) {
    for (const outer in cds.services) {
      if (cds.services[outer].definition && cds.services[outer].definition['@source']) {
        prefixes.add(path.dirname(cds.services[outer].definition['@source']))
      }
    }
  }

  let file
  // find first messages_${locale}.properties file in cds.env.i18n.folders
  for (const dir of dirs) {
    // w/o prefix
    file = exists([dir], locale)
    if (file) break

    // w/ prefix
    for (const prefix of prefixes.keys()) {
      file = exists([prefix, dir], locale)
      if (file) break
    }

    if (file) break
  }

  return file
}

function init(locale, file) {
  if (!i18ns[locale]) i18ns[locale] = {}

  if (!file) file = findFile(locale)
  if (!file) return

  let raw
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch (e) {
    if (LOG._warn) {
      e.message = `Unable to load file "${file}" for locale "${locale}" due to error: ` + e.message
      LOG.warn(e)
    }
    return
  }

  try {
    const pairs = raw
      .replace(/\r/g, '')
      .split(/\n/)
      .map(ele => ele.trim())
      .filter(ele => ele && !ele.startsWith('#'))
      .map(ele => {
        const del = ele.indexOf('=')
        return [ele.slice(0, del), ele.slice(del + 1)].map(ele => ele.trim())
      })
    for (const [key, value] of pairs) {
      i18ns[locale][key] = value
    }
  } catch (e) {
    if (LOG._warn) {
      e.message = `Unable to process file "${file}" for locale "${locale}" due to error: ` + e.message
      LOG.warn(e)
    }
  }
}

init('default', path.join(__dirname, 'messages.properties'))
init('')

module.exports = (key, locale = '', args = {}) => {
  if (typeof locale !== 'string') {
    args = locale
    locale = ''
  }

  // initialize locale if not yet done
  if (!i18ns[locale]) {
    init(locale)
  }

  // for locale OR app default OR cds default
  let text = i18ns[locale][key] || i18ns[''][key] || i18ns.default[key]
  if (!text) return
  // best effort replacement
  try {
    const matches = text.match(/\{[\w][\w]*\}/g) || []
    for (const match of matches) {
      const arg = args[match.slice(1, -1)]
      const argtext = i18ns[locale][arg] || i18ns[''][arg] || i18ns.default[arg]
      text = text.replace(match, argtext || (arg != null ? arg : 'NULL'))
    }
  } catch (e) {
    // nothing to do
  }

  return text
}
