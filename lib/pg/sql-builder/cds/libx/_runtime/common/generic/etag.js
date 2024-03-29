const cds = require('../../cds')
const { SELECT } = cds.ql

// REVISIT: draft should not be handled here, e.g., target.name should be adjusted before
const { isActiveEntityRequested } = require('../../fiori/utils/where')
const { ensureDraftsSuffix } = require('../../fiori/utils/handler')
const { cqn2cqn4sql } = require('../../common/utils/cqn2cqn4sql')
const ODataRequest = require('../../cds-services/adapter/odata-v4/ODataRequest')

const C_U_ = {
  CREATE: 1,
  UPDATE: 1
}

const getSelectCQN = (query, target, model) => {
  // REVISIT DRAFT HANDLING: this function is a hack until we solve drafts properly
  let requestTarget
  if (query.SELECT) {
    requestTarget = query.SELECT.from
  } else if (query.UPDATE) {
    requestTarget = query.UPDATE.entity
  } else {
    requestTarget = query.DELETE.from
  }

  const targetName = isActiveEntityRequested(requestTarget.ref[0].where) ? target.name : ensureDraftsSuffix(target.name)
  const cqn = cqn2cqn4sql(SELECT.from(requestTarget), model)
  cqn.columns([target._etag])
  cqn.SELECT.from.ref[0] = targetName

  return cqn
}

/**
 * Generic handler for @odata.etag-enabled entities
 *
 * @param req
 */
const _handler = async function (req) {
  // REVISIT: The check for ODataRequest should be removed after etag logic is moved
  // from okra to commons and etag handling is also allowed for rest.
  if (req instanceof ODataRequest && req.isConcurrentResource) {
    const etagElement = req.target.elements[req.target._etag]

    // validate
    if (req.isConditional && !req.query.INSERT) {
      const result = await cds.tx(req).run(getSelectCQN(req.query, req.target, this.model))

      if (result.length === 1) {
        const etag = Object.values(result[0])[0]
        req.validateEtag(etag == null ? 'null' : etag)
      } else {
        req.validateEtag('*')
      }
    }

    // generate new etag, if UUID
    if (C_U_[req.event] && etagElement.type === 'cds.UUID') {
      req.data[etagElement.name] = cds.utils.uuid()
    }
  }
}

/**
 * handler registration
 *
 */
/* istanbul ignore next */
module.exports = cds.service.impl(function () {
  _handler._initial = true

  for (const k in this.entities) {
    const entity = this.entities[k]

    if (!Object.values(entity.elements).some(ele => ele['@odata.etag'])) {
      // entity not @odata.etag-enabled
      continue
    }

    // handler for CREATE is registered for backwards compatibility w.r.t. ETag generation
    let events = ['CREATE', 'READ', 'UPDATE', 'DELETE']

    // if odata and fiori is separated, this will not be needed in the odata version
    if (entity._isDraftEnabled) {
      events = ['READ', 'NEW', 'DELETE', 'PATCH', 'EDIT', 'CANCEL']
    }

    this.before(events, entity, _handler)

    for (const action in entity.actions) {
      this.before(action, entity, _handler)
    }
  }
})
