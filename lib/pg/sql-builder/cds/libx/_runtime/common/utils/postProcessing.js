const { revertData } = require('./resolveView')

// creates a map with key "remote origin name" and value { as: "projection name"}
// if it is an expand, it contains an additional property .expand with classic ref/as syntax
// ref/as syntax is kept in order to reuse handleAliasInResult
const _createAliasMap = columns => {
  if (columns) {
    let aliasMap
    for (const col of columns) {
      const processor = {}
      if (col.as) {
        processor.as = col.as
        aliasMap || (aliasMap = new Map())
        if (col.ref) {
          aliasMap.set(col.ref[col.ref.length - 1], processor)
        }
      }
      if (col.expand) {
        processor.expand = col.expand
      }
    }

    return aliasMap
  }
}

// Transforms the result of the remote service according to the provided aliases
const handleAliasInResult = (columns, result) => {
  const postProcessor = _createAliasMap(columns)
  const resultArray = Array.isArray(result) ? result : [result]
  if (postProcessor) {
    for (const row of resultArray) {
      // we need to use a cache because of cross renamings
      // e. g. column a is renamed to b and column b is renamed to a
      const tempCache = new Map()

      for (const col in row) {
        const processor = postProcessor.get(col)
        if (processor && processor.as !== col) {
          // if a value for the alias is already present, add it to the cache
          if (row[processor.as]) {
            tempCache.set(processor.as, row[processor.as])
          }

          // get the value from cache if present
          row[processor.as] = tempCache.get(col) || row[col]

          // if it was not overridden because of a renaming,
          // delete it from the row
          if (!tempCache.has(processor.as)) {
            delete row[col]
          }
        }

        if (processor && processor.expand) {
          handleAliasInResult(processor.expand, row[processor.as || col])
        }
      }
    }
  }
}

// REVISIT: todo renaming for expanded entities
// REVISIT: todo renaming for deep operations
const postProcess = (query, result, service, onlySelectAliases = false) => {
  if (query.SELECT) {
    if (query.SELECT.columns && query.SELECT.columns.find(col => col.func === 'count' && col.as === '$count')) {
      return [{ $count: result }]
    }
    handleAliasInResult(query.SELECT.columns, result)

    if (!onlySelectAliases) {
      const transition =
        query.SELECT && query.SELECT._transitions && query.SELECT._transitions[query.SELECT._transitions.length - 1]
      if (transition) return revertData(result, transition, service)
    }

    return result
  }
  if (query.DELETE) return result
  let transition
  if (query.INSERT) transition = query.INSERT._transitions[query.INSERT._transitions.length - 1]
  if (query.UPDATE) transition = query.UPDATE._transitions[query.UPDATE._transitions.length - 1]
  return revertData(result, transition, service)
}

module.exports = {
  postProcess
}
