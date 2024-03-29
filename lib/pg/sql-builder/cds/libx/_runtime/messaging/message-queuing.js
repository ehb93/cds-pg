const cds = require('../cds.js')
const AMQPWebhookMessaging = require('./AMQPWebhookMessaging')
const AMQPClient = require('./common-utils/AMQPClient.js')

const optionsMessaging = require('./message-queuing-utils/options-messaging.js')
const optionsManagement = require('./message-queuing-utils/options-management.js')
const authorizedRequest = require('./common-utils/authorizedRequest')
const LOG = cds.log('messaging')

class MQManagement {
  constructor({ options, queueConfig, queueName, subscribedTopics }) {
    this.options = options
    this.queueConfig = queueConfig
    this.queueName = queueName
    this.subscribedTopics = subscribedTopics
  }

  async getQueue(queueName = this.queueName) {
    const res = await authorizedRequest({
      method: 'GET',
      uri: this.options.url,
      path: `/v1/management/queues/${encodeURIComponent(queueName)}`,
      oa2: this.options.auth.oauth2,
      attemptInfo: () => LOG._info && LOG.info('Get queue', { queue: queueName }),
      errMsg: `Queue "${queueName}" could not be retrieved`,
      target: { kind: 'QUEUE', queue: queueName },
      tokenStore: this
    })
    return res.body
  }

  async getQueues() {
    const res = await authorizedRequest({
      method: 'GET',
      uri: this.options.url,
      path: `/v1/management/queues`,
      oa2: this.options.auth.oauth2,
      attemptInfo: () => LOG._info && LOG.info('Get queues'),
      errMsg: `Queues could not be retrieved`,
      target: { kind: 'QUEUE' },
      tokenStore: this
    })
    return res.body && res.body.results
  }

  createQueue(queueName = this.queueName) {
    return authorizedRequest({
      method: 'PUT',
      uri: this.options.url,
      path: `/v1/management/queues/${encodeURIComponent(queueName)}`,
      oa2: this.options.auth.oauth2,
      dataObj: this.queueConfig,
      attemptInfo: () => LOG._info && LOG.info('Create queue', { queue: queueName }),
      errMsg: `Queue "${queueName}" could not be created`,
      target: { kind: 'QUEUE', queue: queueName },
      tokenStore: this
    })
  }

  deleteQueue(queueName = this.queueName) {
    return authorizedRequest({
      method: 'DELETE',
      uri: this.options.url,
      path: `/v1/management/queues/${encodeURIComponent(queueName)}`,
      oa2: this.options.auth.oauth2,
      attemptInfo: () => LOG._info && LOG.info('Delete queue', { queue: queueName }),
      errMsg: `Queue "${queueName}" could not be deleted`,
      target: { kind: 'QUEUE', queue: queueName },
      tokenStore: this
    })
  }

  async getSubscriptions(queueName = this.queueName) {
    const res = await authorizedRequest({
      method: 'GET',
      uri: this.options.url,
      path: `/v1/management/queues/${encodeURIComponent(queueName)}/subscriptions/topics`,
      oa2: this.options.auth.oauth2,
      attemptInfo: () => LOG._info && LOG.info('Get subscriptions', { queue: queueName }),
      errMsg: `Subscriptions for "${queueName}" could not be retrieved`,
      target: { kind: 'SUBSCRIPTION', queue: queueName },
      tokenStore: this
    })
    return res.body
  }

  createSubscription(topicPattern, queueName = this.queueName) {
    return authorizedRequest({
      method: 'PUT',
      uri: this.options.url,
      path: `/v1/management/queues/${encodeURIComponent(queueName)}/subscriptions/topics/${encodeURIComponent(
        topicPattern
      )}`,
      oa2: this.options.auth.oauth2,
      attemptInfo: () => LOG._info && LOG.info('Create subscription', { topic: topicPattern, queue: queueName }),
      errMsg: `Subscription "${topicPattern}" could not be added to queue "${queueName}"`,
      target: { kind: 'SUBSCRIPTION', queue: queueName, topic: topicPattern },
      tokenStore: this
    })
  }

  deleteSubscription(topicPattern, queueName = this.queueName) {
    return authorizedRequest({
      method: 'DELETE',
      uri: this.options.url,
      path: `/v1/management/queues/${encodeURIComponent(queueName)}/subscriptions/topics/${encodeURIComponent(
        topicPattern
      )}`,
      oa2: this.options.auth.oauth2,
      attemptInfo: () => LOG._info && LOG.info('Delete subscription', { topic: topicPattern, queue: queueName }),
      errMsg: `Subscription "${topicPattern}" could not be deleted from queue "${queueName}"`,
      target: { kind: 'SUBSCRIPTION', queue: queueName, topic: topicPattern },
      tokenStore: this
    })
  }

  async createQueueAndSubscriptions() {
    LOG._info && LOG.info(`Create messaging artifacts`)
    const created = await this.createQueue()
    if (created && created.statusCode === 200) {
      // We need to make sure to only keep our own subscriptions
      const resGet = await this.getSubscriptions()
      if (resGet && resGet.results && Array.isArray(resGet.results)) {
        const existingSubscriptions = resGet.results.map(s => s.topic)
        const obsoleteSubs = existingSubscriptions.filter(s => !this.subscribedTopics.has(s))
        const additionalSubs = [...this.subscribedTopics]
          .map(kv => kv[0])
          .filter(s => !existingSubscriptions.some(e => s === e))
        await Promise.all([
          ...obsoleteSubs.map(s => this.deleteSubscription(s)),
          ...additionalSubs.map(s => this.createSubscription(s))
        ])
        return
      }
    }
    await Promise.all([...this.subscribedTopics].map(kv => kv[0]).map(t => this.createSubscription(t)))
  }

  waitUntilReady() {
    return this
  }
}

class MessageQueuing extends AMQPWebhookMessaging {
  async init() {
    await super.init()
    await this.getClient().connect()
  }

  prepareTopic(topic, inbound) {
    return super.prepareTopic(topic, inbound).replace(/\./g, '/')
  }

  getClient() {
    if (this.client) return this.client
    const optionsAMQP = optionsMessaging(this.options)
    this.client = new AMQPClient({
      optionsAMQP,
      optionsApp: this.optionsApp,
      queueName: this.queueName,
      prefix: { topic: 'topic://', queue: 'queue://' }
    })
    return this.client
  }

  getManagement() {
    if (this.management) return this.management
    const _optionsManagement = optionsManagement(this.options)
    const queueConfig = this.queueConfig
    const queueName = this.queueName
    this.management = new MQManagement({
      options: _optionsManagement,
      queueConfig,
      queueName,
      subscribedTopics: this.subscribedTopics
    })
    return this.management
  }
}

module.exports = MessageQueuing
