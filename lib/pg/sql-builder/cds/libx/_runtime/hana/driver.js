const cds = require('../cds')
const LOG = cds.log('hana|db|sql')

/*
 * dynatrace
 */

const { dynatraceClient, isDynatraceEnabled } = require('./dynatrace')

/*
 * common
 */

const _ensureError = err => (err instanceof Error ? err : Object.assign(new Error(err.message), err))

/*
 * hdb
 */
const _addCheckServerIdentity = creds => {
  // REVISIT: copied from old cds-hana
  if (creds.sslValidateCertificate === false && creds.sslHostNameInCertificate) {
    const allowedHost = creds.sslHostNameInCertificate
    creds.checkServerIdentity = host => {
      if (host !== allowedHost) {
        throw new Error(
          `The name on the security certificate "${allowedHost}" is invalid or does not match the name of the site "${host}".`
        )
      }
    }
  }
}

function _connectHdb(creds, tenant) {
  _addCheckServerIdentity(creds)

  return new Promise((resolve, reject) => {
    // tls keep alive
    if (process.env.HDB_TCP_KEEP_ALIVE_IDLE) {
      const num = Number(process.env.HDB_TCP_KEEP_ALIVE_IDLE)
      creds.tcpKeepAliveIdle = Number.NaN(num) ? false : num
    }

    const hdbClient = this.createClient(creds)
    hdbClient.name = this.name // TODO find better way?

    const client = isDynatraceEnabled() ? dynatraceClient(hdbClient, creds, tenant) : hdbClient

    const start = LOG._debug && Date.now()
    client.connect(err => {
      if (err) {
        err = _ensureError(err)
        err.message = `Could not establish connection for tenant "${tenant}" due to error: ` + err.message
        LOG._error && LOG.error(err)

        // error on .connect shall lead to pool drain
        err._connectError = true

        reject(err)
      } else {
        if (creds.schema) {
          client.exec(`SET SCHEMA ${creds.schema}`, err => {
            if (err) {
              err.message = `Could not set schema "${creds.schema}" due to error: ` + err.message
              reject(err)
            } else {
              LOG._debug && LOG.debug(`Elapsed time to create new database connection: ${Date.now() - start}ms`)
              resolve(client)
            }
          })
        } else {
          LOG._debug && LOG.debug(`Elapsed time to create new database connection: ${Date.now() - start}ms`)
          resolve(client)
        }

        client.once('error', err => {
          client.hadError = true
          if (LOG._warn) {
            err.message = 'Client error: ' + err.message
            LOG.warn(err)
          }
        })
      }
    })
  })
}

/*
 * hana-client
 */

function _connectHanaClient(creds, tenant) {
  return new Promise((resolve, reject) => {
    const hanaClient = this.createConnection()

    hanaClient.name = this.name // TODO find better way?
    // ugly, but we need it for the hana-client streaming extension.
    // "client" does not contain the credentials in case of hana-client.
    hanaClient._creds = creds

    const client = isDynatraceEnabled() ? dynatraceClient(hanaClient, creds, tenant) : hanaClient

    if (creds.schema) {
      // REVISIT
      creds.CURRENTSCHEMA = creds.schema
    }

    const start = LOG._debug && Date.now()
    client.connect(creds, err => {
      if (err) {
        err = _ensureError(err)
        err.message = `Could not establish connection for tenant "${tenant}" due to error: ` + err.message
        LOG._error && LOG.error(err)

        // error on .connect shall lead to pool drain
        err._connectError = true

        reject(err)
      } else {
        LOG._debug && LOG.debug(`Elapsed time to create new database connection: ${Date.now() - start}ms`)
        resolve(client)
      }
    })
  })
}

/*
 * facade
 */

let driver

const _getHanaDriver = (name = 'hdb') => {
  if (driver) return driver

  try {
    driver = Object.assign({ name }, require(name))

    driver.__connect = (...args) =>
      name === 'hdb' ? _connectHdb.call(driver, ...args) : _connectHanaClient.call(driver, ...args)
    driver.__disconnect = client => {
      return new Promise(resolve => {
        client.disconnect(err => {
          // REVISIT: what to do? ignore? crash app?
          if (err) {
            if (LOG._warn) {
              err.message = 'Could not disconnect due to error: ' + err.message
              LOG.warn(err)
            }
            resolve()
          } else resolve()
        })
      })
    }
    driver.__isConnected = client => {
      if (name === 'hdb') {
        return !client.hadError && client.readyState === 'connected'
      }

      return client.state() === 'connected'
    }

    return driver
  } catch (e) {
    if (name === 'hdb') {
      LOG._debug && LOG.debug(`Failed to require "hdb" with error "${e.message}". Trying "@sap/hana-client" next.`)
      return _getHanaDriver('@sap/hana-client')
    } else {
      throw new Error(
        'Neither "hdb" nor "@sap/hana-client" could be required. Please make sure one of them is installed.'
      )
    }
  }
}

module.exports = _getHanaDriver('hdb')
