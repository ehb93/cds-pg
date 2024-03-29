#!/usr/bin/env node

//
// Update CDS Delimited Identifiers
//
// This script replaces the old delimited identifier style with the new one
// that is mandatory in cds-compiler v2.
//
// Example CDS:
//    entity "My Entity" { ... }
// will become:
//    entity ![My Entity] { ... }
//
// Usage:
//   cds_update_identifiers.js my_file.cds
//
// If you want to update all identifiers in a directory, you can use
// this Shell script:
//   find . -type f -iname '*.cds' -exec cds_update_identifiers.js {} \;
//
// Note that you need to update the path to this script in the commands above.
//

'use strict';

const parseLanguage = require('../lib/language/antlrParser');

const fs = require('fs');
const path = require('path');

const cliArgs = process.argv.slice(2);
const filename = cliArgs[0];

if (cliArgs.length !== 1)
  exitError(`Expected exactly one argument, ${cliArgs.length} given`);

if (!filename)
  exitError('Expected non-empty filename as argument!');

// Do not use allow-list approach.
// There may be CDS files with other extensions than `.cds`.
if (filename.endsWith('.csn') || filename.endsWith('.json'))
  exitError('Only CDS files can be passed! Found CSN file!');

let source = fs.readFileSync(filename, 'utf-8');
source = modernizeIdentifierStyle(source, filename);
fs.writeFileSync(filename, source);
process.exit(0); // success

// --------------------------------------------------------

function modernizeIdentifierStyle(source, filename) {
  const options = { messages: [], attachTokens: true };

  // parseLanguage does not throw on CompilationError, so
  // we do not need a try...catch block.
  const ast = parseLanguage(source, filename, options);

  // To avoid spam, only report errors.
  // Users should use the compiler to get all messages.
  const errors = options.messages
    .filter(msg => (msg.severity === 'Error' && msg.messageId !== 'syntax-deprecated-ident'));
  if (errors.length > 0) {
    errors.forEach((msg) => {
      console.error(msg.toString());
    });
    console.error(`Found ${errors.length} errors! \n`);
    exitError('The parser emitted errors. Please fix them first and try again.');
  }

  let currentOffset = 0;

  const { tokens } = ast.tokenStream;
  for (const token of tokens) {
    if (token.type === ast.tokenStream.Identifier && token.text.startsWith('"'))
      updateIdent(token);
  }

  return source;

  // -----------------------------------------------

  function updateIdent(identToken) {
    const newIdentText = toNewIdentStyle(identToken.text);

    if (!identToken.stop)
      throw new Error(`INTERNAL ERROR: Identifier at ${identToken.start} has no end!`);

    const start = identToken.start + currentOffset;
    const end = identToken.stop + currentOffset + 1; // end points at the position *before* the character

    source = replaceSliceInSource(source, start, end, newIdentText);

    currentOffset += (newIdentText.length - identToken.text.length);
  }

  function toNewIdentStyle(oldIdentText) {
    let ident = oldIdentText.slice(1, oldIdentText.length - 1);

    // There are only two replacement rules we need to check for:
    ident = ident.replace(/""/g, '"');
    ident = ident.replace(/]/g, ']]');

    return `![${ident}]`;
  }
}

/**
 * Replaces a given span with @p replaceWith
 *
 * @param {string} source
 * @param {number} startIndex
 * @param {number} endIndex
 * @param {string} replaceWith
 * @return {string}
 */
function replaceSliceInSource(source, startIndex, endIndex, replaceWith) {
  return source.substring(0, startIndex) +
          replaceWith +
          source.substring(endIndex);
}

/**
 * @param {string} msg
 */
function exitError(msg) {
  console.error(msg);
  usage();
  process.exit(1);
}

function usage() {
  console.error('');
  console.error(`usage: ${path.basename(process.argv[1])} <filename>`);
}
