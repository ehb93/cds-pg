// Util functions for operations usually used with files.

'use strict';

const fs = require('fs');

/**
 * Split the given source string into its lines.  Respects Unix,
 * Windows und Macintosh line breaks.
 *
 * @param {string} src
 * @returns {string[]}
 */
function splitLines(src) {
  return src.split(/\r\n?|\n/);
}

/**
 * Returns filesystem utils readFile(), isFile(), realpath() for _CDS_ usage.
 * This includes a trace as well as usage of a file cache.
 *
 * Note: The synchronous versions accept a callback as well, which is executed
 *       immediately! This is different from NodeJS's readFileSync()!
 *       This is done to allow using it in places where fs.readFile (async) is used.
 *
 * @param {object} fileCache
 * @param {boolean} enableTrace
 */
function cdsFs(fileCache, enableTrace) {
  const readFile = _wrapReadFileCached(fs.readFile);
  const readFileSync = _wrapReadFileCached((filename, enc, cb) => {
    try {
      cb(null, fs.readFileSync( filename, enc ));
    }
    catch (err) {
      cb(err, null);
    }
  });
  const isFile = _wrapIsFileCached(fs.stat);
  const isFileSync = _wrapIsFileCached(( filename, cb) => {
    try {
      cb(null, fs.statSync( filename ));
    }
    catch (err) {
      cb( err, null );
    }
  });

  return {
    readFile,
    readFileSync,
    isFile,
    isFileSync,
    realpath,
    realpathSync,
  };

  function realpath(path, cb) {
    return fs.realpath(path, cb);
  }

  function realpathSync(path, cb) {
    try {
      cb(null, fs.realpathSync(path));
    }
    catch (err) {
      cb(err, null);
    }
  }

  /**
   * Wraps the given reader into a cached environment including a trace.
   * The given @p reader must have the same signature as fs.readFile.
   *
   * @param {(filename: string, enc: string, cb: (err, data) => void) => void} reader
   */
  function _wrapReadFileCached( reader ) {
    return (filename, enc, cb) => {
      if (typeof enc === 'function') { // moduleResolve uses old-style API
        cb = enc;
        enc = null;
      }
      let body = fileCache[filename];
      if (body && typeof body === 'object' && body.realname) {
        filename = body.realname; // use fs.realpath name
        body = fileCache[filename];
      }
      if (body !== undefined && body !== true) { // true: we just know it is there
        if (body === false) {
          body = new Error( `ENOENT: no such file or directory, open '${ filename }'`);
          body.code = 'ENOENT';
          body.errno = -2;
          body.syscall = 'open';
          body.path = filename;
        }
        if (body instanceof Error) {
          traceFS( 'READFILE:cache-error:', filename, body.message );
          cb( body );   // no need for process.nextTick( cb, body ) with moduleResolve
        }
        else {
          traceFS( 'READFILE:cache:', filename, body );
          cb( null, body );
        }
      }
      else {
        traceFS( 'READFILE:start:', filename );
        // TODO: set cache directly to some "delay" - store error differently?
        // e.g. an error of callback functions!
        reader(filename, enc, ( err, data ) => {
          fileCache[filename] = err || data;
          traceFS( 'READFILE:data:', filename, err || data );
          cb( err, data );
        });
      }
    };
  }

  /**
   * Wraps the given fsStat into a cached environment including a trace.
   * The given @p fsStat must have the same signature as fs.stat.
   *
   * @param {(filename: string, cb: (err, data) => void) => void} fsStat
   */
  function _wrapIsFileCached(fsStat) {
    return ( filename, cb ) => {
      let body = fileCache[filename];
      if (body !== undefined) {
        traceFS( 'ISFILE:cache:', filename, body );
        if (body instanceof Error)
          cb( body );   // no need for process.nextTick( cb, body ) with moduleResolve
        else
          cb( null, !!body );
      }
      else {
        traceFS( 'ISFILE:start:', filename, body );
        // in the future (if we do module resolve ourself with just readFile),
        // we avoid parallel readFile by storing having an array of `cb`s in
        // fileCache[ filename ] before starting fs.readFile().
        fsStat( filename, ( err, stat ) => {
          if (err)
            body = (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? false : err;
          else
            body = !!(stat.isFile() || stat.isFIFO());
          if (fileCache[filename] === undefined) // parallel readFile() has been processed
            fileCache[filename] = body;
          traceFS( 'ISFILE:data:', filename, body );
          if (body instanceof Error)
            cb( err );
          else
            cb( null, body );
        });
      }
    };
  }

  function traceFS( intro, filename, data ) {
    if (!enableTrace)
      return;

    if (typeof data === 'string' || data instanceof Buffer)
      data = typeof data;
    else if (data === undefined)
      data = '?';
    else
      data = `${ data }`;

    // eslint-disable-next-line no-console
    console.log( intro, filename, data);
  }
}

module.exports = {
  splitLines,
  cdsFs,
};
