'use strict';

// API functions for backends (i.e. functions that take a compiled
// augmented CSN and generate something from it)

const { transformForHanaWithCsn } = require('./transform/forHanaNew');
const { compactModel, sortCsn } = require('./json/to-csn')
const { toCdsSourceCsn } = require('./render/toCdl');
const { toSqlDdl } = require('./render/toSql');
const { toRenameDdl } = require('./render/toRename');
const { manageConstraints, listReferentialIntegrityViolations } = require('./render/manageConstraints');
const { transform4odataWithCsn } = require('./transform/forOdataNew');
const { csn2edm, csn2edmAll } = require('./edm/csn2edm');
const { mergeOptions }  = require('./model/csnUtils');
const { isBetaEnabled } = require('./base/model');
const { optionProcessor } = require('./optionProcessor')
const timetrace = require('./utils/timetrace');
const { makeMessageFunction } = require('./base/messages');
const { forEachDefinition } = require('./model/csnUtils');

/**
 * Generate ODATA for `csn` using `options`.
 * The twin of the toOdata function but using CSN
 *
 * @param {CSN.Model}   csn
 * @param {CSN.Options} [options]
 */
function toOdataWithCsn(csn, options) {
  // In case of API usage the options are in the 'options' argument
  // put the OData specific options under the 'options.toOdata' wrapper
  // and leave the rest under 'options'
  if (options && !options.toOdata) {
    _wrapRelevantOptionsForCmd(options, 'toOdata');
  }
  // Provide defaults and merge options with those from csn
  options = mergeOptions({ toOdata : getDefaultBackendOptions().toOdata }, options);

  // Provide something to generate if nothing else was given (conditional default)
  if (!options.toOdata.xml && !options.toOdata.json && !options.toOdata.csn) {
    options.toOdata.xml = true;
  }
  if (!options.toOdata.separate && !options.toOdata.combined) {
    options.toOdata.combined = true;
  }

  const { error, warning } = makeMessageFunction(csn, options, 'for.odata');

  // Verify options
  optionProcessor.verifyOptions(options, 'toOdata', true).forEach(complaint => warning(null, null, `${complaint}`));

  // Prepare model for ODATA processing
  let forOdataCSN = transform4odataWithCsn(csn, options);
  // Assemble result object
  let result = {
    services: Object.create(null),
  }
  if (options.toOdata.csn) {
    result.csn = forOdataCSN;
  }

  // Create annotations and metadata once per service
  if (options.toOdata.xml || options.toOdata.json) {
    let allServices = csn2edmAll(forOdataCSN, options);
    for(let serviceName in allServices) {
      let l_edm = allServices[serviceName];


      result.services[serviceName] = {};
      if (options.toOdata.xml) {
        if (options.toOdata.separate) {
          result.services[serviceName].annotations = l_edm.toXML('annotations');
          result.services[serviceName].metadata = l_edm.toXML('metadata');
        }
        if (options.toOdata.combined) {
          result.services[serviceName].combined = l_edm.toXML('all');
        }
      }
      if (options.toOdata.json) {
        // JSON output is not available for ODATA V2
        if (options.toOdata.version === 'v2') {
          error(null, null, `OData JSON output is not available for OData V2`);
        }
        // FIXME: Why only metadata_json - isn't this rather a 'combined_json' ? If so, rename it!
        result.services[serviceName].metadata_json = l_edm.toJSON();
      }
    }
  }

  return result;
}

// Generate edmx for given 'service' based on 'csn' (new-style compact, already prepared for OData)
// using 'options'
function preparedCsnToEdmx(csn, service, options) {
  let edmx = csn2edm(csn, service, options).toXML('all');
  return {
    edmx,
  };
}

// Generate edmx for given 'service' based on 'csn' (new-style compact, already prepared for OData)
// using 'options'
function preparedCsnToEdmxAll(csn, options) {
  let edmx = csn2edmAll(csn, options);
  for(const service in edmx){
    edmx[service] = edmx[service].toXML('all');
  }
  return {
    edmx,
  };
}

// Generate edm-json for given 'service' based on 'csn' (new-style compact, already prepared for OData)
// using 'options'
function preparedCsnToEdm(csn, service, options) {
  // Merge options; override OData version as edm json is always v4
  options = mergeOptions(options, { toOdata : { version : 'v4' }});
  const edmj = csn2edm(csn, service, options).toJSON();
  return {
    edmj,
  };
}

// Generate edm-json for given 'service' based on 'csn' (new-style compact, already prepared for OData)
// using 'options'
function preparedCsnToEdmAll(csn, options) {
  // Merge options; override OData version as edm json is always v4
  options = mergeOptions(options, { toOdata : { version : 'v4' }});
  let edmj = csn2edmAll(csn, options);
  for(const service in edmj){
    edmj[service] = edmj[service].toJSON();
  }
  return {
    edmj,
  };
}

// ----------- toCdl -----------

/**
 * @param {XSN.Model | CSN.Model} model
 * @param {CSN.Options} options
 * @param {boolean} [silent]
 */
function handleToCdlOptions(model, options, silent=false){
  // In case of API usage the options are in the 'options' argument
  // put the OData specific options under the 'options.toCdl' wrapper
  // and leave the rest under 'options'
  if (options && !options.toCdl) {
    _wrapRelevantOptionsForCmd(options, 'toCdl');
  }

  // Merge options with those from XSN model
  options = mergeOptions({ toCdl : true }, model.options, options);

  const { warning } = makeMessageFunction(model, options, 'to.cdl');

  // Verify options
  optionProcessor.verifyOptions(options, 'toCdl', silent).forEach(complaint => warning(null, null, `${complaint}`));

  return options;
}

/**
 * Generate CDS source text for CSN model.

 * One source is created per top-level artifact.
 * Returns an object with a `result` dictionary of top-level artifacts
 * by their names, like this:
 *
 *   {
 *     "foo" : "using XY; context foo {...};",
 *     "bar.wiz" : "namespace bar; entity wiz {...};"
 *   }
 *
 * Throws a CompilationError on errors.
 *
 * @param {CSN.Model} csn
 * @param {CSN.Options} options
 */
function toCdlWithCsn(csn, options) {
  options = handleToCdlOptions(csn, options, true);
  const result = toCdsSourceCsn(csn, options);
  return { result, options };
}

// ----------- toSql -----------

/**
 * Generate SQL DDL statements for augmented CSN 'model'.
 * The following options control what is actually generated (see help above):
 *   options : {
 *     toSql.names
 *     toSql.dialect
 *     toSql.user.id
 *     toSql.user.locale
 *     toSql.src
 *     toSql.csn
 *   }
 * Options provided here are merged with (and take precedence over) options from 'model'.
 * If neither 'toSql.src' nor 'toSql.csn' are provided, the default is to generate only SQL DDL
 * source files.
 * If all provided options are part of 'toSql', the 'toSql' wrapper can be omitted.
 * The result object contains the generation results as follows (as enabled in 'options'):
 *   result : {
 *     csn               : the (compact) transformed CSN model
 *     sql               : a dictionary of top-level artifact names, containing for each name 'X':
 *       <X>             : a string with SQL DDL statements for artifact 'X', terminated with ';'.
 *                         Please note that the name of 'X' may contain characters that are not
 *                         legal for filenames on all operating systems (e.g. ':', '\' or '/').
 *   }
 * Throws a CompilationError on errors.
 *
 * @param {CSN.Model}   model
 * @param {CSN.Options} [options]
 */
function toSqlWithCsn(model, options) {
  timetrace.start('toSqlWithCsn');

  const transformedOptions = transformSQLOptions(model, options);
  const mergedOptions = mergeOptions(transformedOptions.options, { forHana : transformedOptions.forHanaOptions });
  const forSqlCsn = transformForHanaWithCsn(model, mergedOptions, 'to.sql');

  // Assemble result
  /** @type {object} */
  let result = {};
  if (transformedOptions.options.toSql.src) {
    result = toSqlDdl(forSqlCsn, mergedOptions);
  }
  if (transformedOptions.options.toSql.csn) {
    result.csn = options.testMode ? sortCsn(forSqlCsn, options) : forSqlCsn;
  }

  timetrace.stop();
  return result;
}

function transformSQLOptions(model, options) {
  // when toSql is invoked via the CLI - toSql options are under model.options
  // ensure the desired format of the user option
  if (model.options && model.options.toSql &&(model.options.toSql.user || model.options.toSql.locale)) {
    transformUserOption(model.options.toSql);
  }

  // In case of API usage the options are in the 'options' argument
  // put the OData specific options under the 'options.toSql' wrapper
  // and leave the rest under 'options'
  if (options && !options.toSql) {
    _wrapRelevantOptionsForCmd(options, 'toSql');
  }

  // when the API function is used directly - toSql options are in options
  // ensure the desired format of the user option
  if (options && (options.toSql.user || options.toSql.locale)){
    transformUserOption(options.toSql);
  }

  // Provide defaults and merge options with those from model
  options = mergeOptions({ toSql : getDefaultBackendOptions().toSql }, model.options, options);

  // Provide something to generate if nothing else was given (conditional default)
  if (!options.toSql.src && !options.toSql.csn) {
    options.toSql.src = 'sql';
  }

  const { warning, error } = makeMessageFunction(model, options, 'to.sql');

  // Verify options
  optionProcessor.verifyOptions(options, 'toSql', true).forEach(complaint => warning(null, null, `${complaint}`));

  // FIXME: Currently, '--to-sql' implies transformation for HANA (transferring the options to forHana)
  let forHanaOptions = options.toSql;

  // Special case: For naming variant 'hdbcds' in combination with 'toSql', 'forHana' must leave
  // namespaces alone (but must still flatten structs because we need the leaf element names).
  if (options.toSql.names === 'hdbcds') {
    forHanaOptions.keepNamespaces = true;
  }

  if(options.toSql.dialect !== 'hana') {
    // CDXCORE-465, 'quoted' and 'hdbcds' are to be used in combination with dialect 'hana' only
    if(['quoted', 'hdbcds'].includes(options.toSql.names)) {
      error(null, null, `Option "{ toSql.dialect: '${options.toSql.dialect}' }" can't be combined with "{ toSql.names: '${options.toSql.names}' }"`);
    }
    // No non-HANA SQL for HDI
    if(options.toSql.src === 'hdi') {
      error(null, null, `Option "{ toSql.dialect: '${options.toSql.dialect}' }" can't be combined with "{ toSql.src: '${options.toSql.src}' }"`);
    }
  }

  // FIXME: Should not be necessary
  forHanaOptions.alwaysResolveDerivedTypes = true;

  return {options, forHanaOptions};

  // If among the options user, user.id or user.locale are specified via the CLI or
  // via the API, then ensure that at the end there is a user option, which is an object and has(have)
  // "id" and/or "locale" prop(s)
  function transformUserOption(options) {
    // move the user option value under user.id if specified as a string
    if (options.user && typeof options.user === 'string' || options.user instanceof String) {
      options.user = { id: options.user };
    }
    // move the locale option(if provided) under user.locale
    if (options.locale) {
      options.user
        ? Object.assign(options.user, { locale: options.locale })
        : options.user = { locale: options.locale };
      delete options.locale;
    }
  }
}

/**
 * Render the given CSN - assuming that it was correctly transformed for toSQL
 * @param {CSN.Model} csn SQL-transformed CSN
 * @param {object} options Options - same as for toSQLWithCSN
 */
function renderSqlWithCsn(csn, options){
  const transformedOptions = transformSQLOptions(csn, options);
  options = transformedOptions.options;
  // Make the options passed to the renderer just like the original toSQLWithCSN
  return toSqlDdl(csn, mergeOptions(options, { forHana : transformedOptions.forHanaOptions } ));
}
// ----------- toRenameWithCsn -----------

// FIXME: Not yet supported, only in beta mode
// Generate SQL DDL rename statements for a migration, renaming existing tables and their
// columns so that they match the result of "toHana" or "toSql" with the "{ names: 'plain' }
// option.
// Expects the naming convention of the existing tables to be either 'quoted' or 'hdbcds' (default).
// The following options control what is actually generated (see help above):
//   options : {
//     toRename.names
//   }
// Return a dictionary of top-level artifacts by their names, like this:
// { "foo" : "RENAME TABLE \"foo\" ...",
//   "bar::wiz" : "RENAME VIEW \"bar::wiz\" ..."
// }
// Options provided here are merged with (and take precedence over) options from 'model'.
// If all provided options are part of 'toRename', the 'toRename' wrapper can be omitted.
// The result object contains the generation results as follows:
//   result : {
//     rename            : a dictionary of top-level artifact names, containing for each name 'X':
//       <X>             : a string with SQL DDL statements for artifact 'X', terminated with ';'.
//                         Please note that the name of 'X' may contain characters that are not
//                         legal for filenames on all operating systems (e.g. ':', '\' or '/').
//   }
// Throws a CompilationError on errors.
function toRenameWithCsn(csn, options) {
  const { error, warning } = makeMessageFunction(csn, options, 'to.rename');

  // In case of API usage the options are in the 'options' argument
  // put the OData specific options under the 'options.toRename' wrapper
  // and leave the rest under 'options'
  if (options && !options.toRename) {
    _wrapRelevantOptionsForCmd(options, 'toRename');
  }

  // Provide defaults and merge options
  options = mergeOptions({ toRename : getDefaultBackendOptions().toRename }, options);

  // Backward compatibility for old naming modes
  // FIXME: Remove after a few releases
  if (options.toRename.names === 'flat') {
    warning(null, null, `Option "{ toRename.names: 'flat' }" is deprecated, use "{ toRename.names: 'plain' }" instead`);
    options.toRename.names = 'plain';
  }
  else if (options.toRename.names === 'deep') {
    warning(null, null, `Option "{ toRename.names: 'deep' }" is deprecated, use "{ toRename.names: 'quoted' }" instead`);
    options.toRename.names = 'quoted';
  }

  // Verify options
  optionProcessor.verifyOptions(options, 'toRename').forEach(complaint => warning(null, null, `${complaint}`));

  // Requires beta mode
  if (!isBetaEnabled(options, 'toRename')) {
    error(null, null, `Generation of SQL rename statements is not supported yet (only in beta mode)`);
  }

  // Special case: For naming variant 'hdbcds' in combination with 'toRename', 'forHana' must leave
  // namespaces alone (but must still flatten structs because we need the leaf element names).
  if (options.toRename.names === 'hdbcds') {
    options = mergeOptions(options, { forHana : { keepNamespaces: true } });
  }

  // FIXME: Currently, 'toRename' implies transformation for HANA (transferring the options to forHana)
  let forHanaCsn = transformForHanaWithCsn(csn, mergeOptions(options, { forHana : options.toRename } ), 'to.rename');
  // forHanaCsn looses empty contexts and services, add them again so that toRename can calculate the namespaces
  forEachDefinition(csn, (artifact, artifactName) => {
    if(['context', 'service'].includes(artifact.kind) && forHanaCsn.definitions[artifactName] === undefined) {
      forHanaCsn.definitions[artifactName] = artifact;
    }
  });

  // Assemble result
  let result = {
    rename : toRenameDdl(forHanaCsn, options),
    options
  };

  return result;
}

function alterConstraintsWithCsn(csn, options) {
  const { error } = makeMessageFunction(csn, options, 'manageConstraints');
  // Requires beta mode
  if (!isBetaEnabled(options, 'foreignKeyConstraints'))
    error(null, null, 'ALTER TABLE statements for adding/modifying referential constraints are only available in beta mode');

  const {
    drop, alter, names, src, violations
  } = options.manageConstraints || {};

  if(drop && alter)
    error(null, null, 'Option “--drop” can\'t be combined with “--alter”');

  options.toSql = {
    dialect: 'hana',
    names: names || 'plain'
  }
  const transformedOptions = transformSQLOptions(csn, options);
  const mergedOptions = mergeOptions(transformedOptions.options, { forHana : transformedOptions.forHanaOptions });
  const forSqlCsn = transformForHanaWithCsn(csn, mergedOptions, 'to.sql');

  if (violations && src && src !== 'sql')
    error(null, null, `Option “--violations“ can't be combined with source style “${src}“`);

  let intermediateResult;
  if (violations)
    intermediateResult = listReferentialIntegrityViolations(forSqlCsn, mergedOptions);
  else
    intermediateResult = manageConstraints(forSqlCsn, mergedOptions);

  if(options.testMode !== true)
    return intermediateResult;

  // if in testmode, return a string containing all the artifacts
  let resultString = '';
  const extension = src && src === 'hdi' ? 'hdbconstraint' : 'sql';
  for(const id in intermediateResult){
    const initialComment = `--$ --- ${id}.${extension} ---\n\n`;
    resultString += initialComment;
    resultString += intermediateResult[id];
    resultString += '\n\n'
  }
  return resultString;
}

// ----------- toCsn -----------
// TODO: delete

// Generate compact CSN for augmented CSN 'model'
// The following options control what is actually generated:
//   options : {
//     testMode     : if true, the result is extra-stable for automated tests (sorted, no 'version')
//     toCsn.flavor : if 'gensrc', the result CSN is only suitable for use as a source, e.g. for combination with
//                    additional extend/annotate statements, but not for consumption by clients or backends
//                    (default is to produce 'client' CSN with all properties propagated and inferred as required
//                    by consumers and backends)
//   }
// Options provided here are merged with (and take precedence over) options from 'model'.
// Throws a CompilationError on errors.
function toCsn(model, options) {
  const { warning } = makeMessageFunction(model, options, 'to.csn');
  // In case of API usage the options are in the 'options' argument
  // put the OData specific options under the 'options.toCsn' wrapper
  // and leave the rest under 'options'
  if (options && !options.toCsn) {
    _wrapRelevantOptionsForCmd(options, 'toCsn');
  }

  // Merge options with those from XSN model
  options = mergeOptions({ toCsn : {} }, model.options, options);

  // Verify options
  optionProcessor.verifyOptions(options, 'toCsn').forEach(complaint => warning(null, null, `${complaint}`));

  return compactModel(model, options);
}

/**
 * Return a set of options containing the defaults that would be applied by the backends.
 * Note that this only contains simple mergeable default values, not conditional defaults
 * that depend in any way on other options (e.g. toSql provides 'src' if neither 'src' nor
 * 'csn' is given: this is a conditional default).
 *
 * @returns {CSN.Options}
 */
function getDefaultBackendOptions() {
  return {
    toHana: {
      names : 'plain'
    },
    toOdata: {
      version : 'v4',
      odataFormat: 'flat'
    },
    toRename: {
      names: 'hdbcds'
    },
    toSql: {
      names : 'plain',
      dialect: 'plain'
    },
  };
}

// Internal function moving command specific options under a command
// wrapper in the options object
function _wrapRelevantOptionsForCmd(options, command) {
  // take the command's specific options
  let cmdOptions = optionProcessor.camelOptionsForCommand(command);
  if (!options[command])
    options[command] = Object.create(null);
  for (let opt in options) {
    if (cmdOptions.includes(opt)) {
      Object.assign(options[command], { [opt]: options[opt] });
      delete options[opt];
    }
  }
}

module.exports = {
  toOdataWithCsn,
  preparedCsnToEdmx,
  preparedCsnToEdmxAll,
  preparedCsnToEdm,
  preparedCsnToEdmAll,
  toCdlWithCsn,
  toSqlWithCsn,
  renderSqlWithCsn,
  toCsn,
  getDefaultBackendOptions,
  toRenameWithCsn,
  alterConstraintsWithCsn
}
