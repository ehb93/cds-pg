module.exports = Object.assign ( serve, {
    options: [
        '--service', '--from', '--to', '--at', '--with',
        '--port',
    ],
    flags: [
        '--project', '--projects',
        '--in-memory', '--in-memory?',
        '--mocked', '--with-mocks', '--with-bindings',
        '--watch',
    ],
    shortcuts: [ '-s', undefined, '-2', '-a', '-w', '-p' ],
    help: `
# SYNOPSIS

    *cds serve* [ <filenames> ] [ <options> ]
    *cds serve* [  <service>  ] [ <options> ]

    Starts http servers that load service definitions from cds models and
    construct service providers, mounted to respective endpoints to serve
    incoming requests.

    If the given argument refers to existing files, an effective model
    is loaded from these files and *all services*, that are served.
    The default is '*', which loads all models from the project.

    If the given argument doesn't match an existing file, it's used
    as the name of the *single service* to serve.


# OPTIONS


    *-s | --service* <name>  (default: 'all')

        Serve a _single service_ from specified model(s).
        EXAMPLE: *cds serve --service CatalogService*

    *-f | --from* <model>    (default: '*')

        Load service definitions from specified folder(s).
        EXAMPLE: *cds serve --from srv*

    *-w | --with* <impl>

        Define which implementation to use (i.e. a _.js_ file).
        EXAMPLE: *cds serve --service CatalogService --with srv/cat-service.js*

    *-a | --at* <endpoint>

        Add endpoint to bind the service to.
        EXAMPLE: *cds serve --at localhost:3030*

    *-2 | --to* <protocol>

        Decide on the protocol (i.e. _fiori_, _odata_, or _rest_) to serve.
        EXAMPLE: *cds serve --to odata*

    *-p | --project* [<project>]

        Runs _cds serve all_ for the specified project; default: cwd.
        You can use *cds run* as shortcut.

    *--port* <number>

        Specify the port on which the launched server shall listen.
        If you specify '0', the server picks a random free port.
        Alternatively, specify the port using env variable _PORT_.

    *--watch* [<project>]

        Like *--project* but starts through _nodemon_ to restart the server
        upon changes in code or models.
        You can use *cds watch* as shortcut, which is equivalent to:
        *cds serve --with-mocks --in-memory? --watch --project ...*

    *--mocked*

        Use this option to launch a _single service_  in a mock server, for
        a model you imported from an external source, like an S/4 system,.
        In addition to constructing the service provider, this will bootstrap
        a transient _in-memory_ database, filled with tables corresponding
        to the signatures of the service's exposed entities.

    *--with-mocks*

        Use this in combination with the variants serving _multiple services_.
        It starts in-process mock services for all required services configured
        in _package.json#cds.requires_, which don't have external bindings
        in the current process environment.
        Note that by default, this feature is disabled in production and must be
        enabled with configuration 'features.mocked_bindings=true'.

    *--with-bindings*

        Use this option in local tests, to have all services provided by a
        process registered with their physical urls in a temporary file.
        All required services are bound automatically upon bootstrapping.
        Option *--with-mocks* subsumes this option.

    *--in-memory[?]*

        Automatically adds a transient in-memory database bootstrapped on
        each (re-)start in the same way *cds deploy* would do, based on defaults
        or configuration in _package.json#cds.requires.db_. Add a question
        mark to apply a more defensive variant which respects the configured
        database, if any, and only adds an in-memory database if no
        persistent one is configured.

        Requires an sqlite driver to be installed. For example: _npm i sqlite3_.

# EXAMPLES

    *cds serve*
    *cds serve* all
    *cds serve* CatalogService *--from* app/
    *cds serve* CatalogService *--from* srv/ *--at* /cats *--to* rest
    *cds serve* all --watch --with-mocks --in-memory?
    *cds run* some/project
    *cds watch* some/project
    *cds watch*

`})


const cds = require('../lib'), { exists, isfile, local, path } = cds.utils
let log = console.log // provisional logger, see _prepareLogging

/**
 * The main function which dispatches into the respective usage variants.
 * @param {string[]} all - project folder, model filenames, or service name
 */
async function serve (all=[], o={}) { // NOSONAR

  // canonicalize options to ease subsequent tasks...
  const [pms] = all // project folder, model filenames, or service name
  if (o.from)                o.from = o.from.split(',')
  if (o.project||o.projects) { o.project = pms; o.service='all'; o.from='*' }
  else if (o.service)        { o.from    = pms ? pms.split(',') : '*'}
  else if (o.from)           { o.service = pms }
  else if (exists(pms))      { o.service ='all', o.from = all }
  else                       { o.service = pms,  o.from = '*' }

  // IMPORTANT: never load any @sap/cds modules before the chdir above happened!
  // handle --watch and --project
  if (o.watch)  return _watch (o.project,o)   // cds serve --watch <project>
  if (o.project) _chdir_to (o.project)      // cds run --project <project>
  if (!o.silent) _prepare_logging ()

  // The following things are meant for dev mode, which can be overruled by feature flagse...
  const {features} = cds.env
  {
    // handle --with-mocks resp. --mocked
    if (!features.no_mocking) o.mocked = _with_mocks (o)

    // handle --in-memory resp. --in-memory?
    if (features.in_memory_db) o.in_memory = _in_memory (o)

    // load service bindings when mocking or asked to
    if (features.mocked_bindings && o.mocked || o['with-bindings']) await cds.service.bindings

    // live reload, in cooperation with cds watch
    if (features.live_reload)  require('../app/etc/livereload')

    // add dev helper for Fiori URLs
    if (features.fiori_routes) require('../app/fiori/routes')

    // add fiori preview links to default index.html
    if (features.fiori_preview) require('../app/fiori/preview')

  }

  // bootstrap server from project-local server.js or from @sap/cds/server.js
  const cds_server = _local_server_js() || cds.server
  const server = await cds_server(o)

  // return a promise which resolves to the created http server when listening
  return cds.server.listening = new Promise ((_resolve,_reject) => {
    const _started = ()=>{
      const url = cds.server.url = `http://localhost:${server.address().port}`
      cds.emit ('listening', {server,url}) //> inform local listeners
      _resolve (server)
    }
    server.listening ? _started(server) : server.once('listening',_started)
    server.on ('error',_reject) // startup errors like EADDRINUSE
    return server
  })
}


function _local_server_js() {
  const _local = file => isfile(file) || isfile (path.join(cds.env.folders.srv,file))
  let server_js = process.env.CDS_TYPESCRIPT && _local('server.ts') || _local('server.js')
  if (server_js) {
    log && log ('Loading server from', { file: local(server_js) })
    const fn = require (server_js)
    return typeof fn === 'function' ? fn : cds.error `${local(server_js)} must export a function`
  }
}


function _prepare_logging () { // NOSONAR
  // change `log` function to cds.log
  const LOG = cds.log('serve', { prefix:'cds' })
  log = LOG._info && LOG.info

  const _timer = log && `[cds] - launched at ${new Date().toLocaleString()}, in`
  _timer && console.time (_timer)

  // print information when model is loaded
  cds.on ('loaded', (model)=>{
    log && log (`model loaded from ${model.$sources.length} file(s):\n\x1b[2m`)
    for (let each of model.$sources)  log && console.log (' ', local(each))
    log && console.log ('\x1b[0m')
  })

  // print information about each connected service
  cds.on ('connect', ({name,kind,options:{use,credentials}})=>{
    log && log (`connect to ${name} > ${use||kind}`, credentials ? _redacted(credentials) : '')
  })

  // print information about each provided service
  cds.on ('serving', (srv) => {
    const details = { at: srv.path }
    if (srv._source) details.impl = local(srv._source)
    log && log (`${srv.mocked ? 'mocking' : 'serving'} ${srv.name}`, details)
  })

  // print info when we are finally on air
  cds.once ('listening', ({url})=>{
    log && console.log ()
    log && log ('server listening on',{url})
    _timer && console.timeEnd (_timer)
    if (process.stdin.isTTY) log && log (`[ terminate with ^C ]\n`)
  })

  return cds
}


/** handles --watch option */
function _watch (project,o) {
  o.args = process.argv.slice(2) .filter (a => a !== '--watch' && a !== '-w')
  return require('@sap/cds-dk/bin/watch')([project],o)
}


/** handles --project option */
function _chdir_to (project) {
  // try using the given project as dirname, e.g. './bookshop'
  const dir = cds.utils.isdir (project)
  if (dir) return cds.root = dir
  // try using the given project as a node package name, e.g. '@capire/bookshop'
  try { cds.root = path.dirname (require.resolve(project+'/package.json')) }
  // both failed
  catch(_){ cds.error `No such folder or package: '${process.cwd()}' -> '${project}'` }
}


/** handles --in-memory option */
function _in_memory (o) {
  const {env} = cds, db = env.requires.db
  if (o['in-memory'] || o['in-memory?'] && !db) {
    env.add ({ requires: { db: {
      kind:'sqlite', ...env.requires.sqlite,
      credentials:{database:':memory:'}
    }}})
    return true
  }
  if (db && db.credentials && (db.credentials.database || db.credentials.url) === ':memory:') {
    return true
  }
}


/** handles --with-mocks option */
function _with_mocks (o) {
  if (process.env.NODE_ENV === 'production') return
  if (o.mocked || (o.mocked = o['with-mocks'])) {
    cds.on ('loaded', model => cds.deploy.include_external_entities_in(model))
    const mocks = cds.env.features.test_mocks && isfile ('test/mocked.js')
    if (mocks) cds.once ('served', ()=> {
      log && log ('adding mock behaviours from', { file: local(mocks) })
      require(mocks)
    })
    return true
  }
}


const SECRETS = /(password)|(certificate)|(ca)|(clientsecret)/i // 'certificate' and 'ca' on HANA
/** mascades password-like strings, also reducing clutter in output */
function _redacted(cred) {
  if (!cred) return cred
  if (Array.isArray(cred)) return cred.map(_redacted)
  if (typeof cred === 'object') {
    const newCred = Object.assign({}, cred)
    Object.keys(newCred).forEach(k => (typeof newCred[k] === 'string' && SECRETS.test(k)) ? (newCred[k] = '...') : (newCred[k] = _redacted(newCred[k])))
    return newCred
  }
  return cred
}

/* eslint no-console:off */
