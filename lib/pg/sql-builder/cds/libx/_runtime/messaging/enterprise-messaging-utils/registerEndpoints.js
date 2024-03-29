const cds = require('../../cds.js')
const LOG = cds.log('messaging')
const express = require('express')
const getTenantInfo = require('./getTenantInfo.js')
const isSecured = () => cds.requires.uaa && cds.requires.uaa.credentials
const { getTenant } = require('../../common/auth/strategies/utils/xssec.js')

const _isAll = a => a && a.includes('all')
const _hasScope = (scope, req) =>
  req && req.authInfo && req.authInfo.checkLocalScope && req.authInfo.checkLocalScope(scope)

class EndpointRegistry {
  constructor(basePath) {
    const deployPath = basePath + '/deploy'
    const paths = [basePath, deployPath]
    this.webhookCallbacks = new Map()
    this.deployCallbacks = new Map()
    if (isSecured()) {
      const JWTStrategy = require('../../common/auth/strategies/JWT.js')
      const passport = require('passport')
      passport.use(new JWTStrategy(cds.requires.uaa))
      paths.forEach(path => {
        cds.app.use(path, passport.initialize())
        cds.app.use(path, passport.authenticate('JWT', { session: false }))
      })
    }
    paths.forEach(path => {
      cds.app.use(path, express.json({ type: 'application/*+json' }))
      cds.app.use(path, express.json())
      cds.app.use(path, express.urlencoded({ extended: true }))
    })
    LOG._debug && LOG.debug('Register inbound endpoint', { basePath, method: 'OPTIONS' })

    // Clear cds.context as it would interfere with subsequent transactions
    cds.app.use(basePath, (_req, _res, next) => {
      cds.context = undefined
      next()
    })
    cds.app.use(deployPath, (_req, _res, next) => {
      cds.context = undefined
      next()
    })

    cds.app.options(basePath, (req, res) => {
      try {
        if (isSecured() && !_hasScope('emcallback', req)) return res.sendStatus(403)
        res.set('WebHook-Allowed-Origin', req.headers['webhook-request-origin'])
        res.sendStatus(200)
      } catch (error) {
        res.sendStatus(500)
      }
    })
    LOG._debug && LOG.debug('Register inbound endpoint', { basePath, method: 'POST' })
    cds.app.post(basePath, (req, res) => {
      try {
        if (isSecured() && !_hasScope('emcallback', req)) return res.sendStatus(403)
        const queueName = req.query.q
        const authInfo = req.authInfo
        const xAddress = req.headers['x-address']
        const topic = xAddress && xAddress.match(/^topic:(.*)/)[1]
        const payload = req.body
        const cb = this.webhookCallbacks.get(queueName)
        if (!topic || !payload || !queueName || !cb) return res.sendStatus(200)
        const tenantId = getTenant(authInfo)
        const other = authInfo
          ? {
              _: { req: { authInfo, headers: {}, query: {} } }, // for messaging to retrieve subdomain
              user: new cds.User.Privileged(),
              tenant: tenantId
            }
          : {}
        if (!cb) return res.sendStatus(200)
        cb(topic, payload, other, {
          done: () => {
            res.sendStatus(200)
          },
          failed: () => {
            res.sendStatus(500)
          }
        })
      } catch (error) {
        return res.sendStatus(500)
      }
    })
    cds.app.post(deployPath, async (req, res) => {
      try {
        if (isSecured() && !_hasScope('emmanagement', req)) return res.sendStatus(403)
        const tenants = req.body && !_isAll(req.body.tenants) && req.body.tenants
        const queues = req.body && !_isAll(req.body.queues) && req.body.queues
        const options = { wipeData: req.body && req.body.wipeData }

        if (tenants && !Array.isArray(tenants)) res.send(400).send('Request parameter `tenants` must be an array.')
        if (queues && !Array.isArray(queues)) res.send(400).send('Request parameter `queues` must be an array.')

        const tenantInfo = tenants ? await Promise.all(tenants.map(t => getTenantInfo(t))) : await getTenantInfo()

        const callbacks = queues ? queues.map(q => this.deployCallbacks.get(q)) : [...this.deployCallbacks.values()]
        const results = await Promise.all(callbacks.map(c => c(tenantInfo, options)))

        // [{ queue: '...', failed: [...], succeeded: [...] }, ...]
        const hasError = results.some(r => r.failed.length)
        if (hasError) return res.status(500).send(results)
        return res.status(201).send(results)
      } catch (mtxError) {
        // If an unknown tenant id is provided, cds-mtx will crash ("Cannot read property 'hanaClient' of undefined")
        return res.sendStatus(500)
      }
    })
  }

  registerWebhookCallback(queueName, cb) {
    this.webhookCallbacks.set(queueName, cb)
  }

  registerDeployCallback(queueName, cb) {
    this.deployCallbacks.set(queueName, cb)
  }
}

// Singleton registries per basePath
const registries = new Map()

// REVISIT: Use cds mechanism instead of express? -> Need option method and handler for specifica
const registerWebhookEndpoints = (basePath, queueName, cb) => {
  const registry =
    registries.get(basePath) || (registries.set(basePath, new EndpointRegistry(basePath)) && registries.get(basePath))
  registry.registerWebhookCallback(queueName, cb)
}

const registerDeployEndpoints = (basePath, queueName, cb) => {
  const registry =
    registries.get(basePath) || (registries.set(basePath, new EndpointRegistry(basePath)) && registries.get(basePath))
  registry.registerDeployCallback(queueName, cb)
}

// Only needed for testing, not used in productive code
const __clearRegistries = () => registries.clear()

module.exports = { registerWebhookEndpoints, registerDeployEndpoints, __clearRegistries }
