#!/usr/bin/env node

'use strict';

// Very simple command-line interface to support model migration from compiler
// v1 to v2.  (If our client command processor would have been not as difficult
// as after #2629, we could have a cdsc commend "migrate...)

const commands = {
  ria,
};
const compiler = require('../lib/compiler');

const { argv } = process;
const cmd = commands[argv[2]];
const files = argv.slice(3);
const options = { messages: [] };

if (argv.length > 3 && cmd)
  compiler.compileX( files, '', options ).then( cmd, cmd );
else
  usage();

function usage( err ) {
  if (err)
    console.error( 'ERROR:', err );
  console.error( 'Usage: cdsv2m <cmd> <file>...' );
  console.error( '----------- supported commands <cmd>:' );
  console.error( '  ria:      produce Annotate statements getting the v1 behavior for msg redirected-implicitly-ambiguous' );
  process.exitCode = 2;
  return false;
}

function ria() {
  const annotates = Object.create( null );
  const msgs = options.messages.filter( m => m.messageId === 'redirected-implicitly-ambiguous' );
  // regex match on message text not for productive code!
  for (const msgObj of msgs) {
    const matches = msgObj.message.match( /["“][^"”]+["”]/g );
    matches.slice(2).forEach( (name) => {
      annotates[name.slice( 1, -1 )] = true;
    } );
  }
  for (const name in annotates)
    console.log( `annotate ${name} with @cds.redirection.target: false;`);
}
