'use strict'

const util = require('util')
const AbstractError = require('./AbstractError')

/**
 * UriSyntaxError which is mainly thrown by the UriParser when there is a problem with
 * interpreting the url syntactically.
 *
 * @extends AbstractError
 */
class UriSyntaxError extends AbstractError {
  /**
   * Creating an instance of UriSyntaxError.
   * @param {string} message The message of the error
   * @param {...string} parameters parameters for the message
   */
  constructor (message, ...parameters) {
    super(AbstractError.ErrorNames.URI_SYNTAX, util.format(message, ...parameters))
  }
}

UriSyntaxError.Message = {
  TRAILING_SEGMENT: "Trailing segment '%s' is not allowed in '%s'",

  TOKEN_REQUIRED: "Expected uri token '%s' could not be found in '%s' at position %d",
  TOKEN_KINDS_EXPECTED: "Expected a uri token of kinds '%s' in '%s' at position %d",
  PROPERTY_EOF: "Property '%s' must not be followed by any other character in path segment '%s' at position %d",
  NAVIGATION_PROPERTY_EOF:
    "Navigation property '%s' has a 'to one' relation and must " +
    "not be followed by a key or any other character in path segment '%s' at position %d",
  FUNCTION_IMPORT_EOF: "Expected end of segment; return type of function import '%s' does not allow keys",
  FUNCTION_IMPORT_FUNCTION_NOT_FOUND: "Could not find function for function import '%s'",
  FUNCTION_NOT_COMPOSABLE: "Current function '%s' is not composable; trailing segment '%s' ist not allowed",

  KEY_EXPECTED: 'Expected at least one key predicate but found none',
  KEY_VALUE_NOT_FOUND: "No '%s' value found for key '%s'",
  PREVIOUS_TYPE_HAS_NO_MEDIA: "Previous segment type '%s' does not have a media resource",
  MUST_BE_COUNT_OR_BOUND_OPERATION: "Expected current segment '%s' to be '$count' or a bound operation",
  MUST_BE_COUNT_OR_REF_OR_BOUND_OPERATION: "Expected current segment '%s' to be '$count', '$ref', or a bound operation",

  ALIAS_NOT_FOUND: "Parameter alias '%s' not found",
  WRONG_ALIAS_VALUE: "Wrong value for parameter alias '%s'",

  OPTION_UNKNOWN: "Unknown system query option '%s'",
  OPTION_NOT_ALLOWED: "Query option '%s' is not supported for this request; only '%s' are allowed",
  OPTION_NON_NEGATIVE_INTEGER: "The value of the option '%s' must be a non-negative integer",
  WRONG_OPTION_NAME: 'Allowed query option expected',
  DUPLICATED_OPTION: "Duplicated option '%s'",
  WRONG_COUNT_VALUE: "Only the following values are allowed for the system query option '$count': true, false",
  WRONG_OPTION_VALUE: "Wrong value for the system query option '%s'",
  OPTION_EXPECTED: "Expected query option '%s'",

  EXPAND_NO_VALID_PATH: "No valid expand path found in '%s' at position %d",
  EXPAND_DUPLICATED_NAVIGATION_PROPERTY: "Duplicated navigation property '%s'",

  PHRASE_OR_WORD_EXPECTED: "Expected PHRASE or WORD in '%s' at position %d",
  SEARCH_NOT_MUST_BE_FOLLOWED_BY_A_TERM: "NOT must be followed by a term in '%s' at position %d",

  ALIAS_EXPECTED: 'An alias must be specified at position %d',
  WRONG_AGGREGATE_EXPRESSION_SYNTAX: 'Wrong syntax for aggregate expression at position %d',
  WRONG_WITH_SYNTAX: "Wrong syntax for 'with' at position %d"
}

module.exports = UriSyntaxError
