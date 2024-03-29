const dynatrace = {}
try {
  dynatrace.sdk = require('@dynatrace/oneagent-sdk')
  dynatrace.api = dynatrace.sdk.createInstance()
} catch (err) {
  // If module was not required, do not do anything
}

const isDynatraceEnabled = () => {
  return dynatrace.sdk !== undefined
}

const _dynatraceResultCallback = function (tracer, cb) {
  return function (err, results, fields) {
    if (err) {
      tracer.error(err)
    } else {
      tracer.setResultData({
        rowsReturned: (results && results.length) || results
      })
    }
    tracer.end(cb, err, results, fields)
  }
}

const _execUsingDynatrace = (client, execFn, dbInfo) => {
  // args = [sql, options, callback] --> options is optional
  return function (...args) {
    const cb = args[args.length - 1]

    const tracer = dynatrace.api.traceSQLDatabaseRequest(dbInfo, {
      statement: args[0]
    })

    tracer.startWithContext(execFn, client, ...args.slice(0, args.length - 1), _dynatraceResultCallback(tracer, cb))
  }
}

const _preparedStmtUsingDynatrace = function (client, prepareFn, dbInfo) {
  // args = [sql, options, callback] --> options is optional
  return function (...args) {
    const cb = args[args.length - 1]

    const tracer = dynatrace.api.traceSQLDatabaseRequest(dbInfo, {
      statement: args[0]
    })

    tracer.startWithContext(prepareFn, client, ...args.slice(0, args.length - 1), (err, stmt) => {
      if (err) {
        tracer.error(err)
        tracer.end(cb, err)
      } else {
        // same here. hana-client does not like decorating
        const originalExecFn = stmt.exec
        stmt.exec = function (...args) {
          const stmtCb = args[args.length - 1]
          originalExecFn.call(stmt, ...args.slice(0, args.length - 1), _dynatraceResultCallback(tracer, stmtCb))
        }
        cb(null, stmt)
      }
    })
  }
}

const dynatraceClient = (client, credentials, tenant) => {
  const dbInfo = {
    name: `SAPHANA${tenant === 'anonymous' ? '' : `-${tenant}`}`,
    vendor: dynatrace.sdk.DatabaseVendor.HANADB,
    host: credentials.host,
    port: Number(credentials.port)
  }

  // hana-client does not like decorating.
  // because of that, we need to override the fn and pass the original fn for execution
  const originalExecFn = client.exec
  const originalPrepareFn = client.prepare
  client.exec = _execUsingDynatrace(client, originalExecFn, dbInfo)
  client.prepare = _preparedStmtUsingDynatrace(client, originalPrepareFn, dbInfo)

  return client
}

const _createHanaClientStreamingStatement = function (extension, createStmtFn) {
  // args = [sql, options, callback] --> options is optional
  return function (dbc, sql, cb) {
    const dbInfo = {
      name: `SAPHANA${dbc._tenant === 'anonymous' ? '' : `-${dbc._tenant}`}`,
      vendor: dynatrace.sdk.DatabaseVendor.HANADB,
      host: dbc._creds.host,
      port: Number(dbc._creds.port)
    }

    const tracer = dynatrace.api.traceSQLDatabaseRequest(dbInfo, {
      statement: sql
    })

    tracer.startWithContext(createStmtFn, extension, dbc, sql, (err, stmt) => {
      if (err) {
        tracer.error(err)
        tracer.end(cb, err)
      } else {
        // same here. hana-client does not like decorating
        const originalExecFn = stmt.stmt.exec
        stmt.stmt.exec = function (...args) {
          const stmtCb = args[args.length - 1]
          originalExecFn.call(stmt.stmt, ...args.slice(0, args.length - 1), _dynatraceResultCallback(tracer, stmtCb))
        }
        cb(null, stmt)
      }
    })
  }
}

const dynatraceStreamingExtension = extension => {
  const originalCreateStmtFn = extension.createStatement
  const decorator = {}
  Object.setPrototypeOf(decorator, extension)
  // ensure that dynatrace calls the original function of the extension
  decorator.createStatement = _createHanaClientStreamingStatement(extension, originalCreateStmtFn)

  return decorator
}

module.exports = { dynatraceClient, dynatraceStreamingExtension, isDynatraceEnabled }
