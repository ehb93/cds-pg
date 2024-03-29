'use strict'

const KeyPredicateParser = require('./KeyPredicateParser')
const FunctionParameterParser = require('./FunctionParameterParser')
const UriResource = require('./UriResource')
const UriTokenizer = require('./UriTokenizer')
const TokenKind = UriTokenizer.TokenKind
const FullQualifiedName = require('../FullQualifiedName')
const EdmTypeKind = require('../edm/EdmType').TypeKind
const EdmPrimitiveTypeKind = require('../edm/EdmPrimitiveTypeKind')
const UriSyntaxError = require('../errors/UriSyntaxError')
const UriSemanticError = require('../errors/UriSemanticError')
const NotImplementedError = require('../errors/NotImplementedError')
const FeatureSupport = require('../FeatureSupport')

/**
 * OData ABNF resource-path parser
 */
class ResourcePathParser {
  /**
   * Creates an instance of ResourcePathParser.
   * @param {Edm} edm The current instance of EDM
   * @param {Object} aliases Alias definitions
   */
  constructor (edm, aliases) {
    this._edm = edm
    this._aliases = aliases
    this._edmContainer = this._edm.getEntityContainer()
    this._target = null
  }

  /**
   * Parse the current URI segments. These segments must not include any '/'.
   * @param {string[]} uriPathSegments The current already percent-decoded URI segments
   * @throws {UriSyntaxError|UriSemanticError} if the URI could not be parsed
   * @returns {UriResource[]} An array of UriResource objects
   */
  parse (uriPathSegments) {
    this._target = null
    let result = []
    let tokenizer = new UriTokenizer(uriPathSegments[0])

    tokenizer.requireNext(TokenKind.ODataIdentifier)

    const currentToken = tokenizer.getText()
    let currentResource = new UriResource()
    let edmResult = this._edmContainer.getEntitySet(currentToken)

    if (edmResult) {
      currentResource
        .setKind(UriResource.ResourceKind.ENTITY_COLLECTION)
        .setIsCollection(true)
        .setEntitySet(edmResult)

      this._target = edmResult
      const uriResources = this._parseCollectionNavigation(uriPathSegments, currentResource, tokenizer)
      return result.concat(uriResources)
    }

    edmResult = this._edmContainer.getSingleton(currentToken)

    if (edmResult) {
      currentResource
        .setKind(UriResource.ResourceKind.SINGLETON)
        .setSingleton(edmResult)
        .setIsCollection(false)

      this._target = edmResult
      tokenizer.requireNext(TokenKind.EOF)
      uriPathSegments.shift()
      return result.concat(this._parseSingleNavigation(uriPathSegments, currentResource))
    }

    edmResult = this._edmContainer.getActionImport(currentToken)

    if (edmResult) {
      const unboundAction = edmResult.getUnboundAction()

      this._target = edmResult.getReturnedEntitySet()

      currentResource
        .setKind(UriResource.ResourceKind.ACTION_IMPORT)
        .setActionImport(edmResult)
        .setAction(unboundAction)
        .setIsCollection(unboundAction.getReturnType() ? unboundAction.getReturnType().isCollection() : false)
        .setTarget(this._target)

      tokenizer.requireNext(TokenKind.EOF)
      uriPathSegments.shift()
      return result.concat(currentResource)
    }

    edmResult = this._edmContainer.getFunctionImport(currentToken)

    if (edmResult) {
      const functions = edmResult.getUnboundFunctions()
      const returnType = functions[0].getReturnType()
      const isCollection = returnType.isCollection()
      const kind = returnType.getType().getKind()

      this._parseFunctionImport(currentResource, edmResult, tokenizer)

      const unboundFunction = currentResource.getFunction()
      if (unboundFunction && !unboundFunction.isComposable() && uriPathSegments.length > 1) {
        throw new UriSyntaxError(
          UriSyntaxError.Message.FUNCTION_NOT_COMPOSABLE,
          unboundFunction.getName(),
          uriPathSegments[uriPathSegments.length - 1]
        )
      }

      this._target = edmResult.getReturnedEntitySet()

      if (kind === EdmTypeKind.ENTITY) {
        currentResource.setTarget(this._target)

        if (isCollection) {
          // We do not need EOF / uriPathSegments.shift() because we try to parse
          // the next key (if available). This is done in the current segment.
          return [].concat(this._parseCollectionNavigation(uriPathSegments, currentResource, tokenizer))
        }

        // If the return type is not a collection, no keys are allowed.
        if (tokenizer.next(TokenKind.OPEN)) {
          throw new UriSyntaxError(UriSyntaxError.Message.FUNCTION_IMPORT_EOF, edmResult.getName())
        }

        tokenizer.requireNext(TokenKind.EOF)
        uriPathSegments.shift()
        return result.concat(this._parseSingleNavigation(uriPathSegments, currentResource))
      }

      // Only entities can have keys.
      if (tokenizer.next(TokenKind.OPEN)) {
        throw new UriSyntaxError(UriSyntaxError.Message.FUNCTION_IMPORT_EOF, edmResult.getName())
      }

      tokenizer.requireNext(TokenKind.EOF)
      uriPathSegments.shift()

      let functionRest
      if (isCollection) {
        functionRest =
          kind === EdmTypeKind.COMPLEX
            ? this._parseComplexCollectionPath(uriPathSegments, currentResource)
            : this._parsePrimitiveCollectionPath(uriPathSegments, currentResource)
      } else {
        functionRest =
          kind === EdmTypeKind.COMPLEX
            ? this._parseComplexPath(uriPathSegments, currentResource)
            : this._parsePrimitivePath(uriPathSegments, currentResource)
      }

      return functionRest ? result.concat(currentResource, functionRest) : result.concat(currentResource)
    }

    throw new UriSemanticError(UriSemanticError.Message.WRONG_NAME, currentToken)
  }

  /**
   * Parse a function import.
   * @param {UriResource} currentResource The current uri resource object
   * @param {EdmFunctionImport} functionImport The current function import
   * @param {UriTokenizer} tokenizer The current tokenizer
   * @private
   */
  _parseFunctionImport (currentResource, functionImport, tokenizer) {
    currentResource.setKind(UriResource.ResourceKind.FUNCTION_IMPORT)
    currentResource.setFunctionImport(functionImport)

    // Parse function-import parameters.
    const functions = functionImport.getUnboundFunctions()
    const parser = new FunctionParameterParser(this._edm, this._aliases)
    parser.parse(functionImport.getName(), functions, tokenizer, visitedParameters => {
      return functionImport.getUnboundFunction(Array.from(visitedParameters.keys()))
    })

    const unboundFunction = parser.getFunction()
    if (!unboundFunction) {
      throw new UriSyntaxError(UriSyntaxError.Message.FUNCTION_IMPORT_FUNCTION_NOT_FOUND, tokenizer.getText())
    }

    currentResource
      .setFunction(unboundFunction)
      .setFunctionParameters(parser.getParameters())
      .setIsCollection(unboundFunction.getReturnType().isCollection())
  }

  /**
   * Parse OData ABNF collection navigation.
   * @param {string[]} uriPathSegments The uri path segments
   * @param {UriResource} currentResourceParam The current resource
   * @param {UriTokenizer} tokenizerParam The current tokenizer
   * @returns {UriResource|UriResource[]|null} Returns UriResource, array of UriResource, or null
   * @private
   */
  _parseCollectionNavigation (uriPathSegments, currentResourceParam, tokenizerParam) {
    let result = []
    let currentResource = currentResourceParam
    let tokenizer = tokenizerParam

    if (tokenizer.next(TokenKind.EOF) && uriPathSegments.length > 1) {
      const typeTokenizer = new UriTokenizer(uriPathSegments[1])

      if (typeTokenizer.next(TokenKind.QualifiedName)) {
        const qualifiedName = typeTokenizer.getText()
        const typeCastResource = this._parseTypeCast(currentResource, qualifiedName)
        if (typeCastResource) {
          uriPathSegments.shift()
          result.push(currentResource)
          currentResource = typeCastResource
          tokenizer = typeTokenizer
        }
      }
    }

    const uriResources = this._parseCollectionNavPath(uriPathSegments, currentResource, tokenizer)
    return result.concat(uriResources)
  }

  /**
   * Parse OData type cast.
   * @param {UriResource} prevResource The previous resource
   * @param {string} qualifiedName The qualified name of the current uri segment
   * @returns {?UriResource} a UriResource or null
   * @private
   */
  _parseTypeCast (prevResource, qualifiedName) {
    const fqn = FullQualifiedName.createFromNameSpaceAndName(qualifiedName)
    const currentType = prevResource.getEdmType()

    const type =
      currentType.getKind() === EdmTypeKind.ENTITY ? this._edm.getEntityType(fqn) : this._edm.getComplexType(fqn)
    if (!type) return null

    // Type casts are explicitly not supported (although the parser can parse them).
    FeatureSupport.failUnsupported(FeatureSupport.features.TypeCast, qualifiedName, 0)

    if (!type.compatibleTo(currentType)) {
      throw new UriSemanticError(
        UriSemanticError.Message.INCOMPATIBLE_TYPE,
        qualifiedName,
        currentType.getFullQualifiedName()
      )
    }

    return new UriResource()
      .setKind(UriResource.ResourceKind.TYPE_CAST)
      .setTypeCast(type)
      .setIsCollection(prevResource.isCollection())
  }

  /**
   * Parse OData ABNF collection nav path.
   * @param {string[]} uriPathSegments The uri path segments
   * @param {UriResource} currentResource The current resource
   * @param {UriTokenizer} tokenizer The current tokenizer
   * @returns {UriResource|UriResource[]|null} Returns UriResource, array of UriResource, or null
   * @private
   */
  _parseCollectionNavPath (uriPathSegments, currentResource, tokenizer) {
    if (tokenizer.next(TokenKind.OPEN)) {
      if (tokenizer.next(TokenKind.CLOSE)) throw new UriSyntaxError(UriSyntaxError.Message.KEY_EXPECTED)

      const edmType = currentResource.getEdmType()
      const keyPredicates = new KeyPredicateParser(this._edm, this._aliases).parse(currentResource, edmType, tokenizer)

      tokenizer.requireNext(TokenKind.CLOSE)
      currentResource.setKeyPredicates(keyPredicates).setIsCollection(false)

      if (currentResource.getKind() === UriResource.ResourceKind.ENTITY_COLLECTION) {
        currentResource.setKind(UriResource.ResourceKind.ENTITY)
      } else if (currentResource.getKind() === UriResource.ResourceKind.NAVIGATION_TO_MANY) {
        currentResource.setKind(UriResource.ResourceKind.NAVIGATION_TO_ONE)
      }

      tokenizer.requireNext(TokenKind.EOF)
      uriPathSegments.shift()

      return this._parseSingleNavigation(uriPathSegments, currentResource)
    }

    tokenizer.requireNext(TokenKind.EOF)
    uriPathSegments.shift()
    if (uriPathSegments.length === 0) return currentResource

    let nextTokenizer = new UriTokenizer(uriPathSegments[0])

    const refResource = this._parseConstant(
      uriPathSegments,
      nextTokenizer,
      TokenKind.REF,
      currentResource.isCollection() ? UriResource.ResourceKind.REF_COLLECTION : UriResource.ResourceKind.REF
    )
    if (refResource) {
      refResource.setIsCollection(currentResource.isCollection())
      return [currentResource].concat(refResource)
    }

    let countResource = this._parseConstant(
      uriPathSegments,
      nextTokenizer,
      TokenKind.COUNT,
      UriResource.ResourceKind.COUNT
    )
    if (countResource) {
      countResource.setIsCollection(currentResource.isCollection())
      return [currentResource].concat(countResource)
    }

    // When Okra receives a request like `/Collection/a.b.c`, it is checked here if it is a bound action/function.
    // if it was not a bound action/function, we remember the error in order to throw it later, if `a.b.c` is also not a key predicate.
    // This might be the case for integer keys.
    let err
    if (nextTokenizer.next(TokenKind.QualifiedName)) {
      try {
        return [currentResource].concat(this._parseBoundOperation(uriPathSegments, currentResource, nextTokenizer))
      } catch (error) {
        err = error
      }
    }

    const keyPredicates = new KeyPredicateParser().parseKeyPathSegments(currentResource, uriPathSegments)
    if (keyPredicates) {
      currentResource.setKeyPredicates(keyPredicates).setIsCollection(false)
      if (currentResource.getKind() === UriResource.ResourceKind.ENTITY_COLLECTION) {
        currentResource.setKind(UriResource.ResourceKind.ENTITY)
      } else if (currentResource.getKind() === UriResource.ResourceKind.NAVIGATION_TO_MANY) {
        currentResource.setKind(UriResource.ResourceKind.NAVIGATION_TO_ONE)
      }
      for (let i = 0; i < keyPredicates.length; i++) uriPathSegments.shift()
      return this._parseSingleNavigation(uriPathSegments, currentResource)
    }

    if (err) throw err

    throw new UriSyntaxError(UriSyntaxError.Message.MUST_BE_COUNT_OR_REF_OR_BOUND_OPERATION, uriPathSegments[0])
  }

  /**
   * Parse OData ABNF single navigation.
   * @param {string[]} uriPathSegments The uri path segments
   * @param {UriResource} prevResource The previous resource
   * @returns {UriResource|UriResource[]|null} Returns UriResource, array of UriResource, or null
   * @private
   */
  _parseSingleNavigation (uriPathSegments, prevResource) {
    if (uriPathSegments.length === 0) return prevResource

    let result = [prevResource]
    let currentResource = prevResource
    let tokenizer = new UriTokenizer(uriPathSegments[0])

    // parse qualifiedEntityTypeName
    if (tokenizer.next(TokenKind.QualifiedName)) {
      const typeCastResource = this._parseTypeCast(currentResource, tokenizer.getText())
      if (typeCastResource) {
        tokenizer.requireNext(TokenKind.EOF)
        uriPathSegments.shift()

        tokenizer = new UriTokenizer(uriPathSegments[0])
        result.push(typeCastResource)
        currentResource = typeCastResource

        if (uriPathSegments.length === 0) return result
      } else {
        // parse boundOperation
        return result.concat(this._parseBoundOperation(uriPathSegments, currentResource, tokenizer))
      }
    }

    // parse bound operation
    if (tokenizer.next(TokenKind.QualifiedName)) {
      return result.concat(this._parseBoundOperation(uriPathSegments, currentResource, tokenizer))
    }

    // parse $ref
    const refResource = this._parseConstant(uriPathSegments, tokenizer, TokenKind.REF, UriResource.ResourceKind.REF)
    if (refResource) return result.concat(refResource)

    // parse $value
    const valueResource = this._parseConstant(
      uriPathSegments,
      tokenizer,
      TokenKind.VALUE,
      UriResource.ResourceKind.VALUE
    )

    if (valueResource) {
      const currentType = currentResource.getEdmType()

      if (currentType.hasStream()) {
        return result.concat(valueResource)
      }

      throw new UriSyntaxError(UriSyntaxError.Message.PREVIOUS_TYPE_HAS_NO_MEDIA, currentType.getName())
    }

    const uriResources = this._parsePropertyPath(uriPathSegments, currentResource, tokenizer)
    return result.concat(uriResources)
  }

  /**
   * Parse any of the OData bound operations.
   * @param {string[]} uriPathSegments The uri path segments
   * @param {UriResource} currentResource The current resource
   * @param {UriTokenizer} tokenizer The current tokenizer
   * @returns {UriResource|UriResource[]|null} Returns UriResource, array of UriResource, or null
   * @private
   */
  _parseBoundOperation (uriPathSegments, currentResource, tokenizer) {
    const fqn = FullQualifiedName.createFromNameSpaceAndName(tokenizer.getText())
    const bindingParamTypeFqn = currentResource.getEdmType().getFullQualifiedName()

    // parse bound action
    const isCollection = currentResource.isCollection()
    const boundAction = this._edm.getBoundAction(fqn, bindingParamTypeFqn, isCollection)

    if (boundAction) {
      tokenizer.requireNext(TokenKind.EOF)
      uriPathSegments.shift()

      this._target = boundAction.getReturnedEntitySet(this._target)

      return new UriResource()
        .setKind(UriResource.ResourceKind.BOUND_ACTION)
        .setAction(boundAction)
        .setIsCollection(boundAction.getReturnType() && boundAction.getReturnType().isCollection())
        .setTarget(this._target)
    }

    // parse bound function
    return this._parseBoundFunction(uriPathSegments, tokenizer, fqn, bindingParamTypeFqn, isCollection)
  }

  /**
   * Parse an OData bound function.
   * @param {string[]} uriPathSegments The uri path segments
   * @param {UriTokenizer} tokenizer The current tokenizer
   * @param {FullQualifiedName} fqn full qualified name of the function
   * @param {FullQualifiedName} bindingParamTypeFqn full qualified name of the type of the binding parameter
   * @param {boolean} previousIsCollection whether the previous resource is a collection
   * @returns {UriResource|UriResource[]|null} Returns UriResource, array of UriResource, or null
   * @private
   */
  _parseBoundFunction (uriPathSegments, tokenizer, fqn, bindingParamTypeFqn, previousIsCollection) {
    let result = []
    let currentResource = new UriResource().setKind(UriResource.ResourceKind.BOUND_FUNCTION)

    const availableBoundFunctions = this._edm.getBoundFunctions(fqn, bindingParamTypeFqn, previousIsCollection)

    const getOverloadingFunctionFn = visitedParameters =>
      this._edm.getBoundFunction(fqn, bindingParamTypeFqn, previousIsCollection, Array.from(visitedParameters.keys()))

    const parser = new FunctionParameterParser(this._edm, this._aliases)
    parser.parse(fqn.toString(), availableBoundFunctions, tokenizer, getOverloadingFunctionFn)

    currentResource.setFunctionParameters(parser.getParameters())
    let currentBoundFunction = parser.getFunction()
    if (!currentBoundFunction) {
      throw new UriSemanticError(UriSemanticError.Message.NEITHER_STRUCTURED_TYPE_NOR_BOUND_OPERATION, fqn.toString())
    }
    if (!currentBoundFunction.isComposable() && uriPathSegments.length > 1) {
      throw new UriSyntaxError(
        UriSyntaxError.Message.FUNCTION_NOT_COMPOSABLE,
        currentBoundFunction.getName(),
        uriPathSegments[uriPathSegments.length - 1]
      )
    }

    const returnTypeEdmTypeKind = currentBoundFunction
      .getReturnType()
      .getType()
      .getKind()
    const returnTypeIsCollection = currentBoundFunction.getReturnType().isCollection()

    currentResource.setFunction(currentBoundFunction).setIsCollection(returnTypeIsCollection)

    this._target = currentBoundFunction.getReturnedEntitySet(this._target)

    if (returnTypeEdmTypeKind === EdmTypeKind.ENTITY) {
      currentResource.setTarget(this._target)

      if (returnTypeIsCollection) {
        result = result.concat(this._parseCollectionNavigation(uriPathSegments, currentResource, tokenizer))
      } else {
        tokenizer.requireNext(TokenKind.EOF)
        uriPathSegments.shift()
        result = result.concat(this._parseSingleNavigation(uriPathSegments, currentResource))
      }
    } else if (returnTypeEdmTypeKind === EdmTypeKind.COMPLEX) {
      tokenizer.requireNext(TokenKind.EOF)
      uriPathSegments.shift()

      result.push(currentResource)
      const resultTemp = returnTypeIsCollection
        ? this._parseComplexCollectionPath(uriPathSegments, currentResource)
        : this._parseComplexPath(uriPathSegments, currentResource)
      if (resultTemp) result = result.concat(resultTemp)
    } else {
      tokenizer.requireNext(TokenKind.EOF)
      uriPathSegments.shift()

      result.push(currentResource)
      const resultTemp = returnTypeIsCollection
        ? this._parsePrimitiveCollectionPath(uriPathSegments, currentResource)
        : this._parsePrimitivePath(uriPathSegments, currentResource)
      if (resultTemp) result = result.concat(resultTemp)
    }

    return result
  }

  /**
   * Parse OData property path.
   * @param {string[]} uriPathSegments The uri path segments
   * @param {UriResource} prevResource The previous resource
   * @param {UriTokenizer} tokenizer The current tokenizer
   * @throws UriSemanticError If no property path was found
   * @returns {UriResource|UriResource[]|null} Returns UriResource, array of UriResource, or null
   * @private
   */
  _parsePropertyPath (uriPathSegments, prevResource, tokenizer) {
    tokenizer.requireNext(TokenKind.ODataIdentifier)

    // Try to find navigation property.
    let navProp = this._parseNavigationProperty(uriPathSegments, prevResource, tokenizer)
    if (navProp) return navProp

    // Try to find structural property.
    let structuralProperty = this._parseProperty(uriPathSegments, prevResource, tokenizer)
    if (structuralProperty) return structuralProperty

    // If we can not find any other artifact an error should be thrown.
    throw new UriSemanticError(
      UriSemanticError.Message.PROPERTY_NOT_FOUND,
      tokenizer.getText(),
      prevResource.getEdmType().getName()
    )
  }

  /**
   * Parse OData navigation property.
   * @param {string[]} uriPathSegments The uri path segments
   * @param {UriResource} prevResource The previous resource
   * @param {UriTokenizer} tokenizer The current tokenizer
   * @returns {UriResource|UriResource[]|null} Returns UriResource, array of UriResource, or null
   * @private
   */
  _parseNavigationProperty (uriPathSegments, prevResource, tokenizer) {
    let propertyName = tokenizer.getText()

    let navProp = prevResource.getEdmType().getNavigationProperty(propertyName)
    if (!navProp) return null

    const isCollection = navProp.isCollection()
    this._target = this._target === null ? null : this._target.getRelatedBindingTarget(propertyName)
    let newResource = new UriResource()
      .setNavigationProperty(navProp)
      .setIsCollection(isCollection)
      .setTarget(this._target)

    if (isCollection) {
      newResource.setKind(UriResource.ResourceKind.NAVIGATION_TO_MANY)
      return this._parseCollectionNavigation(uriPathSegments, newResource, tokenizer)
    }

    newResource.setKind(UriResource.ResourceKind.NAVIGATION_TO_ONE)

    if (!tokenizer.next(TokenKind.EOF)) {
      throw new UriSyntaxError(
        UriSyntaxError.Message.NAVIGATION_PROPERTY_EOF,
        propertyName,
        tokenizer.getParseString(),
        tokenizer.getPosition()
      )
    }

    uriPathSegments.shift()
    return this._parseSingleNavigation(uriPathSegments, newResource)
  }

  /**
   * Parse OData property.
   * @param {string[]} uriPathSegments The uri path segments
   * @param {UriResource} prevResource The previous resource
   * @param {UriTokenizer} tokenizer The current tokenizer
   * @returns {UriResource|UriResource[]|null} Returns UriResource, array of UriResource, or null
   * @private
   */
  _parseProperty (uriPathSegments, prevResource, tokenizer) {
    let propertyName = tokenizer.getText()
    let property = prevResource.getEdmType().getStructuralProperty(propertyName)

    if (property) {
      const isCollection = property.isCollection()
      let newResource = new UriResource().setProperty(property).setIsCollection(isCollection)

      let isComplex = false
      switch (property.getType().getKind()) {
        case EdmTypeKind.PRIMITIVE:
        case EdmTypeKind.ENUM:
        case EdmTypeKind.DEFINITION:
          newResource.setKind(
            isCollection
              ? UriResource.ResourceKind.PRIMITIVE_COLLECTION_PROPERTY
              : UriResource.ResourceKind.PRIMITIVE_PROPERTY
          )
          break
        case EdmTypeKind.COMPLEX:
          isComplex = true
          newResource.setKind(
            isCollection
              ? UriResource.ResourceKind.COMPLEX_COLLECTION_PROPERTY
              : UriResource.ResourceKind.COMPLEX_PROPERTY
          )
          break
        default:
          throw new NotImplementedError()
      }

      if (!tokenizer.next(TokenKind.EOF)) {
        throw new UriSyntaxError(
          UriSyntaxError.Message.PROPERTY_EOF,
          propertyName,
          tokenizer.getParseString(),
          tokenizer.getPosition()
        )
      }

      uriPathSegments.shift()

      let trailingPath
      if (isCollection) {
        trailingPath = isComplex
          ? this._parseComplexCollectionPath(uriPathSegments, newResource)
          : this._parsePrimitiveCollectionPath(uriPathSegments, newResource)
      } else {
        trailingPath = isComplex
          ? this._parseComplexPath(uriPathSegments, newResource)
          : this._parsePrimitivePath(uriPathSegments, newResource)
      }
      return trailingPath ? [newResource].concat(trailingPath) : newResource
    }

    return null
  }

  /**
   * Parse OData complex path.
   * @param {string[]} uriPathSegments The uri path segments
   * @param {UriResource} prevResource The previous resource
   * @returns {UriResource|UriResource[]} Returns an UriResource or array of UriResource
   * @private
   */
  _parseComplexPath (uriPathSegments, prevResource) {
    if (uriPathSegments.length === 0) return null

    let result = []
    let currentResource = prevResource
    let tokenizer = new UriTokenizer(uriPathSegments[0])

    let qualifiedName = null

    if (tokenizer.next(TokenKind.QualifiedName)) {
      qualifiedName = tokenizer.getText()

      const typeCastResource = this._parseTypeCast(currentResource, qualifiedName)
      if (typeCastResource) {
        tokenizer.requireNext(TokenKind.EOF)
        uriPathSegments.shift()
        qualifiedName = null
        if (uriPathSegments.length === 0) return typeCastResource
        tokenizer = new UriTokenizer(uriPathSegments[0])
        result.push(currentResource)
        currentResource = typeCastResource
      }
    }

    if (!qualifiedName && tokenizer.next(TokenKind.QualifiedName)) {
      qualifiedName = tokenizer.getText()
    }

    if (qualifiedName) {
      return result.concat(this._parseBoundOperation(uriPathSegments, currentResource, tokenizer))
    }

    return result.concat(this._parsePropertyPath(uriPathSegments, currentResource, tokenizer))
  }

  /**
   * Parse OData primitive path.
   * @param {string[]} uriPathSegments The uri path segments
   * @param {UriResource} prevResource The previous resource
   * @returns {UriResource|UriResource[]|null} UriResource, array of UriResource or null
   * @private
   */
  _parsePrimitivePath (uriPathSegments, prevResource) {
    if (uriPathSegments.length === 0) return null

    const tokenizer = new UriTokenizer(uriPathSegments[0])

    if (prevResource.getEdmType() !== EdmPrimitiveTypeKind.Stream) {
      const valueResource = this._parseConstant(
        uriPathSegments,
        tokenizer,
        TokenKind.VALUE,
        UriResource.ResourceKind.VALUE
      )
      if (valueResource) {
        valueResource.setIsCollection(false)
        return valueResource
      }
    }

    tokenizer.requireNext(TokenKind.QualifiedName)
    return this._parseBoundOperation(uriPathSegments, prevResource, tokenizer)
  }

  /**
   * Parse OData primitive collection path.
   * @param {string[]} uriPathSegments The uri path segments
   * @param {UriResource} prevResource The previous resource
   * @returns {UriResource|UriResource[]|null} UriResource, array of UriResource or null
   * @private
   */
  _parsePrimitiveCollectionPath (uriPathSegments, prevResource) {
    if (uriPathSegments.length === 0) return null

    // parse $count
    const tokenizer = new UriTokenizer(uriPathSegments[0])
    const countResource = this._parseConstant(
      uriPathSegments,
      tokenizer,
      TokenKind.COUNT,
      UriResource.ResourceKind.COUNT
    )
    if (countResource) {
      countResource.setIsCollection(true)
      return countResource
    }

    if (tokenizer.next(TokenKind.QualifiedName)) {
      return this._parseBoundOperation(uriPathSegments, prevResource, tokenizer)
    }

    throw new UriSyntaxError(UriSyntaxError.Message.MUST_BE_COUNT_OR_BOUND_OPERATION, uriPathSegments[0])
  }

  /**
   * Parse OData complex collection path.
   * @param {string[]} uriPathSegments The uri path segments
   * @param {UriResource} prevResource The previous resource
   * @returns {UriResource[]} array of UriResource
   * @private
   */
  _parseComplexCollectionPath (uriPathSegments, prevResource) {
    if (uriPathSegments.length === 0) return null

    let tokenizer = new UriTokenizer(uriPathSegments[0])
    let result = []
    let currentResource = prevResource

    if (tokenizer.next(TokenKind.QualifiedName)) {
      const typeCastResource = this._parseTypeCast(prevResource, tokenizer.getText())
      if (typeCastResource) {
        tokenizer.requireNext(TokenKind.EOF)
        uriPathSegments.shift()

        result.push(typeCastResource)
        if (uriPathSegments.length === 0) return result
        tokenizer = new UriTokenizer(uriPathSegments[0])
        currentResource = typeCastResource
      } else {
        return result.concat(this._parseBoundOperation(uriPathSegments, currentResource, tokenizer))
      }
    }

    // parse $count
    const countResource = this._parseConstant(
      uriPathSegments,
      tokenizer,
      TokenKind.COUNT,
      UriResource.ResourceKind.COUNT
    )
    if (countResource) {
      countResource.setIsCollection(true)
      result.push(countResource)
      return result
    }

    if (tokenizer.next(TokenKind.QualifiedName)) {
      return result.concat(this._parseBoundOperation(uriPathSegments, currentResource, tokenizer))
    }

    throw new UriSyntaxError(UriSyntaxError.Message.MUST_BE_COUNT_OR_BOUND_OPERATION, uriPathSegments[0])
  }

  /**
   * Parse OData ABNF constant like $ref or $value.
   * @param {string[]} uriPathSegments THe current uri path segments
   * @param {UriTokenizer} tokenizer The current tokenizer
   * @param {UriTokenizer.TokenKind} tokenKind The token kind to read next
   * @param {UriResource.ResourceKind} resourceKind The resource kind to set if token read was successful
   * @returns {?UriResource} UriResource or null
   * @private
   */
  _parseConstant (uriPathSegments, tokenizer, tokenKind, resourceKind) {
    if (tokenizer.next(tokenKind)) {
      tokenizer.requireNext(TokenKind.EOF)
      uriPathSegments.shift()
      return new UriResource().setKind(resourceKind)
    }
    return null
  }
}

module.exports = ResourcePathParser
