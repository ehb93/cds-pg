const cds = require('../../../../cds')

const RestRequest = require('../RestRequest')

const getData = require('../utils/data')
const { bufferToBase64 } = require('../utils/binary')

const _locationHeader = (entity, serviceName, resultObject) => {
  const keyName = Object.keys(entity.keys)[0]
  const entityNameWithoutServicePrefix = entity.name.replace(`${serviceName}.`, '')
  return `../${entityNameWithoutServicePrefix}/${resultObject[keyName]}`
}

/*
 * optimistically transforms result from flat to complex based on input
 */
const _transformToComplex = (result, data) => {
  for (let i = 0; i < result.length; i++) {
    const d = result[i]
    const cd = data[i]

    const props = Object.keys(d)
    const keys = Object.keys(cd).filter(k => !props.includes(k))

    for (const k of keys) {
      const inner = props.filter(p => p.startsWith(`${k}_`)).map(p => p.split(`${k}_`)[1])
      if (inner.length > 0) {
        d[k] = {}
        for (const i of inner) {
          d[k][i] = d[`${k}_${i}`]
          delete d[`${k}_${i}`]
        }
      }
    }
  }
}

module.exports = service => {
  return async (restReq, restRes, next) => {
    const {
      _parsed: parsed,
      _parsed: { target }
    } = restReq

    const [validationError, data] = getData(parsed, restReq)
    if (validationError) return next(validationError)

    // create tx and set as cds.context
    // REVISIT: _model should not be necessary
    const tx = service.tx({ user: restReq.user, req: restReq, _model: service.model })
    cds.context = tx

    let result, err, commit, location
    try {
      const reqs = data.map(d => new RestRequest(parsed, d, restReq, restRes, service))
      result = await Promise.all(reqs.map(req => tx.dispatch(req)))

      _transformToComplex(result, data)
      bufferToBase64(result, target)

      // batch?
      if (!Array.isArray(restReq.body)) {
        result = result[0]
        location = _locationHeader(target, service.name, result)
      }

      commit = true
      await tx.commit(result)
    } catch (e) {
      err = e
      if (!commit) {
        // ignore rollback error, which should never happen
        await tx.rollback(e).catch(() => {})
      }
    } finally {
      if (err) next(err)
      else {
        // only set status if not yet modified
        if (restRes.statusCode === 200) restRes.status(201)
        if (location) restRes.set('location', location)
        restRes.send(result)
      }
    }
  }
}
