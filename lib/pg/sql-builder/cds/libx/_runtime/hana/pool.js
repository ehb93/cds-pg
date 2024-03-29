const cds = require('../cds')
const LOG = cds.log('hana|db|sql')

const { pool } = require('@sap/cds-foss')
const hana = require('./driver')

const _require = require('../common/utils/require')

let im

function multiTenantInstanceManager(db = cds.env.requires.db) {
  const credentials = db.credentials
  if (
    !credentials ||
    typeof credentials !== 'object' ||
    !(credentials.get_managed_instance_url || credentials.sm_url)
  ) {
    throw Object.assign(new Error('No or malformed db credentials'), { credentials: credentials })
  }

  // new instance manager
  return new Promise((resolve, reject) => {
    // REVISIT: better cache settings? current copied from old cds-hana...
    // note: may need to be low for mtx tests -> configurable?
    const opts = Object.assign(credentials, {
      cache_max_items: 1,
      cache_item_expire_seconds: 1
    })
    // REVISIT: should be relative
    // const mtxPath = require.resolve('@sap/cds-mtx', { paths: [process.env.pwd(), __dirname] })
    // const imPath = require.resolve('@sap/instance-manager', { paths: [mtxPath] })
    // _require(imPath).create(opts, (err, res) => {
    _require('@sap/instance-manager').create(opts, (err, res) => {
      if (err) return reject(err)
      resolve(res)
    })
  })
}

function singleTenantInstanceManager(db = cds.env.requires.db) {
  const credentials = db.credentials

  if (!credentials || typeof credentials !== 'object' || !credentials.host) {
    throw Object.assign(new Error('No or malformed db credentials'), { credentials: credentials })
  }

  // mock instance manager
  return {
    get: (_, cb) => {
      cb(null, { credentials: credentials })
    }
  }
}

async function credentials4(tenant, credentials) {
  if (!im) {
    const opts = credentials ? { credentials } : undefined
    im = cds.env.requires.db.multiTenant ? await multiTenantInstanceManager(opts) : singleTenantInstanceManager(opts)
  }

  return new Promise((resolve, reject) => {
    im.get(tenant, (err, res) => {
      if (err) return reject(err)
      if (!res)
        return reject(Object.assign(new Error(`There is no instance for tenant "${tenant}"`), { statusCode: 404 }))
      resolve(res.credentials)
    })
  })
}

function factory4(creds, tenant) {
  return {
    create: function () {
      return hana.__connect(creds, tenant)
    },
    destroy: function (client) {
      return hana.__disconnect(client)
    },
    validate: function (client) {
      return hana.__isConnected(client)
    }
  }
}

/*
 * default generic-pool config
 */
const config = { min: 0, max: 100, testOnBorrow: true }

// REVISIT: copied from old cds-hana
const _getMassagedCreds = function (creds) {
  if (!('ca' in creds) && creds.certificate) {
    creds.ca = creds.certificate
  }
  if ('encrypt' in creds && !('useTLS' in creds)) {
    creds.useTLS = creds.encrypt
  }
  if ('hostname_in_certificate' in creds && !('sslHostNameInCertificate' in creds)) {
    creds.sslHostNameInCertificate = creds.hostname_in_certificate
  }
  if ('validate_certificate' in creds && !('sslValidateCertificate' in creds)) {
    creds.sslValidateCertificate = creds.validate_certificate
  }
  return creds
}

const _getPoolConfig = function () {
  const { pool: poolConfig } = cds.env.requires.db

  const mergedConfig = Object.assign({}, config, poolConfig)

  // defaults
  if (!poolConfig) {
    if (process.env.NODE_ENV === 'production') {
      mergedConfig.acquireTimeoutMillis = 1000
    } else {
      mergedConfig.acquireTimeoutMillis = 10 * 1000
    }
    mergedConfig.softIdleTimeoutMillis = 30 * 1000
    mergedConfig.idleTimeoutMillis = 30 * 1000
  }

  // if evictionRunIntervalMillis is not set specifically, set to 2x of idleTimeoutMillis or softIdleTimeoutMillis
  if (!('evictionRunIntervalMillis' in mergedConfig)) {
    mergedConfig.evictionRunIntervalMillis =
      2 * (mergedConfig.idleTimeoutMillis || mergedConfig.softIdleTimeoutMillis || 30 * 1000)
  }

  // if numTestsPerEvictionRun is not set specifically, set to ~30% of min-max delta
  if (!('numTestsPerEvictionRun' in mergedConfig) && mergedConfig.max - mergedConfig.min > 0) {
    mergedConfig.numTestsPerEvictionRun = Math.ceil((mergedConfig.max - mergedConfig.min) / 3)
  }

  return mergedConfig
}

const pools = new Map()

async function pool4(tenant, credentials) {
  if (!pools.get(tenant)) {
    pools.set(
      tenant,
      new Promise((resolve, reject) => {
        credentials4(tenant, credentials)
          .then(creds => {
            const config = _getPoolConfig()
            LOG._info && LOG.info('effective pool configuration:', config)
            const p = pool.createPool(factory4(_getMassagedCreds(creds), tenant), config)

            const INVALID_CREDENTIALS_WARNING = `Could not establish connection for tenant "${tenant}". Existing pool will be drained.`
            const INVALID_CREDENTIALS_ERROR = new Error(
              `Create is blocked for tenant "${tenant}" due to invalid credentials.`
            )

            /*
             * The error listener for "factoryCreateError" is registered in order to find out failed connection attempts.
             * If it fails due to invalid credentials, we delete the current pool from the pools map and overwrite the pool factory create function.
             * Background is that generic-pool will continue to try to open a connection by calling the factory create function until the "acquireTimeoutMillis" is reached.
             * This ends up in many connection attempts for one request even though the credentials are invalid.
             * Because of the deletion in the map, subsequent requests will fetch the credentials again.
             */
            p.on('factoryCreateError', async function (err) {
              if (err._connectError) {
                LOG._warn && LOG.warn(INVALID_CREDENTIALS_WARNING)
                pools.delete(tenant)
                if (p._factory && p._factory.create) {
                  // reject after 100 ms to not block CPU completely
                  p._factory.create = () =>
                    new Promise((resolve, reject) => setTimeout(() => reject(INVALID_CREDENTIALS_ERROR), 100))
                }
                await p.drain()
                await p.clear()
              }
            })

            resolve(p)
          })
          .catch(e => {
            // delete pools entry if fetching credentials failed
            pools.delete(tenant)
            reject(e)
          })
      }).then(p => {
        pools.set(tenant, p)
        return p
      })
    )
  }
  if ('then' in pools.get(tenant)) {
    pools.set(tenant, await pools.get(tenant))
  }

  return pools.get(tenant)
}

async function resilientAcquire(pool, attempts = 1) {
  // max 3 attempts
  attempts = Math.min(attempts, 3)
  let client
  let err
  let attempt = 0
  while (!client && attempt < attempts) {
    try {
      client = await pool.acquire()
    } catch (e) {
      if (e.name !== 'TimeoutError') throw e
      err = e
      attempt++
    }
  }
  if (client) return client
  err.statusCode = 503
  err.message =
    'Acquiring client from pool timed out. Please review your system setup, transaction handling, and pool configuration.'
  err._attempts = attempt
  throw err
}

module.exports = {
  acquire: async (tenant, credentials) => {
    const pool = await pool4(tenant, credentials)
    const _attempts = cds.env.requires.db.connection_attempts
    const attempts = _attempts && !isNaN(_attempts) && parseInt(_attempts)
    const client = await resilientAcquire(pool, attempts)
    client._pool = pool
    return client
  },
  release: client => {
    return client._pool.release(client)
  },
  drain: async tenant => {
    if (!pools.get(tenant)) {
      return
    }
    const p = await pool4(tenant)
    pools.delete(tenant)
    await p.drain()
    await p.clear()
  }
}
