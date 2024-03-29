const { getMaxPageSize } = require('../../../../common/utils/page')
const { findCsnTargetFor } = require('../../../../common/utils/csn')

const _getEntitySets = (edm, namespace) => {
  const entities = []
  const entityContainerName = edm.$EntityContainer
  if (entityContainerName && edm[namespace]) {
    const entityContainer = edm[namespace][entityContainerName.replace(`${namespace}.`, '')]
    if (entityContainer && entityContainer.$Kind === 'EntityContainer') {
      const containerContent = Object.getOwnPropertyNames(entityContainer)
      containerContent.forEach(element => {
        if (entityContainer[element].$Collection) {
          entities.push(element)
        }
      })
    }
  }
  return entities
}

const _getConcurrent = (namespace, element, csn) => {
  // autoexposed entities now used . in csn and _ in edm
  const e = findCsnTargetFor(element, csn, namespace)

  return Object.values(e.elements).some(val => {
    return val['@odata.etag']
  })
}

const oDataConfiguration = (edm, csn) => {
  let namespace
  for (const prop in edm) {
    if (typeof edm[prop] === 'object' && edm[prop].EntityContainer) {
      namespace = prop
      break
    }
  }

  const entitySets = _getEntitySets(edm, namespace)
  if (entitySets.length === 0) return

  const configuration = {}

  for (const entitySet of entitySets) {
    // autoexposed entities now used . in csn and _ in edm
    const e = findCsnTargetFor(entitySet, csn, namespace)

    configuration[entitySet] = {
      maxPageSize: getMaxPageSize(e),
      isConcurrent: _getConcurrent(namespace, entitySet, csn)
    }

    // custom aggregates
    const cas = Object.keys(e).filter(k => k.startsWith('@Aggregation.CustomAggregate'))
    for (const ca of cas) {
      configuration[entitySet].customAggregates = configuration[entitySet].customAggregates || {}
      configuration[entitySet].customAggregates[ca.split('#')[1]] = e[ca]
    }
  }

  return { [namespace]: configuration }
}

module.exports = oDataConfiguration
