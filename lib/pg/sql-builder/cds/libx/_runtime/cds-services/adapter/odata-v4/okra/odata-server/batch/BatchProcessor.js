'use strict'

const commons = require('../../odata-commons')
const HttpStatusCode = commons.http.HttpStatusCode
const HttpStatusCodes = HttpStatusCode.StatusCodes
const HttpStatusCodesText = HttpStatusCode.Texts
const OdataResponseInBatch = require('../core/OdataResponseInBatch')
const PlainHttpResponse = require('../core/PlainHttpResponse')
const BatchExitHandler = require('./BatchExitHandler')
const BatchedRequestExecutor = require('./BatchedRequestExecutor')
const BatchContext = require('./BatchContext')

/**
 * The BatchProcessor executes the batched requests and handles possible errors.
 * The error handling respects the $batch error specifications.
 */
class BatchProcessor {
  /**
   * Creates an instance of BatchProcessor.
   * @param {BatchContext} batchContext the batch context
   */
  constructor (batchContext) {
    /**
     * Batch context
     * @type {BatchContext}
     * @private
     */
    this._batchContext = batchContext

    this._logger = batchContext.getRequest().getLogger()
  }

  /**
   * Process the requests contained in the batch request.
   * @returns {Promise} the overall result
   */
  process () {
    const request = this._batchContext.getRequest()
    const componentManager = request.getService().getComponentManager()

    let result
    const batchStartHandler = componentManager.getComponent(BatchExitHandler.BATCH_START)
    if (batchStartHandler) {
      result = BatchExitHandler.handleBatchStart(batchStartHandler, this._batchContext, request.getApplicationData())
    } else {
      result = Promise.resolve()
    }

    this._requests = new Map(this._batchContext.getRequestList().map(req => [req.getOdataRequestId(), req]))
    this._openRequestIds = new Set(this._requests.keys())
    this._finishedRequestIds = new Set()
    this._openGroups = new Map()
    this._finishedGroups = new Set()
    result = result
      .then(() => this._executeOpenRequests())
      // Discard previous useless return values.
      .then(() => {
        if (this._batchContext.isContinueOnError() && this._batchContext.getFailedAtomicityGroups().size > 0) {
          // Continue execution -> Preference continue-on-error was applied.
          this._batchContext
            .getResponse()
            .getPreferencesApplied()
            .setOdataContinueOnErrorApplied(true)
        }

        return Promise.resolve(this._batchContext.getFrameworkError())
      })
      .catch(frameworkError => {
        return Promise.resolve(frameworkError)
      })

    const batchEndHandler = componentManager.getComponent(BatchExitHandler.BATCH_END)
    if (batchEndHandler) {
      result = result.then(frameworkError => {
        const failedRequests = this._batchContext.getFailedRequestsOfAtomicityGroup(null)
        return BatchExitHandler.handleBatchEnd(
          batchEndHandler,
          this._batchContext,
          frameworkError,
          request.getApplicationData(),
          failedRequests
        )
      })
    } else {
      // Resurrect error.
      result = result.then(error => (error ? Promise.reject(error) : Promise.resolve()))
    }

    return result
  }

  /**
   * Executes the open requests contained in the batch request, calling itself as long as requests are still open.
   * @returns {Promise} the overall result
   * @private
   */
  _executeOpenRequests () {
    const batchRequest = this._batchContext.getRequest()
    const groupStartHandler = batchRequest
      .getService()
      .getComponentManager()
      .getComponent(BatchExitHandler.ATOMICITY_GROUP_START)
    let promises = []
    for (const id of this._openRequestIds) {
      const request = this._requests.get(id)
      if (this._isRequestStartable(request)) {
        const groupId = request.getAtomicityGroupId()

        if (groupId === null || this._openGroups.get(groupId)) {
          this._openRequestIds.delete(id)
          promises.push(
            new BatchedRequestExecutor(this._batchContext, request)
              .execute()
              .catch(frameworkError => {
                // This framework Error here is NOT caused by an request execution, because those errors
                // would be serialised into the response of the sub request.
                this._batchContext.setFrameworkError(frameworkError)
                this._handleFrameworkError(frameworkError, groupId)
              })
              .then(() => {
                this._finishedRequestIds.add(id)
                return this._executeOpenRequests()
              })
          )
        } else if (!this._openGroups.has(groupId) && !this._finishedGroups.has(groupId)) {
          if (groupStartHandler) {
            this._openGroups.set(groupId, false)
            promises.push(
              BatchExitHandler.handleGroupStart(groupStartHandler, batchRequest.getApplicationData(), groupId)
                .then(() => this._openGroups.set(groupId, true))
                .catch(frameworkError => {
                  this._handleFrameworkError(frameworkError, groupId)
                })
                .then(() => this._executeOpenRequests())
            )
          } else {
            this._openGroups.set(groupId, true)
            promises.push(this._executeOpenRequests())
          }
        }
      } else {
        this._checkFailedDependency(id, request)
      }
    }

    const groupEndHandler = batchRequest
      .getService()
      .getComponentManager()
      .getComponent(BatchExitHandler.ATOMICITY_GROUP_END)
    for (const [groupId, isStarted] of this._openGroups) {
      const groupRequestIds = Array.from(this._requests.keys()).filter(
        id => this._requests.get(id).getAtomicityGroupId() === groupId
      )
      // Either the group is completely finished, or it has at least one failed request and no request is running.
      if (
        (isStarted && groupRequestIds.every(id => this._finishedRequestIds.has(id))) ||
        (this._batchContext.getFailedAtomicityGroups().has(groupId) &&
          !groupRequestIds.some(id => !this._openRequestIds.has(id) && !this._finishedRequestIds.has(id)))
      ) {
        this._openGroups.delete(groupId)
        if (groupEndHandler) {
          promises.push(
            BatchExitHandler.handleGroupEnd(
              groupEndHandler,
              this._batchContext,
              batchRequest.getApplicationData(),
              groupId
            )
              .then(repeat => {
                if (repeat) {
                  for (const [id, request] of this._requests) {
                    if (request.getAtomicityGroupId() === groupId) {
                      this._finishedRequestIds.delete(id)
                      this._openRequestIds.add(id)
                    }
                  }
                  this._batchContext.removeAtomicityGroup(groupId)
                } else {
                  this._finishedGroups.add(groupId)
                }

                const failedRequests = this._batchContext.getFailedRequestsOfAtomicityGroup(groupId)
                if (failedRequests.length > 0 && !this._batchContext.isContinueOnError()) {
                  // stop processing
                  for (const id of this._openRequestIds) this._finishedRequestIds.add(id)
                  this._openRequestIds.clear()
                }
              })
              .catch(frameworkError => {
                this._handleFrameworkError(frameworkError, groupId)
              })
              .then(() => this._executeOpenRequests())
          )
        } else {
          this._finishedGroups.add(groupId)
        }
      }
    }

    return Promise.all(promises)
  }

  /**
   * Determines whether a request can be started by looking at its dependencies and the general state.
   * @param {OdataRequestInBatch} request the request
   * @returns {boolean} whether the request can be started
   * @private
   */
  _isRequestStartable (request) {
    const continueOnError = this._batchContext.isContinueOnError()
    return (
      request.getDependsOn().every(
        id =>
          // if dependent is request and finished (with or without error)
          (this._finishedRequestIds.has(id) && (continueOnError || !this._batchContext.isRequestFailed(id))) ||
          // if dependent is atomicity group and finished (with or without error)
          (this._finishedGroups.has(id) && (continueOnError || !this._batchContext.getFailedAtomicityGroups().get(id)))
      ) &&
      // TODO check this and clause for MULTIPART<>JSON
      (continueOnError ||
        this._batchContext.getSemantics() === BatchContext.SEMANTICS.MULTIPART ||
        this._batchContext.getFailedAtomicityGroups().size === 0)
    )
  }

  /**
   * Sets a request to FAILED_DEPENDENCY if one of its dependencies failed already
   * and to finished if it can no longer run
   * if we have neither to continue on error nor multipart semantics.
   * @param {string} id the request ID
   * @param {OdataRequestInBatch} request the request
   * @private
   */
  _checkFailedDependency (id, request) {
    if (
      this._batchContext.getSemantics() !== BatchContext.SEMANTICS.MULTIPART &&
      !this._batchContext.isContinueOnError()
    ) {
      if (request.getDependsOn().some(dependentId => this._batchContext.isRequestFailed(dependentId))) {
        this._openRequestIds.delete(id)
        this._finishedRequestIds.add(id)
        let plainHttpResponse = new PlainHttpResponse()
        plainHttpResponse.statusCode = HttpStatusCodes.FAILED_DEPENDENCY
        plainHttpResponse.statusMessage = HttpStatusCodesText[HttpStatusCodes.FAILED_DEPENDENCY]
        const odataResponseInBatch = new OdataResponseInBatch(plainHttpResponse, id)
        this._batchContext.addResponseInBatch(odataResponseInBatch)
        this._batchContext.markRequestAsFailed(id, request, odataResponseInBatch)
      } else if (
        this._batchContext.getFailedAtomicityGroups().size &&
        request
          .getDependsOn()
          .every(dependentId => this._finishedRequestIds.has(dependentId) || this._finishedGroups.has(dependentId))
      ) {
        this._openRequestIds.delete(id)
        this._finishedRequestIds.add(id)
        let plainHttpResponse = new PlainHttpResponse()
        plainHttpResponse.statusCode = HttpStatusCodes.UNPROCESSABLE_ENTITY
        plainHttpResponse.statusMessage = HttpStatusCodesText[HttpStatusCodes.UNPROCESSABLE_ENTITY]
        const odataResponseInBatch = new OdataResponseInBatch(plainHttpResponse, id)
        this._batchContext.markRequestAsFailed(id, request, odataResponseInBatch)
      }
    }
  }

  /**
   * Handles a framework error.
   * @param {Error} frameworkError the framework error
   * @param {?string} groupId the atomicity-group ID
   * @private
   */
  _handleFrameworkError (frameworkError, groupId) {
    this._batchContext.markAtomicityGroupAsFailed(groupId, frameworkError)
    this._finishedGroups.add(groupId)
    for (const id of this._openRequestIds) this._finishedRequestIds.add(id)
    this._openRequestIds.clear()
  }
}

module.exports = BatchProcessor
