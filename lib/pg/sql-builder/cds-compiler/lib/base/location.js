'use strict';

// This file contains functions related to XSN/CSN-location objects,
// but not semantic locations (which are message-specific),

const { copyPropIfExist } = require('../utils/objectUtils');

/**
 * Create a location with properties `file`, `line` and `col` from argument
 * `start`, and properties `endLine` and `endCol` from argument `end`.
 *
 * @param {XSN.WithLocation} start
 * @param {XSN.WithLocation} end
 * @returns {CSN.Location}
 */
function combinedLocation( start, end ) {
  if (!start || !start.location)
    return end.location;
  else if (!end || !end.location)
    return start.location;
  const loc = {
    file: start.location.file,
    line: start.location.line,
    col: start.location.col,
  };
  copyPropIfExist(end.location, 'endLine', loc);
  copyPropIfExist(end.location, 'endCol', loc);
  return loc;
}

/**
 * Create an empty location object with the given file name.
 *
 * @param {string} filename
 * @returns {CSN.Location}
 */
function emptyLocation(filename) {
  return {
    file: filename,
    line: 1,
    col: 1,
    endLine: 1,
    endCol: 1,
  };
}

/**
 * Create an empty location object with the given file name.
 * The end line/column is not set and therefore the location is weak.
 *
 * @param {string} filename
 * @returns {CSN.Location}
 */
function emptyWeakLocation(filename) {
  return {
    file: filename,
    line: 1,
    col: 1,
  };
}

/**
 * Returns a dummy location for built-in definitions.
 *
 * @returns {CSN.Location}
 */
function builtinLocation() {
  return emptyLocation('<built-in>');
}

/**
 * Return gnu-style error string for location `loc`:
 *  - 'File:Line:Col' without `loc.end`
 *  - 'File:Line:StartCol-EndCol' if Line = start.line = end.line
 *  - 'File:StartLine.StartCol-EndLine.EndCol' otherwise
 *
 * @param {CSN.Location|CSN.Location} location
 * @param {boolean} [normalizeFilename]
 */
function locationString( location, normalizeFilename ) {
  if (!location)
    return '<???>';
  const loc = location;
  let filename = (loc.file && normalizeFilename)
      ? loc.file.replace( /\\/g, '/' )
      : loc.file;
  if (!(loc instanceof Object))
    return loc;
  if (!loc.line) {
    return filename;
  }
  else if (!loc.endLine) {
    return (loc.col)
      ? `${filename}:${loc.line}:${loc.col}`
      : `${filename}:${loc.line}`;
  }
  else {
    return (loc.line === loc.endLine)
      ? `${filename}:${loc.line}:${loc.col}-${loc.endCol}`
      : `${filename}:${loc.line}.${loc.col}-${loc.endLine}.${loc.endCol}`;
  }
}

/**
 * Return the source location of the complete dictionary `dict`.  If
 * `extraLocation` is truthy, also consider this location.
 * ASSUMPTION: all entries in the dictionary have a property `location` and
 * `location.file` has always the same value.
 *
 * TODO: remove this function - if we really want to have dictionary locations,
 * set them in the CDL parser, e.g. via a symbol.
 *
 * @param {object} dict
 * @param {CSN.Location} [extraLocation]
 * @returns {CSN.Location}
 */
function dictLocation( dict, extraLocation ) {
  if (!dict)
    return extraLocation;

  if (!Array.isArray(dict))
    dict = Object.getOwnPropertyNames( dict ).map( name => dict[name] );

  /** @type {CSN.Location[]} */
  const locations = [].concat( ...dict.map( _objLocations ) );
  if (extraLocation)
    locations.push( extraLocation );

  const min = locations.reduce( (a, b) => (a.line < b.line || (a.line === b.line && a.col < b.col) ? a : b) );
  const max = locations.reduce( (a, b) => {
    const lineA = (a.endLine || a.line);
    const lineB = (b.endLine || b.line);
    return (lineA > lineB || (lineA === lineB && (a.endCol || a.col) > (b.endCol || b.col)) ? a : b);
  });
  return {
    file: min.file,
    line: min.line,
    col: min.col,
    endLine: max.endLine,
    endCol: max.endCol,
  };
}
dictLocation.end = (dict) => {
  const loc = dictLocation( dict );
  return loc && { file: loc.file, line: loc.endLine, col: loc.endCol };
};

function _objLocations( obj ) {
  return Array.isArray(obj) ? obj.map( o => o.location ) : [ obj.location ];
}

module.exports = {
  combinedLocation,
  emptyLocation,
  emptyWeakLocation,
  builtinLocation,
  dictLocation,
  locationString,
};
