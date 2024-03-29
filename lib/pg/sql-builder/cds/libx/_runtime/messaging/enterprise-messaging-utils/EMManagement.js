const authorizedRequest = require('../common-utils/authorizedRequest')
const cds = require('../../cds.js')
const LOG = cds.log('messaging')
const sleep = require('util').promisify(setTimeout)

const _getWebhookName = queueName => queueName

// REVISIT: Maybe use `error` definitions as in req.error?

class EMManagement {
  constructor({
    optionsManagement,
    queueConfig,
    queueName,
    optionsMessagingREST,
    optionsWebhook,
    path,
    optionsApp,
    subscribedTopics,
    maxRetries,
    subdomain,
    namespace
  }) {
    this.subdomain = subdomain
    this.options = optionsManagement
    this.queueConfig = queueConfig
    this.queueName = queueName
    this.optionsMessagingREST = optionsMessagingREST
    this.optionsWebhook = optionsWebhook
    this.path = path
    this.optionsApp = optionsApp
    this.subscribedTopics = subscribedTopics
    this.maxRetries = maxRetries === undefined ? 10 : maxRetries
    this.subdomainInfo = this.subdomain ? `(subdomain: ${this.subdomain})` : ''
    this.namespace = namespace
  }

  async getQueue(queueName = this.queueName) {
    const res = await authorizedRequest({
      method: 'GET',
      uri: this.options.uri,
      path: `/hub/rest/api/v1/management/messaging/queues/${encodeURIComponent(queueName)}`,
      oa2: this.options.oa2,
      attemptInfo: () =>
        LOG._info &&
        LOG.info('Get queue', this.subdomain ? { queue: queueName, subdomain: this.subdomain } : { queue: queueName }),
      errMsg: `Queue "${queueName}" could not be retrieved ${this.subdomainInfo}`,
      target: { kind: 'QUEUE', queue: queueName },
      tokenStore: this
    })
    return res.body
  }

  async getQueues() {
    const res = await authorizedRequest({
      method: 'GET',
      uri: this.options.uri,
      path: `/hub/rest/api/v1/management/messaging/queues`,
      oa2: this.options.oa2,
      attemptInfo: () => LOG._info && LOG.info('Get queues', this.subdomain ? { subdomain: this.subdomain } : {}),
      errMsg: `Queues could not be retrieved ${this.subdomainInfo}`,
      target: { kind: 'QUEUE' },
      tokenStore: this
    })
    return res.body
  }

  createQueue(queueName = this.queueName) {
    return authorizedRequest({
      method: 'PUT',
      uri: this.options.uri,
      path: `/hub/rest/api/v1/management/messaging/queues/${encodeURIComponent(queueName)}`,
      oa2: this.options.oa2,
      dataObj: this.queueConfig,
      attemptInfo: () =>
        LOG._info &&
        LOG.info(
          'Create queue',
          this.subdomain ? { queue: queueName, subdomain: this.subdomain } : { queue: queueName }
        ),
      errMsg: `Queue "${queueName}" could not be created ${this.subdomainInfo}`,
      target: { kind: 'QUEUE', queue: queueName },
      tokenStore: this
    })
  }

  deleteQueue(queueName = this.queueName) {
    return authorizedRequest({
      method: 'DELETE',
      uri: this.options.uri,
      path: `/hub/rest/api/v1/management/messaging/queues/${encodeURIComponent(queueName)}`,
      oa2: this.options.oa2,
      attemptInfo: () =>
        LOG._info &&
        LOG.info(
          'Delete queue',
          this.subdomain ? { queue: queueName, subdomain: this.subdomain } : { queue: queueName }
        ),
      errMsg: `Queue "${queueName}" could not be deleted ${this.subdomainInfo}`,
      target: { kind: 'QUEUE', queue: queueName },
      tokenStore: this
    })
  }

  async getSubscriptions(queueName = this.queueName) {
    const res = await authorizedRequest({
      method: 'GET',
      uri: this.options.uri,
      path: `/hub/rest/api/v1/management/messaging/queues/${encodeURIComponent(queueName)}/subscriptions`,
      oa2: this.options.oa2,
      attemptInfo: () =>
        LOG._info &&
        LOG.info(
          'Get subscriptions',
          this.subdomain ? { queue: queueName, subdomain: this.subdomain } : { queue: queueName }
        ),
      errMsg: `Subscriptions for "${queueName}" could not be retrieved ${this.subdomainInfo}`,
      target: { kind: 'SUBSCRIPTION', queue: queueName },
      tokenStore: this
    })
    return res.body
  }

  createSubscription(topicPattern, queueName = this.queueName) {
    return authorizedRequest({
      method: 'PUT',
      uri: this.options.uri,
      path: `/hub/rest/api/v1/management/messaging/queues/${encodeURIComponent(
        queueName
      )}/subscriptions/${encodeURIComponent(topicPattern)}`,
      oa2: this.options.oa2,
      attemptInfo: () =>
        LOG._info &&
        LOG.info(
          'Create subscription',
          this.subdomain
            ? { topic: topicPattern, queue: queueName, subdomain: this.subdomain }
            : { topic: topicPattern, queue: queueName }
        ),
      errMsg: `Subscription "${topicPattern}" could not be added to queue "${queueName}" ${this.subdomainInfo}`,
      target: { kind: 'SUBSCRIPTION', queue: queueName, topic: topicPattern },
      tokenStore: this
    })
  }

  deleteSubscription(topicPattern, queueName = this.queueName) {
    return authorizedRequest({
      method: 'DELETE',
      uri: this.options.uri,
      path: `/hub/rest/api/v1/management/messaging/queues/${encodeURIComponent(
        queueName
      )}/subscriptions/${encodeURIComponent(topicPattern)}`,
      oa2: this.options.oa2,
      attemptInfo: () =>
        LOG._info &&
        LOG.info(
          'Delete subscription',
          this.subdomain
            ? { topic: topicPattern, queue: queueName, subdomain: this.subdomain }
            : { topic: topicPattern, queue: queueName }
        ),
      errMsg: `Subscription "${topicPattern}" could not be deleted from queue "${queueName}" ${this.subdomainInfo}`,
      target: { kind: 'SUBSCRIPTION', queue: queueName, topic: topicPattern },
      tokenStore: this
    })
  }

  async getWebhook(queueName = this.queueName) {
    const webhookName = _getWebhookName(queueName)
    const res = await authorizedRequest({
      method: 'GET',
      uri: this.optionsMessagingREST.uri,
      path: `/messagingrest/v1/subscriptions/${encodeURIComponent(webhookName)}`,
      oa2: this.optionsMessagingREST.oa2,
      attemptInfo: () =>
        LOG._info &&
        LOG.info(
          'Get webhook',
          this.subdomain
            ? { webhook: webhookName, queue: queueName, subdomain: this.subdomain }
            : { webhook: webhookName, queue: queueName }
        ),
      errMsg: `Webhook "${webhookName}" could not be retrieved ${this.subdomainInfo}`,
      target: { kind: 'WEBHOOK', queue: queueName, webhook: webhookName },
      tokenStore: this
    })
    return res.body
  }

  async createWebhook(queueName = this.queueName) {
    const webhookName = _getWebhookName(queueName)
    await authorizedRequest({
      method: 'DELETE',
      uri: this.optionsMessagingREST.uri,
      path: `/messagingrest/v1/subscriptions/${encodeURIComponent(webhookName)}`,
      oa2: this.optionsMessagingREST.oa2,
      attemptInfo: () =>
        LOG._info &&
        LOG.info(
          'Delete webhook',
          this.subdomain
            ? { webhook: webhookName, queue: queueName, subdomain: this.subdomain }
            : { webhook: webhookName, queue: queueName }
        ),
      errMsg: `Webhook "${webhookName}" could not be deleted ${this.subdomainInfo}`,
      target: { kind: 'WEBHOOK', queue: queueName, webhook: webhookName },
      tokenStore: this
    })
    const pushConfig = {
      type: 'webhook',
      endpoint: this.optionsApp.appURL + this.path,
      exemptHandshake: false,
      defaultContentType: 'application/json'
    }

    // Use credentials from Enterprise Messaging.
    // For it to work, you'll need to add scopes in your
    // xs-security.json:
    //
    // scopes: [{
    //   "name": "$XSAPPNAME.em",
    //   "description": "EM Callback Access",
    //   "grant-as-authority-to-apps": ["$XSSERVICENAME(messaging-name)"]
    // }]
    pushConfig.securitySchema = {
      type: 'oauth2',
      grantType: 'client_credentials',
      clientId: this.optionsMessagingREST.oa2.client,
      clientSecret: this.optionsMessagingREST.oa2.secret,
      tokenUrl: this.optionsMessagingREST.oa2.endpoint
    }

    const dataObj = {
      name: webhookName,
      address: `queue:${queueName}`,
      qos: 1,
      ...(this.optionsWebhook || {}),
      pushConfig: { ...pushConfig, ...((this.optionsWebhook && this.optionsWebhook.pushConfig) || {}) }
    }

    return authorizedRequest({
      method: 'POST',
      uri: this.optionsMessagingREST.uri,
      path: '/messagingrest/v1/subscriptions',
      oa2: this.optionsMessagingREST.oa2,
      dataObj,
      attemptInfo: () =>
        LOG._info &&
        LOG.info(
          'Create webhook',
          this.subdomain
            ? { webhook: webhookName, queue: queueName, subdomain: this.subdomain }
            : { webhook: webhookName, queue: queueName }
        ),
      errMsg: `Webhook "${webhookName}" could not be created ${this.subdomainInfo}`,
      target: { kind: 'WEBHOOK', queue: queueName, webhook: webhookName },
      tokenStore: this
    })
  }

  deleteWebhook(queueName = this.queueName) {
    const webhookName = _getWebhookName(queueName)
    return authorizedRequest({
      method: 'DELETE',
      uri: this.optionsMessagingREST.uri,
      path: `/messagingrest/v1/subscriptions/${encodeURIComponent(webhookName)}`,
      oa2: this.optionsMessagingREST.oa2,
      attemptInfo: () =>
        LOG._info &&
        LOG.info(
          'Delete webhook',
          this.subdomain
            ? { webhook: webhookName, queue: queueName, subdomain: this.subdomain }
            : { webhook: webhookName, queue: queueName }
        ),
      errMsg: `Webhook "${webhookName}" could not be deleted ${this.subdomainInfo}`,
      target: { kind: 'WEBHOOK', queue: queueName, webhook: webhookName },
      tokenStore: this
    })
  }

  async createQueueAndSubscriptions() {
    LOG._info && LOG.info(`Create messaging artifacts ${this.subdomainInfo}`)

    const created = await this.createQueue()
    if (created && created.statusCode === 200) {
      // We need to make sure to only keep our own subscriptions
      const resGet = await this.getSubscriptions()
      if (Array.isArray(resGet)) {
        const existingSubscriptions = resGet.map(s => s.topicPattern)
        const obsoleteSubs = existingSubscriptions.filter(s => !this.subscribedTopics.has(s))
        const additionalSubs = [...this.subscribedTopics]
          .map(kv => kv[0])
          .filter(s => !existingSubscriptions.some(e => s === e))
        const unchangedSubs = []
        // eslint-disable-next-line no-unused-vars
        for (const [s, _] of this.subscribedTopics) {
          if (existingSubscriptions.some(e => s === e)) unchangedSubs.push(s)
        }
        LOG._info && LOG.info('Unchanged subscriptions', unchangedSubs, ' ', this.subdomainInfo)
        await Promise.all([
          ...obsoleteSubs.map(s => this.deleteSubscription(s)),
          ...additionalSubs.map(async s => this._createSubscription(s))
        ])
        return
      }
    }
    await Promise.all([...this.subscribedTopics].map(kv => kv[0]).map(t => this._createSubscription(t)))
  }

  _throwIfNotBadRequest(e) {
    // If it's not a bad request, immediately throw,
    // otherwise throw a better error message.
    if (!e.response || !e.response.statusCode >= 500 || e.response.statusCode < 400) throw e
  }

  async _createSubscription(sub) {
    try {
      await this.createSubscription(sub)
    } catch (e) {
      this._throwIfNotBadRequest(e)
      throw new Error(
        `Topic subscription "${sub}" cannot be created. Hint: Please check the topic rules of your SAP Event Mesh instance.`
      )
    }
  }

  async deploy() {
    await this.createQueueAndSubscriptions()
    if (this.optionsMessagingREST) await this.createWebhook()
  }

  async undeploy() {
    LOG._info && LOG.info(`Delete messaging artifacts ${this.subdomainInfo}`)
    await this.deleteQueue()
    if (this.optionsMessagingREST) await this.deleteWebhook()
  }

  readinessCheck() {
    return authorizedRequest({
      method: 'GET',
      uri: this.options.uri,
      path: `/hub/rest/api/v1/management/messaging/readinessCheck`,
      oa2: this.options.oa2,
      attemptInfo: () => LOG._info && LOG.info(`Readiness Check ${this.subdomainInfo}`),
      errMsg: `Readiness Check failed ${this.subdomainInfo}`,
      target: { kind: 'READINESSCHECK' },
      tokenStore: this
    })
  }

  async waitUntilReady({ maxRetries = this.maxRetries, waitingPeriod } = {}) {
    let tries = 0
    const check = async () => {
      try {
        tries++
        await this.readinessCheck()
      } catch (e) {
        if (tries <= maxRetries) {
          if (e.response.statusCode !== 503) {
            const errMsg = 'Readiness Check cannot be performed: ' + JSON.stringify(e.response)
            const errObj = new Error(errMsg)
            errObj.target = e.target
            throw errObj
          }
          const retryAfter = e.response && e.response.headers && e.response.headers['retry-after']
          const _waitingPeriod = waitingPeriod || (retryAfter && Number(retryAfter) * 1000) || 120 * 1000
          LOG._info &&
            LOG.info(`Readiness Check failed ${this.subdomainInfo}, retrying in ${_waitingPeriod / 1000} seconds...`)
          await sleep(_waitingPeriod)
          await check()
        } else {
          const errObj = new Error('Readiness Check: Maximum tries exceeded', {
            tokenEndpoint: this.options.oa2.endpoint,
            uri: this.options.uri
          })
          errObj.target = e.target
          throw errObj
        }
      }
    }
    await check()
    return this
  }
}

module.exports = EMManagement
