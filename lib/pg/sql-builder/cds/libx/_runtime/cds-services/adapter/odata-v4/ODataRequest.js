const cds = require('../../../cds')
// requesting logger without module on purpose!
const LOG = cds.log()

const {
  uri: {
    UriResource: {
      ResourceKind: { BOUND_ACTION, BOUND_FUNCTION, ACTION_IMPORT, FUNCTION_IMPORT }
    }
  }
} = require('./okra/odata-server')

const { findCsnTargetFor } = require('../../../common/utils/csn')

const odataToCQN = require('./odata-to-cqn')
const { getData, getParams } = require('./utils/data')
const { isCustomOperation } = require('./utils/request')
const { flattenDeepToOneAssociations } = require('../../services/utils/handlerUtils')

function _isCorrectCallToViewWithParams(csdlStructuredType) {
  return (
    csdlStructuredType.navigationProperties &&
    csdlStructuredType.navigationProperties[0] &&
    csdlStructuredType.navigationProperties[0].name === 'Parameters' &&
    csdlStructuredType.navigationProperties[0].partner === 'Set'
  )
}

function _getTarget(service, segments) {
  let last = segments.pop()

  if (!last || last.getKind() === ACTION_IMPORT || last.getKind() === FUNCTION_IMPORT) {
    return
  }

  if (last.getKind() === BOUND_FUNCTION || last.getKind() === BOUND_ACTION) {
    last = segments.pop()
  }

  if (last.getEdmType() && last.getEdmType().csdlStructuredType) {
    const { namespace } = last.getEdmType().getFullQualifiedName()
    // REVISIT: better way to identify situation "view with parameters"
    const name = _isCorrectCallToViewWithParams(last.getEdmType().csdlStructuredType)
      ? last.getEdmType().csdlStructuredType.navigationProperties[0].type.name
      : last.getEdmType().csdlStructuredType.name

    // autoexposed entities now used . in csn and _ in edm
    const target =
      findCsnTargetFor(name, service.model, namespace) ||
      (name.endsWith('Parameters') && service.model.definitions[namespace + '.' + name.replace(/Parameters$/, '')])

    if (target && target.kind === 'entity') {
      return target
    }
  }

  return _getTarget(service, segments)
}

/**
 * Class representing an OData request.
 * @extends cds.Request
 *
 * @param {string} type - The OData request type (a.k.a. "Component")
 * @param {import('../../services/Service')} service - The underlying CAP service
 * @param {import('./okra/odata-server/core/OdataRequest')} odataReq - OKRA's req
 * @param {import('./okra/odata-server/core/OdataResponse')} odataRes - OKRA's res
 */
class ODataRequest extends cds.Request {
  constructor(type, service, odataReq, odataRes, upsert) {
    const req = odataReq.getBatchApplicationData()
      ? odataReq.getBatchApplicationData().req
      : odataReq.getIncomingRequest()
    const res = req.res

    /*
     * target
     */
    const target = _getTarget(service, [...odataReq.getUriInfo().getPathSegments()])

    /*
     * data
     */
    const data = getData(type, odataReq, service)

    /*
     * query
     */
    const operation = isCustomOperation(odataReq.getUriInfo().getPathSegments())
      ? odataReq.getUriInfo().getLastSegment().getKind()
      : type
    const query = odataToCQN(operation, service, target, data, odataReq, upsert)

    /*
     * event
     */
    let event = type

    // actions & functions
    const uriInfoLastSegment = odataReq.getUriInfo().getLastSegment()

    switch (uriInfoLastSegment && uriInfoLastSegment.getKind()) {
      case 'BOUND.ACTION':
        event = uriInfoLastSegment.getAction().getName()
        break

      case 'ACTION.IMPORT':
        event = uriInfoLastSegment.getActionImport().getName()
        break

      case 'BOUND.FUNCTION':
        event = uriInfoLastSegment.getFunction().getName()
        break

      case 'FUNCTION.IMPORT':
        event = uriInfoLastSegment.getFunctionImport().getName()
        break

      // no default
    }

    // draft
    if (target && target._isDraftEnabled) {
      if (type === 'CREATE') event = 'NEW'
      else if (event === 'draftEdit') event = 'EDIT'
      else if (type === 'UPDATE') event = 'PATCH'
      else if (type === 'DELETE' && data.IsActiveEntity !== 'true') event = 'CANCEL'
    }

    // mark query as for an OData READ
    if (event === 'READ') Object.defineProperty(query.SELECT, '_4odata', { value: true })

    /*
     * method, headers
     */
    const method = odataReq.getMethod()

    // REVISIT: Why do we mix headers of $batch and batched request headers??
    const headers = Object.assign({}, req.headers, odataReq.getHeaders())

    /*
     * super
     */
    const { user } = req

    // REVISIT: _model should not be necessary
    const _model = service.model

    // REVISIT: public API for query options (express style req.query already in use)?
    const _queryOptions = odataReq.getQueryOptions()
    super({ event, target, data, query, user, method, headers, req, res, _model, _queryOptions })

    // REVISIT: validate associations for deep insert
    flattenDeepToOneAssociations(this, this.model)

    /*
     * req.run
     */
    Object.defineProperty(this, 'run', {
      configurable: true,
      get:
        () =>
        (...args) => {
          if (!cds._deprecationWarningForRun) {
            LOG._warn && LOG.warn('req.run is deprecated and will be removed.')
            cds._deprecationWarningForRun = true
          }

          return cds.tx(this).run(...args)
        }
    })

    /*
     * req.params
     */
    Object.defineProperty(this, 'params', {
      configurable: true,
      get: function () {
        this._params = this._params || getParams(odataReq)
        return this._params
      }
    })

    /*
     * REVISIT: compat req._.*
     */
    // odataReq and odataRes
    this._.odataReq = odataReq
    this._.odataRes = odataRes
    // req._.shared
    const that = this
    Object.defineProperty(this._, 'shared', {
      get() {
        if (!cds._deprecationWarningForShared) {
          LOG._warn && LOG.warn('req._.shared is deprecated and will be removed.')
          cds._deprecationWarningForShared = true
        }

        if (that.context) {
          that._shared = that.context._shared = that.context._shared || { req, res }
        } else {
          that._shared = that._shared || { req, res }
        }
        return that._shared
      }
    })

    // req.attr
    const attr = { identityZone: this.tenant }
    Object.defineProperty(this, 'attr', {
      get() {
        if (!cds._deprecationWarningForAttr) {
          LOG._warn && LOG.warn('req.attr is deprecated and will be removed.')
          cds._deprecationWarningForAttr = true
        }

        return attr
      }
    })

    if (this._.req.performanceMeasurement) {
      this.performanceMeasurement = this._.req.performanceMeasurement
    }

    if (this._.req.dynatrace) {
      this.dynatrace = this._.req.dynatrace
    }

    /*
     * req.isConcurrentResource
     */
    // REVISIT: re-implement in runtime w/o using okra
    Object.defineProperty(this, 'isConcurrentResource', {
      get() {
        this._isConcurrentResource = this._isConcurrentResource || odataReq.getConcurrentResource() !== null
        return this._isConcurrentResource
      }
    })

    /*
     * req.isConditional
     */
    // REVISIT: re-implement in runtime w/o using okra
    Object.defineProperty(this, 'isConditional', {
      get() {
        this._isConditional = this._isConditional || odataReq.isConditional()
        return this._isConditional
      }
    })

    /*
     * req.validateEtag()
     */
    // REVISIT: re-implement in runtime w/o using okra
    this.validateEtag = (...args) => {
      return odataReq.validateEtag(...args)
    }

    /*
     * req.getUriInfo()
     * req.getUrlObject()
     *
     * In draft context req object is cloned.
     * Defining a property here will not work.
     */
    // REVISIT: re-implement in runtime w/o using okra
    this.getUriInfo = () => {
      this._uriInfo = this._uriInfo || odataReq.getUriInfo()
      return this._uriInfo
    }

    this.getUrlObject = () => {
      this._urlObject = this._urlObject || odataReq.getUrlObject()
      return this._urlObject
    }
  }
}

module.exports = ODataRequest
