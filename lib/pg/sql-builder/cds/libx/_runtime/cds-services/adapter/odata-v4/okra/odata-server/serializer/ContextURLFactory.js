'use strict'

const commons = require('../../odata-commons')
const EdmTypeKind = commons.edm.EdmType.TypeKind
const ResourceKind = commons.uri.UriResource.ResourceKind
const QueryOptions = commons.uri.UriInfo.QueryOptions
const RepresentationKind = commons.format.RepresentationKind.Kinds
const UriHelper = require('../utils/UriHelper')
const SerializationError = require('../errors/SerializationError')
const { appURL } = require('../../../../../../common/utils/vcap')

/**
 * Context URL construction.
 */
class ContextURLFactory {

  /**
   * Creates context URL for the request URI represented by the uriInfo input parameter.
   * @param {UriInfo} uriInfo information about the request URI
   * @param {?(ExpandItem[])} expand expand items
   * @param {RepresentationKind.Kinds} representationKind the representation kind
   * @param {Map.<UriResource, Object>} [providedKeyMap] the application-provided keys for each path segment
   *                                                     (see docs in context-url-building.md file)
   * @param {IncomingMessage} request Request received from the client
   * @param {Edm} edm the EDM
   * @returns {string} Context URL
   */
  createContextURL(uriInfo, expand, representationKind, providedKeyMap = new Map(), edm, request, logger) {
    const pathSegments = uriInfo.getPathSegments()
    const lastSegment = pathSegments[pathSegments.length - 1]

    if (lastSegment.getKind() === ResourceKind.SERVICE) return '$metadata'
    if (lastSegment.getKind() === ResourceKind.METADATA) return ''

    const contextUrlInfo = this._parseSegments(pathSegments, providedKeyMap, edm)

    const contextUrlPrefix = this._buildContextUrlPrefix(contextUrlInfo, pathSegments, request, logger)

    const finalEdmType = uriInfo.getFinalEdmType()
    const structuredType =
      finalEdmType && (finalEdmType.getKind() === EdmTypeKind.ENTITY || finalEdmType.getKind() === EdmTypeKind.COMPLEX)
        ? finalEdmType
        : null

    let url = contextUrlInfo.result
    if (contextUrlInfo.isOnlyTyped) {
      url = finalEdmType.getFullQualifiedName().toString()
      if (lastSegment.isCollection()) url = 'Collection(' + url + ')'
    }

    // There are special cases in the decision whether to add an entity suffix:
    // - The response representation kind of a create request is different from what we expect from the URL.
    // - Singletons represent a single entity, but their context URL has no entity suffix.
    const isEntity =
      (contextUrlInfo.isEntity || (!contextUrlInfo.isOnlyTyped && representationKind === RepresentationKind.ENTITY)) &&
      !(
        lastSegment.getSingleton() ||
        (lastSegment.getTarget() && edm.getEntityContainer().getSingleton(lastSegment.getTarget().getName()))
      )

    const selectItems = uriInfo.getQueryOption(QueryOptions.SELECT)
    // Transient types introduced by Data Aggregation have a select list if they are aggregated.
    // In that case key properties are not required, even in expanded entities.
    const isReduced = finalEdmType && finalEdmType.isReduced && finalEdmType.isReduced()
    let select = this._buildSelect(selectItems, expand, structuredType, !isReduced)
    if (!selectItems && isReduced) select = select.concat(Array.from(finalEdmType.getProperties().keys()))
    const selectString = select.length ? '(' + select.join(',') + ')' : ''

    return contextUrlPrefix + '$metadata#' + url + selectString + (isEntity ? '/$entity' : '')
  }

  /**
   * Parse the URI segments.
   * @param {UriResource[]} pathSegments the path segments
   * @param {Map.<UriResource, Object>} keyMap the application-provided keys for each path segment
   * @param {Edm} edm the entity data model
   * @returns {{result: string, isOnlyTyped: boolean, isEntity: boolean, hasReferencedSegment: boolean}} result object
   * @private
   */
  _parseSegments (pathSegments, keyMap, edm) {
    const localNamespace = edm.getEntityContainer().getNamespace()

    let result = []
    let isOnlyTyped = false
    let isEntity = false
    let isFinal = false
    let hasReferencedSegment = false

    // The iteration starts at the end and goes backwards until a final result has been obtained.
    for (let index = pathSegments.length - 1; index >= 0; index--) {
      const segment = pathSegments[index]
      let target

      const kind = segment.getKind()
      switch (kind) {
        case ResourceKind.ENTITY:
          target = segment.getEntitySet()
          result.unshift(
            target.getName() +
            (pathSegments.length > index + 1
              ? this._buildKeys(target.getEntityType(), segment.getKeyPredicates(), keyMap.get(segment))
              : '')
          )
          if (result.length === 1) isEntity = true
          break
        case ResourceKind.ENTITY_COLLECTION:
          target = segment.getEntitySet()
          result.unshift(target.getName())
          break
        case ResourceKind.SINGLETON:
          target = segment.getSingleton()
          result.unshift(target.getName())
          break

        case ResourceKind.NAVIGATION_TO_ONE:
        case ResourceKind.NAVIGATION_TO_MANY: {
          const edmNavigationProperty = segment.getNavigationProperty()
          target = segment.getTarget()
          const hasKeys = result.length && !segment.isCollection()
          if (edmNavigationProperty.containsTarget()) {
            result.unshift(
              edmNavigationProperty.getName() +
              (edmNavigationProperty.isCollection() && hasKeys
                ? this._buildKeys(
                  edmNavigationProperty.getEntityType(),
                  segment.getKeyPredicates(),
                  keyMap.get(segment)
                )
                : '')
            )
            if (result.length === 1 && !segment.isCollection()) isEntity = true
          } else if (target) {
            const name = target.getName()
            result.unshift(
              name +
              (hasKeys
                ? this._buildKeys(target.getEntityType(), segment.getKeyPredicates(), keyMap.get(segment))
                : '')
            )
            if (result.length === 1 && !segment.isCollection()) isEntity = true
            isFinal = true
          } else {
            isOnlyTyped = true
          }
          break
        }

        case ResourceKind.REF:
          result.unshift('$ref')
          isFinal = true
          break
        case ResourceKind.REF_COLLECTION:
          result.unshift('Collection($ref)')
          isFinal = true
          break

        case ResourceKind.PRIMITIVE_PROPERTY:
        case ResourceKind.PRIMITIVE_COLLECTION_PROPERTY:
        case ResourceKind.COMPLEX_PROPERTY:
        case ResourceKind.COMPLEX_COLLECTION_PROPERTY:
          result.unshift(segment.getProperty().getName())
          break

        case ResourceKind.FUNCTION_IMPORT:
        case ResourceKind.ACTION_IMPORT:
        case ResourceKind.BOUND_FUNCTION:
        case ResourceKind.BOUND_ACTION:
          target = segment.getTarget()
          if (target) {
            result.unshift(
              target.getName() +
              (result.length && !segment.isCollection()
                ? this._buildKeys(target.getEntityType(), segment.getKeyPredicates(), keyMap.get(segment))
                : '')
            )
            if (result.length === 1 && !segment.isCollection()) isEntity = true
            isFinal = true
          } else {
            isOnlyTyped = true
          }
          break

        case ResourceKind.TYPE_CAST:
          result.unshift(
            segment
              .getEdmType()
              .getFullQualifiedName()
              .toString()
          )
          if (result.length === 1 && segment.getEdmType().getKind() === EdmTypeKind.ENTITY && !segment.isCollection()) {
            isEntity = true
          }
          break

        case ResourceKind.CROSSJOIN:
          result.unshift('Collection(Edm.ComplexType)')
          break

        case ResourceKind.ALL:
          if (result.length) isOnlyTyped = true // typecast segment after $all
          if (!isOnlyTyped) result.unshift('Collection(Edm.EntityType)')
          break

        default:
          throw new SerializationError('Unsupported segment type found in URL path segments: ' + kind)
      }
      if (target && target.getEntityType().getNamespace() !== localNamespace) hasReferencedSegment = true
      if (isOnlyTyped || isFinal) break
    }

    return { result: result.join('/'), isOnlyTyped, isEntity, hasReferencedSegment }
  }

  /**
   * Builds the key parameter string from URI parameters and provided keys.
   * The result will be a string looking like "(PropertyInt16=1,PropertyString='2')".
   *
   * @param {EdmEntityType} edmType the edm entity type where the keys exist
   * @param {UriParameter[]} uriParameters the key predicates to build
   * @param {Object} [providedKeys] the application-provided keys (see also context-url-building.md)
   * @returns {string} the result string
   * @private
   */
  _buildKeys(edmType, uriParameters, providedKeys = {}) {
    let resultKeys = UriHelper.buildKeyPredicates(uriParameters)

    // Add missing keys from application-provided keys to the existing keys extracted from the URI.
    // A provided key is only added to the existing keys if this key does not exist already.
    const availableKeys = edmType.getKeyPropertyRefs()
    for (const name in providedKeys) {
      if (!availableKeys.has(name)) {
        throw new SerializationError(
          "Key property '" + name + "' does not exist in '" + edmType.getFullQualifiedName() + "'"
        )
      }
      if (!resultKeys.find(elem => elem.name === name)) {
        const propertyType = availableKeys
          .get(name)
          .getProperty()
          .getType()
        resultKeys.push({ name, value: providedKeys[name], type: propertyType })
      }
    }

    if (resultKeys.length > 0 && resultKeys.length < availableKeys.size) {
      throw new SerializationError("Missing key value(s) for '" + edmType.getFullQualifiedName() + "'")
    }

    return resultKeys.length > 0 ? UriHelper.buildKeyString(resultKeys) : ''
  }

  /**
   * Builds the context URL select list.
   * @param {?(SelectItem[])} select select items
   * @param {?(ExpandItem[])} expand expand items
   * @param {?(EdmEntityType|EdmComplexType)} type the type of the current structure or null
   * @param {boolean} isKeyRequired whether key properties are required for the select list
   * @returns {string[]} the built select list
   * @private
   */
  _buildSelect(select, expand, type, isKeyRequired) {
    let value = []

    if (select) {
      let isAll = false
      for (const selectItem of select) {
        if (selectItem.isAllOperationsInSchema()) {
          value.push(selectItem.getAllOperationsInSchemaNamespace() + '.*')
        } else if (selectItem.isAll()) {
          isAll = true
          break
        } else {
          const selectItemString = selectItem
            .getPathSegments()
            .map(uriResource => uriResource.getPathSegmentIdentifier())
            .join('/')
          if (!value.includes(selectItemString)) value.push(selectItemString)
        }
      }

      // If there is one '*' selected, the context URL contains only '*'.
      if (isAll) {
        value = ['*']
      } else if (type && type.getKind() === EdmTypeKind.ENTITY && isKeyRequired) {
        for (const keyName of type.getKeyPropertyRefs().keys()) {
          if (!value.includes(keyName)) value.push(keyName)
        }
      }
    }

    if (expand && expand.length) {
      const expandValue = this._buildExpand(expand, type, isKeyRequired)
      if (expandValue) value.push(expandValue)
    }

    return value
  }

  /**
   * Builds the expand context URL part string. This includes nested select items and nested expands.
   * @param {ExpandItem[]} expand the expand items to be processed
   * @param {EdmEntityType} type the type of the expanded entity
   * @param {boolean} isKeyRequired whether key properties are required for the select list
   * @returns {string} the expand context URL string
   * @private
   */
  _buildExpand(expand, type, isKeyRequired) {
    let result = []
    for (const expandItem of expand) {
      const expandItemPathsegments = expandItem.getPathSegments()
      const finalResourceSegment = expandItemPathsegments[expandItemPathsegments.length - 1]
      // /$count on an expanded entity -> The navigation property shall not be part of the Context URI.
      if (finalResourceSegment && finalResourceSegment.getKind() === ResourceKind.COUNT) continue

      const pathSegmentIdentifier = expandItemPathsegments.map(segment => segment.getPathSegmentIdentifier()).join('/')

      let nextExpandItems = expandItem.getOption(QueryOptions.EXPAND)

      const selectItems = expandItem.getOption(QueryOptions.SELECT)
      if (selectItems) {
        let plusSign = ''
        if (expandItem.getOption('$levels')) {
          // The '+' only should be used if the expanded property has a $levels option.
          // The recursion should end here also. Therefore the possible next expand-item list is set to null.
          plusSign = '+'
          nextExpandItems = null
        }
        const nextSelect = this._buildSelect(
          selectItems,
          nextExpandItems,
          finalResourceSegment.getEdmType(),
          isKeyRequired
        )
        const nextSelectBuild = nextSelect.length ? `(${nextSelect.join(',')})` : ''
        result.push(pathSegmentIdentifier + plusSign + nextSelectBuild)
      } else if (nextExpandItems) {
        const nestedExpand = this._buildExpand(nextExpandItems, finalResourceSegment.getEdmType(), isKeyRequired) || ''
        result.push(finalResourceSegment.getPathSegmentIdentifier() + '(' + nestedExpand + ')')
      } else if (pathSegmentIdentifier) {
        // Regarding to an internal discussion on the structure of the context url
        // the following decision was made:
        // $metadata#ESAllPrim     -> All Properties
        // $metadata#ESAllPrim(PrimProperty)  -> Only PrimProperty from $select
        // $metadata#ESAllPrim(NavPropertyETTwoPrimMany()) -> All Properties of ESAllPrim and
        //      NavPropertyETTwoPrimMany expanded with all properties
        // $metadata#ESAllPrim(PrimProperty,NavPropertyETTwoPrimMany()) -> PrimProperty of ESAllPrim and
        //      NavPropertyETTwoPrimMany expanded with all properties
        // See also https://issues.oasis-open.org/browse/ODATA-1156

        result.push(pathSegmentIdentifier + '(' + (expandItem.isAll() ? '*' : '') + ')')
      } else if (expandItem.isAll()) {
        // Define a local function because navigation properties must be searched recursively.
        const getExpandPaths = structuredType => {
          let structureResult = []
          for (const name of structuredType.getNavigationProperties().keys()) structureResult.push(name)
          for (const [name, property] of structuredType.getProperties()) {
            if (property.getType().getKind() === EdmTypeKind.COMPLEX) {
              for (const innerPath of getExpandPaths(property.getType())) {
                structureResult.push(name + '/' + innerPath)
              }
            }
          }
          return structureResult
        }
        for (const path of getExpandPaths(type)) result.push(path + '()')
      } else {
        result.push('')
      }
    }

    return result.join(',')
  }

  /**
   * Builds context URL prefix
   * @param {Object} contextUrlInfo context URL information
   * @param {UriResource[]} pathSegments the path segments
   * @param {IncomingMessage} request request received from the client
   * @param {LoggerFacade} logger the logger
   * @returns {string} context URL prefix
   * @private
   */
  _buildContextUrlPrefix(contextUrlInfo, pathSegments, request, logger) {
    if (!!cds.env.odata.contextAbsoluteUrl) {
      try {
        if (typeof cds.env.odata.contextAbsoluteUrl === 'string') {
        let userDefinedURL = new URL(cds.env.odata.contextAbsoluteUrl, cds.env.odata.contextAbsoluteUrl).toString()
        return !userDefinedURL.endsWith('/') && `${userDefinedURL}/` || userDefinedURL
        }
      } catch (e) {
        e.message = `cds.odata.contextAbsoluteUrl could not be parsed as URL: ${cds.env.odata.contextAbsoluteUrl}`
        logger.warning(e)
      }
      const reqURL = request && request.get && request.get('host') && `${request.protocol || 'https'}://${request.get('host')}`
      const baseAppURL = appURL || reqURL || ''
      const serviceUrl = `${request && request.baseUrl || ''}/`
      return baseAppURL && new URL(serviceUrl, baseAppURL).toString()
    }
    return contextUrlInfo.hasReferencedSegment ? '/' : '../'.repeat(pathSegments.length - 1)
  }
}

module.exports = ContextURLFactory
