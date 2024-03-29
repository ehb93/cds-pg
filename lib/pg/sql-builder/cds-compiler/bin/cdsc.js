#!/usr/bin/env node

// command line interface to the cds api resp. cds compiler
// Usage: cdsc [options] <file> ...
// Call cdsc --help for a detailed description
// Exit codes are:
//   0   for success
//   1   compilation error
//   2   command line usage error

// For recursive *.cds expansion, use
//   cdsc $(find . -name '*.cds' -type f)

'use strict';

/* eslint no-console:off */

const compiler = require('../lib/compiler');
const main = require('../lib/main');
const { for_sql, for_hdi, for_hdbcds } = require('../lib/api/main');
const { compactModel } = require('../lib/json/to-csn');
const { toRenameWithCsn, alterConstraintsWithCsn } = require('../lib/backends');
const util = require('util');
const fs = require('fs');
const path = require('path');
const { reveal } = require('../lib/model/revealInternalProperties');
const enrichCsn = require('../lib/model/enrichCsn');
const { optionProcessor } = require('../lib/optionProcessor');
const { explainMessage, hasMessageExplanation, sortMessages } = require('../lib/base/messages');
const term = require('../lib/utils/term');
const { splitLines } = require('../lib/utils/file');
const { addLocalizationViews } = require('../lib/transform/localized');
const { availableBetaFlags } = require('../lib/base/model');

// Note: Instead of throwing ProcessExitError, we would rather just call process.exit(exitCode),
// but that might truncate the output of stdout and stderr, both of which are async (or rather,
// may possibly be async, depending on OS and whether I/O goes to TTY, socket, file, ... sigh)
class ProcessExitError extends Error {
  constructor(exitCode, ...args) {
    super(...args);
    this.exitCode = exitCode;
  }
}

function remapCmdOptions(options, cmdOptions) {
  if (!cmdOptions)
    return options;

  for (const [ key, value ] of Object.entries(cmdOptions)) {
    switch (key) {
      case 'names':
        options.sqlMapping = value;
        break;
      case 'user':
        if (!options.magicVars)
          options.magicVars = {};
        options.magicVars.user = value;
        break;
      case 'dialect':
        options.sqlDialect = value;
        break;
      case 'version':
        options.odataVersion = value;
        break;
      case 'locale':
        if (!options.magicVars)
          options.magicVars = {};
        options.magicVars.locale = value;
        break;
      default:
        options[key] = value;
    }
  }
  return options;
}

// Parse the command line and translate it into options
try {
  const cmdLine = optionProcessor.processCmdLine(process.argv);
  // Deal with '--version' explicitly
  if (cmdLine.options.version) {
    process.stdout.write(`${main.version()}\n`);
    throw new ProcessExitError(0);
  }
  // Deal with '--help' explicitly
  if (cmdLine.command) {
    // Command specific help
    if (cmdLine.options.help || cmdLine.options[cmdLine.command] && cmdLine.options[cmdLine.command].help)
      displayUsage(null, optionProcessor.commands[cmdLine.command].helpText, 0);
  }
  else if (cmdLine.options.help) {
    // General help
    displayUsage(null, optionProcessor.helpText, 0);
  }

  if (cmdLine.unknownOptions.length > 0) {
    // Print an INFO message about unknown options but
    // continue with defaults and do not abort execution.
    cmdLine.unknownOptions.forEach(msg => process.stderr.write(`cdsc: INFO: ${msg}\n`));
  }

  // Report complaints if any
  if (cmdLine.cmdErrors.length > 0) {
    // Command specific errors
    displayUsage(cmdLine.cmdErrors, optionProcessor.commands[cmdLine.command].helpText, 2);
  }
  else if (cmdLine.errors.length > 0) {
    // General errors
    displayUsage(cmdLine.errors, optionProcessor.helpText, 2);
  }

  // Default warning level is 2 (info)
  // FIXME: Is that not set anywhere in the API?
  if (!cmdLine.options.warning)
    cmdLine.options.warning = 2;

  // Default output goes to stdout
  if (!cmdLine.options.out)
    cmdLine.options.out = '-';

  // --cds-home <dir>: modules starting with '@sap/cds/' are searched in <dir>
  if (cmdLine.options.cdsHome) {
    if (!global.cds)
      global.cds = {};
    global.cds.home = cmdLine.options.cdsHome;
  }
  // Default color mode is 'auto'
  term.useColor(cmdLine.options.color || 'auto');

  // Set default command if required
  cmdLine.command = cmdLine.command || 'toCsn';

  if (cmdLine.options.rawOutput)
    cmdLine.options.attachValidNames = true;

  // Internally, parseCdl is an option so we map the command to it.
  if (cmdLine.command === 'parseCdl') {
    cmdLine.command = 'toCsn';
    cmdLine.options.parseCdl = true;
    if (cmdLine.args.files.length > 1) {
      const err = `'parseCdl' expects exactly one file! ${cmdLine.args.files.length} provided.`;
      displayUsage(err, optionProcessor.commands.parseCdl.helpText, 2);
    }
  }

  if (cmdLine.options.directBackend)
    validateDirectBackendOption(cmdLine.command, cmdLine.options, cmdLine.args);


  if (cmdLine.options.beta) {
    const features = cmdLine.options.beta.split(',');
    cmdLine.options.beta = {};
    features.forEach((val) => {
      cmdLine.options.beta[val] = true;
    });
  }

  // Enable all beta-flags if betaMode is set to true
  if (cmdLine.options.betaMode)
    cmdLine.options.beta = availableBetaFlags;

  if (cmdLine.options.deprecated) {
    const features = cmdLine.options.deprecated.split(',');
    cmdLine.options.deprecated = {};
    features.forEach((val) => {
      cmdLine.options.deprecated[val] = true;
    });
  }
  // Do the work for the selected command
  executeCommandLine(cmdLine.command, cmdLine.options, cmdLine.args);
}
catch (err) {
  // This whole try/catch is only here because process.exit does not work in combination with
  // stdout/err - see comment at ProcessExitError
  if (err instanceof ProcessExitError)
    process.exitCode = err.exitCode;
  else
    throw err;
}

/**
 * `--direct-backend` can only be used with certain backends and with certain files.
 * This function checks these pre-conditions and emits an error if a condition isn't
 * fulfilled.
 *
 * @param {string} command
 * @param {CSN.Options} options
 * @param {object} args
 */
function validateDirectBackendOption(command, options, args) {
  if (![ 'toCdl', 'toOdata', 'toHana', 'toCsn', 'toSql' ].includes(command)) {
    displayUsage(`Option '--direct-backend' can't be used with command '${command}'`,
                 optionProcessor.helpText, 2);
  }
  if (!args.files || args.files.length !== 1) {
    displayUsage(`Option '--direct-backend' expects exactly one JSON file, but ${args.files.length} given`,
                 optionProcessor.helpText, 2);
  }
  const filename = args.files[0];
  if (!filename.endsWith('.csn') && !filename.endsWith('.json')) {
    displayUsage('Option \'--direct-backend\' expects a filename with a *.csn or *.json suffix',
                 optionProcessor.helpText, 2);
  }
}

// Display help text 'helpText' and 'error' (if any), then exit with exit code <code>
function displayUsage(error, helpText, code) {
  // Display non-error output (like help) to stdout
  const out = (code === 0 && !error) ? process.stdout : process.stderr;
  // Display help text first, error at the end (more readable, no scrolling)
  out.write(`${helpText}\n`);
  if (error) {
    if (error instanceof Array)
      out.write(`${error.map(error => `cdsc: ERROR: ${error}`).join('\n')}\n`);
    else
      out.write(`cdsc: ERROR: ${error}\n`);
  }
  throw new ProcessExitError(code);
}

// Executes a command line that has been translated to 'command' (what to do), 'options' (how) and 'args' (which files)
function executeCommandLine(command, options, args) {
  const normalizeFilename = options.testMode && process.platform === 'win32';
  const messageLevels = {
    Error: 0, Warning: 1, Info: 2, None: 3,
  };
  // All messages are put into the message array, even those which should not
  // been displayed (severity 'None')

  // Create output directory if necessary
  if (options.out && options.out !== '-' && !fs.existsSync(options.out))
    fs.mkdirSync(options.out);


  // Add implementation functions corresponding to commands here
  const commands = {
    toCdl,
    toCsn,
    toHana,
    toOdata,
    toRename,
    manageConstraints,
    toSql,
  };
  const commandsWithoutCompilation = {
    explain,
  };

  if (!commands[command] && !commandsWithoutCompilation[command])
    throw new Error(`Missing implementation for command ${command}`);


  if (commandsWithoutCompilation[command]) {
    commandsWithoutCompilation[command]();
    return;
  }

  options.messages = [];

  const fileCache = Object.create(null);
  const compiled = options.directBackend
    ? util.promisify(fs.readFile)( args.files[0], 'utf-8' ).then(str => JSON.parse( str ))
    : compiler.compileX( args.files, undefined, options, fileCache );

  compiled.then( commands[command] )
    .then( displayMessages, displayErrors )
    .catch( catchErrors );

  return; // below are only command implementations.

  // Execute the command line option '--to-cdl' and display the results.
  // Return the original model (for chaining)
  function toCdl( model ) {
    const csn = options.directBackend ? model : compactModel(model, options);
    const cdlResult = main.to.cdl(csn, remapCmdOptions(options));
    for (const name in cdlResult)
      writeToFileOrDisplay(options.out, `${name}.cds`, cdlResult[name]);

    return model;
  }

  // Execute the command line option 'toCsn' and display the results.
  // Return the original model (for chaining)
  function toCsn( model ) {
    if (options.directBackend) {
      displayNamedCsn(model, 'csn', options);
    }
    else {
      // Result already provided by caller
      displayNamedXsn(model, 'csn', options);
    }
    return model;
  }

  // Execute the command line option '--to-hana' and display the results.
  // Return the original model (for chaining)
  function toHana( model ) {
    const csn = options.directBackend ? model : compactModel(model, options);

    if (options.toHana && options.toHana.csn) {
      displayNamedCsn(for_hdbcds(csn, remapCmdOptions(options, options.toHana)), 'hana_csn', options);
    }
    else {
      const hanaResult = main.to.hdbcds(csn, remapCmdOptions(options, options.toHana));
      for (const name in hanaResult)
        writeToFileOrDisplay(options.out, name, hanaResult[name]);
    }

    return model;
  }

  // Execute the command line option '--to-odata' and display the results.
  // Return the original model (for chaining)
  function toOdata( model ) {
    if (options.toOdata &&
      options.toOdata.version === 'v4x') {
      options.toOdata.version = 'v4';
      options.toOdata.odataFormat = 'structured';
      options.toOdata.odataContainment = true;
    }
    const csn = options.directBackend ? model : compactModel(model, options);
    const odataCsn = main.for.odata(csn, remapCmdOptions(options, options.toOdata));
    if (options.toOdata && options.toOdata.csn) {
      displayNamedCsn(odataCsn, 'odata_csn', options);
    }
    else if (options.toOdata && options.toOdata.json) {
      const result = main.to.edm.all(odataCsn, options);
      for (const serviceName in result)
        writeToFileOrDisplay(options.out, `${serviceName}.json`, result[serviceName]);
    }
    else {
      const result = main.to.edmx.all(odataCsn, options);
      for (const serviceName in result)
        writeToFileOrDisplay(options.out, `${serviceName}.xml`, result[serviceName]);
    }
    return model;
  }

  // Execute the command line option '--to-rename' and display the results.
  // Return the original model (for chaining)
  //
  // / THIS MUST SURVIVE IF WE REMOVE THE OLD API
  // / DO NOT DELETE THIS TORENAME FUNCTIONALITY!!
  function toRename( model ) {
    const csn = options.directBackend ? model : compactModel(model, options);
    const renameResult = toRenameWithCsn(csn, options);
    let storedProcedure = `PROCEDURE RENAME_${renameResult.options.toRename.names.toUpperCase()}_TO_PLAIN LANGUAGE SQLSCRIPT AS BEGIN\n`;
    for (const name in renameResult.rename) {
      storedProcedure += `  --\n  -- ${name}\n  --\n`;
      storedProcedure += renameResult.rename[name];
    }
    storedProcedure += 'END;\n';
    writeToFileOrDisplay(options.out, `storedProcedure_${renameResult.options.toRename.names}_to_plain.sql`, storedProcedure, true);
    return model;
  }

  // Execute the command line option 'manageConstraints' and display the results.
  function manageConstraints( model ) {
    const csn = options.directBackend ? model : compactModel(model, options);
    const alterConstraintsResult = alterConstraintsWithCsn(csn, options);
    const { src } = options.manageConstraints || {};
    Object.keys(alterConstraintsResult).forEach((id) => {
      const renderedConstraintStatement = alterConstraintsResult[id];
      if (src === 'hdi')
        writeToFileOrDisplay(options.out, `${id}.hdbconstraint`, renderedConstraintStatement);
      else
        writeToFileOrDisplay(options.out, `${id}.sql`, renderedConstraintStatement);
    });
  }

  // Execute the command line option '--to-sql' and display the results.
  // Return the original model (for chaining)
  function toSql( model ) {
    const csn = options.directBackend ? model : compactModel(model, options);
    if (options.toSql && options.toSql.src === 'hdi') {
      if (options.toSql.csn) {
        displayNamedCsn(for_hdi(csn, remapCmdOptions(options, options.toSql)), 'hdi_csn', options);
      }
      else {
        const hdiResult = main.to.hdi(csn, remapCmdOptions(options, options.toSql));
        for (const name in hdiResult)
          writeToFileOrDisplay(options.out, name, hdiResult[name]);
      }
    }
    else if (options.toSql && options.toSql.csn) {
      displayNamedCsn(for_sql(csn, remapCmdOptions(options, options.toSql)), 'sql_csn', options);
    }
    else {
      const sqlResult = main.to.sql(csn, remapCmdOptions(options, options.toSql));
      writeToFileOrDisplay(options.out, 'model.sql', sqlResult.join('\n'), true);
    }
    return model;
  }

  function explain() {
    if (args.length !== 1)
      displayUsage('Command \'explain\' expects exactly one message-id.', optionProcessor.commands.explain.helpText, 2);

    const id = args.files[0];
    if (!hasMessageExplanation(id))
      console.error(`Message '${id}' does not have an explanation!`);
    else
      console.log(explainMessage(id));
  }

  // Display error messages in `err` resulting from a compilation.  Also set
  // process.exitCode - process.exit() will force the process to exit as quickly
  // as possible = is problematic, since console.error() might be asynchronous
  function displayErrors(err) {
    if (err instanceof main.CompilationError) {
      if (options.rawOutput)
        console.error( util.inspect( reveal( err.model, options.rawOutput ), false, null ));
      else
        displayMessages( err.model, err.messages );
      process.exitCode = 1;
    }
    else if (err instanceof compiler.InvocationError) {
      console.error( '' );
      for (const sub of err.errors)
        console.error( sub.message );
      console.error( '' );
      process.exitCode = 2;
    }
    else {
      throw err;
    }

    err.hasBeenReported = true;
    throw err;
  }

  /**
   * Print the model's messages to stderr in a human readable way.
   *
   * @param {CSN.Model | XSN.Model} model
   * @param {CSN.Message[]} messages
   */
  function displayMessages( model, messages = options.messages ) {
    if (!Array.isArray(messages))
      return model;

    const log = console.error;

    sortMessages(messages);

    if (options.internalMsg) {
      messages.map(msg => util.inspect( msg, { depth: null, maxArrayLength: null } ) )
        .forEach(msg => log(msg));
    }
    else if (options.noMessageContext) {
      messages.filter(msg => (messageLevels[msg.severity] <= options.warning))
        .forEach(msg => log(main.messageString(msg, normalizeFilename, !options.showMessageId)));
    }
    else {
      // Contains file-contents that are split at '\n'. Try to avoid multiple `.split()` calls.
      const splitCache = Object.create(null);
      const sourceLines = (name) => {
        if (!splitCache[name])
          splitCache[name] = fileCache[name] ? splitLines(fileCache[name]) : fileCache;
        return splitCache[name];
      };
      let hasAtLeastOneExplanation = false;
      messages.filter(msg => messageLevels[msg.severity] <= options.warning).forEach((msg) => {
        hasAtLeastOneExplanation = hasAtLeastOneExplanation || main.hasMessageExplanation(msg.messageId);
        const name = msg.location && msg.location.file;
        const fullFilePath = name ? path.resolve('', name) : undefined;
        const context = fullFilePath && sourceLines(fullFilePath);
        log(main.messageStringMultiline(msg, {
          normalizeFilename, noMessageId: !options.showMessageId, withLineSpacer: true, hintExplanation: true,
        }));
        if (context)
          log(main.messageContext(context, msg));
        log(); // newline
      });
      if (options.showMessageId && hasAtLeastOneExplanation)
        log(`${term.help('help')}: Messages marked with '…' have an explanation text. Use \`cdsc explain <message-id>\` for a more detailed error description.`);
    }
    return model;
  }

  // Write the model 'model' to file '<name>.{json|raw.txt}' in directory 'options.out',
  // or display it to stdout if 'options.out' is '-'.
  // Depending on 'options.rawOutput', the model is either compacted to 'name.json' or
  // written in raw form to '<name>_raw.txt'.
  function displayNamedXsn(xsn, name, options) {
    if (options.rawOutput) {
      writeToFileOrDisplay(options.out, `${name}_raw.txt`, util.inspect(reveal(xsn, options.rawOutput), false, null), true);
    }
    else if (options.internalMsg) {
      writeToFileOrDisplay(options.out, `${name}_raw.txt`, util.inspect(reveal(xsn).messages, { depth: null, maxArrayLength: null }), true);
    }
    else if (!options.lintMode) {
      const csn = compactModel(xsn, options);
      if (command === 'toCsn' && options.toCsn && options.toCsn.withLocalized)
        addLocalizationViews(csn, options);
      if (options.enrichCsn)
        enrichCsn( csn, options );
      writeToFileOrDisplay(options.out, `${name}.json`, csn, true);
    }
  }

  /**
   * @param {CSN.Model} csn
   * @param {string} name
   * @param {CSN.Options} options
   */
  function displayNamedCsn(csn, name, options) {
    if (!csn) // only print CSN if it is set.
      return;
    if (options.internalMsg) {
      writeToFileOrDisplay(options.out, `${name}_raw.txt`, options.messages, true);
    }
    else if (!options.lintMode && !options.internalMsg) {
      if (command === 'toCsn' && options.toCsn && options.toCsn.withLocalized)
        addLocalizationViews(csn, options);
      writeToFileOrDisplay(options.out, `${name}.json`, csn, true);
    }
  }

  // Write the result 'content' to a file 'filename' in directory 'dir', except if 'dir' is '-'.
  // In that case, display 'content' to stdout.
  // If 'content' is not a string, JSON-stringify it
  // If displaying to stdout, prepend a headline containing 'filename', unless 'omitHeadline' is set.
  // For filenames, illegal characters (slash, backslash, colon) are replaced by '_'.
  function writeToFileOrDisplay(dir, fileName, content, omitHeadline = false) {
    if (options.lintMode && !options.rawOutput || options.internalMsg)
      return;
    fileName = fileName.replace(/[:/\\]/g, '_');

    // replace all dots with underscore to get deployable .hdbcds sources (except the one before the file extension)
    if (options.transformation === 'hdbcds')
      fileName = fileName.replace(/\.(?=.*?\.)/g, '_');

    if (!(content instanceof String || typeof content === 'string'))
      content = JSON.stringify(content, null, 2);

    if (dir === '-') {
      if (!omitHeadline)
        process.stdout.write(`// ------------------- ${fileName} -------------------\n`);

      process.stdout.write(`${content}\n`);
      if (!omitHeadline)
        process.stdout.write('\n');
    }
    else {
      // TODO: We might consider using async file-system API ...
      fs.writeFileSync(path.join(dir, fileName), content);
    }
  }

  function catchErrors(err) {
    if (err instanceof Error && err.hasBeenReported)
      return;
    console.error( '' );
    console.error( 'INTERNAL ERROR: %s', err );
    console.error( util.inspect(err, false, null) );
    console.error( '' );
    process.exitCode = 70;
  }
}
