const DELIMITER = require('./templateDelimiter')

const _addSubTemplate = (templateElements, elementName, subTemplate) => {
  if (subTemplate.elements.size > 0) {
    const t = templateElements.get(elementName)
    if (t) t.template = subTemplate
    else templateElements.set(elementName, { template: subTemplate })
  }
}

const _addToTemplateElements = (templateElements, elementName, picked) => {
  const tEl = templateElements.get(elementName)
  if (tEl) Object.assign(tEl, { picked })
  else templateElements.set(elementName, { picked })
}

const _addCacheToTemplateElements = (templateElements, elementName, cached) => {
  const tEl = templateElements.get(elementName)
  if (tEl) tEl.template = cached.template
  else templateElements.set(elementName, cached)
}

const _pick = (pick, element, target, parent, templateElements, elementName) => {
  const _picked = pick(element, target, parent)
  if (_picked) _addToTemplateElements(templateElements, elementName, { plain: _picked })
}

const _isInlineStructured = element => {
  return (
    (element._isStructured && !element.type) || (element.items && element.items._isStructured && !element.items.type)
  )
}

const _isNextTargetCacheable = element => {
  return (
    element.isAssociation ||
    (element._isStructured && element.type) ||
    (element.items && element.items._isStructured && element.items.type)
  )
}

const _getNextTarget = (model, element, currentPath = []) => {
  // _typed_ targets have names whereas inlines are targets themselves
  // For inlines names should be resolved up to the entity to avoid struct name clashings in entityMap
  if (_isNextTargetCacheable(element)) {
    const nextTargetName = element.target || element.type || (element.items && element.items.type)
    return {
      nextTargetName,
      nextTarget: model.definitions[nextTargetName]
    }
  }

  if (_isInlineStructured(element)) {
    return {
      nextTargetName: [...currentPath, element.name].join(DELIMITER),
      nextTarget: element.items || element
    }
  }

  return {}
}

/**
 *
 * @param {import('@sap/cds-compiler/lib/api/main').CSN} model Model
 * @param {Map} cache Internal - do not use
 * @param {object} targetEntity The target entity which needs to be traversed
 * @param {object} callbacks
 * @param {function} callbacks.pick Callback function to pick elements. If it returns a truthy value, the element will be picked. The returned value is part of the template.
 * @param {function} callbacks.ignore Callback function to ignore elements. If it returns a truthy value, the element will be ignored.
 * @param {object} [parent=null] The parent entity
 * @param {Map} [_entityMap] This parameter is an implementation side-effect — don't use it
 * @param {array} [targetPath=[]]
 */
function _getTemplate(model, cache, targetEntity, callbacks, parent = null, _entityMap = new Map(), targetPath = []) {
  const { pick, ignore } = callbacks
  const templateElements = new Map()
  const template = { target: targetEntity, elements: templateElements }
  const currentPath = [...targetPath, targetEntity.name]
  _entityMap.set(currentPath.join(DELIMITER), { template })
  if (!targetEntity.elements) return template

  for (const elementName in targetEntity.elements) {
    const element = targetEntity.elements[elementName]
    if (ignore && ignore(element, targetEntity, parent)) continue

    _pick(pick, element, targetEntity, parent, templateElements, elementName)

    if (element.items) {
      _pick(pick, element.items, targetEntity, parent, templateElements, ['_itemsOf', elementName].join(DELIMITER))
    }

    const { nextTargetName, nextTarget } = _getNextTarget(model, element, currentPath)
    const nextTargetCached = _entityMap.get(nextTargetName)

    if (nextTargetCached) {
      _addCacheToTemplateElements(templateElements, elementName, nextTargetCached)
    } else if (nextTarget) {
      // For associations and _typed_ structured elements, there's a (cacheable) target,
      // inline structures must be handled separately.
      const subTemplate = _isInlineStructured(element)
        ? _getTemplate(model, cache, nextTarget, { pick, ignore }, targetEntity, _entityMap, currentPath)
        : cache.for(nextTarget, getTemplate(model, { pick, ignore }, targetEntity, _entityMap))
      _addSubTemplate(templateElements, elementName, subTemplate)
    }
  }

  return template
}

const getTemplate =
  (model, ...args) =>
  (target, cache) =>
    _getTemplate(model, cache, target, ...args)

const getCache = (anything, cache, newCacheFn) => {
  let _cached = cache.get(anything)
  if (_cached) return _cached

  _cached = (typeof newCacheFn === 'function' && newCacheFn(anything, cache)) || new Map()
  _cached.for = (_usecase, _newCacheFn) => getCache(_usecase, _cached, _newCacheFn)
  cache.set(anything, _cached)
  return _cached
}

module.exports = (usecase, tx, target, ...args) => {
  // get model first as it may be added to tx (cf. "_ensureModel")
  const model = tx.model
  if (!model) return

  // double-check with get target from model
  // since target might come from anywhere like via cqn etc
  if (!target) return
  const root = (model && model.definitions[target.name]) || (target.elements && target)
  if (!root) return

  // tx could be the service itself
  // prefer ApplicationService (i.e., tx.context._tx.__proto__)
  // REVISIT: context._tx is not a stable API -> pls do not rely on that
  const service = tx.context
    ? (tx.context._tx && Object.getPrototypeOf(tx.context._tx)) || Object.getPrototypeOf(tx)
    : tx
  if (!service) return

  // cache templates at service for garbage collection
  if (usecase && !service._templateCache) service._templateCache = new Map()
  // model can be also a subset from tx

  // if no usecase, don't save cache on the service object
  return getCache(usecase, usecase ? service._templateCache : new Map())
    .for(model)
    .for(root, getTemplate(model, ...args))
}
