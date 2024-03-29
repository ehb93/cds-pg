const cds = require('../../../../cds')

const { UNAUTHORIZED, FORBIDDEN, getRequiresAsArray } = require('../../../../common/utils/auth')

const measurePerformance = require('../../perf/performance')

module.exports = srv => {
  const requires = getRequiresAsArray(srv.definition)

  return (odataReq, odataRes, next) => {
    const req = odataReq.getBatchApplicationData()
      ? odataReq.getBatchApplicationData().req
      : odataReq.getIncomingRequest()
    const { res, user, path, headers } = req

    const { protectMetadata } = cds.env.odata
    if (protectMetadata === false && (path === '/' || path.endsWith('/$metadata'))) {
      // > nothing to do
      return next()
    }

    // in case of $batch we need to challenge directly, as the header is not processed if in $batch response body
    if (user && user._challenges && path.endsWith('/$batch')) {
      res.set('WWW-Authenticate', user._challenges.join(';'))
      return next(UNAUTHORIZED)
    }

    // check @requires as soon as possible (DoS)
    if (requires.length > 0 && !requires.some(r => user.is(r))) {
      // > unauthorized or forbidden?
      if (user._is_anonymous) {
        if (user._challenges) res.set('WWW-Authenticate', user._challenges.join(';'))
        // REVISIT: security log in else case?
        return next(UNAUTHORIZED)
      }
      // REVISIT: security log?
      return next(FORBIDDEN)
    }

    /*
     * .on('request') is the only possibility to set a shared object,
     * that can be used in ATOMICITY_GROUP_START and ATOMICITY_GROUP_END
     */
    if (path.endsWith('/$batch')) {
      // ensure content type
      const ct = headers['content-type'] || ''
      if (!ct.match(/multipart\/mixed/) && !ct.match(/application\/json/)) {
        return next({
          statusCode: 400,
          code: '400',
          message: 'Batch requests must have content type multipart/mixed or application/json'
        })
      }

      odataReq.setApplicationData({ req })
    }

    // in case of batch request with sap-statistics=true also measure performance of batched requests
    if (odataReq.getBatchApplicationData()) {
      measurePerformance(req, res)
    }

    next()
  }
}
