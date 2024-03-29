// Main XSN-based compiler functions

'use strict';

const { resolveModule, resolveModuleSync } = require('../utils/moduleResolve');
const parseLanguage = require('../language/antlrParser');
const parseCsn = require('../json/from-csn');

const assertConsistency = require('./assert-consistency');
const moduleLayers = require('./moduleLayers');
const { define } = require('./definer');
const resolve = require('./resolver');
const propagator = require('./propagator');
const check = require('./checks');


const { emptyWeakLocation } = require('../base/location');
const { createMessageFunctions, deduplicateMessages } = require('../base/messages');
const { promiseAllDoNotRejectImmediately } = require('../base/node-helpers');
const { cdsFs } = require('../utils/file');

const fs = require('fs');
const path = require('path');


// Class for command invocation errors.  Additional members:
//  `errors`: vector of errors (file IO or ArgumentError)
class InvocationError extends Error {
  constructor( errs, ...args ) {
    super(...args);
    this.errors = errs;
    this.hasBeenReported = false;
  }
}

// Class for argument errors.  Additional members:
//  `argument`: the command argument (repeated file names)
class ArgumentError extends Error {
  constructor( arg, ...args ) {
    super(...args);
    this.argument = arg;
  }
}

/**
 * Parse the given source with the correct parser based on the file name's
 * extension. For example use edm2csn for `.xml` files and the CDL parser
 * for `.cds` files.
 *
 * @param {string} source Source code of the file.
 * @param {string} filename Filename including its extension, e.g. "file.cds"
 * @param {object} options Compile options
 * @param {object} messageFunctions If not provided, parse errors will not lead to an exception
 */
function parseX( source, filename, options = {}, messageFunctions ) {
  if (!messageFunctions)
    messageFunctions = createMessageFunctions( options, 'parse' );
  const ext = path.extname( filename ).toLowerCase();
  if ([ '.json', '.csn' ].includes(ext) || options.fallbackParser === 'csn!')
    return parseCsn.parse( source, filename, options, messageFunctions );
  if ([ '.cds', '.hdbcds', '.hdbdd', '.cdl' ].includes(ext))
    return parseLanguage( source, filename, options, messageFunctions );
  if (options.fallbackParser === 'csn')
    return parseCsn.parse( source, filename, options, messageFunctions );
  if (options.fallbackParser)   // any other value: like 'cdl' (historic reasons)
    return parseLanguage( source, filename, options, messageFunctions );

  const model = { location: { file: filename } };
  messageFunctions.error( 'file-unknown-ext', emptyWeakLocation(filename),
                          { file: ext && ext.slice(1), '#': !ext && 'none' }, {
                            std: 'Unknown file extension $(FILE)',
                            none: 'No file extension',
                          } );
  return model;
}

// Main function: Compile the sources from the files given by the array of
// `filenames`.  As usual with the `fs` library, relative file names are
// relative to the working directory `process.cwd()`.  With argument `dir`, the
// file names are relative to `process.cwd()+dir`.  Options can have the
// following properties:
//  - Truthy `parseOnly`: stop compilation after parsing.
//  - Truthy `lintMode`: do not do checks and propagation
//  - many others - TODO

// This function returns a Promise and can be used with `await`.  For an example
// see `examples/api-usage/`.
// See function `compileSyncX` or `compileSourcesX` for alternative compile
// functions.
//
// The promise is fulfilled if all files could be read and processed without
// errors.  The fulfillment value is an augmented CSN (see
// ./compiler/definer.js).
//
// If there are errors, the promise is rejected.  If there was an invocation
// error (repeated filenames or if the file could not be read), the rejection
// value is an InvocationError.  Otherwise, the rejection value is a
// CompilationError containing a vector of individual errors.
//
// `fileCache` is a dictionary of absolute file names to the file content
//  - false: the file does not exist
//  - true: file exists (fstat), no further knowledge yet - i.e. value will change!
//  - 'string' or instanceof Buffer: the file content
//  - { realname: fs.realpath(filename) }: if filename is not canonicalized
//
function compileX( filenames, dir = '', options = {}, fileCache = Object.create(null) ) {
  // A non-proper dictionary (i.e. with prototype) is safe if the keys are
  // absolute file names - they start with `/` or `\` or similar
  // if (Object.getPrototypeOf( fileCache ))
  //   fileCache = Object.assign( Object.create(null), fileCache );
  dir = path.resolve(dir);
  const a = processFilenames( filenames, dir );
  a.fileContentDict = Object.create(null);

  const model = { sources: a.sources, options };
  model.$messageFunctions = createMessageFunctions( options, 'compile', model );
  let all = promiseAllDoNotRejectImmediately( a.files.map(readAndParse) );

  all = all
    .then( testInvocation, (reason) => {
      // do not reject with PromiseAllError, use InvocationError:
      const errs = reason.valuesOrErrors.filter( e => e instanceof Error );
      // internal error if no file IO error (has property `path`)
      return Promise.reject( errs.find( e => !e.path ) ||
                             new InvocationError( [ ...a.repeated, ...errs ]) );
    });
  if (!options.parseOnly && !options.parseCdl)
    all = all.then( readDependencies );
  return all.then( () => {
    moduleLayers.setLayers( a.sources );
    return compileDoX( model );
  });

  // Read file `filename` and parse its content, return messages
  function readAndParse( filename ) {
    if ( filename === false )   // module which has not been found
      return [];
    const rel = a.sources[filename] || path.relative( dir, filename );
    if (typeof rel === 'object') // already parsed
      return [];                 // no further dependency processing
    // no parallel readAndParse with same resolved filename should read the file,
    // also ensure deterministic sequence in a.sources:
    a.sources[filename] = { location: { file: rel } };

    return new Promise( (fulfill, reject) => {
      cdsFs( fileCache, options.traceFs ).readFile( filename, 'utf8', (err, source) => {
        if (err) {
          reject(err);
        }
        else {
          try {
            a.fileContentDict[filename] = source;
            const ast = parseX( source, rel, options, model.$messageFunctions );
            a.sources[filename] = ast;
            ast.location = { file: rel };
            ast.dirname = path.dirname( filename );
            assertConsistency( ast, options );
            fulfill( ast );
          }
          catch (e) {
            reject( e );
          }
        }
      });
    });
  }

  // Combine the parse results (if there are not file IO errors)
  function testInvocation( values ) {
    if (a.repeated.length)
      // repeated file names in invocation => just report these
      return Promise.reject( new InvocationError(a.repeated) );
    return values;
  }

  function readDependencies( astArray ) {
    const promises = [];
    for (const ast of astArray) {
      // console.log( 'READ-DEP:',ast.filename, ast.dependencies && ast.dependencies.length )
      if (!ast.dependencies || !ast.dependencies.length)
        continue;
      const dependencies = Object.create( null );
      for (const d of ast.dependencies) {
        const module = d.val;
        const dep = dependencies[module];
        if (dep)
          dep.usingFroms.push( d );
        else
          dependencies[module] = { module, basedir: ast.dirname, usingFroms: [ d ] };
      }
      // create promises after all usingFroms have been collected, as the
      // Promise executor is called immediately with `new`:
      for (const module in dependencies) {
        promises.push( resolveModule( dependencies[module], fileCache, options,
                                      model.$messageFunctions ) );
      }
    }
    if (!promises.length)
      return [];
    // read files (important part: adding filename to a.sources) after having
    // resolved the module names to ensure deterministic sequence in a.sources
    return Promise.all( promises )
      .then( fileNames => Promise.all( fileNames.map( readAndParse ) ) )
      .then( readDependencies );
  }
}

/**
 * Synchronous version of function `compile`
 *  - an invocation error ends the compilation immediately.
 *
 * @param {string[]} filenames Files to compile.
 * @param {string} [dir=""] Base directory. All files are resolved relatively
 *                          to this directory
 * @param {object} [options={}] Compilation options.
 * @returns {XSN.Model} Augmented CSN
 */
function compileSyncX( filenames, dir = '', options = {}, fileCache = Object.create(null) ) {
  // A non-proper dictionary (i.e. with prototype) is safe if the keys are
  // absolute file names - they start with `/` or `\` or similar
  dir = path.resolve(dir);
  const a = processFilenames( filenames, dir );
  a.fileContentDict = Object.create(null);

  const model = { sources: a.sources, options };
  model.$messageFunctions = createMessageFunctions( options, 'compile', model );

  let asts = [];
  const errors = [];
  a.files.forEach( val => readAndParseSync( val, (err, ast) => {
    if (err)
      errors.push(err);
    if (ast)
      asts.push(ast);
  }));

  if (errors.length || a.repeated.length) {
    // internal error if no file IO error (has property `path`)
    const internalError = errors.find( e => !e.path );
    throw internalError || new InvocationError( [ ...a.repeated, ...errors ] );
  }

  if (!options.parseOnly && !options.parseCdl) {
    while (asts.length) {
      const fileNames = readDependenciesSync( asts );
      asts = [];
      // TODO: check the following eslint error
      // eslint-disable-next-line no-loop-func
      fileNames.forEach( (fileName) => {
        readAndParseSync(fileName, ( err, ast ) => {
          if (err)
            throw err;
          if (ast)
            asts.push( ast );
        });
      } );
    }
  }

  moduleLayers.setLayers( a.sources );
  return compileDoX( model );

  // Read file `filename` and parse its content, return messages
  function readAndParseSync( filename, cb ) {
    if ( filename === false ) {   // module which has not been found
      cb(null, null);
      return;
    }
    const rel = a.sources[filename] || path.relative( dir, filename );
    if (typeof rel === 'object') { // already parsed
      cb(null, null);
      return;                 // no further dependency processing
    }
    // no parallel readAndParse with same resolved filename should read the file,
    // also ensure deterministic sequence in a.sources:
    a.sources[filename] = { location: { file: rel } };

    cdsFs( fileCache, options.traceFs ).readFileSync( filename, 'utf8', (err, source) => {
      if (err) {
        cb(err, null);
      }
      else {
        try {
          a.fileContentDict[filename] = source;
          const ast = parseX( source, rel, options, model.$messageFunctions );
          a.sources[filename] = ast;
          ast.location = { file: rel };
          ast.dirname = path.dirname( filename );
          assertConsistency( ast, options );
          cb( null, ast );
        }
        catch (e) {
          cb(e, null);
        }
      }
    });
  }

  function readDependenciesSync( astArray ) {
    const fileNames = [];
    for (const ast of astArray) {
      // console.log( 'READ-DEP:',ast.filename, ast.dependencies && ast.dependencies.length )
      if (!ast.dependencies || !ast.dependencies.length)
        continue;
      const dependencies = Object.create( null );
      for (const d of ast.dependencies) {
        const module = d.val;
        const dep = dependencies[module];
        if (dep)
          dep.usingFroms.push( d );
        else
          dependencies[module] = { module, basedir: ast.dirname, usingFroms: [ d ] };
      }
      // create promises after all usingFroms have been collected, as the
      // Promise executor is called immediately with `new`:
      for (const module in dependencies) {
        fileNames.push( resolveModuleSync( dependencies[module], fileCache, options,
                                           model.$messageFunctions ) );
      }
    }
    if (!fileNames.length)
      return [];
    // read files (important part: adding filename to a.sources) after having
    // resolved the module names to ensure deterministic sequence in a.sources
    return fileNames;
  }
}

/**
 * Promise-less main functions: compile the given sources.
 *
 * Argument `sourcesDict` is a dictionary (it could actually be a ordinary object)
 * mapping filenames to either source texts (string) or XSN objects (AST-like
 * augmented CSNs).  It could also be a simple string, which is then considered
 * to be the source text of a file named `<stdin>.cds`.
 *
 * See function `compileX` for the meaning of the argument `options`.  If there
 * are parse or other compilation errors, throw an exception CompilationError
 * containing a vector of individual errors.
 *
 * TODO: re-check `using from` dependencies.
 *
 * @param {string|object} sourcesDict Files to compile.
 * @param {object} [options={}] Compilation options.
 * @returns {XSN.Model} Augmented CSN
 */
function compileSourcesX( sourcesDict, options = {} ) {
  if (typeof sourcesDict === 'string')
    sourcesDict = { '<stdin>.cds': sourcesDict };
  const sources = Object.create(null);
  const model = { sources, options };
  model.$messageFunctions = createMessageFunctions( options, 'compile', model );

  for (const filename in sourcesDict) {
    const source = sourcesDict[filename];
    if (typeof source === 'string') {
      const ast = parseX( source, filename, options, model.$messageFunctions );
      sources[filename] = ast;
      ast.location = { file: filename };
      assertConsistency( ast, options );
    }
    else {                      // source is a XSN object (CSN/CDL parser output)
      sources[filename] = source;
    }
  }
  moduleLayers.setLayers( sources );

  return compileDoX( model );
}

/**
 * Recompile the given CSN
 *
 * @param {object} csn Input CSN to recompile to XSN
 * @param {object} options Options
 * @returns {object} XSN
 *
 * TODO: probaby issue message api-recompiled-csn there.
 */
function recompileX( csn, options ) {
  options = { ...options, parseCdl: false, $recompile: true };
  // TODO: $recompile: true should be enough
  // Explicitly set parseCdl to false because backends cannot handle it
  // Explicitly delete all toCsn options:
  delete options.toCsn;

  const file = csn.$location && csn.$location.file &&
    csn.$location.file.replace(/[.]cds$/, '.cds.csn') || '<recompile>.csn';

  const sources = Object.create(null);
  const model = { sources, options };
  model.$messageFunctions = createMessageFunctions( options, 'compile', model );
  // TODO: or use module which invokes the recompilation?

  sources[file] = parseCsn.augment( csn, file, options, model.$messageFunctions );
  moduleLayers.setLayers( sources );
  const compiled = compileDoX( model ); // calls throwWithError()
  if (options.messages)         // does not help with exception in compileDoX()
    deduplicateMessages(options.messages); // TODO: do better
  return compiled;
}

/**
 * On the given model (AST like CSN) run the definer, resolver as well as semantic checks.
 * Creates an augmented CSN (XSN) and returns it.
 *
 * @param {object} model AST like CSN generated e.g. by `parseLanguage()`
 * @returns {XSN.Model} Augmented CSN (XSN)
 */
function compileDoX( model ) {
  const { options } = model;
  const { throwWithError } = model.$messageFunctions;
  if (!options.testMode)
    model.meta = {}; // provide initial central meta object
  if (options.parseOnly) {
    throwWithError();
    return model;
  }
  define( model );
  // do not run the resolver in parse-cdl mode or we get duplicate annotations, etc.
  // TODO: do not use this function for parseCdl anyway…
  if (options.parseCdl) {
    throwWithError();
    return model;
  }
  resolve( model );
  assertConsistency( model );
  throwWithError();
  if (options.lintMode)
    return model;

  check(model);
  throwWithError();
  return propagator.propagate( model );
}

// Process an array of `filenames`.  Returns an object with properties:
//  - `sources`: dictionary which has a filename as key (value is irrelevant)
//  - `files`: the argument array without repeating the same name
//  - `repeated`: array of filenames which have been repeatedly listed
//    (listed only once here even if listed thrice)
//
// Note: there is nothing file-specific about the filenames, the filenames are
// not normalized - any strings work
function processFilenames( filenames, dir ) {
  const sources = Object.create(null); // not {} = no [[Prototype]]
  const files = [];
  const repeated = [];

  for (const originalName of filenames) {
    let name = path.resolve(dir, originalName);

    try {
      // Resolve possible symbolic link; if the file does not exist
      // we just continue using the original name because readFile()
      // already handles non-existent files.
      name = fs.realpathSync(name);
    }
    catch (e) {
      // Ignore the not-found (ENOENT) error
    }

    if (!sources[name]) {
      sources[name] = path.relative( dir, name );
      files.push(name);
    }
    else if (typeof sources[name] === 'string') { // not specified more than twice
      const msg = `Repeated argument: file '${ sources[name] }'`;
      repeated.push( new ArgumentError( name, msg ) );
    }
  }
  return { sources, files, repeated };
}


module.exports = {
  parseX,
  compileX,
  compileSyncX,
  compileSourcesX,
  recompileX,
  InvocationError,    // TODO: make it no error if same file name is provided twice
};
