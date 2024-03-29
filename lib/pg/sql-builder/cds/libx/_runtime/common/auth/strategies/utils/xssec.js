const getUserId = (user, info) => {
  // fallback for grant_type=client_credentials (xssec v3)
  return user.id || (info && info.getClientId && info.getClientId())
}

const _addRolesFromGrantType = (roles, info) => {
  const grantType = info && (info.grantType || (info.getGrantType && info.getGrantType()))
  if (grantType) {
    // > not "weak"
    roles.push('authenticated-user')
    if (['client_credentials', 'client_x509'].includes(grantType)) {
      roles.push('system-user')
    }
  }
}

const getRoles = (roles, info) => {
  _addRolesFromGrantType(roles, info)

  // convert to object
  roles = Object.assign(...roles.map(ele => ({ [ele]: true })))

  if (info && info.checkLocalScope && typeof info.checkLocalScope === 'function') {
    // > xssec v3
    const _roles = roles
    roles = new Proxy(_roles, {
      get: function (_, role) {
        return role in _roles ? _roles[role] : info.checkLocalScope(role)
      }
    })
  }

  return roles
}

const getAttrForJWT = info => {
  if (!info) {
    return {}
  }

  if (info.getAttribute && typeof info.getAttribute === 'function') {
    // > xssec v3
    return new Proxy(
      {},
      {
        get: function (_, attr) {
          return info.getAttribute(attr)
        }
      }
    )
  }

  return {}
}

// xssec v3 only
const getAttrForXSSEC = info => {
  if (!info) return {}

  return new Proxy(
    {},
    {
      get: function (_, attr) {
        // try to get saml attribute via API (getEmail, getFamilyName, etc.)
        try {
          const getter = `get${attr[0].toUpperCase()}${attr.slice(1)}`
          if (info[getter] && typeof info[getter] === 'function') {
            return info[getter]()
          }
        } catch (e) {
          // ignore
        }

        // default to getAttribute
        return info.getAttribute(attr)
      }
    }
  )
}

const getTenant = info => {
  // xssec v3
  return info && info.getZoneId && info.getZoneId()
}

module.exports = {
  getUserId,
  getRoles,
  getAttrForJWT,
  getAttrForXSSEC,
  getTenant
}
