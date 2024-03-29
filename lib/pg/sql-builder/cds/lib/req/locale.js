
const {i18n} = require('..').env
const INCLUDE_LIST = i18n.preserved_locales.reduce((p,n)=>{
  p[n]=n; p[n.toUpperCase()]=n; return p
},{
  en_US_x_saptrc: 'en_US_saptrc',
  en_US_x_sappsd: 'en_US_sappsd'
})

const from_req = req => req.query['sap-language'] || req.headers['x-sap-request-language'] || req.headers['accept-language']

function req_locale (req) {
  if (!req) return i18n.default_language
  const locale = from_req(req)
  if (!locale) return i18n.default_language
  const loc = locale.replace(/-/g,'_')
  return INCLUDE_LIST[loc]
  || /([a-z]+)/i.test(loc) && RegExp.$1.toLowerCase()
  || i18n.default_language
}

module.exports = Object.assign(req_locale, { from_req })
