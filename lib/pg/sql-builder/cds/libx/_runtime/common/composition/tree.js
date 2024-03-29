const cds = require('../../cds')

const { ensureNoDraftsSuffix } = require('../utils/draft')
const { isRootEntity } = require('../utils/csn')
const { getTransition, getDBTable } = require('../utils/resolveView')

const getError = require('../../common/error')

/*
 * own utils
 */

const _foreignKeysToLinks = (element, inverse) =>
  element._foreignKeys.map(e => {
    e = inverse
      ? {
          childElement: e.parentElement,
          parentElement: e.childElement,
          childFieldValue: e.parentFieldValue,
          parentFieldValue: e.childFieldValue,
          prefix: e.prefix
        }
      : e
    const link = {}
    if (e.parentElement)
      link.entityKey =
        e.prefix && !e.parentElement.name.includes(e.prefix)
          ? `${e.prefix}_${e.parentElement.name}`
          : e.parentElement.name
    if (e.childElement)
      link.targetKey =
        e.prefix && !e.childElement.name.includes(e.prefix) ? `${e.prefix}_${e.childElement.name}` : e.childElement.name
    if (e.parentFieldValue !== undefined) link.entityVal = e.parentFieldValue
    if (e.childFieldValue !== undefined) link.targetVal = e.childFieldValue
    return link
  })

const _resolvedElement = (element, service) => {
  if (!element.target) return element
  // skip forbidden view check if association to view with foreign key in target
  const skipForbiddenViewCheck = element._isAssociationStrict && element.on && !element['@odata.contained']
  const { target, mapping } = getTransition(element._target, service, skipForbiddenViewCheck)
  const newElement = { target: target.name, _target: target }
  Object.setPrototypeOf(newElement, element)
  if (element.on) {
    newElement.on = element.on.map(onEl => {
      if (!onEl.ref || onEl.ref[0] !== element.name) return onEl
      const mapped = mapping.get(onEl.ref[1])
      if (!mapped || !mapped.ref) return onEl
      const newRef = [onEl.ref[0], mapped.ref[0]]
      return { ...onEl, ...{ ref: newRef } }
    })
  }
  return newElement
}

const _navigationExistsInCompositionMap = (element, compositionMap) =>
  compositionMap.has(element.target) && element._isCompositionEffective

const _isUnManaged = element => element.on && !element._isSelfManaged

const _isNonRecursiveNavigation = (element, rootEntityName) =>
  rootEntityName !== element.target && element._isCompositionEffective

const _skipPersistence = (element, definitions) => definitions[element.target]._hasPersistenceSkip

const _createSubElement = (element, definitions) => {
  const subObject = { name: element.name, customBackLinks: [], links: [], backLinks: [] }
  if (_skipPersistence(element, definitions)) {
    subObject.skipPersistence = true
  }
  return subObject
}

// eslint-disable-next-line complexity
const _getCompositionTreeRec = ({
  rootEntityName,
  definitions,
  compositionMap,
  compositionTree,
  entityName,
  parentEntityName,
  resolveViews,
  service
}) => {
  compositionMap.set(parentEntityName, compositionTree)
  compositionTree.source = parentEntityName
  if (parentEntityName !== rootEntityName) {
    compositionTree.target = entityName
  }
  compositionTree.compositionElements = []
  compositionTree.backLinks = compositionTree.backLinks || []
  compositionTree.customBackLinks = compositionTree.customBackLinks || []

  const parentEntity = definitions[parentEntityName]

  for (const elementName in parentEntity.elements) {
    const unresolvedEl = parentEntity.elements[elementName]
    const element = resolveViews ? _resolvedElement(unresolvedEl, service) : unresolvedEl
    if (!element.isAssociation) continue
    if (_navigationExistsInCompositionMap(element, compositionMap)) {
      const compositionElement = Object.assign({}, compositionMap.get(element.target), {
        name: element.name,
        target: parentEntityName,
        links: [],
        backLinks: [],
        customBackLinks: []
      })
      if (!element._isSelfManaged) {
        const backLinks = _foreignKeysToLinks(element, true) || []
        if (element.is2many) {
          compositionElement.customBackLinks.push(...backLinks)
        } else {
          compositionElement.backLinks.push(...backLinks)
        }
      } else {
        const targetEntity = definitions[element.target]
        for (const backLinkName in targetEntity.elements) {
          const _backLink = targetEntity.elements[backLinkName]
          if (!_backLink._isAssociationEffective) continue
          if (
            _backLink._isCompositionBacklink &&
            _backLink.target === compositionElement.target &&
            _backLink._anchor.name === element.name
          ) {
            const backLinks = _foreignKeysToLinks(_backLink) || []
            if (_isUnManaged(element)) {
              compositionElement.customBackLinks.push(...backLinks)
            } else {
              compositionElement.backLinks.push(...backLinks)
            }
          }
        }
      }
      compositionTree.compositionElements.push(compositionElement)
    } else if (_isNonRecursiveNavigation(element, rootEntityName)) {
      const subObject = _createSubElement(element, definitions)
      if (!element._isSelfManaged) {
        const backLinks = _foreignKeysToLinks(element, true) || []
        if (element.is2many) {
          subObject.customBackLinks.push(...backLinks)
        } else {
          subObject.backLinks.push(...backLinks)
        }
      }
      compositionTree.compositionElements.push(subObject)
      _getCompositionTreeRec({
        rootEntityName,
        definitions,
        compositionMap,
        compositionTree: subObject,
        entityName: parentEntityName,
        parentEntityName: element.target,
        service
      })
    } else if (
      element._isAssociationEffective &&
      element._isCompositionBacklink &&
      element.target === compositionTree.target &&
      compositionMap.has(element.target)
    ) {
      const backLinks = _foreignKeysToLinks(element) || []
      if (_isUnManaged(element)) {
        compositionTree.customBackLinks.push(...backLinks)
      } else {
        compositionTree.backLinks.push(...backLinks)
      }
    }
  }
}

const _resolvedEntityName = (entityName, definitions) => {
  const target = definitions[entityName]
  if (!target) return entityName
  const resolved = getDBTable(target)
  return resolved.name
}

const _removeLocalizedTextsFromDraftTree = (compositionTree, definitions, checkedEntities = new Set()) => {
  for (const e of compositionTree.compositionElements) {
    if (checkedEntities.has(e.source)) {
      return
    }

    const target = definitions[e.target]
    if (e.name === 'texts' && target.elements.localized && !target['@fiori.draft.enabled']) {
      compositionTree.compositionElements.splice(compositionTree.compositionElements.indexOf(e), 1)
    } else {
      checkedEntities.add(e.source)
      _removeLocalizedTextsFromDraftTree(e, definitions, checkedEntities)
    }
  }
}

const _getCompositionTree = ({ definitions, rootEntityName, checkRoot = true, resolveViews = false, service }) => {
  const rootName = resolveViews ? _resolvedEntityName(rootEntityName, definitions) : rootEntityName

  if (checkRoot && !isRootEntity(definitions, rootEntityName)) {
    throw getError(`Entity "${rootEntityName}" is not root entity`)
  }
  const compositionTree = {}
  _getCompositionTreeRec({
    rootEntityName: rootName,
    definitions,
    compositionMap: new Map(),
    compositionTree,
    entityName: rootName,
    parentEntityName: rootName,
    resolveViews,
    service
  })

  if (definitions[rootEntityName]._isDraftEnabled) {
    _removeLocalizedTextsFromDraftTree(compositionTree, definitions)
  }

  return compositionTree
}

const _cacheCompositionParentsOfOne = ({ definitions }) => {
  for (const parentName in definitions) {
    const parent = definitions[parentName]
    if (!parent.kind === 'entity' || !parent.elements) continue
    for (const elementName in parent.elements) {
      const element = parent.elements[elementName]
      if (element._isCompositionEffective && element.is2one && !element._isSelfManaged) {
        const targetName = element.target
        const target = definitions[targetName]
        if (!target) continue
        const parentMap = (target.own('__oneCompositionParents') && target.__oneCompositionParents) || new Map()
        const binding = parentMap.get(parentName) || {}
        binding.elements = binding.elements || new Map()
        const el = _createSubElement(element, definitions)
        el.target = targetName
        el.source = parentName
        el.links = _foreignKeysToLinks(element)
        binding.elements.set(element.name, el)
        parentMap.set(parentName, binding)
        target.set('__oneCompositionParents', parentMap)
      }
    }
  }
}

const _memoizeGetCompositionTree = fn => {
  const cache = new Map()
  return ({ definitions, rootEntityName, checkRoot = true, resolveViews = false, service }) => {
    const key = [rootEntityName, checkRoot].join('#')

    // use ApplicationService as cache key for extensibility
    // REVISIT: context._tx is not a stable API -> pls do not rely on that
    const cacheKey = (cds.context && cds.context._tx && Object.getPrototypeOf(cds.context._tx)) || definitions

    const map = cache.get(cacheKey)
    const cachedResult = map && map.get(key)
    if (cachedResult) return cachedResult
    _cacheCompositionParentsOfOne({ definitions })
    const compTree = fn({ definitions, rootEntityName, checkRoot, resolveViews, service })

    const _map = map || new Map()
    _map.set(key, compTree)
    if (!map) cache.set(cacheKey, _map)

    return compTree
  }
}

/*
 * exports
 */

const getCompositionRoot = (definitions, entity) => {
  const associationElements = Object.keys(entity.elements)
    .map(key => entity.elements[key])
    .filter(element => element._isAssociationEffective)

  for (const { target } of associationElements) {
    const parentEntity = definitions[target]
    for (const parentElementName in parentEntity.elements) {
      const parentElement = parentEntity.elements[parentElementName]
      if (
        parentElement._isCompositionEffective &&
        parentElement.target === entity.name &&
        parentElement.target !== ensureNoDraftsSuffix(parentElement.parent.name)
      ) {
        return getCompositionRoot(definitions, parentEntity)
      }
    }
  }
  return entity
}

/**
 * Provides tree of all compositions. (Cached)
 *
 * @param {object} definitions Definitions of the reflected model
 * @param {string} rootEntityName Name of the root entity
 * @param {boolean} checkRoot Check is provided entity is a root
 * @returns {object} tree of all compositions
 * @throws Error if no valid root entity provided
 */
const getCompositionTree = _memoizeGetCompositionTree(_getCompositionTree)

module.exports = {
  getCompositionTree,
  getCompositionRoot
}
