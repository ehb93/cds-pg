const AMQPWebhookMessaging = require('./AMQPWebhookMessaging')
const AMQPClient = require('./common-utils/AMQPClient')
const optionsMessaging = require('./enterprise-messaging-utils/options-messaging.js')
const optionsManagement = require('./enterprise-messaging-utils/options-management.js')
const EMManagement = require('./enterprise-messaging-utils/EMManagement.js')
const cloudEvents = require('./enterprise-messaging-utils/cloudEvents.js')

class EnterpriseMessagingShared extends AMQPWebhookMessaging {
  async init() {
    await super.init()
    await this.getClient().connect()
    cloudEvents.defaultOptions(this.options)
  }

  getClient() {
    if (this.client) return this.client
    const optionsAMQP = optionsMessaging(this.options, 'amqp10ws')
    this.client = new AMQPClient({
      optionsAMQP,
      optionsApp: this.optionsApp,
      queueName: this.queueName,
      prefix: { topic: 'topic:', queue: 'queue:' }
    })
    return this.client
  }

  getManagement() {
    if (this.management) return this.management
    const optsManagement = optionsManagement(this.options)
    const queueConfig = this.queueConfig
    const queueName = this.queueName
    this.management = new EMManagement({
      optionsManagement: optsManagement,
      queueConfig,
      queueName,
      subscribedTopics: this.subscribedTopics,
      alternativeTopics: this.alternativeTopics,
      namespace: this.options.credentials && this.options.credentials.namespace
    })
    return this.management
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

module.exports = EnterpriseMessagingShared
