const cds = require('../../cds')

const { hasDeepUpdate, getDeepUpdateCQNs, selectDeepUpdateData } = require('../../common/composition')
const { getFlatArray, processCQNs } = require('../utils/deep')
const { timestampToISO } = require('../data-conversion/timestamp')

const _includesCompositionTarget = (cqns, target) => {
  return cqns.find(cqn => {
    return (cqn.UPDATE && cqn.UPDATE.entity === target) || (cqn.DELETE && cqn.DELETE.from === target)
  })
}

const _getFilteredCqns = (cqns, model) => {
  // right to left processing necessary!
  for (let i = cqns.length - 1; i >= 0; i--) {
    const cqn = cqns[i]

    const entity = model && cqn.UPDATE && model.definitions[cqn.UPDATE.entity]
    if (!entity) continue

    /*
     * do not filter if:
     * - there is a propterty that is not managed or managed but filled by custom handler (i.e., its value doesn't start with $)
     * - a composition target is updated as well
     */
    let moreThanManaged = Object.keys(cqn.UPDATE.data).some(
      k => entity.elements[k]['@cds.on.update'] === undefined || !cqn.UPDATE.data[k].startsWith('$')
    )
    if (moreThanManaged) continue

    // REVISIT: remove feature flag update_header_item after grace period of at least two months (> April release)
    if (cds.env.features.update_header_item !== false) {
      const comps = Object.values(entity.associations || {}).filter(assoc => assoc._isCompositionEffective)
      for (const comp of comps) {
        if (_includesCompositionTarget(cqns, comp.target)) {
          moreThanManaged = true
          break
        }
      }
    }
    if (moreThanManaged) continue

    // remove current cqn
    cqns.splice(i, 1)
  }

  return cqns
}

const update = (executeUpdateCQN, executeSelectCQN) => async (model, dbc, query, req) => {
  const { user, locale, timestamp } = req
  const isoTs = timestampToISO(timestamp)

  if (hasDeepUpdate(model && model.definitions, query)) {
    // REVISIT: _activeData gets set in case of draftActivate for performance, but this is a layer violation
    let selectData = req._ && req._.query && req._.query._activeData
    if (!selectData) {
      // REVISIT: avoid additional read
      selectData = await selectDeepUpdateData(model && model.definitions, query, req, false, false, cds.db)
    } else {
      selectData = [selectData]
    }

    let cqns = getDeepUpdateCQNs(model && model.definitions, query, selectData)

    // the delete chunks, i.e., how many deletes can be processed in parallel
    const chunks = []
    for (const each of cqns) chunks.push(each.filter(e => e.DELETE).length)

    // remove queries that only want to update @cds.on.update properties
    cqns = _getFilteredCqns(getFlatArray(cqns), model)

    if (cqns.length === 0) return 0
    const results = await processCQNs(executeUpdateCQN, cqns, model, dbc, user, locale, isoTs, chunks)
    // return number of affected rows of "root cqn", if an update, 1 otherwise (as not update of root but its children)
    if (cqns[0].UPDATE) return results[0]
    return 1
  }

  // REVISIT: don't invoke setters if not needed
  return executeUpdateCQN(model, dbc, query, user, locale, isoTs)
}

module.exports = update
