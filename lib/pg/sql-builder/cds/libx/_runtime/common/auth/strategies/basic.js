const cds = require('../../../cds')

const _require = require('../../utils/require')

// use _require for a better error message
const { BasicStrategy: BS } = _require('passport-http')

class BasicStrategy extends BS {
  constructor(credentials) {
    super(function (user, password, done) {
      if (credentials[user] === password) {
        done(null, new cds.User({ id: user }))
      } else {
        this.fail()
      }
    })
  }
}

module.exports = BasicStrategy
