const cdsc = require ('@sap/cds-compiler')
const cds = require ('../index')

/** cds.parse is both, a namespace and a shortcut for cds.parse.cdl */
const cds_parse = (src,o) => cds.compile (src,o,'parsed')
const parse = module.exports = Object.assign (cds_parse, {

  CDL: (...args) => tagged(parse.cdl, ...args),
  CQL: (...args) => tagged(parse.cql, ...args),
  CXL: (...args) => tagged(parse.expr, ...args),

  cdl: cds_parse,
  cql: x => { try { return cdsc.parse.cql(x,undefined,{messages:[]}) } catch(e) {
    e.message = e.message.replace('<query>.cds:',`In '${e.cql = x}' at `)
    throw e // with improved error message
  }},
  path: (x,...values) => {
    if (x && x.raw) return tagged (parse.path,x,...values)
    if (/^[A-Za-z_$][A-Za-z_0-9.$]*$/.test(x)) return {ref:[x]}
    let {SELECT} = parse.cql('SELECT from '+x)
    return SELECT.from
  },
  column: x => {
    let as = /\s+as\s+(\w+)$/i.exec(x)
    if (as) {
      let col = parse.expr(x.slice(0,as.index)); col.as = as[1]
      return col
    }
    else return parse.expr(x)
  },
  expr: x => {
    if (typeof x !== 'string') throw cds.error.expected `${{x}} to be an expression string`
    if (x in keywords) return {ref:[x]}
    try { return cdsc.parse.expr(x,undefined,{messages:[]}) } catch(e) {
      e.message = e.message.replace('<expr>.cds:1:',`In '${e.expr = x}' at `)
      throw e // with improved error message
    }
  },
  xpr: x => { const y = parse.expr(x); return y.xpr || [y] },
  ref: x => parse.expr(x).ref,

  properties: (...args) => (parse.properties = require('./etc/properties').parse) (...args),
  yaml: (...args) => (parse.yaml = require('./etc/yaml').parse) (...args),
  csv: (...args) => (parse.csv = require('./etc/csv').parse) (...args),
  json: (...args) => JSON.parse (...args),

})


const tagged = (parse, strings, ...values) => {
  if (!strings.raw) return parse (strings, ...values)
  const all = new Array (strings.length + values.length)
  for (var i=0; i<strings.length-1; ++i) {
    let v = values[i], s = strings[i]
    all[2*i] = s
    all[2*i+1] = v instanceof cds.entity ? v.name : ':'+i
    if (typeof v === 'string' && s.endsWith(' like ') && !v.includes('%')) values[i] = `%${v}%`
    if (Array.isArray(v) && s.endsWith(' in ')) values[i] = {list: v.map(cxn4)}
  }
  all[2*i] = strings[i]
  return merge (parse(all.join('')), values)
}

const merge = (o,values) => {
  for (let k in o) {
    const x = o[k]
    if (x.param) {
      let val = values[x.ref[0]]; if (val === undefined) continue
      let y = o[k] = cxn4(val)
      if (x.cast) y.cast = x.cast
      if (x.key) y.key = x.key
      if (x.as) y.as = x.as
    } else if (typeof x === 'object') merge(x,values)
  }
  return o
}

const cxn4 = x => x.SELECT || x.ref || x.xpr || x.val !== undefined|| x.list || x.func ? x : {val:x}
const keywords = { KEY:1, key:1, SELECT:1, select:1 }