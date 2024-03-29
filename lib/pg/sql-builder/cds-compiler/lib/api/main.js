/** @module API */

'use strict';

const prepareOptions = require('./options');
const backends = require('../backends');
const { setProp } = require('../base/model');
const { emptyLocation } = require('../base/location');
const { CompilationError, makeMessageFunction } = require('../base/messages');
const { recompileX } = require('../compiler/index');
const { compactModel, sortCsn } = require('../json/to-csn');
const { transform4odataWithCsn } = require('../transform/forOdataNew.js');
const { toSqlDdl } = require('../render/toSql');
const { compareModels } = require('../modelCompare/compare');
const sortViews = require('../model/sortViews');
const { getResultingName } = require('../model/csnUtils');
const timetrace = require('../utils/timetrace');
const { transformForHanaWithCsn } = require('../transform/forHanaNew');

/**
 * Return the artifact name for use for the hdbresult object
 * So that it stays compatible with v1 .texts
 *
 * @param {string} artifactName Name to map
 * @param {CSN.Model} csn SQL transformed model
 * @returns {string} Name with . replaced as _ in some places
 */
function getFileName(artifactName, csn) {
  return getResultingName(csn, 'quoted', artifactName);
}

const propertyToCheck = {
  odata: 'toOdata',
};

const { cloneCsn } = require('../model/csnUtils');
const { toHdbcdsSource } = require('../render/toHdbcds');

const relevantGeneralOptions = [ /* for future generic options */ ];
const relevantOdataOptions = [ 'sqlMapping', 'odataFormat' ];
const warnAboutMismatchOdata = [ 'odataVersion' ];

/**
 * Attach options and transformation name to the $meta tag
 *
 * @param {CSN.Model} csn CSN to attach to
 * @param {string} transformation Name of the transformation - odata or hana
 * @param {NestedOptions} options Options used for the transformation
 * @param {string[]} relevantOptionNames Option names that are defining characteristics
 * @param {string[]} [optionalOptionNames=[]] Option names that should be attached as a fyi
 */
function attachTransformerCharacteristics(csn, transformation, options,
                                          relevantOptionNames, optionalOptionNames = []) {
  const relevant = {};
  const propName = propertyToCheck[transformation];
  for (const name of relevantOptionNames ) {
    if (options[propName][name] !== undefined)
      relevant[name] = options[propName][name];
  }

  for (const name of optionalOptionNames ) {
    if (options[propName][name] !== undefined)
      relevant[name] = options[propName][name];
  }

  for (const name of relevantGeneralOptions ) {
    if (options[name] !== undefined)
      relevant[name] = options[name];
  }
  if (!csn.meta)
    setProp(csn, 'meta', {});

  setProp(csn.meta, 'options', relevant);
  setProp(csn.meta, 'transformation', transformation);
}

/**
 * Check the characteristics of the provided, already transformed CSN
 * Report an error if they do not match with the currently requested options
 * V2 vs V4, plain vs hdbcds etc.
 *
 * @param {CSN.Model} csn CSN to check
 * @param {NestedOptions} options Options used for the transformation - scanned top-level
 * @param {string[]} relevantOptionNames Option names that are defining characteristics
 * @param {string[]} warnAboutMismatch Option names to warn about, but not error on
 * @param {string} module Name of the module that calls this function, e.g. `for.odata`
 */
function checkPreTransformedCsn(csn, options, relevantOptionNames, warnAboutMismatch, module) {
  if (!csn.meta) {
    // Not able to check
    return;
  }
  const { error, warning, throwWithError } = makeMessageFunction(csn, options, module);

  for (const name of relevantOptionNames ) {
    if (options[name] !== csn.meta.options[name])
      error('wrong-pretransformed-csn', null, `Expected pre-processed CSN to have option "${ name }" set to "${ options[name] }". Found: "${ csn.meta.options[name] }"`);
  }

  for (const name of warnAboutMismatch ) {
    if (options[name] !== csn.meta.options[name])
      warning('options-mismatch-pretransformed-csn', null, `Expected pre-processed CSN to have option "${ name }" set to "${ options[name] }". Found: "${ csn.meta.options[name] }"`);
  }

  throwWithError();
}

/**
 * Check if the CSN was already run through the appropriate transformer
 *
 * - Currently only check for odata, as hana is not exposed
 *
 * @param {CSN.Model} csn CSN
 * @param {string} transformation Name of the transformation
 * @returns {boolean} Return true if it is pre-transformed
 */
function isPreTransformed(csn, transformation) {
  return csn.meta && csn.meta.transformation === transformation;
}

/**
 * Get an odata-CSN without option handling.
 *
 * @param {CSN.Model} csn Clean input CSN
 * @param {object} internalOptions processed options
 * @returns {object} Return an oData-pre-processed CSN
 */
function odataInternal(csn, internalOptions) {
  const oDataCsn = transform4odataWithCsn(csn, internalOptions);
  attachTransformerCharacteristics(oDataCsn, 'odata', internalOptions, relevantOdataOptions, warnAboutMismatchOdata);
  return oDataCsn;
}

/**
 * Return a odata-transformed CSN
 *
 * @param {CSN.Model} csn Clean input CSN
 * @param {oDataOptions} [options={}] Options
 * @returns {oDataCSN} Return an oData-pre-processed CSN
 */
function odata(csn, options = {}) {
  const internalOptions = prepareOptions.for.odata(options);
  return odataInternal(csn, internalOptions);
}

/**
 * Process the given csn back to cdl.
 *
 * @param {object} csn CSN to process
 * @param {object} [externalOptions={}] Options
 * @returns {CDL} { <artifactName>: <CDL representation>, ...}
 */
function cdl(csn, externalOptions = {}) {
  const internalOptions = prepareOptions.to.cdl(externalOptions);
  const { result } = backends.toCdlWithCsn(cloneCsn(csn, internalOptions), internalOptions);
  return result;
}
/**
 * Transform a CSN like to.sql
 *
 * @param {CSN.Model} csn Plain input CSN
 * @param {sqlOptions} [options={}] Options
 * @returns {CSN.Model} CSN transformed like to.sql
 * @private
 */
function forSql(csn, options = {}) {
  const internalOptions = prepareOptions.to.sql(options);
  internalOptions.toSql.csn = true;
  return backends.toSqlWithCsn(csn, internalOptions).csn;
}
/**
 * Transform a CSN like to.hdi
 *
 * @param {CSN.Model} csn Plain input CSN
 * @param {hdiOptions} [options={}] Options
 * @returns {CSN.Model} CSN transformed like to.hdi
 * @private
 */
function forHdi(csn, options = {}) {
  const internalOptions = prepareOptions.to.hdi(options);
  internalOptions.toSql.csn = true;
  return backends.toSqlWithCsn(csn, internalOptions).csn;
}
/**
 * Transform a CSN like to.hdbcds
 *
 * @param {CSN.Model} csn Plain input CSN
 * @param {hdbcdsOptions} [options={}] Options
 * @returns {CSN.Model} CSN transformed like to.hdbcds
 * @private
 */
function forHdbcds(csn, options = {}) {
  const internalOptions = prepareOptions.to.hdbcds(options);
  internalOptions.transformation = 'hdbcds';

  const hanaCsn = transformForHanaWithCsn(csn, internalOptions, 'to.hdbcds');

  return internalOptions.testMode ? sortCsn(hanaCsn, internalOptions) : hanaCsn;
}

/**
 * Process the given CSN into SQL.
 *
 * @param {CSN.Model} csn A clean input CSN
 * @param {sqlOptions} [options={}] Options
 * @returns {SQL[]} Array of SQL statements, tables first, views second
 */
function sql(csn, options = {}) {
  const internalOptions = prepareOptions.to.sql(options);

  // we need the CSN for view sorting
  internalOptions.toSql.csn = true;

  const intermediateResult = backends.toSqlWithCsn(csn, internalOptions);

  const result = sortViews(intermediateResult);

  return result.map(obj => obj.sql).filter(create => create);
}

/**
 * Process the given CSN into HDI artifacts.
 *
 * @param {CSN.Model} csn A clean input CSN
 * @param {hdiOptions} [options={}] Options
 * @returns {HDIArtifacts} { <filename>:<content>, ...}
 */
function hdi(csn, options = {}) {
  const internalOptions = prepareOptions.to.hdi(options);

  // we need the CSN for view sorting
  internalOptions.toSql.csn = true;

  const intermediateResult = backends.toSqlWithCsn(csn, internalOptions);

  const sqlCSN = intermediateResult.csn;
  delete intermediateResult.csn;

  if (internalOptions.testMode) {
    // All this mapping is needed because sortViews crossmatches
    // passed in SQLs with the CSN artifact name
    // But we also need to return it with the correct file ending in the end
    // so remember and do lot's of mapping here.

    const flat = flattenResultStructure(intermediateResult);

    const nameMapping = Object.create(null);
    const sqlsWithCSNNamesToSort = Object.create(null);
    const sqlsNotToSort = Object.create(null);

    Object.keys(flat).forEach((key) => {
      const artifactNameLikeInCsn = key.replace(/\.[^/.]+$/, '');
      nameMapping[artifactNameLikeInCsn] = key;
      if (key.endsWith('.hdbtable') || key.endsWith('.hdbview'))
        sqlsWithCSNNamesToSort[artifactNameLikeInCsn] = flat[key];
      else
        sqlsNotToSort[key] = flat[key];
    });

    const sorted = sortViews({ sql: sqlsWithCSNNamesToSort, csn: sqlCSN })
      .filter(obj => obj.sql)
      .reduce((previous, current) => {
        const hdiArtifactName = remapName(nameMapping[current.name], sqlCSN, k => !k.endsWith('.hdbindex'));
        previous[hdiArtifactName] = current.sql;
        return previous;
      }, Object.create(null));

    // now add the not-sorted stuff, like indizes
    Object.keys(sqlsNotToSort).forEach((key) => {
      sorted[remapName(key, sqlCSN, k => !k.endsWith('.hdbindex'))] = sqlsNotToSort[key];
    });

    return sorted;
  }

  return remapNames(flattenResultStructure(intermediateResult), sqlCSN, k => !k.endsWith('.hdbindex'));
}
/**
 * Remap names so that they stay consistent between v1 and v2
 *
 * Mainly important for _texts -> .texts
 *
 * @param {object} dict Result dictionary by toSql
 * @param {CSN.Model} csn SQL transformed CSN
 * @param {Function} filter Filter for keys not to remap
 * @returns {object} New result structure
 */
function remapNames(dict, csn, filter) {
  const result = Object.create(null);

  for (const [ key, value ] of Object.entries(dict)) {
    const name = remapName(key, csn, filter);
    result[name] = value;
  }

  return result;
}
/**
 * Remap names so that it stays consistent between v1 and v2
 *
 * Mainly important for _texts -> .texts
 *
 * @param {string} key Filename
 * @param {CSN.Model} csn SQL transformed CSN
 * @param {Function} filter Filter for keys not to remap
 * @returns {string} Remapped filename
 */
function remapName(key, csn, filter = () => true) {
  if (filter(key)) {
    const lastDot = key.lastIndexOf('.');
    const prefix = key.slice(0, lastDot);
    const suffix = key.slice(lastDot);

    const remappedName = getFileName(prefix, csn);
    return remappedName + suffix;
  }

  return key;
}

/**
 * Return all changes in artifacts between two given models.
 * Note: Only supports changes in entities (not views etc.) compiled/rendered as HANA-CSN/SQL.
 *
 * @param {CSN.Model}  csn          A clean input CSN representing the desired "after-image"
 * @param {hdiOptions} options      Options
 * @param {CSN.Model}  beforeImage  A HANA-transformed CSN representing the "before-image", or null in case no such image
 *                                  is known, i.e. for the very first migration step
 * @returns {object} - afterImage:  The desired after-image in HANA-CSN format
 *                   - definitions: An array of objects with all artifacts in the after-image. Each object specifies
 *                                  the artifact filename, the suffix, and the corresponding SQL statement to create
 *                                  the artifact.
 *                   - deletions:   An array of objects with the deleted artifacts. Each object specifies the artifact
 *                                  filename and the suffix.
 *                   - migrations:  An array of objects with the changed (migrated) artifacts. Each object specifies the
 *                                  artifact filename, the suffix, and the changeset (an array of changes, each specifying
 *                                  whether it incurs potential data loss, and its respective SQL statement(s), with
 *                                  multiple statements concatenated as a multi-line string in case the change e.g.
 *                                  consists of a column drop and add).
 */
function hdiMigration(csn, options, beforeImage) {
  /**
   * Swap arguments in case of inverted argument order.
   * This is for backward compatibility with @sap/cds@4.5.(2…3).
   *
   * @todo Remove in cds-compiler@2.x
   * @param {hdiOptions|CSN.Model} inputOptions Options or CSN image
   * @param {CSN.Model|hdiOptions} inputBeforeImage CSN image or options
   * @returns {Array} Array where the real options come first
   */
  function backwardCompatible(inputOptions, inputBeforeImage) {
    /**
     * Check whether the given argument is a CSN
     *
     * @param {object} arg Argument to verify
     * @returns {boolean} True if it is a CSN
     */
    function isBeforeImage(arg) {
      return arg === null || [ 'definitions', 'meta', '$version' ].some(key => key in arg);
    }
    return isBeforeImage(inputBeforeImage)
      ? [ inputOptions, inputBeforeImage ]
      : [ inputBeforeImage, inputOptions ];
  }
  [ options, beforeImage ] = backwardCompatible(options, beforeImage);

  const internalOptions = prepareOptions.to.hdi(options);
  internalOptions.toSql.csn = true;

  // Prepare after-image.
  // FIXME: Is this needed?
  // cloneCsnMessages(csn, options, internalOptions);
  const afterImage = backends.toSqlWithCsn(csn, internalOptions).csn;

  // Compare both images.
  const diff = compareModels(beforeImage || afterImage, afterImage, internalOptions);

  // Convert the diff to SQL.
  internalOptions.forHana = true; // Make it pass the SQL rendering
  const { deletions, migrations, ...hdbkinds } = toSqlDdl(diff, internalOptions);

  return {
    afterImage,
    definitions: createDefinitions(),
    deletions: createDeletions(),
    migrations: createMigrations(),
  };

  /**
   * From the given HDI artifacts, create the the correct result structure.
   *
   * @returns {object[]} Array of objects, each having: name, suffix and sql
   */
  function createDefinitions() {
    const result = [];
    for (const [ kind, artifacts ] of Object.entries(hdbkinds)) {
      const suffix = `.${ kind }`;
      for (const [ name, sqlStatement ] of Object.entries(artifacts)) {
        if ( kind !== 'hdbindex' )
          result.push({ name: getFileName(name, afterImage), suffix, sql: sqlStatement });
        else
          result.push({ name, suffix, sql: sqlStatement });
      }
    }
    return result;
  }
  /**
   * From the given deletions, create the correct result structure.
   *
   * @returns {object[]} Array of objects, each having: name and suffix - only .hdbtable as suffix for now
   */
  function createDeletions() {
    const result = [];
    for (const [ name ] of Object.entries(deletions))
      result.push({ name: getFileName(name, beforeImage), suffix: '.hdbtable' });

    return result;
  }
  /**
   * From the given migrations, create the correct result structure.
   *
   * @returns {object[]} Array of objects, each having: name, suffix and changeset.
   */
  function createMigrations() {
    const result = [];
    for (const [ name, changeset ] of Object.entries(migrations))
      result.push({ name: getFileName(name, afterImage), suffix: '.hdbmigrationtable', changeset });

    return result;
  }
}

hdi.migration = hdiMigration;

/**
 * Process the given CSN into HDBCDS artifacts.
 *
 * @param {any} csn A clean input CSN
 * @param {hdbcdsOptions} [options={}] Options
 * @returns {HDBCDS} { <filename>:<content>, ...}
 */
function hdbcds(csn, options = {}) {
  timetrace.start('to.hdbcds');
  const internalOptions = prepareOptions.to.hdbcds(options);
  internalOptions.transformation = 'hdbcds';

  const hanaCsn = forHdbcds(csn, internalOptions);

  const result = flattenResultStructure(toHdbcdsSource(hanaCsn, internalOptions));
  timetrace.stop();
  return result;
}
/**
 * Generate a edm document for the given service
 *
 * @param {CSN|oDataCSN} csn Clean input CSN or a pre-transformed CSN
 * @param {oDataOptions} [options={}] Options
 * @returns {edm} The JSON representation of the service
 */
function edm(csn, options = {}) {
  // If not provided at all, set service to undefined to trigger validation
  const internalOptions = prepareOptions.to.edm(
    // eslint-disable-next-line comma-dangle
    options.service ? options : Object.assign({ service: undefined }, options)
  );

  const { service } = options;

  let servicesEdmj;
  if (isPreTransformed(csn, 'odata')) {
    checkPreTransformedCsn(csn, internalOptions, relevantOdataOptions, warnAboutMismatchOdata, 'for.odata');
    servicesEdmj = backends.preparedCsnToEdm(csn, service, internalOptions);
  }
  else {
    const oDataCsn = odataInternal(csn, internalOptions);
    servicesEdmj = backends.preparedCsnToEdm(oDataCsn, service, internalOptions);
  }
  return servicesEdmj.edmj;
}

edm.all = edmall;

/**
 * Generate edm documents for all services
 *
 * @param {CSN|oDataCSN} csn Clean input CSN or a pre-transformed CSN
 * @param {oDataOptions} [options={}] Options
 * @returns {edms} { <service>:<JSON representation>, ...}
 */
function edmall(csn, options = {}) {
  const internalOptions = prepareOptions.to.edm(options);
  const { error } = makeMessageFunction(csn, internalOptions, 'for.odata');

  if (internalOptions.version === 'v2')
    error(null, null, 'OData JSON output is not available for OData V2');

  const result = {};
  let oDataCsn = csn;

  if (isPreTransformed(csn, 'odata'))
    checkPreTransformedCsn(csn, internalOptions, relevantOdataOptions, warnAboutMismatchOdata, 'for.odata');

  else
    oDataCsn = odataInternal(csn, internalOptions);

  const servicesJson = backends.preparedCsnToEdmAll(oDataCsn, internalOptions);
  const services = servicesJson.edmj;
  for (const serviceName in services) {
    const lEdm = services[serviceName];
    // FIXME: Why only metadata_json - isn't this rather a 'combined_json' ? If so, rename it!
    result[serviceName] = lEdm;
  }
  return result;
}
/**
 * Generate a edmx document for the given service
 *
 * @param {CSN|oDataCSN} csn Clean input CSN or a pre-transformed CSN
 * @param {oDataOptions} [options={}] Options
 * @returns {edmx} The XML representation of the service
 */
function edmx(csn, options = {}) {
  // If not provided at all, set service to undefined to trigger validation
  const internalOptions = prepareOptions.to.edmx(
    // eslint-disable-next-line comma-dangle
    options.service ? options : Object.assign({ service: undefined }, options)
  );

  const { service } = options;

  let services;
  if (isPreTransformed(csn, 'odata')) {
    checkPreTransformedCsn(csn, internalOptions, relevantOdataOptions, warnAboutMismatchOdata, 'for.odata');
    services = backends.preparedCsnToEdmx(csn, service, internalOptions);
  }
  else {
    const oDataCsn = odataInternal(csn, internalOptions);
    services = backends.preparedCsnToEdmx(oDataCsn, service, internalOptions);
  }

  return services.edmx;
}

edmx.all = edmxall;

/**
 * Generate edmx documents for all services
 *
 * @param {CSN|oDataCSN} csn Clean input CSN or a pre-transformed CSN
 * @param {oDataOptions} [options={}] Options
 * @returns {edmxs} { <service>:<XML representation>, ...}
 */
function edmxall(csn, options = {}) {
  const internalOptions = prepareOptions.to.edmx(options);

  const result = {};
  let oDataCsn = csn;

  if (isPreTransformed(csn, 'odata'))
    checkPreTransformedCsn(csn, internalOptions, relevantOdataOptions, warnAboutMismatchOdata, 'for.odata');

  else
    oDataCsn = odataInternal(csn, internalOptions);

  const servicesEdmx = backends.preparedCsnToEdmxAll(oDataCsn, internalOptions);
  const services = servicesEdmx.edmx;
  // Create annotations and metadata once per service
  for (const serviceName in services) {
    const lEdm = services[serviceName];
    result[serviceName] = lEdm;
  }

  return result;
}

/**
 * Flatten the result structure to a flat map.
 *
 * Don't loop over messages.
 *
 * @param {object} toProcess { <type>: { <name>:<content>, ...}, <type>: ...}
 * @returns {object} { <name.type>:<content> }
 */
function flattenResultStructure(toProcess) {
  const result = {};
  for (const [ fileType, artifacts ] of Object.entries(toProcess)) {
    if (fileType === 'messages')
      continue;
    for (const filename of Object.keys(artifacts))
      result[`${ filename }.${ fileType }`] = artifacts[filename];
  }

  return result;
}

module.exports = {
  odata: publishCsnProcessor(odata, 'for.odata'),
  cdl: publishCsnProcessor(cdl, 'to.cdl'),
  sql: publishCsnProcessor(sql, 'to.sql'),
  hdi: publishCsnProcessor(hdi, 'to.hdi'),
  hdbcds: publishCsnProcessor(hdbcds, 'to.hdbcds'),
  edm: publishCsnProcessor(edm, 'to.edm'),
  edmx: publishCsnProcessor(edmx, 'to.edmx'),
  /** Internal only */
  for_sql: publishCsnProcessor(forSql, 'for.sql'),
  for_hdi: publishCsnProcessor(forHdi, 'for.hdi'),
  for_hdbcds: publishCsnProcessor(forHdbcds, 'for.hdbcds'),
  /** */
};


/**
 * @param {any} processor CSN processor
 * @param {string} _name Name of the processor
 * @returns {any} Function that calls the processor and recompiles in case of internal errors
 */
function publishCsnProcessor( processor, _name ) {
  api.internal = processor;

  if (processor.all)
    api.all = publishCsnProcessor(processor.all, `${ _name }.all`);

  if (processor.migration)
    api.migration = publishCsnProcessor(processor.migration, `${ _name }.migration`);

  if (processor.mtx)
    api.mtx = publishCsnProcessor(processor.mtx, `${ _name }.mtx`);

  return api;

  /**
   * Function that calls the processor and re-compiles in case of internal errors
   *
   * @param {object} csn CSN
   * @param {object} options Options
   * @param {any} args Any additional arguments
   * @returns {any} What ever the processor returns
   */
  function api( csn, options = {}, ...args ) {
    try {
      return processor( csn, options, ...args );
    }
    catch (err) {
      if (err instanceof CompilationError || options.noRecompile)
      // options.testMode && err instanceof RangeError) // stack overflow
        throw err;

      const { info } = makeMessageFunction( csn, options, 'compile' );
      info( 'api-recompiled-csn', emptyLocation('csn.json'), {}, 'CSN input had to be recompiled' );
      // next line to be replaced by CSN parser call which reads the CSN object
      const xsn = recompileX(csn, options);
      const recompiledCsn = compactModel(xsn);
      return processor( recompiledCsn, options, ...args );
    }
  }
}


/**
 * Option format used by the old API, where they are grouped thematically.
 *
 * @typedef {object} NestedOptions
 */

/**
 * Option format used by the new API, where all options are top-level.
 *
 * @typedef {object} FlatOptions
 */

/**
 * Available SQL dialects
 *
 * @typedef {'hana' | 'sqlite' } SQLDialect
 */

/**
 * Available naming modes
 *
 * @typedef {'plain' | 'quoted' | 'hdbcds' } NamingMode
 */

/**
 * Available SQL change modes
 *
 * @typedef {'alter' | 'drop' } SqlChangeMode
 */

/**
 * Available oData versions
 *
 * @typedef {'v2' | 'v4' } oDataVersion
 */

/**
 * Available oData versions
 *
 * @typedef { 'structured' | 'flat' } oDataFormat
 */

/**
 * Generally available options
 *
 * @typedef {object} Options
 * @property {object} [beta] Enable experimental features - not for productive use!
 * @property {boolean} [dependentAutoexposed=false] For dependent autoexposed entities (managed compositions, texts entity), follow name of base entity
 * @property {boolean} [longAutoexposed=false] Deprecated: Produce long names (with underscores) for autoexposed entities
 * @property {Map<string, number>} [severities={}] Map of message-id and severity that allows setting the severity for the given message
 * @property {Array} [messages] Allows collecting all messages in the options instead of printing them to stderr.
 */

/**
 * Options available for all oData-based functions
 *
 * @typedef {object} oDataOptions
 * @property {object} [beta] Enable experimental features - not for productive use!
 * @property {boolean} [longAutoexposed=false] Deprecated: Produce long names (with underscores) for autoexposed entities
 * @property {Map<string, number>} [severities={}] Map of message-id and severity that allows setting the severity for the given message
 * @property {Array} [messages] Allows collecting all messages in the options instead of printing them to stderr.
 * @property {oDataVersion} [odataVersion='v4'] Odata version to use
 * @property {oDataFormat} [odataFormat='flat'] Wether to generate oData as flat or as structured. Structured only with v4.
 * @property {NamingMode} [sqlMapping='plain'] Naming mode to use
 * @property {string} [service] If a single service is to be rendered
 */

/**
 * Options available for to.hdi
 *
 * @typedef {object} hdiOptions
 * @property {NamingMode} [sqlMapping='plain'] Naming mode to use
 * @property {SqlChangeMode} [sqlChangeMode='alter'] SQL change mode to use (for changed columns)
 * @property {boolean} [allowCsnDowngrade=false] Allow downgrades of CSN major version (for modelCompare)
 * @property {object} [beta] Enable experimental features - not for productive use!
 * @property {boolean} [longAutoexposed=false] Deprecated: Produce long names (with underscores) for autoexposed entities
 * @property {Map<string, number>} [severities={}] Map of message-id and severity that allows setting the severity for the given message
 * @property {Array} [messages] Allows collecting all messages in the options instead of printing them to stderr.
 */

/**
 * Options available for to.hdbcds
 *
 * @typedef {object} hdbcdsOptions
 * @property {NamingMode} [sqlMapping='plain'] Naming mode to use
 * @property {object} [beta] Enable experimental features - not for productive use!
 * @property {boolean} [longAutoexposed=false] Deprecated: Produce long names (with underscores) for autoexposed entities
 * @property {Map<string, number>} [severities={}] Map of message-id and severity that allows setting the severity for the given message
 * @property {Array} [messages] Allows collecting all messages in the options instead of printing them to stderr.
 */

/**
 * Options available for to.sql
 *
 * @typedef {object} sqlOptions
 * @property {NamingMode} [sqlMapping='plain'] Naming mode to use
 * @property {SQLDialect} [sqlDialect='sqlite'] SQL dialect to use
 * @property {object} [magicVars] Object containing values for magic variables like "$user"
 * @property {string} [magicVars.locale] Value for the "$user.locale" in "sqlite" dialect
 * @property {string} [magicVars.user] Value for the "$user" variable in "sqlite" dialect
 * @property {object} [beta] Enable experimental features - not for productive use!
 * @property {boolean} [longAutoexposed=false] Deprecated: Produce long names (with underscores) for autoexposed entities
 * @property {Map<string, number>} [severities={}] Map of message-id and severity that allows setting the severity for the given message
 * @property {Array} [messages] Allows collecting all messages in the options instead of printing them to stderr.
 */

/**
 * A fresh (just compiled, not transformed) CSN
 *
 * @typedef {object} CSN
 */

/**
 * A CSN transformed for oData - can be rendered to edm or edmx
 *
 * @typedef {CSN.Model} oDataCSN
 */

/**
 * The CDL representation of a model
 *
 * @typedef {object} CDL
 */

/**
 * A map of { <file.hdbcds>:<content> }.
 *
 * @typedef {object} HDBCDS
 */

/**
 * A map of { <file.hdbtable/view...>:<content> }.
 *
 * @typedef {object} HDIArtifacts
 */

/**
 * A SQL statement - CREATE TABLE, CREATE VIEW etc.
 *
 * @typedef {string} SQL
 */

/**
 * The XML document representing the service.
 *
 * @typedef {object} edmx
 */

/**
 * The JSON document representing the service.
 *
 * @typedef {object} edm
 */

/**
 * A map of { <serviceName>:<XML> }.
 *
 * @typedef {object} edmxs
 */

/**
 * A map of { <serviceName>:<JSON> }.
 *
 * @typedef {object} edms
 */
