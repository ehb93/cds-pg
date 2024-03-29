const cds = require('../../../cds')
// requesting logger without module on purpose!
const LOG = cds.log()

const restToCqn = require('./rest-to-cqn')
const { flattenDeepToOneAssociations } = require('../../services/utils/handlerUtils')

/*
 * Class representing a REST request.
 * @extends Request
 *
 * @param {String} parsed - The parsed url of the incoming request
 * @param {Object} data - A deep copy of the request payload
 * @param {Object} req - express' req
 * @param {Object} res - express' res
 * @param {Object} service - The underlying CAP service
 */
class RestRequest extends cds.Request {
  constructor(parsed, data, req, res, service) {
    const { event, target } = parsed

    /*
     * query
     */
    const query = restToCqn(parsed, data, req, service)

    /*
     * method, params, headers
     */
    const { method, params, headers } = req

    /*
     * super
     */
    const { user } = req
    // REVISIT: _model should not be necessary
    const _model = service.model
    // REVISIT: public API for query options (express style req.query already in use)?
    const _queryOptions = req.query
    super({ event, target, data, query, user, method, params, headers, req, res, _model, _queryOptions })

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

    if (this._.req.performanceMeasurement) {
      this.performanceMeasurement = this._.req.performanceMeasurement
    }
    if (this._.req.dynatrace) {
      this.dynatrace = this._.req.dynatrace
    }
  }
}

module.exports = RestRequest
