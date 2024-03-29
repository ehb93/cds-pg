'use strict';

const { makeMessageFunction } = require('../base/messages');

/* eslint-disable arrow-body-style */
const booleanValidator = {
  validate: val => val === true || val === false,
  expected: () => 'type boolean',
  found: val => `type ${ typeof val }`,
};

/**
 * Validation function. Returns false if invalid.
 *
 * @typedef {(input: any) => boolean} ValidateFunction
 */

/**
 * @typedef {object} Validator
 * @property {ValidateFunction} validate Run the validation check
 * @property {Function} expected Returns the expected type/value as a string.
 * @property {Function} found Returns the actually found type/value as a string.
 */

/**
 * Generate a Validator that validates that the
 * input is a string and one of the available options.
 *
 * @param {any} availableValues Available values
 * @returns {Validator} Return a validator for a string in an expected range
 */
function generateStringValidator(availableValues) {
  return {
    validate: val => typeof val === 'string' && availableValues.indexOf(val) !== -1,
    expected: (val) => {
      return typeof val !== 'string' ? 'type string' : availableValues.join(', ');
    },
    found: (val) => {
      return typeof val !== 'string' ? `type ${ typeof val }` : `value ${ val }`;
    },
  };
}

const validators = {
  beta: {
    validate: val => val !== null && typeof val === 'object' && !Array.isArray(val),
    expected: () => 'type object',
    found: (val) => {
      return val === null ? val : `type ${ typeof val }`;
    },
  },
  deprecated: {
    validate: val => val !== null && typeof val === 'object' && !Array.isArray(val),
    expected: () => 'type object',
    found: (val) => {
      return val === null ? val : `type ${ typeof val }`;
    },
  },
  severities: {
    validate: val => val !== null && typeof val === 'object' && !Array.isArray(val),
    expected: () => 'type object',
    found: (val) => {
      return val === null ? val : `type ${ typeof val }`;
    },
  },
  magicVars: {
    validate: val => val !== null && typeof val === 'object' && !Array.isArray(val),
    expected: () => 'type object',
    found: (val) => {
      return val === null ? val : `type ${ typeof val }`;
    },
  },
  messages: {
    validate: val => Array.isArray(val),
    expected: () => 'type array',
    found: val => `type ${ typeof val }`,
  },
  sqlDialect: generateStringValidator([ 'sqlite', 'hana', 'plain' ]),
  sqlMapping: generateStringValidator([ 'plain', 'quoted', 'hdbcds' ]),
  odataVersion: generateStringValidator([ 'v2', 'v4' ]),
  odataFormat: generateStringValidator([ 'flat', 'structured' ]),
  service: {
    validate: val => typeof val === 'string',
    expected: () => 'type string',
    found: val => `type ${ typeof val }`,
  },
  serviceNames: {
    validate: val => Array.isArray(val) && !val.some(y => (typeof y !== 'string')),
    expected: () => 'type array of string',
    found: val => `type ${ typeof val }`,
  },
  defaultStringLength: {
    validate: val => Number.isInteger(val),
    expected: () => 'Integer literal',
    found: val => `type ${ typeof val }`,
  },
  csnFlavor: {
    validate: val => typeof val === 'string',
    expected: () => 'type string',
    found: val => `type ${ typeof val }`,
  },
  dictionaryPrototype: {
    validate: () => true,
  },
};

const allCombinationValidators = {
  'valid-structured': {
    validate: options => options.odataVersion === 'v2' && options.odataFormat === 'structured',
    severity: 'error',
    getMessage: () => 'Structured OData is only supported with OData version v4',
  },
  'sql-dialect-and-naming': {
    validate: options => options.sqlDialect && options.sqlMapping && ![ 'hana' ].includes(options.sqlDialect) && [ 'quoted', 'hdbcds' ].includes(options.sqlMapping),
    severity: 'error',
    getMessage: options => `sqlDialect '${ options.sqlDialect }' can't be combined with sqlMapping '${ options.sqlMapping }'`,
  },
  'beta-no-test': {
    validate: options => options.beta && !options.testMode,
    severity: 'warning',
    getMessage: () => 'Option "beta" was used. This option should not be used in productive scenarios!',
  },
};
/* eslint-disable jsdoc/no-undefined-types */
/**
 * Run the validations for each option.
 * Use a custom validator or "default" custom validator, fallback to Boolean validator.
 *
 * @param {object} options Flat options object to validate
 * @param {string} moduleName The called module, e.g. 'for.odata', 'to.hdi'. Needed to initialize the message functions
 * @param {object} [customValidators] Map of custom validators to use
 * @param {string[]} [combinationValidators] Validate option combinations
 * @returns {void}
 * @throws {CompilationError} Throws in case of invalid option usage
 */
function validate(options, moduleName, customValidators = {}, combinationValidators = []) {
  // TODO: issuing messages in this function looks very strange...
  {
    const messageCollector = { messages: [] };
    const { error, throwWithError } = makeMessageFunction(null, messageCollector, moduleName);

    for (const optionName of Object.keys(options)) {
      const optionValue = options[optionName];
      const validator = customValidators[optionName] || validators[optionName] || booleanValidator;

      if (!validator.validate(optionValue))
        error('invalid-option', null, {}, `Expected option "${ optionName }" to have "${ validator.expected(optionValue) }". Found: "${ validator.found(optionValue) }"`);
    }
    throwWithError();
  }

  const message = makeMessageFunction(null, options, moduleName);

  for (const combinationValidatorName of combinationValidators.concat([ 'beta-no-test' ])) {
    const combinationValidator = allCombinationValidators[combinationValidatorName];
    if (combinationValidator.validate(options))
      message[combinationValidator.severity]('invalid-option-combination', null, {}, combinationValidator.getMessage(options));
  }

  message.throwWithError();
}
/* eslint-enable jsdoc/no-undefined-types */


module.exports = { validate, generateStringValidator };
/* eslint-enable arrow-body-style */
