const { isSameArray } = require('./utils')

/**
 * Add odata select to a CQN object.
 *
 * @param {string} select - odata select string
 * @param {Array} keys - array of primary keys
 * @param {object} entity - csn entity targeted by the request
 * @private
 */
const selectToCQN = (select, keys, entity) => {
  const elements = []
  const columns = select.split(',').map(e => e.split('/'))
  if (columns.some(col => col[0] === '*')) {
    return []
  }

  for (const col of columns) {
    if (!entity.elements[col[0]] || !entity.elements[col[0]].isAssociation) {
      elements.push({ ref: col })
    }
  }

  for (const key of keys) {
    // add key, as odata-v4 always expects the key here.
    const newRef = { ref: [key] }
    if (key && !elements.some(ref => isSameArray(ref.ref, newRef.ref))) {
      elements.push(newRef)
    }
  }

  for (const col in entity.elements) {
    const newRef = { ref: [col] }
    if (entity.elements[col]['@odata.etag'] && !elements.some(ref => isSameArray(ref.ref, newRef.ref))) {
      elements.push(newRef)
    }
  }

  return Array.from(elements)
}

module.exports = selectToCQN
