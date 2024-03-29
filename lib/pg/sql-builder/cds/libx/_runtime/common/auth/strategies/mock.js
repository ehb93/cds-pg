const cds = require('../../../cds')

const CHALLENGE = 'Basic realm="Users"'

const _getUser = (users, id) => {
  let user

  for (const k in users) {
    if (k === id || users[k].ID === id) {
      user = users[k]
      break
    }
  }

  if (!user && users['*']) user = { id }

  return user
}

const _getRoles = user => {
  const _roles = ['any', 'identified-user', 'authenticated-user']

  if (user.roles) {
    _roles.push(...user.roles)
  }

  if (user.jwt) {
    const scopes = user.jwt.scope || user.jwt.scopes || []
    const aud = user.jwt.aud || []
    _roles.push(
      ...scopes.map(s => {
        for (const each of aud) {
          s = s.replace(`${each}.`, '')
        }
        return s
      })
    )
  }

  if (user.jwt && (user.jwt.grant_type === 'client_credentials' || user.jwt.grant_type === 'client_x509')) {
    _roles.push('system-user')
  }

  return _roles
}

class MockStrategy {
  constructor(users, name = 'mock') {
    this.name = name
    this.users = users || cds.env.requires.auth.users || {}
  }

  authenticate(req) {
    const authorization = req.headers.authorization
    if (!authorization) return this.fail(CHALLENGE)

    const [scheme, base64] = authorization.split(' ')
    if (!scheme || scheme.toLowerCase() !== 'basic') return this.fail(CHALLENGE)
    if (!base64) return this.fail(400)

    const [id, password] = Buffer.from(base64, 'base64').toString().split(':')

    let user = _getUser(this.users, id)
    if (!user) return this.fail(CHALLENGE)
    if (user.password && user.password !== password) return this.fail(CHALLENGE)

    const _roles = _getRoles(user)
    const attr = Object.assign({}, user.userAttributes, user.jwt && user.jwt.userInfo, user.jwt && user.jwt.attributes)
    const tenant = user.tenant || (user.jwt && user.jwt.zid) || null

    user = new cds.User({ id: user.ID || id, _roles, attr, tenant })

    // set _req for locale getter
    Object.defineProperty(user, '_req', { enumerable: false, value: req })

    this.success(user)
  }
}

module.exports = MockStrategy
