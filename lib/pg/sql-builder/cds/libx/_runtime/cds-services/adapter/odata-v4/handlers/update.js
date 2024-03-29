const cds = require('../../../../cds')
const { SELECT, UPDATE } = cds.ql
const ODataRequest = require('../ODataRequest')

const {
  Components: { DATA_UPDATE_HANDLER, DATA_CREATE_HANDLER }
} = require('../okra/odata-server')

const { getSapMessages } = require('../../../../common/error/frontend')
const { validateResourcePath } = require('../utils/request')
const { isReturnMinimal } = require('../utils/handlerUtils')
const readAfterWrite = require('../utils/readAfterWrite')
const { toODataResult, postProcess, postProcessMinimal } = require('../utils/result')
const { hasOmitValuesPreference } = require('../utils/omitValues')
const { mergeJson } = require('../../../services/utils/compareJson')

/*
const { isStreaming } = require('../utils/stream')
const { findCsnTargetFor } = require('../../../../common/utils/csn')
const { isActiveEntityRequested, removeIsActiveEntityRecursively } = require('../../../../fiori/utils/where')
const { ensureDraftsSuffix } = require('../../../../fiori/utils/handler')
*/

const _isUpsertAllowed = target => {
  return !(cds.env.runtime && cds.env.runtime.allow_upsert === false) && !(target && target._isDraftEnabled)
}

const _infoForeignKeyInParent = (req, odataReq, odataRes, tx) => {
  const info = {}
  // keys not in data
  if (req.target.keys && Object.keys(req.target.keys).some(key => Object.keys(req.data).includes(key))) {
    return info
  }

  req = new ODataRequest(DATA_CREATE_HANDLER, tx, odataReq, odataRes, true)
  const nav = req.query.INSERT.into.ref && req.query.INSERT.into.ref.length !== 0 && req.query.INSERT.into.ref[1]
  const parent = req.query.INSERT.into.ref && req.query.INSERT.into.ref[0].id

  // not a navigation
  if (!parent || !nav) {
    return info
  }

  const navID = typeof nav === 'string' ? nav : nav.id
  const navElement = tx.model.definitions[parent].elements[navID]

  // not a containment
  if (!navElement['@odata.contained']) {
    return info
  }

  const where = req.query.INSERT.into.ref[0].where
  return { parent, navElement, where }
}

const _create = async (req, odataReq, odataRes, tx) => {
  let result

  const { parent, navElement, where } = _infoForeignKeyInParent(req, odataReq, odataRes, tx)
  if (parent && navElement && where) {
    const onKeys = navElement._foreignKeys
    const parentKeys = onKeys.filter(key => key.parentElement).map(key => key.parentElement.name)
    const parentKeyObj = await tx.run(SELECT.from(parent).columns(parentKeys).where(where))

    const parentUpdateObj = {}
    onKeys.forEach(key => {
      let parentKeyVal, parentUpdateRequired
      if (parentKeyObj.length !== 0 && parentKeyObj[0][key.parentElement.name] !== null) {
        parentKeyVal = parentKeyObj[0][key.parentElement.name]
      } else if (key.childElement.type === 'cds.UUID' && key.childElement.key) {
        parentUpdateRequired = true
        parentKeyVal = cds.utils.uuid()
      } else {
        throw new Error('Only keys of type UUID can be generated: ' + key.childFieldName)
      }
      odataReq.getBody()[key.childElement.name] = parentKeyVal

      if (parentUpdateRequired) {
        parentUpdateObj[key.parentElement.name] = parentKeyVal
      }
    })

    odataRes.setStatusCode(201)
    req = new ODataRequest(DATA_CREATE_HANDLER, tx, odataReq, odataRes, true)
    result = await tx.dispatch(req)

    if (Object.keys(parentUpdateObj).length !== 0) {
      await tx.run(UPDATE(parent).set(parentUpdateObj).where(where))
    }
  } else {
    req = new ODataRequest(DATA_CREATE_HANDLER, tx, odataReq, odataRes, true)
    result = await tx.dispatch(req)
  }

  return [result, req]
}

const _updateThenCreate = async (req, odataReq, odataRes, tx) => {
  let result

  try {
    result = await tx.dispatch(req)
  } catch (e) {
    if ((e.code === 404 || e.status === 404 || e.statusCode === 404) && _isUpsertAllowed(req.target)) {
      // REVISIT: remove error (and child?) from tx.context? -> would require a unique req.id
      ;[result, req] = await _create(req, odataReq, odataRes, tx)
    } else {
      throw e
    }
  }

  return [result, req]
}

const _readAfterWriteAndVirtuals = async (req, service, result) => {
  const dataInDb = await readAfterWrite(req, service)
  if (dataInDb.length) result = mergeJson(dataInDb[0], result, req.target)
  return result
}

const _shouldReadPreviousResult = req =>
  req.event === 'UPDATE' && !isReturnMinimal(req) && hasOmitValuesPreference(req.headers.prefer, 'defaults')

/*
const _getEntity = (segments, model) => {
  let entityName, namespace
  const previous = segments[segments.length - 2]
  if (previous.getKind() === 'ENTITY') {
    entityName = previous.getEntitySet().getName()
    namespace = previous.getEdmType().getFullQualifiedName().namespace
  } else if (previous.getKind() === 'NAVIGATION.TO.ONE') {
    entityName = previous.getTarget().getName()
    namespace = previous.getTarget().getEntityType().getFullQualifiedName().namespace
  }

  if (entityName) {
    return findCsnTargetFor(entityName, model, namespace)
  }
}

const _getMediaType = entity => {
  if (entity._hasPersistenceSkip) return

  return Object.values(entity.elements).find(ele => ele['@Core.IsMediaType'])
}

const _getMediaTypeCQN = (mediaType, contentType, entity, req) => {
  const where = req.query.UPDATE.entity.ref[0].where
  const isActive = isActiveEntityRequested(where)
  const data = {}
  data[mediaType.name] = contentType
  const cqn = UPDATE(entity).set(data)
  cqn.UPDATE.where = removeIsActiveEntityRecursively(where)
  if (!isActive) {
    cqn.UPDATE.entity = ensureDraftsSuffix(entity.name)
  }

  return cqn
}

const _handleMediaType = async (odataReq, model, tx, req) => {
  const segments = odataReq.getUriInfo().getPathSegments()
  const contentType = odataReq._inRequest.headers['content-type']
  if (isStreaming(segments) && contentType) {
    const entity = _getEntity(segments, model)
    if (entity && !entity['@cds.persistence.skip']) {
      const mediaType = _getMediaType(entity)
      if (mediaType) {
        await tx.run(_getMediaTypeCQN(mediaType, contentType, entity, req))
      }
    }
  }
}
*/

/**
 * The handler that will be registered with odata-v4.
 *
 * In case of success it calls next with the number of updated entries as result.
 * In case of error it calls next with error.
 *
 * @param {import('../../../services/Service')} service
 * @returns {function}
 */
const update = service => {
  return async (odataReq, odataRes, next) => {
    let req
    try {
      validateResourcePath(odataReq, service)
      req = new ODataRequest(DATA_UPDATE_HANDLER, service, odataReq, odataRes)
    } catch (e) {
      return next(e)
    }

    const changeset = odataReq.getAtomicityGroupId()
    const tx = changeset ? odataReq.getBatchApplicationData().txs[changeset] : service.tx(req)
    cds.context = tx

    // putting a property?
    const primitive = odataReq.getUriInfo().getLastSegment().getKind() === 'PRIMITIVE.PROPERTY'

    let result, err, commit
    try {
      // // REVISIT: should be handled somewhere else
      // await _handleMediaType(odataReq, service.model, tx, req)

      let previousResult
      if (_shouldReadPreviousResult(req)) {
        previousResult = await _readAfterWriteAndVirtuals(req, service, result)
      }

      // try UPDATE and, on 404 error, try CREATE
      ;[result, req] = await _updateThenCreate(req, odataReq, odataRes, tx)

      if (!isReturnMinimal(req)) {
        // REVISIT: find better solution
        if (!primitive && req._.readAfterWrite) {
          result = await _readAfterWriteAndVirtuals(req, service, result)
        }

        postProcess(req, odataRes, service, result, previousResult)
      } else {
        postProcessMinimal(req, result)
      }

      if (changeset) {
        // for passing into commit
        odataReq.getBatchApplicationData().results[changeset].push({ result, req })
      } else {
        commit = true
        await tx.commit(result)
      }

      if (isReturnMinimal(req)) {
        odataRes.setStatusCode(204)
      }
    } catch (e) {
      err = e
      if (!changeset && !commit) {
        // ignore rollback error, which should never happen
        await tx.rollback(e).catch(() => {})
      } else if (changeset) {
        // for passing into rollback
        odataReq.getBatchApplicationData().errors[changeset].push({ error: e, req })
      }
    } finally {
      req.messages && odataRes.setHeader('sap-messages', getSapMessages(req.messages, req._.req))

      if (err) next(err)
      else if (primitive && result) {
        const prop = odataReq.getUriInfo().getLastSegment().getProperty().getName()
        const res = { value: result[prop] }
        for (const k of Object.keys(result).filter(k => k.match(/^\*/))) res[k] = result[k]
        next(null, res)
      } else next(null, toODataResult(result))
    }
  }
}

module.exports = update
