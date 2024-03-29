const cds = require('../cds.js')
const AMQPWebhookMessaging = require('./AMQPWebhookMessaging.js')
const optionsMessaging = require('./enterprise-messaging-utils/options-messaging.js')
const optionsManagement = require('./enterprise-messaging-utils/options-management.js')
const EMManagement = require('./enterprise-messaging-utils/EMManagement.js')
const optionsForSubdomain = require('./common-utils/optionsForSubdomain.js')
const authorizedRequest = require('./common-utils/authorizedRequest')
const sleep = require('util').promisify(setTimeout)
const {
  registerDeployEndpoints,
  registerWebhookEndpoints
} = require('./enterprise-messaging-utils/registerEndpoints.js')
const LOG = cds.log('messaging')
const cloudEvents = require('./enterprise-messaging-utils/cloudEvents.js')

const BASE_PATH = '/messaging/enterprise-messaging'

const _checkAppURL = appURL => {
  if (!appURL)
    throw new Error(
      'Enterprise Messaging: You need to provide an HTTPS endpoint to your application.\n\nHint: You can set the application URI in environment variable `VCAP_APPLICATION.application_uris[0]`. This is needed because incoming messages are delivered through HTTP via webhooks.\nExample: `{ ..., "VCAP_APPLICATION": { "application_uris": ["my-app.com"] } }`\nIn case you want to use Enterprise Messaging in shared (that means single-tenant) mode, you can use kind `enterprise-messaging-amqp`.'
    )
  if (appURL.startsWith('https://localhost'))
    throw new Error(
      'The endpoint of your application is local and cannot be reached from Enterprise Messaging.\n\nHint: For local development you can set up a tunnel to your local endpoint and enter its public https endpoint in `VCAP_APPLICATION.application_uris[0]`.\nIn case you want to use Enterprise Messaging in shared (that means single-tenant) mode, you can use kind `enterprise-messaging-amqp`.'
    )
}

// REVISIT: It's bad to have to rely on the subdomain.
// For all interactions where we perform the token exchange ourselves,
// we will be able to use the zoneId instead of the subdomain.
const _subdomainFromContext = context =>
  context && context._ && context._.req && context._.req.authInfo && context._.req.authInfo.getSubdomain()

class EnterpriseMessaging extends AMQPWebhookMessaging {
  init() {
    cloudEvents.defaultOptions(this.options)
    return super.init()
  }

  // Needs to be run after `served` event, otherwise `ProvisioningService` might not be available.
  // REVISIT: We should register the handlers before, otherwise a tenant subscription
  // immediately after app start won't trigger those handlers.
  async addMTXHandlers() {
    const provisioning = await cds.connect.to('ProvisioningService')
    const tenantPersistence = await cds.connect.to('TenantPersistenceService')
    tenantPersistence.impl(() => {
      tenantPersistence.on('createTenant', async (req, next) => {
        const res = await next()
        const subdomain = req.data.subscriptionData.subscribedSubdomain
        const management = await this.getManagement(subdomain).waitUntilReady()
        await management.deploy()
        return res
      })
    })
    provisioning.impl(() => {
      provisioning.on('DELETE', 'tenant', async (req, next) => {
        const subdomain = req.data.subscribedSubdomain
        try {
          const management = await this.getManagement(subdomain).waitUntilReady()
          await management.undeploy()
        } catch (error) {
          LOG._error && LOG.error('Failed to delete messaging artifacts for subdomain', subdomain, '(', error, ')')
        }
        return next()
      })
      provisioning.on('dependencies', async (req, next) => {
        LOG._info && LOG.info('Include Enterprise-Messaging as SaaS dependency')
        const res = await next()
        const xsappname = this.options.credentials && this.options.credentials.xsappname
        if (xsappname) {
          const exists = res.some(d => d.xsappname === xsappname)
          if (!exists) res.push({ xsappname })
        }
        return res
      })
    })
  }

  startListening() {
    const doNotDeploy = cds._mtxEnabled && !this.options.deployForProvider
    if (doNotDeploy) LOG._info && LOG.info('Skipping deployment of messaging artifacts for provider account')
    super.startListening({ doNotDeploy })
    if (!doNotDeploy && this.subscribedTopics.size) {
      const management = this.getManagement()
      // Webhooks will perform an OPTIONS call on creation to check the availability of the app.
      // On systems like Cloud Foundry the app URL will only be advertised once
      // the app is healthy, i.e. when the health check was performed successfully.
      // Therefore we need to wait a few seconds (configurable) to make sure the app
      // can be reached from Enterprise Messaging.
      const waitingPeriod = this.options.webhook && this.options.webhook.waitingPeriod
      if (waitingPeriod === 0) return this.queued(management.createWebhook.bind(management))()
      sleep(waitingPeriod || 5000).then(() => this.queued(management.createWebhook.bind(management))())
    }
  }

  async listenToClient(cb) {
    _checkAppURL(this.optionsApp.appURL)
    registerWebhookEndpoints(BASE_PATH, this.queueName, cb)
    if (cds._mtxEnabled) {
      await this.addMTXHandlers()
      registerDeployEndpoints(BASE_PATH, this.queueName, async (tenantInfo, options) => {
        const result = { queue: this.queueName, succeeded: [], failed: [] }
        await Promise.all(
          tenantInfo.map(async info => {
            try {
              const management = await this.getManagement(info.subdomain).waitUntilReady()
              if (options.wipeData) await management.undeploy()
              await management.deploy()
              result.succeeded.push(info.tenant)
            } catch (error) {
              LOG._error && LOG.error('Failed to create messaging artifacts for subdomain', info.subdomain, ':', error)
              result.failed.push({ error: error.message, tenant: info.tenant })
            }
          })
        )
        return result
      })
    }
  }

  getManagement(subdomain) {
    const _subdomain = (typeof subdomain === 'string' && subdomain) || _subdomainFromContext(this.context || subdomain)
    const optsManagement = optionsManagement(this.options)
    const queueConfig = this.queueConfig
    const queueName = this.queueName
    const optsManagementSwitched = _subdomain
      ? optionsForSubdomain.oa2ForSubdomain(optsManagement, _subdomain)
      : optsManagement
    const optionsMessagingREST = optionsMessaging(this.options, 'httprest')
    const optionsMessagingRESTSwitched = _subdomain
      ? optionsForSubdomain.oa2ForSubdomain(optionsMessagingREST, _subdomain)
      : optionsMessagingREST
    const optionsWebhook = { ...this.options.webhook }
    delete optionsWebhook.waitingPeriod

    return new EMManagement({
      optionsManagement: optsManagementSwitched,
      queueConfig,
      queueName,
      optionsMessagingREST: optionsMessagingRESTSwitched,
      optionsWebhook,
      optionsApp: this.optionsApp,
      maxRetries: this.options.maxRetries,
      path: `${BASE_PATH}?q=${this.queueName}`,
      subscribedTopics: this.subscribedTopics,
      alternativeTopics: this.alternativeTopics,
      subdomain: _subdomain,
      namespace: this.options.credentials && this.options.credentials.namespace
    })
  }

  async emit(event, ...etc) {
    const msg = this.message4(event, ...etc)
    const optionsMessagingREST = optionsMessaging(this.options, 'httprest')
    const context = this.context || cds.context
    const tenant = context && context.tenant
    const topic = msg.event
    const message = { ...(msg.headers || {}), data: msg.data }
    let errMsg = `Message with topic "${topic}" could not be sent`
    if (tenant) errMsg += ' (tenant: ' + tenant + ')'

    await this.queued(() => {})()

    return authorizedRequest({
      method: 'POST',
      uri: optionsMessagingREST.uri,
      path: `/messagingrest/v1/topics/${encodeURIComponent(topic)}/messages`,
      oa2: optionsMessagingREST.oa2,
      tenant,
      dataObj: message,
      headers: {
        'x-qos': 1
      },
      attemptInfo: () => LOG._info && LOG.info('Emit', { topic }),
      errMsg,
      target: { kind: 'MESSAGE', topic },
      tokenStore: {}
    })
  }

  wildcarded(topic) {
    return topic.replace(/.*?\/.*?\/.*?\//, '+/+/+/')
  }

  prepareTopic(topic, inbound) {
    return cloudEvents.prepareTopic(topic, inbound, this.options, super.prepareTopic.bind(this))
  }

  prepareHeaders(headers, event) {
    cloudEvents.prepareHeaders(headers, event, this.options, super.prepareHeaders.bind(this))
  }
}

module.exports = EnterpriseMessaging
