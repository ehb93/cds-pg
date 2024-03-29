const cds = require ('../../index')

const path = require('path')

module.exports = (csn,o={}) => JSON.stringify (csn, (_,v) => {

  if (!v) return v

  else if (v.grant && v.where) try {
    // Add a parsed _where clause for @restrict.{grant,where} annotations
    return {...v, _where: JSON.stringify (cds.parse.xpr(v.where)) }
  } catch(e){/* ignored */}

  else if (v.kind === "service" && !v['@source'] && v.$location && v.$location.file) {
    // Preserve original sources for services so we can use them for finding
    // sibling implementation filed when reloaded from csn.json.
    const file = (o.cwd !== o.src) ? path.relative(o.src, path.join(o.cwd, v.$location.file)) : v.$location.file
    return { '@source': file.replace(/\\/g,'/'), ...v }
  }

  return v

}, o && o.indents || 2)
