const cds = require('../../_runtime/cds')

const { where2obj } = require('../../_runtime/common/utils/cqn')
const { findCsnTargetFor } = require('../../_runtime/common/utils/csn')

function _keysOf(entity) {
  return entity && entity.keys
    ? Object.keys(entity.keys).filter(
        k => entity.elements[k].type !== 'cds.Association' && entity.elements[k]['@odata.foreignKey4'] !== 'up_'
      )
    : []
}

function _getDefinition(definition, name) {
  return (
    (definition.definitions && definition.definitions[name]) ||
    (definition.elements && definition.elements[name]) ||
    (definition.actions && definition.actions[name]) ||
    definition[name]
  )
}

function _resolveAliasInWhere(where, entity) {
  if (!entity._alias2ref) return
  for (let i = 0; i < where.length; i++) {
    if (!where[i].ref || where[i].ref.length > 1 || entity.keys[where[i].ref[0]]) continue
    where[i].ref = entity._alias2ref[where[i].ref[0]] || where[i].ref
  }
}

// case: single key without name, e.g., Foo(1)
function _addRefToWhereIfNecessary(where, entity) {
  if (!where || where.length !== 1) return 0
  const keys = _keysOf(entity)
  if (keys.length !== 1) return 0
  where.unshift(...[{ ref: [keys[0]] }, '='])
  return 1
}

function _processSegments(cqn, model) {
  const { ref } = cqn.SELECT.from

  let current = model
  let path
  let keys = null
  let keyCount = 0
  let incompleteKeys
  let one
  for (let i = 0; i < ref.length; i++) {
    const seg = ref[i].id || ref[i]
    const params = ref[i].where && where2obj(ref[i].where)

    if (incompleteKeys) {
      // > key
      keys = keys || _keysOf(current)
      const key = keys[keyCount++]
      one = true
      const element = current.elements[key]
      let base = ref[i - keyCount]
      if (!base.id) base = { id: base, where: [] }
      if (base.where.length) base.where.push('and')
      base.where.push({ ref: [key] }, '=', { val: element.type === 'cds.Integer' ? Number(seg) : seg })
      ref[i] = null
      ref[i - keyCount] = base
      incompleteKeys = keyCount < keys.length
    } else {
      // > entity or property (incl. nested) or navigation or action or function
      keys = null
      keyCount = 0
      one = false

      path = path ? path + `${path.match(/:/) ? '.' : ':'}${seg}` : seg
      // REVISIT: replace use case: <namespace>.<entity>_history is at <namespace>.<entity>.history
      current = _getDefinition(current, seg) || _getDefinition(current, seg.replace(/_/g, '.'))
      // REVISIT: 404 or 400?
      if (!current) cds.error(`Invalid resource path "${path}"`, { code: 404 })

      if (current.kind === 'entity') {
        // > entity
        one = !!(ref[i].where || current._isSingleton)
        incompleteKeys = ref[i].where ? false : i === ref.length - 1 || one ? false : true
        if (ref[i].where) {
          keyCount += _addRefToWhereIfNecessary(ref[i].where, current)
          _resolveAliasInWhere(ref[i].where, current)
        }
      } else if ({ action: 1, function: 1 }[current.kind]) {
        // > action or function
        if (i !== ref.length - 1) {
          const msg = `${i ? 'Unbound' : 'Bound'} ${current.kind} are only supported as the last path segment.`
          throw Object.assign(new Error(msg), { statusCode: 501 })
        }
        ref[i] = { operation: current.name }
        if (params) ref[i].args = params
        if (current.returns && current.returns.type) one = true
      } else if (current.isAssociation) {
        // > navigation
        one = !!(current.is2one || ref[i].where)
        incompleteKeys = one || i === ref.length - 1 ? false : true
        current = model.definitions[current.target]
        if (ref[i].where) {
          keyCount += _addRefToWhereIfNecessary(ref[i].where, current)
          _resolveAliasInWhere(ref[i].where, current)
        }
      } else if (current._isStructured) {
        // > nested property
        one = true
        current = current.elements
      } else {
        // > property
        one = true
      }
    }
  }

  if (incompleteKeys) {
    // > last segment not fully qualified
    throw Object.assign(
      new Error(
        `Entity "${current.name}" has ${_keysOf(current).length} keys. Only ${keyCount} ${
          keyCount === 1 ? 'was' : 'were'
        } provided.`
      ),
      { status: 400 }
    )
  }

  // remove all nulled refs
  cqn.SELECT.from.ref = ref.filter(r => r)

  // one?
  if (one) cqn.SELECT.one = true

  // REVISIT: better
  // set target (csn definition) for later retrieval
  cqn.__target = current
}

function _4service(service) {
  const { namespace, model } = service

  return cqn => {
    const { ref } = cqn.SELECT.from

    // REVISIT: shouldn't be necessary
    /*
     * make first path segment fully qualified
     */
    const root = findCsnTargetFor(ref[0].id || ref[0], model, namespace)
    // REVISIT: 404 or 400?
    if (!root) cds.error(`Invalid resource path "${namespace}.${ref[0].id || ref[0]}"`, { code: 404 })
    if (ref[0].id) ref[0].id = root.name
    else ref[0] = root.name

    /*
     * key vs. path segments (/Books/1/author/books/2/...) and more
     */
    _processSegments(cqn, model)

    return cqn
  }
}

const cache = new WeakMap()

module.exports = {
  for: service => {
    if (!cache.has(service)) cache.set(service, _4service(service))
    return cache.get(service)
  }
}
