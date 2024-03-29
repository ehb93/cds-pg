// Custom resolve functionality for the CDS compiler
//
// See `internalDoc/ModuleResolution.md` for details on the algorithm.
// The algorithm is based on NodeJS's `require()`.

'use strict';

const path = require('path');

const { cdsFs } = require('./file');

const DEFAULT_ENCODING = 'utf-8';

/**
 * Default lookup-extensions.  If a module "./index" is requested, then
 * "./index.cds" is checked first, then "index.csn" and so on.
 */
const extensions = [ '.cds', '.csn', '.json' ];

/**
 * A global cds.home configuration can be set that forces the cds-compiler to
 * use a certain directory for all @sap/cds/ includes.
 * This function handles such module paths.
 *
 * @todo Re-think:
 *   - Why can't a JAVA installation set a (symbolic) link?
 *   - Preferred to a local installation? Not the node-way!
 *   - Why a global?  The Umbrella could pass it as an option.
 *
 * @param {string} modulePath
 * @returns {string}
 */
function adaptCdsModule(modulePath) {
  // eslint-disable-next-line
  if (global['cds'] && global['cds'].home && modulePath.startsWith( '@sap/cds/' ))
    // eslint-disable-next-line
    return global['cds'].home + modulePath.slice(8)
  return modulePath;
}

/**
 * @param {object} dep
 * @param {object} fileCache
 * @param {CSN.Options} options
 */
function resolveModule( dep, fileCache, options, messageFunctions ) {
  const _fs = cdsFs(fileCache, options.traceFs);
  // let opts = { extensions, basedir: dep.basedir, preserveSymlinks: false };
  // `preserveSymlinks` option does not really work -> provide workaround anyway...
  // Hm, the resolve package also does not follow the node recommendation:
  // "Using fs.stat() to check for the existence of a file before calling
  // fs.open(), fs.readFile() or fs.writeFile() is not recommended"
  const opts = {
    extensions,
    basedir: dep.basedir,
    isFile: _fs.isFile,
    readFile: _fs.readFile,
    realpath: _fs.realpath,
  };
  return new Promise( (fulfill, reject) => {
    const lookupPath = adaptCdsModule(dep.module);
    resolveCDS( lookupPath, opts, (err, res) => {
      // console.log('RESOLVE', dep, res, err)
      if (err) {
        reject(err);
      }
      else {
        const body = fileCache[res];
        if (body === undefined || body === true) { // use fs if no or just temp entry
          dep.absname = res;
          _fs.realpath( res, cb );
        }
        else if (body && typeof body === 'object' && body.realname) {
          // dep.absname = body.realname;
          cb( null, body.realname ); // use fs.realpath name
        }
        else {
          // dep.absname = res;
          cb( null, res );
        }
      }
    });

    function cb( err, res ) {
      if (err) {
        reject(err);
      }
      else {
        if (dep.absname)
          fileCache[dep.absname] = (dep.absname === res) || { realname: res };
        dep.resolved = res;   // store in dep that module resolve was successful
        for (const from of dep.usingFroms)
          from.realname = res;
        fulfill(res);
      }
    }
  }).catch( () => {
    _errorFileNotFound(dep, options, messageFunctions);
    return false;
  });
}


/**
 * @param {object} dep
 * @param {object} fileCache
 * @param {CSN.Options} options
 */
function resolveModuleSync( dep, fileCache, options, messageFunctions ) {
  const _fs = cdsFs(fileCache, options.traceFs);
  const opts = {
    extensions,
    basedir: dep.basedir,
    isFile: _fs.isFileSync,
    readFile: _fs.readFileSync,
    realpath: _fs.realpathSync,
  };

  let result = null;
  let error = null;
  const lookupPath = adaptCdsModule(dep.module);

  resolveCDS( lookupPath, opts, (err, res) => {
    if (err)
      error = err;
    if (res)
      result = res;
  });

  if (error) {
    _errorFileNotFound(dep, options, messageFunctions);
    return false;
  }

  const body = result ? fileCache[result] : undefined;
  if (body === undefined || body === true) { // use fs if no or just temp entry
    dep.absname = result;
    _fs.realpathSync( result, (err, modulePath) => {
      if (err)
        error = err;
      else
        result = modulePath;
    });
  }
  else if (body && typeof body === 'object' && body.realname) {
    result = body.realname;
  }

  if (error) {
    _errorFileNotFound(dep, options, messageFunctions);
    return false;
  }

  if (dep.absname)
    fileCache[dep.absname] = (dep.absname === result) || { realname: result };
  dep.resolved = result;   // store in dep that module resolve was successful
  for (const from of dep.usingFroms)
    from.realname = result;

  return result;
}

function _errorFileNotFound(dep, options, { error }) {
  if (dep.resolved) {
    let resolved = path.relative( dep.basedir, dep.resolved );
    if (options.testMode)
      resolved = resolved.replace( /\\/g, '/' );
    for (const from of dep.usingFroms) {
      error( 'file-not-readable', from.location, { file: resolved },
             'Cannot read file $(FILE)' );
    }
  }
  else if (isLocalFile( dep.module ) ) {
    for (const from of dep.usingFroms) {
      error( 'file-unknown-local', from.location, { file: dep.module },
             'Cannot find local module $(FILE)' );
    }
  }
  else {
    const internal = /[\\/]/.test( dep.module ) && 'internal';
    for (const from of dep.usingFroms) {
      error( 'file-unknown-package', from.location,
             { file: dep.module, '#': internal }, {
               std: 'Cannot find package $(FILE)',
               internal: 'Cannot find package module $(FILE)',
             } );
    }
  }
}

/**
 * Resolve the given path according to NodeJS's rules for `require()`.
 *
 * We use the interface of the NodeJS package `resolve` for compatibility
 * with existing code.  This may change at a later point.
 *
 * @param {string} moduleName Module to load, e.g. `./Include.cds` or `@sap/cds/common`.
 * @param {ResolveOptions} options
 * @param {(err, result) => void} callback
 */
function resolveCDS(moduleName, options, callback) {
  const isWindows = (process.platform === 'win32');
  let resolvedBaseDir = path.resolve(options.basedir);

  // NodeJS does not preserve symbolic links when resolving modules.
  // So neither do we.
  options.realpath(resolvedBaseDir, (realPathErr, realPath) => {
    // There may be an error in resolving the symlink.
    // We ignore the error and simply use the original path.
    // Otherwise cds-lsp tests would fail because they don't have real
    // files in their tests.
    if (!realPathErr)
      resolvedBaseDir = realPath;
    load();
  });

  function load() {
    if (isLocalFile(moduleName))
      loadFromLocalFileOrDirectory();
    else
      loadNodeModules(resolvedBaseDir);
  }

  /**
   * The module is local and not a in a node_module directory.
   * Try to load it as a file or directory.
   */
  function loadFromLocalFileOrDirectory() {
    // Also handles absolute file paths.
    const withBase = path.resolve(resolvedBaseDir, moduleName);
    // If the local moduleName ends with a slash (or references the sub-directory)
    // it is a good indicator that we want to load a directory and we save some
    // file lookups.  Slashes cannot be used in filenames (both *nix and Windows).
    // Shortcut to 2b)
    if (moduleName === '..' || moduleName.endsWith('/'))
      loadAsDirectory(withBase, callback);
    else
      loadAsLocalFileOrDirectory(withBase, callback);
  }

  /**
   * Combines LOAD_AS_FILE() and LOAD_AS_DIRECTORY() from our specification.
   * If no file can be found, it tries to load the moduleName as a directory,
   * i.e. tries to load a `package.json`, etc.
   *
   * @param {string} absoluteModulePath
   * @param {(err, filepath: string|null) => void} cb
   */
  function loadAsLocalFileOrDirectory(absoluteModulePath, cb) {
    loadAsFile(absoluteModulePath, (err, filepath) => {
      if (!err && filepath)
        cb(null, filepath);
      else
        loadAsDirectory(absoluteModulePath, cb);
    });
  }

  /**
   * Try to load the module from absoluteModulePath with different extensions.
   * Instead of the hard-coded extensions, we use the ones supplied by `options.extensions`.
   *
   * @param {string} absoluteModulePath
   * @param {(err, filepath: string|null) => void} cb
   */
  function loadAsFile(absoluteModulePath, cb) {
    const extensionsToTry = [ '' ].concat(options.extensions);
    loadFileWithExtensions(extensionsToTry);

    /**
     * Tries to load `absoluteModulePath` with the given extensions one after another.
     *
     * @param {string[]} exts The extensions to try. Loaded in the order of the array.
     */
    function loadFileWithExtensions(exts) {
      if (exts.length === 0) {
        // If we reach this point then no file with the given extensions could be found.
        cb(makeNotFoundError(), null);
        return;
      }
      const file = absoluteModulePath + exts.shift();
      options.isFile(file, (err, foundAndIsFile) => {
        if (!err && foundAndIsFile)
          cb(null, file);
        else
          loadFileWithExtensions(exts);
      });
    }
  }

  /**
   * Load the module as a directory, i.e. use either the main entry of `package.json`
   * in the directory or an index.ext file.
   *
   * @param {string} absoluteModulePath
   * @param {(err, filepath: string|null) => void} cb
   */
  function loadAsDirectory(absoluteModulePath, cb) {
    loadAndParsePackageJsonInDirectory(absoluteModulePath, (packageErr, packageJson) => {
      const main = packageCdsMain(packageJson);
      if (!packageErr && main)
        loadMain(main);
      else
        loadIndex();
    });

    function loadMain(main) {
      const file = path.join(absoluteModulePath, main);
      loadAsFile(file, (fileErr, filePath) => {
        if (!fileErr && filePath)
          cb(null, filePath);
        else
          loadIndex();
      });
    }

    function loadIndex() {
      const filename = 'index';
      const file = path.join(absoluteModulePath, filename);
      loadAsFile(file, (fileErr, filePath) => {
        if (!fileErr && filePath)
          cb(null, filePath);
        else
          cb(makeNotFoundError(), null);
      });
    }
  }

  /**
   * Try to load the module from a node_modules directory.
   * Start at absoluteDir and go through all parent directories.
   *
   * @param {string} absoluteDir
   */
  function loadNodeModules(absoluteDir) {
    const dirs = nodeModulesPaths(absoluteDir);
    loadFromNodeDirs(dirs);

    function loadFromNodeDirs(nodeDirs) {
      const dir = nodeDirs.shift();
      if (!dir) {
        // We're at root
        callback(makeNotFoundError(), null);
        return;
      }
      const file = path.join(dir, moduleName);
      loadAsLocalFileOrDirectory(file, (err, filepath) => {
        if (!err && filepath)
          callback(null, filepath);
        else
          loadFromNodeDirs(nodeDirs);
      });
    }
  }

  /**
   * Try to load the package.json from the given directory.
   * Is only successful if the file can be read and parsed by JSON.parse().
   *
   * @param {string} packageDir
   * @param {(err, json) => void} cb
   */
  function loadAndParsePackageJsonInDirectory(packageDir, cb) {
    const file = path.join(packageDir, 'package.json');

    options.readFile(file, DEFAULT_ENCODING, (err, content) => {
      if (err) {
        cb(err, null);
        return;
      }
      try {
        const json = JSON.parse(content);
        cb(null, json);
      }
      catch (parseErr) {
        cb(parseErr, null);
      }
    });
  }

  /**
   * Get a list of all `node_modules` directories that MAY exist.
   * Starting from absoluteStart upwards until at root.
   *
   * @param {string} absoluteStart
   * @returns {string[]} Array of possible "node_modules" folders for the given path.
   */
  function nodeModulesPaths(absoluteStart) {
    // Use platform-dependent separator.  All NodeJS `path` methods use the system's path separator.
    const parts = absoluteStart.split(path.sep);
    // Do NOT use global node_modules directories.
    const dirs = [];

    // If we're on *nix systems, the first part is just an empty string ''
    // because the path is absolute.  Re-add it here because `path.join()`
    // ignores empty segments which would result in a relative path.
    if (!isWindows && parts.length > 0 && parts[0] === '')
      parts[0] = '/';

    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i] === 'node_modules')
        continue;
      const dir = path.join(...parts.slice(0, i + 1), 'node_modules');
      dirs.push(dir);
    }
    return dirs;
  }

  /**
   * Create a not found error that can be passed to the caller.
   *
   * @returns {Error}
   */
  function makeNotFoundError() {
    const moduleError = new Error(`Cannot find module '${ moduleName }' from '${ options.basedir }'`);
    // eslint-disable-next-line
    moduleError['code'] = 'MODULE_NOT_FOUND';
    return moduleError;
  }
}

/**
 * Returns true if the given module name is a local file.
 *
 * @param {string} moduleName
 */
function isLocalFile(moduleName) {
  // Starts with or is equal to '..'
  // Starts with '/'
  // Starts with 'C:/' or 'C:\'
  return (/^(\.\.?(\/|$)|\/|(\w:)?[/\\])/).test(moduleName);
}

/**
 * Get the cds.main entry of the package.json
 * @param {object} pkg
 */
function packageCdsMain( pkg ) {
  if (pkg && pkg.cds && typeof pkg.cds.main === 'string')
    return pkg.cds.main;
  return null;
}

/**
 * @typedef {object} ResolveOptions
 * @property {string} basedir
 * @property {string[]} extensions
 * @property {(path: string, callback: (err, foundAndIsFile) => void) => void} isFile
 * @property {(path: string, encoding, callback: (err, content) => void) => void} readFile
 * @property {(path: string, callback: (err, realpath) => void) => void} realpath
 *   used to read `package.json` files.
 */

module.exports = {
  resolveModule,
  resolveModuleSync,
  // exported for unit tests
  resolveCDS,
  isLocalFile,
  extensions,
};
