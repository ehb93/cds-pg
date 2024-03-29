const cds = require('../../cds')

const Differ = require('./utils/differ')

const { resolveView, restoreLink, findQueryTarget } = require('../../common/utils/resolveView')
const { postProcess } = require('../../common/utils/postProcessing')

const _isSimpleCqnQuery = q => typeof q === 'object' && q !== null && !Array.isArray(q) && Object.keys(q).length > 0

/**
 * Generic Service Event Handler.
 */
class ApplicationService extends cds.Service {
  constructor(name, csn, options) {
    // REVISIT: do we still need that -> likely due to legacy test?
    // If not we should remove this legacy constructor
    if (typeof name === 'object') [name, csn, options] = [csn.service, name, csn]
    super(name, csn, options)

    // REVISIT: umbrella calls srv._calculateDiff
    this._differ = new Differ(this)
    this._calculateDiff = this._differ.calculate
  }

  set model(csn) {
    const m = csn && 'definitions' in csn ? cds.linked(cds.compile.for.odata(csn)) : csn
    cds.alpha_localized(m) // with compiler v2 we always need to localized the csn
    super.model = m
  }

  init() {
    /*
     * .before handlers (all with _initial === true)
     */
    require('../../common/generic/auth').call(this, this)
    require('../../common/generic/etag').call(this, this)
    require('../../common/generic/input').call(this, this)
    require('../../common/generic/put').call(this, this)
    require('../../common/generic/temporal').call(this, this)
    require('../../common/generic/paging').call(this, this) // > paging must be executed before sorting
    require('../../common/generic/sorting').call(this, this)

    // draft handlers needed?
    // REVISIT: serve 2 fiori
    this._2fiori = Object.values(this.entities).some(e => e._isDraftEnabled)
    if (this._2fiori) this.registerFioriHandlers()

    // personal data audit logging
    this._4audit = cds.env.features.audit_personal_data && Object.values(this.entities).some(e => e._hasPersonalData)
    if (this._4audit) this.registerPersonalDataHandlers()

    /*
     * .on handlers
     */
    require('../../common/generic/crud').call(this, this)

    return this
  }

  /**
   * @param serviceImpl
   * @deprecated since version 1.11.0 - use Service.prepend instead
   */
  with(serviceImpl) {
    return this.prepend(serviceImpl)
  }

  /**
   * Registers custom handlers.
   *
   * @param {string | object | Function} serviceImpl - init function to register custom handlers.
   */
  impl(serviceImpl) {
    if (typeof serviceImpl === 'string') serviceImpl = require(serviceImpl)
    return this.prepend(serviceImpl)
  }

  registerFioriHandlers() {
    if (this._draftHandlersRegistered) return
    this._draftHandlersRegistered = true

    /*
     * .before handlers (all with _initial === true)
     */
    require('../../fiori/generic/before').call(this, this)

    /*
     * .on handlers
     */
    require('../../fiori/generic/new').call(this, this) // > NEW
    require('../../fiori/generic/patch').call(this, this) // > PATCH
    require('../../fiori/generic/cancel').call(this, this) // > CANCEL
    require('../../fiori/generic/edit').call(this, this) // > EDIT
    require('../../fiori/generic/prepare').call(this, this) // > draftPrepare (-> should be PREPARE)
    require('../../fiori/generic/activate').call(this, this) // > draftActivate (-> should be ACTIVATE)
    require('../../fiori/generic/readOverDraft').call(this, this) // > READ non-draft via navigation
    require('../../fiori/generic/read').call(this, this) // > READ
    require('../../fiori/generic/delete').call(this, this) // > DELETE
  }

  registerPersonalDataHandlers() {
    // register directly if cds.db is already set, otherwise on connect of a DatabaseService
    if (cds.db && !this._personalDataHandlersRegistered) {
      require('../../audit/generic/personal').call(this, this)
      this._personalDataHandlersRegistered = true
    } else {
      const that = this
      cds.on('connect', srv => {
        if (srv instanceof cds.DatabaseService && !that._personalDataHandlersRegistered) {
          require('../../audit/generic/personal').call(that, that)
          that._personalDataHandlersRegistered = true
        }
      })
    }
  }

  // Overload .handle in order to resolve projections up to a definition that is known by the remote service instance.
  // Result is post processed according to the inverse projection in order to reflect the correct result of the original query.
  async handle(req) {
    // compat mode
    if (req._resolved || cds.env.features.resolve_views === false) return super.handle(req)

    if (req.target && req.target.name && this.definition && req.target.name.startsWith(this.definition.name + '.')) {
      return super.handle(req)
    }

    // req.query can be:
    // - empty object in case of unbound action/function
    // - undefined/null in case of plain string queries
    if (_isSimpleCqnQuery(req.query) && this.model) {
      const q = resolveView(req.query, this.model, this)
      const t = findQueryTarget(q) || req.target

      // compat
      restoreLink(req)
      if (req.query.SELECT && req.query.SELECT._4odata) {
        q.SELECT._4odata = req.query.SELECT._4odata
      }

      // REVISIT: We need to provide target explicitly because it's cached already within ensure_target
      const newReq = new cds.Request({ query: q, target: t, _resolved: true })
      const result = await super.dispatch(newReq)

      return postProcess(q, result, this)
    }

    return super.handle(req)
  }
}

module.exports = ApplicationService
