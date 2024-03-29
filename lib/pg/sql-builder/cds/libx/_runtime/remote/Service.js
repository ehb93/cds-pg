const cds = require('../cds')
const LOG = cds.log('remote')

// REVISIT: use cds.log's logger in cloud sdk

// disable sdk logger if not in debug mode
if (!LOG._debug) {
  try {
    const sdkUtils = require('@sap-cloud-sdk/util')
    sdkUtils.setGlobalLogLevel('error')
  } catch (err) {
    /* might fail in cds repl due to winston's exception handler, see cap/issues#10134 */
  }
}

const { resolveView, getTransition, restoreLink, findQueryTarget } = require('../common/utils/resolveView')
const { postProcess } = require('../common/utils/postProcessing')
const { getKind, run, getDestination, getAdditionalOptions, getReqOptions } = require('./utils/client')
const { formatVal } = require('../../odata/utils')

const _isSimpleCqnQuery = q => typeof q === 'object' && q !== null && !Array.isArray(q) && Object.keys(q).length > 0

const _setHeaders = (defaultHeaders, req) => {
  return Object.assign(
    defaultHeaders,
    Object.keys(req.headers).reduce((acc, cur) => {
      acc[cur.toLowerCase()] = req.headers[cur]
      return acc
    }, {})
  )
}
const _setCorrectValue = (el, data, params, kind) => {
  return typeof data[el] === 'object' && kind !== 'odata-v2'
    ? JSON.stringify(data[el])
    : formatVal(data[el], el, { elements: params }, kind)
}

// v4: builds url like /function(p1=@p1,p2=@p2,p3=@p3)?@p1=val&@p2={...}&@p3=[...]
// v2: builds url like /function?p1=val1&p2=val2 for functions and actions
const _buildPartialUrlFunctions = (url, data, params, kind = 'odata-v4') => {
  const funcParams = []
  const queryOptions = []
  for (const el in data) {
    if (kind === 'odata-v2') {
      funcParams.push(`${el}=${_setCorrectValue(el, data, params, kind)}`)
    } else {
      funcParams.push(`${el}=@${el}`)
      queryOptions.push(`@${el}=${_setCorrectValue(el, data, params, kind)}`)
    }
  }
  return kind === 'odata-v2'
    ? `${url}?${funcParams.join('&')}`
    : `${url}(${funcParams.join(',')})?${queryOptions.join('&')}`
}

const _extractParamsFromData = (data, params) => {
  return Object.keys(data).reduce((res, el) => {
    if (params[el]) Object.assign(res, { [el]: data[el] })
    return res
  }, {})
}

const _buildKeys = (req, kind) => {
  const keys = []
  for (const key in req.target.keys) {
    keys.push(`${key}=${formatVal(req.data[key], key, req.target, kind)}`)
  }
  return keys
}

const _handleBoundActionFunction = (srv, def, req, url) => {
  if (def.kind === 'action') {
    return srv.post(url, def.params ? _extractParamsFromData(req.data, def.params) : {})
  }

  if (def.params) {
    const data = _extractParamsFromData(req.data, def.params)
    url = _buildPartialUrlFunctions(url, data, def.params)
  } else url = `${url}()`

  return srv.get(url)
}

const _handleUnboundActionFunction = (srv, def, req, event) => {
  if (def.kind === 'action') {
    return srv.post(`/${event}`, req.data)
  }

  const url =
    Object.keys(req.data).length > 0 ? _buildPartialUrlFunctions(`/${event}`, req.data, def.params) : `/${event}()`
  return srv.get(url)
}

const _handleV2ActionFunction = (srv, def, req, event, kind) => {
  const url =
    Object.keys(req.data).length > 0 ? _buildPartialUrlFunctions(`/${event}`, req.data, def.params, kind) : `/${event}`
  return def.kind === 'function' ? srv.get(url) : srv.post(url, {})
}

const _addHandlerActionFunction = (srv, def, target) => {
  const event = def.name.match(/\w*$/)[0]
  if (target) {
    srv.on(event, target, async function (req) {
      const shortEntityName = req.target.name.replace(`${this.namespace}.`, '')
      const url = `/${shortEntityName}(${_buildKeys(req, this.kind).join(',')})/${this.namespace}.${event}`
      return _handleBoundActionFunction(srv, def, req, url)
    })
  } else {
    srv.on(event, async function (req) {
      if (this.kind === 'odata-v2') return _handleV2ActionFunction(srv, def, req, event, this.kind)
      return _handleUnboundActionFunction(srv, def, req, event)
    })
  }
}

const _selectOnlyWithAlias = q => {
  return q && q.SELECT && !q.SELECT._transitions && q.SELECT.columns && q.SELECT.columns.some(c => c.as)
}

const resolvedTargetOfQuery = q => {
  const transitions = (typeof q === 'object' && (q.SELECT || q.INSERT || q.UPDATE || q.DELETE)._transitions) || []
  return transitions.length && [transitions.length - 1].target
}

class RemoteService extends cds.Service {
  init() {
    if (!this.options.credentials) {
      throw new Error(`No credentials configured for "${this.name}".`)
    }

    this.datasource = this.options.datasource
    this.destinationOptions = this.options.destinationOptions
    this.destination =
      this.options.credentials.destination ||
      getDestination((this.definition && this.definition.name) || this.datasource, this.options.credentials)
    this.requestTimeout = this.options.credentials.requestTimeout
    if (this.requestTimeout == null) this.requestTimeout = 60000
    this.path = this.options.credentials.path
    this.kind = getKind(this.options) // TODO: Simplify

    const clearKeysFromData = function (req) {
      if (req.target && req.target.keys) for (const k of Object.keys(req.target.keys)) delete req.data[k]
    }
    this.before('UPDATE', '*', Object.assign(clearKeysFromData, { _initial: true }))

    for (const each of this.entities) {
      for (const a in each.actions) {
        _addHandlerActionFunction(this, each.actions[a], each)
      }
    }

    for (const each of this.operations) {
      _addHandlerActionFunction(this, each)
    }

    this.on('*', async (req, next) => {
      let { query } = req
      if (!query && !(typeof req.path === 'string')) return next()
      if (cds.env.features.resolve_views === false && typeof query === 'object' && this.model) {
        query = resolveView(query, this.model, this)
      }

      const resolvedTarget = resolvedTargetOfQuery(query) || getTransition(req.target, this).target
      const reqOptions = getReqOptions(req, query, this)
      reqOptions.headers = _setHeaders(reqOptions.headers, req)
      const additionalOptions = getAdditionalOptions(
        req,
        this.destination,
        this.kind,
        resolvedTarget,
        this.destinationOptions
      )

      // hidden compat flag in order to suppress logging response body of failed request
      if (req._suppressRemoteResponseBody) {
        additionalOptions.suppressRemoteResponseBody = req._suppressRemoteResponseBody
      }

      let result = await run(reqOptions, additionalOptions)

      result =
        typeof query === 'object' && query.SELECT && query.SELECT.one && Array.isArray(result) ? result[0] : result

      return cds.env.features.resolve_views === false && typeof query === 'object' ? postProcess(query, result) : result
    })
  }

  // Overload .handle in order to resolve projections up to a definition that is known by the remote service instance.
  // Result is post processed according to the inverse projection in order to reflect the correct result of the original query.
  async handle(req) {
    // compat mode
    if (req._resolved || cds.env.features.resolve_views === false) return super.handle(req)

    if (req.target && req.target.name && this.definition && req.target.name.startsWith(this.definition.name + '.')) {
      const result = await super.handle(req)
      // only post process if alias was explicitely set in query
      if (_selectOnlyWithAlias(req.query)) {
        return postProcess(req.query, result, this, true)
      }
      return result
    }

    // req.query can be:
    // - empty object in case of unbound action/function
    // - undefined/null in case of plain string queries
    if (_isSimpleCqnQuery(req.query) && this.model) {
      const q = resolveView(req.query, this.model, this)
      const t = findQueryTarget(q) || req.target

      // compat
      restoreLink(req)

      // REVISIT: We need to provide target explicitly because it's cached already within ensure_target
      const newReq = new cds.Request({ query: q, target: t, headers: req.headers, _resolved: true })
      const result = await super.dispatch(newReq)

      return postProcess(q, result, this, true)
    }

    return super.handle(req)
  }
}

module.exports = RemoteService
