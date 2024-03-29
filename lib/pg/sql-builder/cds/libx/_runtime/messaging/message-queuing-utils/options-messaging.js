const _checkRequiredCredentials = options => {
  if (!options || !options.credentials || !options.credentials.management || !options.credentials.amqp10) {
    throw new Error(
      'No amqp10ws credentials found. Hint: You need to bind your app to a Message Queuing service or provide the necessary credentials through environment variables.'
    )
  }
}

module.exports = options => {
  _checkRequiredCredentials(options)
  const [host, port] = options.credentials.amqp10.url.replace(/^amqps:\/\//, '').split(':')

  const amqp = {
    tls: {
      servername: host,
      host,
      port: Number(port)
    },
    sasl: {
      mechanism: 'PLAIN',
      user: options.credentials.amqp10.auth.basic.userName,
      password: options.credentials.amqp10.auth.basic.password
    }
  }
  return amqp
}
