module.exports = runCommand;

const cp = require('child_process');
const { nullLogger } = require('./logger');
const term = require('../../utils/term');

const IS_DEBUG = process.env.DEBUG;
const TIMEOUT = 2 * 60 * 1000; // 2min

function _removeColorCodes(chunk) {
  // eslint-disable-next-line no-control-regex
  return chunk.replace(/\x1b\[[;\d]*m/g, '');
}

// start kill timer, reset everytime a chunk arrives
function _startTimer(oldTimer, spawnedProcess, timeOut) {
  clearTimeout(oldTimer);

  return setTimeout(() => {
    spawnedProcess.kill();
  }, timeOut);
}

function _getTimeKey(cmd, args = []) {
  return `[cds.deploy] - ${cmd} ${args.join(' ')}`;
}

function _validate(cmd, cmdArgs = []) {
  // validate input
  if (/[|&;]+/g.exec(cmd)) {
    throw new Error(`[cds.deploy] - Command ${cmd} contains at least one bad character (|, &, or ;) which might be used to concatenate commands.`);
  }

  cmdArgs.forEach((arg) => {
    if (/[|&;]+/g.exec(arg)) {
      throw new Error(`[cds.deploy] - Argument ${arg} contains at least one bad character (|, &, or ;) which might be used to concatenate commands.`);
    }
  });
}

function runCommand(cmd, cmdArgs = [], logger = nullLogger, options = {}, timeOut = TIMEOUT) {

  _validate(cmd, cmdArgs);

  return new Promise((resolve, reject) => {

    try {

      if (IS_DEBUG) {
        logger.time(_getTimeKey(cmd, cmdArgs));
      }

      logger.log();
      logger.log(`[cds.deploy] - Running '${term.as(term.codes.bold, cmd + ' ' + cmdArgs.join(' '))}' with options ${JSON.stringify(options)}`);

      const spawnOptions = { ...options, cwd: process.env._TEST_CWD || process.cwd() };
      spawnOptions.env = Object.assign (process.env, {CF_COLOR:logger.isTTY()}, options.env)

      const spawnedProcess = cp.spawn(cmd, cmdArgs, spawnOptions);
      let spawnTimer = _startTimer(null, spawnedProcess, timeOut);

      let stdout = '';
      let stderr = '';

      if (!options.stdio) {
        spawnedProcess.stdout.on('data', (data) => {
          spawnTimer = _startTimer(spawnTimer, spawnedProcess, timeOut);
          const chunk = data.toString();
          stdout = stdout + chunk;
          logger.write(chunk);
        });

        spawnedProcess.stderr.on('data', (data) => {
          spawnTimer = _startTimer(spawnTimer, spawnedProcess, timeOut);
          const chunk = data.toString();
          stderr = stderr + chunk;
          logger.write(chunk);
        });
      }

      spawnedProcess.on('error', (err) => {
        reject(err);
      });

      spawnedProcess.on('close', (code, signal) => {
        clearTimeout(spawnTimer);

        if (IS_DEBUG) {
          logger.timeEnd(_getTimeKey(cmd, cmdArgs));
        }

        if (!signal) {
          // exited normally
          stdout = _removeColorCodes(stdout);
          stderr = _removeColorCodes(stderr);
          resolve({ code, stdout, stderr });
        } else {
          // sigterm if timer kills spawned process
          const spawnError = new Error(`[cds.deploy] - Failed with signal '${signal}' and code ${code}`);
          spawnError.args = cmdArgs;
          spawnError.options = options;
          spawnError.stdout = stdout;
          spawnError.stderr = stderr;
          spawnError.signal = signal;
          reject(spawnError);
        }
      });
    } catch (err) {
      reject(err);
    }

  });
}
