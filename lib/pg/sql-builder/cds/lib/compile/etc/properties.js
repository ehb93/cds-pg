const path = require('path')
const fs = require('fs')

const Properties = module.exports = { read, parse }

function read (res, ext = '.properties') {
  try {
    // Although properties are actually latin1-encoded, people tend to have
    // unicode chars in them (e.g.German umlauts), so let's parse in utf-8.
    if (!/\.(env|.+rc)$/.test(res) && !path.extname(res)) res += ext
    const src = fs.readFileSync(path.resolve(res),'utf-8')
    const properties = src.match(/^\s*{/) ? JSON.parse(src) : Properties.parse(src)
    return Object.defineProperty (properties, '_source', {value:res})
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error (`Corrupt ${ext} file: ${res+ext}`)
  }
}

function parse (props) {
  const lines = props.split(/\r?\n/)
  const rows = lines.filter(each => !!each.trim()).map(each => {
    const index = each.indexOf('=')
    if (index < 0)  return [each, '']
    return [each.slice(0, index).trim(), each.slice(index + 1).trim()]
  })
  const bundle = rows.reduce((all, [key, value]) => {
    if (key && !/^\s*[#;]/.test(key)) all[key] = value4(value)
    return all
  }, {})
  return bundle
}

function value4(raw) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === '0') return 0
  else return Number(raw) || raw
  .replace(/^"(.*)"$/,"$1") .replace(/^'(.*)'$/,"$1")
  .replace(/\\u[\dA-F]{4}/gi, (match) => String.fromCharCode(parseInt(match.replace(/\\u/g, ''), 16)))
}
