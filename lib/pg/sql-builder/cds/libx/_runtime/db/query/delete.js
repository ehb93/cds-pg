const { getFlatArray, processCQNs } = require('../utils/deep')
const { timestampToISO } = require('../data-conversion/timestamp')
const { hasDeepDelete, getDeepDeleteCQNs } = require('../../common/composition')

const deleteFn = executeDeleteCQN => async (model, dbc, query, req) => {
  const { user, locale, timestamp } = req
  const isoTs = timestampToISO(timestamp)

  let result
  if (hasDeepDelete(model && model.definitions, query)) {
    let cqns = getDeepDeleteCQNs(model && model.definitions, query)

    // the delete chunks, i.e., how many deletes can be processed in parallel
    const chunks = []
    for (const each of cqns) {
      if (each.length) chunks.push(each.length)
    }

    cqns = getFlatArray(cqns)

    if (cqns.length === 0) return 0

    const results = await processCQNs(executeDeleteCQN, cqns, model, dbc, user, locale, isoTs, chunks)
    // return number of affected rows of "root cqn"
    result = results[results.length - 1]
  } else {
    result = await executeDeleteCQN(model, dbc, query, user, locale, isoTs)
  }

  return result
}

module.exports = deleteFn
