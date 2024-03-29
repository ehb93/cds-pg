const express = require('express')
const cds = require('./lib')

/**
 * Standard express.js bootstrapping, constructing an express `application`
 * and launching a corresponding http server using `app.listen()`.
 * Project-specific `./server.js` can overload this and react to these
 * events:
 *
 * - cds.on('bootstrap',(app)) - emitted before any middleware is added
 * - cds.on('loaded',(model)) - emitted when a model was loaded
 * - cds.on('connect',(srv)) - emitted when a service was connected
 * - cds.on('serving',(srv)) - emitted when a service was served
 * - cds.on('listening',({server,url})) - emitted when the server is listening
 *
 * @param {object} options - canonicalized options from `cds serve` cli
 * @param {boolean} options.in_memory - true if we need to bootstrap an in-memory database
 * @param {string} options.service - name of service to be served; default: 'all'
 * @param {string} options.from - filenames of models to load; default: '*'
 * @param {express.Application} options.app - filenames of models to load; default: '*'
 * @param {express.Handler} options.index - custom handler for /
 * @param {express.Handler} options.favicon - custom handler for /favicon.ico
 * @param {express.Handler} options.logger - custom request logger middleware
 * @returns Promise resolving to a Node.js http server as returned by express' `app.listen()`.
 */
module.exports = async function cds_server (options, o = { ...options, __proto__:defaults }) {

  const _in_prod = process.env.NODE_ENV === 'production'

  const app = cds.app = o.app || express()
  app.serve = _app_serve                          //> app.serve allows delegating to sub modules
  cds.emit ('bootstrap',app)                      //> hook for project-local server.js

  // mount static resources and logger middleware
  if (o.cors)      !_in_prod && app.use (o.cors)        //> CORS
  if (o.static)    app.use (express.static (o.static))  //> defaults to ./app
  if (o.favicon)   app.use ('/favicon.ico', o.favicon)  //> if none in ./app
  if (o.index)     app.get ('/',o.index)                //> if none in ./app
  if (o.correlate) app.use (o.correlate)                //> request correlation
  if (o.logger)    app.use (o.logger)                   //> basic request logging
  if (o.toggler)   app.use (o.toggler)                  //> feature toggler

  // give uiflex a chance to plug into everything
  if (cds.requires.extensibility) await require('./libx/_runtime/fiori/uiflex')() // REVISIT: later this should be a ext umbrella service

  // load specified models or all in project
  const csn = await cds.load (o.from||'*', {mocked:o.mocked})
  const m = cds.linked(csn).minified()
  cds.model = o.from = cds.linked (cds.compile.for.odata(m))

  // connect to essential framework services if required
  const _init = o.in_memory && (db => cds.deploy(m).to(db,o))
  if (cds.requires.db) cds.db =  await cds.connect.to ('db') .then (_init)
  if (cds.requires.messaging)    await cds.connect.to ('messaging')
  if (cds.requires.multitenancy) await cds.mtx.in (app)

  // serve graphql
  if (cds.env.features.graphql) serve_graphql(app)

  // serve all services declared in models
  await cds.serve (o.service,o).in (app)
  await cds.emit ('served', cds.services)               //> hook for listeners

  // start http server
  const port = (o.port !== undefined) ? o.port : (process.env.PORT || 4004)
  return app.listen (port)

}


// -------------------------------------------------------------------------
// Default handlers, which can be overidden by options passed to the server
//
const defaults = {

  cors, correlate,

  get static() { return cds.env.folders.app },  //> defaults to ./app

  // default generic index.html page
  get index() {
    const index = require ('./app/index.js')
    return (_,res) => res.send (index.html)
  },

  // default favicon
  get favicon() {
    const favicon = require.resolve ('./app/favicon.ico')
    return express.static (favicon, {maxAge:'14d'})
  },

  // default request logger
  get logger() {
    const LOG = cds.log(), DEBUG = cds.debug('server')
    return (req,_,next) => {
      LOG && LOG (req.method, decodeURI(req.url))
      if (/\$batch/.test(req.url))  req.on ('dispatch', (req) => {
        LOG && LOG ('>', req.event, decodeURI(req._path), req._query||'')
        if (DEBUG && req.query) DEBUG (req.query)
      })
      next()
    }
  },

  // feature toggler
  get toggler() {
    return require('./libx/_runtime/common/toggles/alpha')(cds)
  },
}


// Helpers to delegate to imported UIs
const path = require('path')
const _app_serve = function (endpoint) { return {
  from: (pkg,folder) => {
    folder = !folder ? pkg : path.resolve(require.resolve(pkg+'/package.json'),'../'+folder)
    this.use (endpoint, express.static(folder))
    if (!endpoint.endsWith('/webapp')) (this._app_links || (this._app_links = [])) .push (endpoint)
  }
}}


// register graphql router on served event
function serve_graphql (app) {
  cds.on('served', services => {
    const GraphQLAdapter = require('./libx/gql/GraphQLAdapter')
    app.use(new GraphQLAdapter(services, { graphiql: true }))
    cds.log()("serving GraphQL endpoint for all services { at: '/graphql' }")
  })
}


function cors (req, res, next) {
  const { origin } = req.headers
  if (origin) res.set('access-control-allow-origin', origin)
  if (origin && req.method === 'OPTIONS')
    return res.set('access-control-allow-methods', 'GET,HEAD,PUT,PATCH,POST,DELETE').end()
  next()
}

function correlate (req, res, next) {
  // derive correlation id from req
  const id = req.headers['x-correlation-id'] || req.headers['x-correlationid']
    || req.headers['x-request-id'] || req.headers['x-vcap-request-id']
    || cds.utils.uuid()
  // new intermediate cds.context, if necessary
  if (!cds.context) cds.context = { id }
  // guarantee x-correlation-id going forward and set on res
  req.headers['x-correlation-id'] = id
  res.set('x-correlation-id', id)
  // guaranteed access to cds.context._.req -> REVISIT
  if (!cds.context._) cds.context._ = {}
  if (!cds.context._.req) cds.context._.req = req
  next()
}


// -------------------------------------------------------------------------
if (!module.parent)  module.exports ({from:process.argv[2]})
