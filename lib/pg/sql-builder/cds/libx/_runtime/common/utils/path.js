const cds = require('../../cds')

/*
 * returns path like <service>.<entity>:<prop1>.<prop2> for ref = [{ id: '<service>.<entity>' }, '<prop1>', '<prop2>']
 */
const getPathFromRef = ref => {
  const x = ref.reduce((acc, cur) => {
    acc += (acc ? ':' : '') + (cur.id ? cur.id : cur)
    return acc
  }, '')
  const y = x.split(':')
  let z = y.shift()
  if (y.length) z += ':' + y.join('.')
  return z
}

/*
 * returns the target entity for the given path
 */
const getEntityFromPath = (path, model) => {
  let current = { elements: model.definitions }
  path = typeof path === 'string' ? cds.parse.path(path) : path
  const segments = [...path.ref]
  while (segments.length) {
    const segment = segments.shift()
    current = current.elements[segment.id || segment]
    if (current.target) current = model.definitions[current.target]
  }
  return current
}

module.exports = {
  getPathFromRef,
  getEntityFromPath
}
