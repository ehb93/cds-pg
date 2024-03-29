// csn version functions


// The CSN file format version produced by this compiler
// (Note that all 0.x.x versions are floating targets, i.e. the format is frequently
// changed without notice. The versions only signal certain combinations of "flavors", see below)
// (Note: the SQL name mapping mode is not reflected in the content of the csn, the version only
// signals which default name mapping a backend has to use)
// Historic versions:
//  0.0.1  : Used by HANA CDS for its CSN output (incomplete, not well defined, quite different from CDX ...)
//  0.0.2  : CDX in the initial versions with old-style CSN, default for SQL name mapping is 'quoted'
//  0.0.99 : Like 0.0.2, but with new-style CSN
// Versions that are currently produced by compiler:
//  0.1.0  : Like 0.0.2, default for SQL name mapping is 'plain'
//  0.1.99 : Like 0.1.0, but with new-style CSN
//  0.2 : same as 0.1.99, but with new top-level properties: $version, meta

// Use literal version constants intentionally and not number intervals to 
// record all published version strings of the core compiler.
const newCSNVersions = ["0.1.99","0.2","0.2.0","1.0","2.0"];
// checks if new-csn is requested via the options of already specified in the CSN
// default: old-style
function isNewCSN(csn, options) {
  if( (options && options.newCsn ===  false) ||
        (csn.version && !newCSNVersions.includes(csn.version.csn)) ||
        (csn.$version && !newCSNVersions.includes(csn.$version)))
        {
    return false;
  }
  return true;
}

function checkCSNVersion(csn, options) {
  if (!isNewCSN(csn, options)) {
    // the new transformer works only with new CSN
    const { makeMessageFunction } = require('../base/messages');
    const { error, throwWithError } = makeMessageFunction(csn, options);

    let errStr = 'CSN Version not supported, version tag: "';
    errStr += (csn.version && csn.version.csn ? csn.version.csn : (csn.$version ? csn.$version : 'not available')) + '"';
    errStr += (options.newCsn !== undefined) ? ', options.newCsn: ' + options.newCsn : '';

    error(null, null, errStr);
    throwWithError();
  }
}

module.exports = {
  isNewCSN,
  checkCSNVersion
}
