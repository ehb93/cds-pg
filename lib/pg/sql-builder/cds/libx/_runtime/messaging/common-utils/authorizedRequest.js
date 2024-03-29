const https = require('https')
const requestToken = require('../http-utils/token')

const authorizedRequest = ({
  method,
  uri,
  path,
  oa2,
  tenant,
  dataObj,
  headers,
  tokenStore,
  attemptInfo,
  errMsg,
  target
}) => {
  attemptInfo()
  return new Promise((resolve, reject) => {
    ;((tokenStore.token && Promise.resolve(tokenStore.token)) || requestToken(oa2, tenant, tokenStore))
      .catch(err => reject(err))
      .then(token => {
        const httpOptions = {
          host: uri.replace('https://', ''),
          path,
          headers: {
            Authorization: 'Bearer ' + token
          },
          method
        }

        let data
        if (dataObj) {
          data = JSON.stringify(dataObj)
          httpOptions.headers['Content-Type'] = 'application/json'
          httpOptions.headers['Content-Length'] = data.length
        }

        if (headers) {
          for (const key of Object.keys(headers)) httpOptions.headers[key] = headers[key]
        }

        const req = https.request(httpOptions, res => {
          res.setEncoding('utf8')
          let chunks = ''
          res.on('data', chunk => {
            chunks += chunk
          })
          res.on('end', () => {
            let body
            try {
              body = res.headers && res.headers['content-type'] === 'application/json' ? JSON.parse(chunks) : chunks
            } catch (e) {
              // There are some cases (e.g. ReadinessCheck) where the content type is 'application/json'
              // but the chunks are not valid JSON.
              body = chunks
            }
            const result = { body, headers: res.headers, statusCode: res.statusCode }
            if (res.statusCode < 200 || (res.statusCode >= 300 && !(res.statusCode === 404 && method === 'DELETE'))) {
              const errObj = new Error(errMsg)
              errObj.target = target
              errObj.response = result
              reject(errObj)
            } else {
              resolve(result)
            }
          })
        })

        if (data) req.write(data)
        req.end()
      })
  })
}

module.exports = authorizedRequest
