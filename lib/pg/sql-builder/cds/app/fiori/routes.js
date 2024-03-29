const cds = require('../../lib')

// Only for local cds runs w/o approuter:
// If there is a relative URL in UI5's manifest.json for the datasource,
// like 'browse/' or 'prefix/browse/', we get called with a prefix to the
// service path, like '/browse/webapp/browse/'.
// Serve these requests by redirecting to the actual service URL.
cds.on ('bootstrap', app => {

  const { env, utils:{find,fs}} = cds
  const v2Prefix = (env.odata.v2proxy && env.odata.v2proxy.urlpath) || '/v2'
  const serviceForUri = {}

  dataSourceURIs (env.folders.app).forEach(uri => {
    app.use('*/'+uri, ({originalUrl}, res, next)=> {  //  */browse/webapp[/prefix]/browse/
      // any of our special URLs ($fiori-, $api-docs) ? -> next
      if (originalUrl.startsWith('/$'))  return next()
      // is there a service for '[prefix]/browse' ?
      const srv = serviceForUri[uri] || (serviceForUri[uri] =
        cds.service.providers.find (srv => ('/'+uri).lastIndexOf(srv.path) >=0))
      if (srv) {
        let redirectUrl
        // odata-proxy may be in the line with its /v2 prefix.  Make sure we retain it.
        const v2Index = originalUrl.lastIndexOf(v2Prefix+srv.path)
        if (v2Index >= 0)  // --> /browse/webapp[/prefix]/v2/browse/ -> /v2/browse
          redirectUrl = originalUrl.substring(v2Index)
        else // --> /browse/webapp[/prefix]/browse/ -> /browse
          redirectUrl = originalUrl.substring(originalUrl.lastIndexOf(srv.path))
        if (originalUrl !== redirectUrl)  {// safeguard to prevent running in loops
          // console.log ('>>', req.originalUrl, '->', redirectUrl)
          return res.redirect (308, redirectUrl)
        }
      }
      next()
    })
  })

  function dataSourceURIs (dir) {
    const uris = new Set()
    find (dir, ['*/manifest.json', '*/*/manifest.json']).forEach(file => {
      const {dataSources: ds} = JSON.parse(fs.readFileSync(file))['sap.app'] || {}
      Object.keys (ds||[])
        .filter (k => ds[k].uri && !ds[k].uri.startsWith('/')) // only consider relative URLs)
        .forEach(k => uris.add(ds[k].uri))
    })
    return uris
  }

})
