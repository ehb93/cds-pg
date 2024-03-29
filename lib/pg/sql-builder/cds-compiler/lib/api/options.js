'use strict';

const { validate, generateStringValidator } = require('./validate');

// TODO: there should be just one place where the options are defined with
// their types (not also in validate.js or whatever).

// Options that are advertised and documented to users
const publicOptionsNewAPI = [
  // GENERAL
  'beta',
  'deprecated',
  'addTextsLanguageAssoc',
  'localizedLanguageFallback',  // why can't I define the option type here?
  'severities',
  'messages',
  'withLocations',
  'defaultStringLength',
  'csnFlavor',
  // DB
  'sqlDialect',
  'sqlMapping',
  'sqlChangeMode',
  'allowCsnDowngrade',
  'joinfk',
  'magicVars',
  // ODATA
  'odataVersion',
  'odataFormat',
  'odataContainment',
  'odataForeignKeys',
  'odataProxies',
  'odataXServiceRefs',
  'odataV2PartialConstr',
  'service',
  'serviceNames',
  //
  'dictionaryPrototype',
];

// Internal options used for testing/debugging etc.
const privateOptions = [
  'lintMode',
  'fuzzyCsnError',
  'traceFs',
  'traceParser',
  'traceParserAmb',
  'testMode',
  'testSortCsn',
  'constraintsNotEnforced',
  'constraintsNotValidated',
  'skipDbConstraints',
  'noRecompile',
  'internalMsg',
  'disableHanaComments',      // in case of issues with hana comment rendering
  'dependentAutoexposed',     // deprecated, no effect - TODO: safe to remove?
  'longAutoexposed',          // deprecated, no effect - TODO: safe to remove?
  'localizedWithoutCoalesce', // deprecated version of 'localizedLanguageFallback',
];

const overallOptions = publicOptionsNewAPI.concat(privateOptions);

/**
 * Extract the cds relevant options from the provided options
 * Apply defaults and make sure that the "hard requirements" are met,
 * i.e. src: sql if to.sql() was called.
 *
 * @param {FlatOptions} [input={}] Input options
 * @param {FlatOptions} [defaults={}] Default options to apply
 * @param {FlatOptions} [hardRequire={}] Hard requirements to enforce
 * @param {object} [customValidators] Custom validations to run instead of defaults
 * @param {string[]} [combinationValidators] Option combinations to validate
 * @param {string} moduleName The called module, e.g. 'for.odata', 'to.hdi'. Needed to initialize the message functions
 * @returns {TranslatedOptions} General cds options
 */
function translateOptions(input = {}, defaults = {}, hardRequire = {},
                          customValidators = {}, combinationValidators = [], moduleName = '') {
  const options = Object.assign({}, defaults);
  const inputOptionNames = Object.keys(input);
  for (const name of overallOptions) {
    // Ensure that arrays are not passed as a reference!
    // This caused issues with the way messages are handled in processMessages
    if (Array.isArray(input[name]) && inputOptionNames.indexOf(name) !== -1)
      options[name] = [ ...input[name] ];
    else if (inputOptionNames.indexOf(name) !== -1)
      options[name] = input[name];
  }

  // use original messages object, i.e. keep the reference!
  if (input.messages)
    options.messages = input.messages;

  // Validate the filtered input options
  // only "new-style" options are here
  validate(options,
           moduleName,
           // TODO: is there a better place to specify the type of option values?
           Object.assign( {
             localizedLanguageFallback: generateStringValidator([ 'none', 'coalesce' ]),
             sqlChangeMode: generateStringValidator([ 'alter', 'drop' ]),
           }, customValidators ),
           combinationValidators);

  // Overwrite with the hardRequire options - like src: sql in to.sql()
  Object.assign(options, hardRequire);

  for (const optionName in options) {
    const optionValue = options[optionName];
    mapToOldNames(optionName, optionValue);
  }

  /**
   * Map a new-style option to it's old format
   *
   * @param {string} optionName Name of the option to map
   * @param {any} optionValue Value of the option to map
   */
  function mapToOldNames(optionName, optionValue) {
    // Keep all input options and add the "compatibility" options
    switch (optionName) {
      case 'beta':
        options.betaMode = optionValue;
        break;
      case 'odataVersion':
        options.version = optionValue;
        break;
      case 'sqlDialect':
        options.dialect = optionValue;
        break;
      case 'sqlMapping':
        options.names = optionValue;
        break;
      case 'magicVars':
        if (optionValue.user)
          options.user = optionValue.user;
        if (optionValue.locale)
          options.locale = optionValue.locale;
        break;
      default: break;
    }
  }

  return options;
}

module.exports = {
  to: {
    cdl: options => translateOptions(options, undefined, undefined, undefined, undefined, 'to.cdl'),
    sql: (options) => {
      const hardOptions = { src: 'sql' };
      const defaultOptions = { sqlMapping: 'plain', sqlDialect: 'plain' };
      const processed = translateOptions(options, defaultOptions, hardOptions, undefined, [ 'sql-dialect-and-naming' ], 'to.sql');

      const result = Object.assign({}, processed);
      result.toSql = Object.assign({}, processed);

      return result;
    },
    hdi: (options) => {
      const hardOptions = { src: 'hdi' };
      const defaultOptions = { sqlMapping: 'plain', sqlDialect: 'hana' };
      const processed = translateOptions(options, defaultOptions, hardOptions, { sqlDialect: generateStringValidator([ 'hana' ]) }, undefined, 'to.hdi');

      const result = Object.assign({}, processed);
      result.toSql = Object.assign({}, processed);

      return result;
    },
    hdbcds: (options) => {
      const defaultOptions = { sqlMapping: 'plain', sqlDialect: 'hana' };
      const processed = translateOptions(options, defaultOptions, {}, { sqlDialect: generateStringValidator([ 'hana' ]) }, undefined, 'to.hdbcds');

      const result = Object.assign({}, processed);
      result.forHana = Object.assign({}, processed);

      return result;
    },
    edm: (options) => {
      const hardOptions = { json: true, combined: true };
      const defaultOptions = { odataVersion: 'v4', odataFormat: 'flat' };
      const processed = translateOptions(options, defaultOptions, hardOptions, { odataVersion: generateStringValidator([ 'v4' ]) }, [ 'valid-structured' ], 'to.edm');

      const result = Object.assign({}, processed);
      result.toOdata = Object.assign({}, processed);

      return result;
    },
    edmx: (options) => {
      const hardOptions = { xml: true, combined: true };
      const defaultOptions = {
        odataVersion: 'v4', odataFormat: 'flat',
      };
      const processed = translateOptions(options, defaultOptions, hardOptions, undefined, [ 'valid-structured' ], 'to.edmx');

      const result = Object.assign({}, processed);
      result.toOdata = Object.assign({}, processed);

      return result;
    },
  },
  for: {   // TODO: Rename version to oDataVersion

    odata: (options) => {
      const defaultOptions = { odataVersion: 'v4', odataFormat: 'flat' };
      const processed = translateOptions(options, defaultOptions, undefined, undefined, [ 'valid-structured' ], 'for.odata');

      const result = Object.assign({}, processed);
      result.toOdata = Object.assign({}, processed);


      return result;
    },
    hana: (options) => {
      const defaultOptions = { sqlMapping: 'plain', sqlDialect: 'hana' };
      const processed = translateOptions(options, defaultOptions, undefined, undefined, undefined, 'for.hana');

      const result = Object.assign({}, processed);
      result.forHana = Object.assign({}, processed);


      return result;
    },
  },
};


/**
 * Flat input object using the new-style options.
 *
 * @typedef {object} FlatOptions
 */

/**
 * Flat options object, with defaults, validation and compatibility applied.
 *
 * @typedef {object} TranslatedOptions
 */
