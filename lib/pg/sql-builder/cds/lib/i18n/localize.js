const cds = require ('..')
const {existsSync, readdirSync} = require ('fs')
const {join,dirname,resolve,parse} = require ('path')

const DEBUG = process.env.DEBUG_I18N && console.warn
const conf = cds.env && cds.env.i18n || {}
const DefaultLanguage = conf.default_language || 'en'
const FallbackBundle = conf.fallback_bundle || ''
const I18nFolders = conf.folders || [ '_i18n', 'i18n' ]
const I18nFile = conf.file || 'i18n'


module.exports = Object.assign (localize, {
  bundles4, folders4, folder4, bundle4
})


function localize (model, /*with:*/ locale, aString) {
  const _localize = bundle => localizeString (aString, bundle)

  const bundle = bundles4 (model, locale)
  if (Array.isArray(locale)) { // array of multiple locales
    return (function*(){
      let any;
      if(bundle && bundle[Symbol.iterator]) { // try iteration only if bundle is set
        for (let [lang,each] of bundle)  yield any = [ _localize(each), {lang} ]
      }
      if (!any)  yield [ _localize(), {lang:''} ]
    })()
  } else { // a single locale string
    return _localize(bundle)
  }
}

const TEXT_KEY_MARKER = 'i18n>'
const TEXT_KEYS = /"([^"{]+)?{b?i18n>([^"}]+)}([^"]+)?"/g
function localizeString (aString, bundle) {
  if (!bundle || !aString)  return aString
  if (typeof aString === 'object')  aString = JSON.stringify(aString, null, 2)
  // quick check for presence of any text key, to avoid expensive operation below
  if (aString.indexOf(TEXT_KEY_MARKER) < 0)  return aString
  const isXml = aString.startsWith('<?xml')
  const isJson = /^[{[]/.test(aString)
  return aString.replace (TEXT_KEYS, (_, left='', key, right='') => {
    let val = bundle[key] || key
    if      (val && isXml)   val = escapeXmlAttr(val)
    else if (val && isJson)  val = escapeJson(val)
    return `"${left}${val}${right}"`
  })
}


/**
 * Returns all property bundles, i.e. one for each available translation language,
 * for the given model.
 */
function bundles4 (model, locales) { // NOSONAR

  const folders = folders4 (model)
  if (folders.length === 0)  return  //> no folders, hence no bundles found at all
  if (typeof locales === 'string')  return bundle4 (model, locales)  // single locale string --> single bundle
  if (!locales)  locales = cds.env.i18n.languages  // default
  if (locales.split)  locales = locales.split(',')
  // if no languages are specified, use all available
  if (locales.length === 1 && (locales[0] === '*' || locales[0] === 'all')) {
    locales = allLocales4 (folders)
    if (!locales)  return {}
    if (!locales.includes(FallbackBundle))  locales.push (FallbackBundle)
  }
  DEBUG && DEBUG ('Languages:', locales)

  return (function*(){
    for (let each of locales) {
      let bundle = bundle4 (model, each)
      if (bundle) {
        DEBUG && DEBUG (bundle.toString())
        yield [ each, bundle ]
      }
    }
  })()
}

/**
 * Return locales for all bundles found in given folders derived from .json, .properties or .csv files.
 *
 * TODO - .csv file handling seems to be questionable - do we need to check all .csv files additionally for locales ???
 */
function allLocales4 (folders) {
  // find all languages in all folders
  const files = folders
    .map (folder => readdirSync(folder).filter (e => e.startsWith(I18nFile)).map(i18nFile => join (folder, i18nFile)))
    .reduce ((files, file) => files.concat(file)) // flatten
  if (files.length === 0) {
    DEBUG && DEBUG ('No languages for folders:', folders)
    return null
  }

   if (files[0].endsWith('.csv')) {
    return cds.load.csv (files[0])[0].slice(1)
  } else {
    const locales = new Set()
    files.forEach(file => {
      const parsed = parse(file)
      if (parsed.ext === '.json') {
        Object.keys(require(file)).forEach(locale => locales.add(locale))
      } else if (parsed.ext === '.properties') {
        locales.add(parsed.name.slice(5))
      }
    })
    return Array.from(locales)
  }
}

/**
 * Returns the effective bundle stack for the given language and model folders.
 * Expected bundle stack for languages en and '' + 2 model layers:
    [en]   model/_i18n
      []   model/_i18n
        [en]   model/node_modules/reuse-model/_i18n
          []   model/node_modules/reuse-model/_i18n
 */
function bundle4 (model, locale) {

  const folders = folders4 (model); if (!folders.length)  return //> no folders, hence no bundles found at all
  const bundle = {}

  add (FallbackBundle)  // e.g. i18n.properties
  if (locale === FallbackBundle)  return bundle

  add (DefaultLanguage)  // e.g. i18n_en.properties
  if (locale === DefaultLanguage)  return bundle

  add (locale)  // e.g. i18n_de.properties
  return bundle

  function add (lang) {
    for (let each of folders) {
      const suffix = lang === '' ? '' : '_' + lang
      const file = join (each, I18nFile),  key = file+suffix
      const next = bundle4[key] || (bundle4[key] = (
        loadFromJSON (file, lang)  ||
        cds.load.properties (file + suffix.replace('-','_')) ||  // e.g. en-UK --> en_UK
        cds.load.properties (file + suffix.match(/\w+/)) ||  // e.g. en_UK --> en
        loadFromCSV (file, lang)
      ))
      Object.assign (bundle, next)
    }
  }
}

/**
 * Returns an array of all existing _i18n folders for the models
 * that are merged into the given one..
 */
function folders4 (model) {
  if (model._i18nfolders)  return model._i18nfolders
  // Order of model.$sources is expected to be sorted along usage levels, e.g.
  //   foo/bar.cds
  //   foo/node_modules/reuse-level-1/model.cds
  //   foo/node_modules/reuse-level-2/model.cds
  if (!model.$sources)  return []
  const folders=[];  for (let src of model.$sources) {
    let folder = folder4 (src)
    if (!folder || folders.indexOf(folder) >= 0)  continue
    folders.push(folder)  // use an array here to not screw up the folder order
  }

  Object.defineProperty (model, '_i18nfolders', {value:folders})
  return folders.reverse()
}

/**
 * Returns the location of an existing _i18n folder next to or in the
 * folder hierarchy above the given path, if any.
 */
function folder4 (loc) {
  // already cached from a former lookup?
  if (loc in folder4)  return folder4[loc]
  // check whether a <loc>/_i18n extists
  for (let i18n of I18nFolders) {
    const f = join (loc, i18n)
    if (existsSync(f)) return folder4[loc] = f
  }
  //> no --> search up the folder hierarchy
  let next = dirname(loc)
  return folder4[loc] = !next || next === loc  ?  null  :  folder4(next)
}


function loadFromJSON (res, lang=DefaultLanguage) {
  try {
    const bundles = require (resolve (cds.root,res+'.json'))
    return bundles[lang] || bundles [(lang.match(/\w+/)||[])[0]]
  } catch(e) {
    if (e.code !== 'MODULE_NOT_FOUND')  throw e
  }
}

function loadFromCSV (res, lang=DefaultLanguage) {
  let csv = cds.load.csv(res+'.csv'); if (!csv) return
  let [header, ...rows] = csv
  if (lang === '*') return header.slice(1).reduce ((all,lang,i) => {
    all[lang] = _bundle(i); return all
  },{})
  let col = header.indexOf (lang)
  if (col < 0)  col = header.indexOf ((lang.match(/\w+/)||[])[0])
  if (col > 0) return _bundle (col)
  function _bundle (col) {
    const b={}; for (let row of rows) if (row[col])  b[row[0]] = row[col]
    return Object.defineProperty (b, '_source', {value:res+'.csv'+'#'+lang})
  }
}

// TODO use compiler API for XML escaping
function escapeXmlAttr (str) {
  // first regex: replace & if not followed by apos; or quot; or gt; or lt; or amp; or #
  // Do not always escape > as it is a marker for {i18n>...} translated string values
  let result = str;
  if (typeof str === 'string') {
    result = str.replace(/&(?!(?:apos|quot|[gl]t|amp);|#)/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;')
      .replace(/\r\n|\n/g, '&#xa;');
    if (!result.startsWith('{i18n>') && !result.startsWith('{bi18n'))
      result = result.replace(/>/g, '&gt;')
  }
  return result;
}

function escapeJson (str) { return str
    .replace(/"/g, '\\"')
    .replace(/\\t/g, '\\t')
    .replace(/\\n/g, '\\n')
}


/* eslint no-console:off */
