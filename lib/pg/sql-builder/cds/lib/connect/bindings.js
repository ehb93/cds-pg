const DEBUG = /\b(y|all|serve)\b/.test (process.env.DEBUG) && console.warn
// || console.debug

const cds = require ('..')
const { readFile, readFileSync, writeFile, writeFileSync } = require ('fs')
const [ read, write ] = [ readFile, writeFile ].map(require('util').promisify)
const registry = '~/.cds-services.json'

/** TODO: Add documentation */
module.exports = class Bindings {

    static get registry(){ return registry }

    static then(r,e) {
        const LOG = cds.log('serve', { prefix:'cds' })
        const bindings = new Bindings
        cds.prependOnceListener ('connect', ()=> LOG._info && LOG.info ('connect using bindings from:', { registry }))
        cds.once('listening', ({url})=> bindings.export (cds.service.providers, url))
        return bindings.import() .then (r,e)
    }

    constructor(url) {
        this._source = require ('path') .resolve (cds.root, registry.replace(/^~/, require('os').homedir()))
        this.cds = {provides:{}}
        this.url = url
    }

    async load (sync) {
        DEBUG && DEBUG('[cds] - reading bindings from:', this._source)
        try { Object.assign (this, JSON.parse (sync ? readFileSync (this._source) : await read (this._source))) }
        catch (e) { /* ignored */ }
        return this
    }
    async store (sync) {
        DEBUG && DEBUG ('[cds] - writing bindings to:', this._source)
        const json = JSON.stringify ({cds:this.cds},null,'  ')
        return sync ? writeFileSync (this._source, json) : write (this._source, json)
    }

    async import() {
        const required = cds.requires; if (!required) return this
        const provided = (await this.load()) .cds.provides
        for (let each in required) {
            const req = required[each], bound = provided [req.service||each]
            if (bound) {
              Object.assign (req.credentials || (req.credentials = {}), bound.credentials)
              // REVISIT: temporary fix to inherit kind as well for mocked odata services
              // otherwise mocking with two services does not work for kind:odata-v2
              if (req.kind === 'odata-v2' || req.kind === 'odata-v4') req.kind = 'odata'
            }
        }
        return this
    }

    async export (services, url) {
        this.cleanup (this.url = url)
        // register our services
        const provides = this.cds.provides
        for (let each of services) {
            // if (each.name in cds.env.requires)  continue
            const options = each.options || {}
            provides[each.name] = {
                kind: options.to || 'odata',
                credentials: {
                    ...options.credentials,
                    url: url + each.path
                }
            }
        }
        process.on ('exit', ()=>this.purge())
        return this.store()
    }

    purge() {
        this.load(true)
        DEBUG && DEBUG ('[cds] - purging bindings from:', this._source)
        this.cleanup()
        this.store(true)
    }

    cleanup (url=this.url) {
        // remove all services served at the same url
        const all = this.cds.provides
        for (let [key,srv] of Object.entries (all)) {
            if (srv.credentials && srv.credentials.url && srv.credentials.url.startsWith(url))  delete all [key]
        }
        return this
    }
}

const {NODE_ENV} = process.env
if (NODE_ENV === 'test' || global.it || cds.env.no_bindings) {
    module['exports'] = { then: (r) => r() }
}
/* eslint no-console:off */
