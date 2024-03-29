#!/usr/bin/env node

// Very simple command-line interface for syntax highlighting CDS sources.  The
// interesting part is the correct classification of identifiers versus
// keywords, especially non-reserved ones.  Identifiers might even be
// classified further, especially where the identifier defines a new name.
//
// The output could be used directly by some editors, e.g. Emacs.

/* eslint no-console:off */

'use strict';

const compiler = require('../lib/compiler');
const fs = require('fs');
fs.readFile( '/dev/stdin', 'utf8', highlight );

const categoryChars = {
  artref: 'm',
  paramname: 'b',
  Entity: 'D',
  Enum: 'H',
  Index: 'J',
  AnnoDef: 'V',
  Extend: 'Z',
  Annotate: 'Z',
  Event: 'Y',
};

function highlight( err, buf ) {
  if (err) {
    console.error( 'ERROR:', err.toString() );
    return;
  }
  const ts = compiler.parseX( buf, 'hi.cds', { attachTokens: true, messages: [] } ).tokenStream;
  if (!buf.length || !ts.tokens || !ts.tokens.length)
    return;
  const chars = [ ...buf ];
  for (const tok of ts.tokens) {
    const cat = tok.isIdentifier;
    if (cat && tok.start >= 0) {
      if (cat !== 'ref' || chars[tok.start] !== '$')
        chars[tok.start] = categoryChars[cat] || cat.charAt(0);
      if (tok.stop > tok.start) // stop in ANTLR at last char, not behind
        chars[tok.start + 1] = '_';
    }
  }
  for (const c of chars)
    process.stdout.write( c );
}
