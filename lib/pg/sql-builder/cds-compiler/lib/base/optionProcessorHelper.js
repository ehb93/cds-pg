'use strict'

// Create a command line option processor and define valid commands, options and parameters.
// In order to understand a command line like this:
//   $ node cdsc.js -x 1 --foo toXyz -y --bar-wiz bla arg1 arg2
//
// The following definitions should be made
//
//   const optionProcessor = createOptionProcessor();
//   optionProcessor
//     .help(`General help text`);
//     .option('-x, --x-in-long-form <i>')
//     .option('    --foo')
//   optionProcessor.command('toXyz')
//     .help(`Help text for command "toXyz")
//     .option('-y  --y-in-long-form')
//     .option('    --bar-wiz <w>', ['bla', 'foo'])
//
// Options *must* have a long form, can have at most one <param>, and optionally
// an array of valid param values as strings. Commands and param values must not
// start with '--'. The whole processor and each command may carry a help text.
// To actually parse a command line, use
//   optionProcessor.processCmdLine(process.argv);
// (see below)
function createOptionProcessor() {
  const optionProcessor = {
    commands: {},
    options: {},
    positionalArguments: [],
    optionClashes: [],
    option,
    command,
    positionalArgument,
    help,
    processCmdLine,
    verifyOptions,
    camelOptionsForCommand,
    _parseCommandString,
    _parseOptionString,
  }
  return optionProcessor;

  /**
   * API: Define a general option.
   * @param {string} optString Option string describing the command line option.
   * @param {string[]} [validValues] Array of valid values for the options.
   */
  function option(optString, validValues) {
    return _addOption(optionProcessor, optString, validValues);
  }

  /**
   * API: Define the main help text (header and general options)
   * @param {string} text Help text describing all options, etc.
   */
  function help(text) {
    optionProcessor.helpText = text;
    return optionProcessor;
  }

  /**
   * API: Define a command
   * @param {string} cmdString Command name, e.g. 'S, toSql'
   */
  function command(cmdString) {
    /** @type {object} */
    const command = {
      options: {},
      option,
      help,
      ..._parseCommandString(cmdString)
    };
    if (optionProcessor.commands[command.longName]) {
      throw new Error(`Duplicate assignment for long command ${command.longName}`);
    }
    optionProcessor.commands[command.longName] = command;

    if (command.shortName) {
      if (optionProcessor.commands[command.shortName]) {
        throw new Error(`Duplicate assignment for short command ${command.shortName}`);
      }
      optionProcessor.commands[command.shortName] = command;
    }
    return command;

    // API: Define a command option
    function option(optString, validValues) {
      return _addOption(command, optString, validValues);
    }

    // API: Define the command help text
    function help(text) {
      command.helpText = text;
      return command;
    }
  }

  /**
   * Adds positional arguments to the command line processor. Instructs the processor
   * to either require N positional arguments or a dynamic number (but at least one)
   * @param {string} positionalArgumentDefinition Positional arguments, e.g. '<input> <output>' or '<files...>'
   */
  function positionalArgument(positionalArgumentDefinition) {
    if (optionProcessor.positionalArguments.find((arg) => arg.isDynamic)) {
      throw new Error(`Can't add positional arguments after a dynamic one`);
    }

    const registeredNames = optionProcessor.positionalArguments.map((arg) => arg.name);
    const args = positionalArgumentDefinition.split(' ');

    for (const arg of args) {
      const argName = arg.replace('<', '').replace('>', '').replace('...', '');
      if (registeredNames.includes(argName)) {
        throw new Error(`Duplicate positional argument ${arg}`);
      }
      if (!isParam(arg) && !isDynamicPositionalArgument(arg)) {
        throw new Error(`Unknown positional argument syntax: ${arg}`)
      }

      optionProcessor.positionalArguments.push({
        name: argName,
        isDynamic: isDynamicPositionalArgument(arg),
        required: true
      });

      registeredNames.push(argName);
    }
    return optionProcessor;
  }

  /**
   * Internal: Define a general or command option.
   * Throws if the option is already registered in the given command context.
   * or in the given command.
   * @private
   * @see option()
   */
  function _addOption(command, optString, validValues) {
    const opt = _parseOptionString(optString, validValues);
    if (command.options[opt.longName]) {
      throw new Error(`Duplicate assignment for long option ${opt.longName}`);
    } else if (optionProcessor.options[opt.longName]) {
      // This path is only taken if optString is for commands
      optionProcessor.optionClashes.push({
        option: opt.longName,
        description: `Command '${command.longName}' has option clash with general options for: ${opt.longName}`
      });
    }
    command.options[opt.longName] = opt;
    if (opt.shortName) {
      if (command.options[opt.shortName]) {
        throw new Error(`Duplicate assignment for short option ${opt.shortName}`);
      } else if (optionProcessor.options[opt.shortName]) {
        // This path is only taken if optString is for commands
        optionProcessor.optionClashes.push({
          option: opt.shortName,
          description: `Command '${command.longName}' has option clash with general options for: ${opt.shortName}`
        });
      }
      command.options[opt.shortName] = opt;
    }
    return command;
  }

  // Internal: Parse one command string like "F, toFoo". Return an object like this
  // {
  //   longName: 'toFoo',
  //   shortName: 'F',
  // }
  function _parseCommandString(cmdString) {
    let longName;
    let shortName;

    const tokens = cmdString.trim().split(/, */);
    switch (tokens.length) {
      case 1:
        // Must be "toFoo"
        longName = tokens[0];
        break;
      case 2:
        // Must be "F, toFoo"
        shortName = tokens[0];
        longName = tokens[1];
        break;
      default:
        throw new Error(`Invalid command description: ${cmdString}`);
    }
    return {
      longName,
      shortName,
    }
  }

  // Internal: Parse one option string like "-f, --foo-bar <p>". Returns an object like this
  // {
  //   longName: '--foo-bar',
  //   shortName: '-f',
  //   camelName: 'fooBar',
  //   param: '<p>'
  //   validValues
  // }
  function _parseOptionString(optString, validValues) {
    let longName;
    let shortName;
    let param;
    let camelName;

    // split at spaces (with optional preceding comma)
    const tokens = optString.trim().split(/,? +/);
    switch (tokens.length) {
      case 1:
        // Must be "--foo"
        if (isLongOption(tokens[0])) {
          longName = tokens[0];
        }
        break;
      case 2:
        // Could be "--foo <bar>", or "-f --foo"
        if (isLongOption(tokens[0]) && isParam(tokens[1])) {
          longName = tokens[0];
          param = tokens[1];
        } else if (isShortOption(tokens[0]) && isLongOption(tokens[1])) {
          shortName = tokens[0];
          longName = tokens[1];
        }
        break;
      case 3:
        // Must be "-f --foo <bar>"
        if (isShortOption(tokens[0]) && isLongOption(tokens[1]) && isParam(tokens[2])) {
          shortName = tokens[0];
          longName = tokens[1];
          param = tokens[2];
        }
        break;
      default:
        throw new Error(`Invalid option description, too many tokens: ${optString}`);
    }
    if (!longName) {
      throw new Error(`Invalid option description, missing long name: ${optString}`);
    }
    if (!param && validValues) {
      throw new Error(`Option description has valid values but no param: ${optString}`);
    }
    if (validValues) {
      validValues.forEach((value) => {
        if (typeof value !== 'string')
          throw new Error(`Valid values must be of type string: ${optString}`);
      });
    }
    camelName = _camelify(longName);
    return {
      longName,
      shortName,
      camelName,
      param,
      validValues
    }
  }

  // Return a camelCase name "fooBar" for a long option "--foo-bar"
  function _camelify(opt) {
    return opt.substring(2).replace(/-./g, s => s.substring(1).toUpperCase());
  }

  // Return a long option name like "--foo-bar" for a camel-case name "fooBar"
  function _unCamelify(opt) {
    return `--${opt.replace(/[A-Z]/g, s => '-' + s.toLowerCase())}`;
  }

  // API: Let the option processor digest a command line 'argv'
  // The expectation is to get a commandline like this:
  //       $ node cdsc.js -x 1 --foo toXyz -y --bar-wiz bla arg1 arg2
  // Ignore: ^^^^^^^^^^^^
  // General options: ----^^^^^^^^^^
  // Command: -----------------------^^^^^
  // Command options: ---------------------^^^^^^^^^^^^^^^^
  // Arguments: ------------------------------------------- ^^^^^^^^^
  // Expect everything that starts with '-' to be an option, up to '--'.
  // Be tolerant regarding option placement: General options may also occur
  // after the command (but command options must not occur before the command).
  // Options may also appear after arguments. Report errors and resolve conflicts
  // under the assumption that placement was correct.
  // The return object should look like this:
  // {
  //   command: 'toXyz'
  //   options: {
  //     xInLongForm: 1,
  //     foo: true,
  //     toXyz: {
  //       yInLongForm: true,
  //       barWiz: 'bla',
  //     }
  //   },
  //   unknownOptions: [],
  //   args: {
  //     length: 4,
  //     foo: 'value1',
  //     bar: [ 'value2', 'value3', 'value4' ]
  //   },
  //   cmdErrors: [],
  //   errors: [],
  // }
  function processCmdLine(argv) {
    const result = {
      command: undefined,
      options: { },
      unknownOptions: [],
      args: {
        length: 0
      },
      cmdErrors: [],
      errors: [],
    }

    // Iterate command line
    let seenDashDash = false;
    // 0: "node", 1: filename
    for (let i = 2; i < argv.length; i++) {
      let arg = argv[i];
      // To be compatible with NPM arguments, we need to support `--arg=val` as well.
      if (arg.includes('=')) {
        argv = [ ...argv.slice(0, i), ...arg.split('='), ...argv.slice(i + 1)];
        arg = argv[i];
      }
      if (!seenDashDash && arg.startsWith('-') && arg !== '--') {
        if (result.command) {
          // We already have a command
          const opt = optionProcessor.commands[result.command].options[arg];
          if (opt) {
            // Found as a command option
            i += processOption(i, opt, result.command);
          } else {
            // No command option, try general options as fallback
            const opt = optionProcessor.options[arg];
            if (opt) {
              i += processOption(i, opt, false);
            } else {
              // Not found at all, put into unknownOptions if it is an option
              // for another cdsc command.
              // We dig into the other cdsc commands in order to check if
              // the option expects a parameter and if so to take the next argument as a value
              if (Object.keys(optionProcessor.commands).some(cmd => optionProcessor.commands[cmd].options[arg])) {
                const cmd = optionProcessor.commands[
                  Object.keys(optionProcessor.commands).find(cmd => optionProcessor.commands[cmd].options[arg])
                ];
                i += processOption(i, cmd.options[arg], optionProcessor.commands[result.command], true);
              } else { // still add it to the unknownOptions
                result.unknownOptions.push(`Unknown option "${arg}" for the command "${result.command}"`);
                // if the next argument looks like an argument for this unknown option => skip it
                if ((i + 1) < argv.length && !argv[i + 1].match('(^[.-])|[.](csn|cds|json)$'))
                  i++;
              }
            }
          }
        } else {
          // We don't have a command
          const opt = optionProcessor.options[arg];
          if (opt) {
            // Found as a general option
            i += processOption(i, opt, false);
          } else {
            // Not found, complain
            result.unknownOptions.push(`Unknown option "${arg}"`);
          }
        }
      }
      else if (arg === '--') {
        // No more options after '--'
        seenDashDash = true;
      } else {
        // Command or arg
        if (result.command === undefined) {
          if (optionProcessor.commands[arg]) {
            // Found as command
            result.command = optionProcessor.commands[arg].longName;
            result.options[result.command] = {};
          } else {
            // Not found as command, take as arg and stop looking for commands
            processPositionalArgument(arg);
            result.command = null;
          }
        } else {
          processPositionalArgument(arg);
        }
      }
    }
    // Avoid 'toXyz: {}' for command without options
    if (result.command && Object.keys(result.options[result.command]).length === 0) {
      delete result.options[result.command];
    }

    // Complain about first missing positional arguments
    const missingArg = optionProcessor.positionalArguments.find((arg) => arg.required && !result.args[arg.name]);
    if (missingArg) {
      result.errors.push(`Missing positional argument: <${missingArg.name}${missingArg.isDynamic ? '...' : ''}>`)
    }

    return result;

    function processPositionalArgument(argumentValue) {
      if ( result.args.length === 0 && optionProcessor.positionalArguments.length === 0 )
        return;
      const inBounds = result.args.length < optionProcessor.positionalArguments.length;
      const lastIndex = inBounds ? result.args.length : optionProcessor.positionalArguments.length - 1;
      const nextUnsetArgument = optionProcessor.positionalArguments[lastIndex];
      if (!inBounds && !nextUnsetArgument.isDynamic) {
        result.errors.push(`Too many arguments. Expected ${optionProcessor.positionalArguments.length}`);
        return;
      }
      result.args.length += 1;
      if (nextUnsetArgument.isDynamic) {
        result.args[nextUnsetArgument.name] = result.args[nextUnsetArgument.name] || [];
        result.args[nextUnsetArgument.name].push(argumentValue);
      } else {
        result.args[nextUnsetArgument.name] = argumentValue;
      }
    }

    // (Note that this works on 'argv' and 'result' from above).
    // Process 'argv[i]' as an option.
    // Check the option definition in 'opt' to see if a parameter is expected.
    // If so, take it (complain if one is found in 'argv').
    // Populate 'result.options' with the result. Return the number params found (0 or 1).
    function processOption(i, opt, command, unknownOption = false) {
      // Does this option expect a parameter?
      if (opt.param) {
        if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
          // There should be a param but isn't - complain
          let error = `Missing param "${opt.param}" for option "${opt.shortName ? opt.shortName + ', ': ''}${opt.longName}"`;
          if (command && unknownOption) {
            result.unknownOptions.push(`Unknown option "${argv[i]}" for the command "${command.longName}"`);
          } else if (command) {
            error = `${error} of command "${command}"`;
            result.cmdErrors.push(error);
          } else {
            result.errors.push(error);
          }
          return 0;
        }
        else {
          // Take the option with the parameter
          const value = argv[i + 1];
          const shortOption = opt.shortName ? `${opt.shortName}, ` : ''
          if (command) {
            // if an unknown option for a command => add it to the array and warn about
            if (unknownOption) {
              result.unknownOptions.push(`Unknown option "${argv[i]}" for the command "${command.longName}"`);
            } else {
              result.options[command][opt.camelName] = value;
              if (opt.validValues && !opt.validValues.includes(value)) {
                result.cmdErrors.push(`Invalid value "${value}" for option "${shortOption}${opt.longName}" - use one of [${opt.validValues}]`);
              }
            }
          } else {
            result.options[opt.camelName] = value;
            if (opt.validValues && !opt.validValues.includes(value)) {
              result.errors.push(`Invalid value "${value}" for option "${shortOption}${opt.longName}" - use one of [${opt.validValues}]`);
            }
          }
          return 1;
        }
      }
      // No parameter, take option as bool
      if (command) {
        unknownOption
          ? result.unknownOptions.push(`Unknown option "${argv[i]}" for the command "${command.longName}"`)
          : result.options[command][opt.camelName] = true;
      } else {
        result.options[opt.camelName] = true;
      }
      return 0;
    }
  }

  // Assuming that 'options' came from this option processor, verify options therein.
  // If 'command' is supplied, check only 'options.command', otherwise check
  // only top-level options
  // Return an array of complaints (possibly empty)
  function verifyOptions(options, command = undefined, silent = false) {
    const result = [];
    let opts;

    if((options.betaMode || options.beta) && !options.testMode && !silent) {
      const mode = options.beta ? 'beta' : 'beta-mode';
      result.push(`Option --${mode} was used. This option should not be used in productive scenarios!`)
    }

    if(options) {
      ['defaultStringLength', /*'length', 'precision', 'scale'*/].forEach(facet => {
        if(options[facet] && isNaN(options[facet])) {
          result.push(`Invalid value "${options[facet]}" for option "--${facet}" - not an Integer`);
        } else {
          options[facet] = parseInt(options[facet]);
        }
      });
    }

    if (command) {
      const cmd = optionProcessor.commands[command];
      if (!cmd) {
        throw new Error(`Expected existing command: "${command}"`);
      }
      opts = cmd.options;
      options = options[command] || {};
      if (typeof options === 'boolean') {
        // Special case: command without options
        options = {};
      }
    } else {
      opts = optionProcessor.options;
    }
    // Look at each supplied option
    for (const camelName in options) {
      const opt = opts[_unCamelify(camelName)];
      let error;
      if (!opt) {
        // Don't report commands in top-level options
        if ((command || !optionProcessor.commands[camelName]) && !silent) {
          error = `Unknown option "${command ? command + '.' : ''}${camelName}"`;
        }
      } else {
        const param = options[camelName];
        error = verifyOptionParam(param, opt, command ? command + '.' : '');
      }
      if (error) {
        result.push(error);
      }
    }
    // hard-coded option dependencies (they disappear with command)
    return result;

    // Verify parameter value 'param' against option definition 'opt'. Return an error
    // string or false for an accepted param. Use 'prefix' when mentioning the option name.
    function verifyOptionParam(param, opt, prefix) {
      if (opt.param) {
        // Parameter is required for this option
        if (typeof param === 'boolean') {
          return `Missing value for option "${prefix}${opt.camelName}"`;
        } else if (opt.validValues && !opt.validValues.includes(String(param))) {
          return `Invalid value "${param}" for option "${prefix}${opt.camelName}" - use one of [${opt.validValues}]`;
        }
        return false;
      } else {
        // Option does not expect a parameter
        if (typeof param !== 'boolean') {
          // FIXME: Might be a bit too strict in case of internal sub-options like 'forHana' etc...
          return `Expecting boolean value for option "${prefix}${opt.camelName}"`;
        }
      }
      return false;
    }
  }

  // Return an array of unique camelNames of the options for the specified command
  // If invalid command -> an empty array
  function camelOptionsForCommand(command) {
    if (command && optionProcessor.commands[command]) {
      const cmd = optionProcessor.commands[command];
      return [... new Set(
        Object.keys(cmd.options).map(optName => cmd.options[optName].camelName)
      )];
    } else {
      return [];
    }
  }
}

// Check if 'opt' looks like a "-f" short option
function isShortOption(opt) {
  return /^-[a-zA-Z?]$/.test(opt);
}

// Check if 'opt' looks like a "--foo-bar" long option
function isLongOption(opt) {
  return /^--[a-zA-Z0-9-]+$/.test(opt);
}

// Check if 'opt' looks like a "<foobar>" parameter
function isParam(opt) {
  return /^<[a-zA-Z]+>$/.test(opt);
}

// Check if 'arg' looks like "<foobar...>"
function isDynamicPositionalArgument(arg) {
  return /^<[a-zA-Z]+[.]{3}>$/.test(arg);
}

module.exports = {
  createOptionProcessor,
  isShortOption,
  isLongOption,
  isParam,
  isDynamicPositionalArgument
};
