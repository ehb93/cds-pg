#!/usr/bin/env node

// Very simple command-line interface to LSP-like features for CDS.  We neither
// intend to support all capabilities of a LSP server, nor do we adhere to the
// LSP protocol.  This is just a little playground to optimize the CDS Compiler
// support for the CDS LSP server and to detect potential issues with
// corrupted, incomplete or errorneous CDL sources.
//
// The output could be used directly by some editors, e.g. Emacs.  The
// capabilities supported at the moments is: complete - work in progress.
// Planned are: gotoDefinition, highlight (for syntax highighting).

/* eslint no-console:off */

'use strict';

const commands = {
  complete, find, lint,
};

const fs = require('fs');
const path = require('path');
const compiler = require('../lib/compiler');
const main = require('../lib/main');
const { locationString } = require('../lib/base/messages');
const { availableBetaFlags: beta } = require('../lib/base/model');

const { argv } = process;
const cmd = commands[argv[2]];
const line = Number.parseInt( argv[3] );
const column = Number.parseInt( argv[4] );
const file = argv[5];
const frel = path.relative( '', file || '' );
// TODO: proper realname

if (argv.length > 5 && cmd && line > 0 && column > 0)
  fs.readFile( argv[6] === '-' ? '/dev/stdin' : file, 'utf8', cmd );
else
  usage();

function usage( err ) {
  if (err)
    console.error( 'ERROR:', err );
  console.error( 'Usage: cdsse <cmd> <line> <col> <file> [-]' );
  console.error( '----------- supported commands <cmd>:' );
  console.error( '  complete: syntactic and semantic code completion' );
  console.error( '  find:     location of definition' );
  console.error( '  lint:     linter (<line> and <col> are ignored, should be numbers)' );
  process.exitCode = 2;
  return false;
}

function complete( err, buf ) {
  if (err)
    return usage( err );
  const off = offset( buf );
  if (!off)                     // outside buffer range
    return usage();
  let hasId = false;
  if (off.prefix !== off.cursor) { // with keyword/name prefix
    // tokensAt( buf, off.cursor, false ); // list symbolAtCursor
    hasId = tokensAt( buf, off.prefix, off.col, false );
  }
  else {
    const charBefore = buf[off.prefix - 1];
    if ([ ':', '<', '.', '>', '!', '|', '=' ].includes( charBefore ))
      // If first of multi-char symbols from 'literalNames' in
      // gen/languageParser, calculate "symbol continuation"
      tokensAt( buf, off.prefix - 1, off.col - 1, charBefore );
    hasId = tokensAt( buf, off.prefix, off.col, true );
  }
  if (hasId) {
    const src = `${buf.substring( 0, off.prefix )}__NO_SUCH_ID__${buf.substring( off.cursor )}`;
    const fname = path.resolve( '', file );
    compiler.compileX( [ file ], '', {
      attachValidNames: true, lintMode: true, beta, messages: [],
    }, { [fname]: src } )
      .then( ident, ident );
  }
  return true;

  function ident( xsnOrErr ) {
    if (!(xsnOrErr.messages || xsnOrErr.options && xsnOrErr.options.messages))
      return usage( xsnOrErr );
    const vn = messageAt( xsnOrErr, 'validNames', off.col ) || Object.create(null);
    // TODO: if there is no such message, use console.log( 'arbitrary identifier' )
    // if we want to avoid that the editor switches to fuzzy completion match
    // against the prefix (not yet done anyway)
    for (const n in vn)
      console.log( n, vn[n].kind );
    if (!Object.keys( vn ).length)
      console.log( 'unknown_identifier', 'identifier' );
    return true;
  }
}

// For finding the definition for reference under cursor, do the following
//  * replace identifier under cursor by an undefined name
//  * call compiler and retrieve valid names at cursor position
//  * use originally provided name to find definition and its location.
function find( err, buf ) {
  if (err)
    return usage( err );
  const off = offset( buf, true );
  if (!off)                     // outside buffer range
    return usage();
  if (off.prefix === off.cursor) // not at name
    return true;
  const src = `${buf.substring( 0, off.prefix )}__NO_SUCH_ID__${buf.substring( off.cursor )}`;
  const fname = path.resolve( '', file );
  compiler.compileX( [ file ], '', {
    attachValidNames: true, lintMode: true, beta, messages: [],
  }, { [fname]: src } )
    .then( show, show );
  return true;

  function show( xsnOrErr ) {
    if (!(xsnOrErr.messages || xsnOrErr.options && xsnOrErr.options.messages))
      return usage( xsnOrErr );
    const vn = messageAt( xsnOrErr, 'validNames', off.col ) || Object.create(null);
    const art = vn[buf.substring( off.prefix, off.cursor )];
    if (art)
      console.log( `${locationString( art.name.location || art.location )}: Definition` );
    return true;
  }
}

function lint( err, buf ) {
  if (err)
    return usage( err );
  const fname = path.resolve( '', file );
  compiler.compileX( [ file ], '', { lintMode: true, beta, messages: [] }, { [fname]: buf } )
    .then( display, display );
  return true;

  function display( xsnOrErr ) {
    const messages = xsnOrErr.messages || xsnOrErr.options && xsnOrErr.options.messages;
    if (!messages)
      return usage( xsnOrErr );
    for (const msg of messages)
      console.log( main.messageString( msg ) );
    return true;
  }
}

function tokensAt( buf, offset, col, symbol ) {
  const src = `${buf.substring( 0, offset )}≠${buf.substring( offset )}`;
  const et = messageAt( compiler.parseX( src, frel, { messages: [] } ), 'expectedTokens', col ) || [];
  for (const n of et) {
    if (typeof symbol === 'string') {
      if (n.length > 3 && n.charAt(0) === "'" && n.charAt(1) === symbol)
        console.log( n.slice( 2, -1 ), 'symbolCont' );
    }
    else if (n.charAt(0) === "'") {
      if (symbol)
        console.log( n.slice( 1, -1 ), 'symbol' );
    }
    else if (/^[A-Z_]+$/.test( n )) {
      console.log( n.toLowerCase(), 'keyword' );
    }
    else if (n !== 'Identifier') {
      console.log( n, 'unknown' );
    }
  }
  return et.includes( 'Identifier' );
}

function messageAt( model, prop, col ) {
  const msg = (model.messages || model.options && model.options.messages).find(
    m => m[prop] && m.location.line === line && m.location.col === col && m.location.file === frel
  );
  return msg && msg[prop];
}

/**
 * Returns offsets of current position and start of prefix
 * @param {string} buf
 * @returns {false | { cursor: number, prefix: number, col: number }} Returns false if 'line' is out-of-range.
 */
function offset( buf, alsoSuffix ) { // for line and column
  let pos = 0;
  for (let l = line - 1; l; --l) {
    pos = buf.indexOf( '\n', pos ) + 1;
    if (!pos)
      return false;
  }
  let cursor = pos + column - 1;
  const prefix = /[a-z_0-9$]*$/i.exec( buf.substring( pos, cursor ) ).index + pos;
  const col = column + prefix - cursor;
  if (alsoSuffix)
    cursor += buf.substring( cursor, buf.indexOf( '\n', cursor ) + 1 ).search( /[^a-z_0-9$]/i );
  return { cursor, prefix, col };
}
