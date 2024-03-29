const cdsc = require ('../cdsc')
const cds = require ('../../index')

function cds_compile_to_edm (csn,_o) {
  const o = cdsc._options.for.edm(_o) //> used twice below...
  csn = _4odata(csn,o)
  if (o.service === 'all') return _many ('.json',
    cdsc.to.edm.all (csn,o),
    o.as === 'str' ? JSON.stringify : x=>x
  )
  else return cdsc.to.edm (csn,o)
}


function cds_compile_to_edmx (csn,_o) {
  const o = cdsc._options.for.edm(_o) //> used twice below...
  csn = _4odata(csn,o)
  if (o.service === 'all') return _many ('.xml',
    cdsc.to.edmx.all (csn,o)
  )
  else return cdsc.to.edmx (csn,o)
}



function _4odata (csn,o) {

  const services = cds.linked(csn).services
  if (services.length < 1) throw new Error (
    `There are no service definitions found at all in given model(s).`
  )

  if (!o.service && services.length > 1) throw new Error (`\n
    Found multiple service definitions in given model(s).
    Please choose by adding one of... \n
    -s all ${services.map (s => `\n    -s ${s.name}`).join('')}
  `)

  if (!o.service) {
    o.service = services[0].name
  } else if (o.service !== 'all') { // fetch first matching service
    const srv = services.find (s => s.name === o.service)
    if (!srv) throw new Error (
      `No service definition matching ${o.service} found in given model(s).`
    )
    o.service = srv.name
  }

  // o.service is specified now
  return cds.compile.for.odata(csn,o)
}


function* _many (suffix, all, callback = x=>x) {
  for (let file in all) yield [ callback(all[file]), { file, suffix } ]
}


module.exports = Object.assign (cds_compile_to_edm, { x: cds_compile_to_edmx })
