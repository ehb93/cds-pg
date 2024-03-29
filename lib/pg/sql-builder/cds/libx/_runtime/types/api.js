// Columns

/**
 * @typedef {object} ColumnRef
 * @property {Array<string>} ref
 */

/**
 * @typedef {Array<ColumnRef>} ColumnRefs
 */

// Input constraints

/**
 * @typedef {object} InputConstraints
 * @property {object} element
 * @property {*} value
 * @property {Array} errors
 * @property {string} [key]
 * @property {string[]} [pathSegments]
 * @property {string} event
 */

// ON condition

/**
 * @typedef {object} ONConditionAliases
 * @property {string} select
 * @property {string} join
 */

/**
 * @typedef {object} ONConditionOptions
 * @property {string | Array} [associationNames]
 * @property {object} [csn]
 * @property {ONConditionAliases} [aliases]
 * @property {boolean} [resolveView=true]
 */

// Template processor

/**
 * @typedef {object} TemplateProcessorInfo
 * @property {entity} target
 * @property {Map} elements
 */

/**
 * @typedef {object} TemplateProcessorPathOptions
 * @property {object} [extraKeys]
 * @property {function} [rowKeysGenerator]
 * @property {string[]} [segments=[]] - Path segments to relate the error message.
 * @property {boolean} [includeKeyValues=false] Indicates whether the key values are included in the path segments
 * The path segments are used to build the error target (a relative resource path)
 */

/**
 * @typedef {object} TemplateProcessor
 * @property {Function} processFn
 * @property {object} row
 * @property {TemplateProcessorInfo} template
 * @property {boolean} [isRoot=true]
 * @property {TemplateProcessorPathOptions} [pathOptions=null]
 */

/**
 * @typedef {object} templateProcessorProcessFnArgs
 * @property {object} row
 * @property {string} key
 * @property {object} element
 * @property {boolean} plain
 * @property {boolean} isRoot
 * @property {Array<String>} [pathSegments]
 */

// Search

/**
 * @typedef {object} searchContainsArg
 * @property {ColumnRefs} [list] The columns to
 * be searched
 * @property {string} [val] The search string
 */

/**
 * @typedef {Array<searchContainsArg>} searchContainsArgs
 */

/**
 * @typedef {object} searchContainsExp
 * @property {string} func='contains' The function name
 * @property {searchContainsArgs} args
 */

/**
 * @typedef {object} search2cqnOptions
 * @property {ColumnRefs} [columns] The columns to
 * be searched
 * @property {string} locale The user locale
 */

/**
 * @typedef {object} cqn2cqn4sqlOptions
 * @property {boolean} suppressSearch=false Indicates whether the search handler is called.
 */

module.exports = {}
