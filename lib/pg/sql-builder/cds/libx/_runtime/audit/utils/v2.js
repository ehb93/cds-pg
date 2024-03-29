const cds = require('../../cds')
const LOG = cds.log('audit-log')

const { getObjectAndDataSubject, getAttributeToLog } = require('./log')

function connect(credentials) {
  return new Promise((resolve, reject) => {
    let auditLogging
    try {
      auditLogging = require('@sap/audit-logging')
    } catch (e) {
      LOG._warn &&
        LOG.warn('Unable to require module @sap/audit-logging. Make sure it is installed if audit logging is required.')
      return resolve()
    }
    try {
      auditLogging.v2(credentials, function (err, auditLog) {
        if (err) return reject(err)
        resolve(auditLog)
      })
    } catch (e) {
      LOG._warn && LOG.warn('Unable to initialize audit-logging client with error:', e)
      return resolve()
    }
  })
}

function sendDataAccessLog(entry) {
  return new Promise((resolve, reject) => {
    entry.log(function (err) {
      if (err && LOG._warn) {
        err.message = 'Writing data access log failed with error: ' + err.message
        return reject(err)
      }

      resolve()
    })
  })
}

function sendDataModificationLog(entry) {
  return new Promise((resolve, reject) => {
    entry.logPrepare(function (err) {
      if (err) {
        err.message = 'Preparing data modification log failed with error: ' + err.message
        return reject(err)
      }

      entry.logSuccess(function (err) {
        if (err) {
          err.message = 'Writing data modification log failed with error: ' + err.message
          return reject(err)
        }

        resolve()
      })
    })
  })
}

function sendSecurityLog(entry) {
  return new Promise((resolve, reject) => {
    entry.log(function (err) {
      if (err) {
        err.message = 'Writing security log failed with error: ' + err.message
        return reject(err)
      }

      resolve()
    })
  })
}

function sendConfigChangeLog(entry) {
  return new Promise((resolve, reject) => {
    entry.logPrepare(function (err) {
      if (err) {
        err.message = 'Preparing configuration change log failed with error: ' + err.message
        return reject(err)
      }

      entry.logSuccess(function (err) {
        if (err) {
          err.message = 'Writing configuration change log failed with error: ' + err.message
          return reject(err)
        }

        resolve()
      })
    })
  })
}

function buildDataAccessLogs(alc, accesses, tenant, user) {
  const entries = []
  const errors = []

  for (const access of accesses) {
    try {
      const { dataObject, dataSubject } = getObjectAndDataSubject(access)
      const entry = alc.read(dataObject).dataSubject(dataSubject).tenant(tenant).by(user)
      for (const each of access.attributes) entry.attribute(each)
      for (const each of access.attachments) entry.attachment(each)
      entries.push(entry)
    } catch (err) {
      err.message = 'Building data access log failed with error: ' + err.message
      errors.push(err)
    }
  }

  return { entries, errors }
}

function buildDataModificationLogs(alc, modifications, tenant, user) {
  const entries = []
  const errors = []

  for (const modification of modifications) {
    try {
      const { dataObject, dataSubject } = getObjectAndDataSubject(modification)
      const entry = alc.update(dataObject).dataSubject(dataSubject).tenant(tenant).by(user)
      for (const each of modification.attributes) entry.attribute(getAttributeToLog(each))
      entries.push(entry)
    } catch (err) {
      err.message = 'Building data modification log failed with error: ' + err.message
      errors.push(err)
    }
  }

  return { entries, errors }
}

function buildSecurityLog(alc, action, data, tenant, user) {
  let entry

  try {
    entry = alc.securityMessage('action: %s, data: %s', action, data)
    if (tenant) entry.tenant(tenant)
    if (user) entry.by(user)
  } catch (err) {
    err.message = 'Building security log failed with error: ' + err.message
    throw err
  }

  return entry
}

function buildConfigChangeLogs(alc, configurations, tenant, user) {
  const entries = []
  const errors = []

  for (const configuration of configurations) {
    try {
      const { dataObject } = getObjectAndDataSubject(configuration)
      const entry = alc.configurationChange(dataObject).tenant(tenant).by(user)
      for (const each of configuration.attributes) entry.attribute(getAttributeToLog(each))
      entries.push(entry)
    } catch (err) {
      err.message = 'Building configuration change log failed with error: ' + err.message
      errors.push(err)
    }
  }

  return { entries, errors }
}

module.exports = {
  connect,
  buildDataAccessLogs,
  buildDataModificationLogs,
  buildSecurityLog,
  buildConfigChangeLogs,
  sendDataAccessLog,
  sendDataModificationLog,
  sendSecurityLog,
  sendConfigChangeLog
}
