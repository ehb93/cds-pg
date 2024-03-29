// Functions and classes for syntax messages

// See internalDoc/ReportingMessages.md and lib/base/message-registry.js for details.

'use strict';

const term = require('../utils/term');
const { locationString } = require('./location');
const { isDeprecatedEnabled } = require('./model');
const { centralMessages, centralMessageTexts } = require('./message-registry');
const { copyPropIfExist } = require('../utils/objectUtils');
const _messageIdsWithExplanation = require('../../share/messages/message-explanations.json').messages;
const { analyseCsnPath, traverseQuery } = require('../model/csnRefs');

const fs = require('fs');
const path = require('path');


// Functions ensuring message consistency during runtime with --test-mode

let test$severities = null;
let test$texts = null;

/**
 * Returns true if at least one of the given messages is of severity "Error"
 * @param {CSN.Message[]} messages
 * @returns {boolean}
 */
function hasErrors( messages ) {
  return messages && messages.some( m => m.severity === 'Error' );
}

/**
 * Returns true if at least one of the given messages is of severity "Error"
 * and *cannot* be reclassified to a warning.
 *
 * @param {CSN.Message[]} messages
 * @param {string} moduleName
 * @returns {boolean}
 */
function hasNonDowngradableErrors( messages, moduleName ) {
  return messages && messages.some( m => m.severity === 'Error' &&
      (!m.messageId || !isDowngradable( m.messageId, moduleName )));
}

/**
 * Returns true if the given message id exist in the central message register and is
 * downgradable, i.e. an error can be reclassified to a warning or lower.
 * Returns false if the messages is an errorFor the given moduleName.
 *
 * @param {string} messageId
 * @param {string} moduleName
 * @returns {boolean}
 */
function isDowngradable( messageId, moduleName ) {
  if (!centralMessages[messageId])
    return false;

  const msg = centralMessages[messageId];

  // errorFor has the highest priority.  If the message is an error for
  // the module, it is NEVER downgradable.
  if (msg.errorFor && msg.errorFor.includes(moduleName))
    return false;

  return (msg.severity !== 'Error' ||
        msg.configurableFor === true || // useful with error for syntax variants
        msg.configurableFor && msg.configurableFor.includes( moduleName ));
}

/**
 * Class for combined compiler errors.  Additional members:
 *   `errors`: vector of errors (CompileMessage and errors from peg.js)
 *   `model`: the CSN model
 * TODO: standard param order
 * @class CompilationError
 * @extends {Error}
 */
class CompilationError extends Error {
  /**
   * Creates an instance of CompilationError.
   * @param {array} messages vector of errors
   * @param {XSN.Model} [model] the XSN model, only to be set with options.attachValidNames
   * @param {string} [text] Text of the error
   * @param {any} args Any args to pass to the super constructor
   *
   * @memberOf CompilationError
   */
  constructor(messages, model, text, ...args) {
    super( text || 'CDS compilation failed\n' + messages.map( m => m.toString() ).join('\n'),
          // @ts-ignore Error does not take more arguments according to TypeScript...
           ...args );
    this.messages = messages;

    /** @type {boolean} model */
    this.hasBeenReported = false; // TODO: remove this bin/cdsc.js specifics
    // property `model` is only set with options.attachValidNames:
    Object.defineProperty( this, 'model', { value: model || undefined, configurable: true } );
  }
  toString() {                  // does not really help -> set message
    return this.message.includes('\n')
      ? this.message
      : this.message + '\n' + this.messages.map( m => m.toString() ).join('\n');
  }
  /**
   * @deprecated Use `.messages` instead.
   */
  get errors() {
    return this.messages;
  }
}

/**
 * Class for individual compile message.
 *
 * @class CompileMessage
 */
class CompileMessage {
  /**
   * Creates an instance of CompileMessage.
   * @param {any} location Location of the message
   * @param {string} msg The message text
   * @param {CSN.MessageSeverity} [severity='Error'] Severity: Debug, Info, Warning, Error
   * @param {string} [id] The ID of the message - visible as property messageId
   * @param {any} [home]
   *
   * @memberOf CompileMessage
   */
  constructor(location, msg, severity = 'Error', id = null, home = null, moduleName = null) {
    this.message = msg;
    this.location = location;
    this.$location = dollarLocation( this.location );
    this.validNames = null;
    if (home)                   // semantic location, e.g. 'entity:"E"/element:"x"'
      this.home = home;
    this.severity = severity;
    if (id)
      Object.defineProperty( this, 'messageId', { value: id } );
      // this.messageId = id;  // ids not yet finalized
    if (moduleName)
      Object.defineProperty( this, '$module', { value: moduleName } );
  }

  toString() {                  // should have no argument...
    return messageString( this, undefined, true ); // no message-id before finalization!
  }
}

/**
 * Temporary v1 function to convert an "old-style" location to "new-style".
 *
 * @param {CSN.Location} location
 * @return {CSN.Location}
 * @todo Remove
 */
function dollarLocation( location ) {
  const file  = location && location.file || undefined;
  if (!file)
    return {};
  const loc = {
    file,
    line: location.line,
    col: location.col,
    address: undefined,
  };
  copyPropIfExist(location, 'endLine', loc);
  copyPropIfExist(location, 'endCol', loc);
  // TODO:
  // return {
  //   ...location,
  //   address: undefined,
  // };
  return loc;
}

/**
 * Handle compiler messages, i.e. throw a compiler exception if there are errors.
 *
 * @param {object} model CSN or XSN
 * @param {CSN.Options} [options]
 * @deprecated Use throwWithError() from makeMessageFunction instead.
 */
function handleMessages( model, options = {} ) {
  const messages = options.messages;
  if (messages && messages.length) {
    if (hasErrors( messages ))
      throw new CompilationError( messages, options.attachValidNames && model );
  }
  return model;
}

const severitySpecs = {
  error: { name: 'Error', level: 0 },
  warning: { name: 'Warning', level: 1 },
  info: { name: 'Info', level: 2 },
  debug: { name: 'Debug', level: 3 },
};

/**
 * Reclassify the given message's severity using:
 *
 *  1. The specified severity: either centrally provided or via the input severity
 *     - when generally specified as 'Error', immediately return 'Error'
 *       if message is not specified as configurable (for the given module name)
 *     - when generally specified otherwise, immediately return 'Error'
 *       if message is specified as being an error for the given module name
 *  2. User severity wishes in option `severities`: when provided and no 'Error' has
 *     been returned according to 1, return the severity according to the user wishes.
 *  3. Otherwise, use the specified severity.
 *
 * @param {string} id
 * @param {CSN.MessageSeverity} severity
 * @param {object} severities
 * @param {string} moduleName
 * @returns {CSN.MessageSeverity}
 *
 * TODO: we should pass options as usual
 * TODO: should be part of the returned function
 */
function reclassifiedSeverity( id, severity, severities, moduleName, deprecatedDowngradable ) {
  const spec = centralMessages[id] || { severity };
  if (spec.severity === 'Error') {
    const { configurableFor } = spec;
    if (!(Array.isArray( configurableFor )
          ? configurableFor.includes( moduleName )
          : configurableFor && (configurableFor !== 'deprecated' || deprecatedDowngradable)))
      return 'Error';
  }
  else {
    const { errorFor } = spec;
    if (Array.isArray( errorFor ) && errorFor.includes( moduleName ))
      return 'Error';
  }
  return normalizedSeverity( severities[id] ) || spec.severity;
}

function normalizedSeverity( severity ) {
  if (typeof severity !== 'string')
    return (severity == null) ? null : 'Error';
  let s = severitySpecs[ severity.toLowerCase() ];
  return s ? s.name : 'Error';
}

/**
 * Reclassifies all messages according to the current module.
 * This is required because if throwWithError() throws and the message's
 * severities has `errorFor` set, then the message may still appear to be a warning.
 *
 * TODO: this actually likely needs to be called by the backend module at the beginning!
 *
 * @param {CSN.Message[]} messages
 * @param {object} severities
 * @param {string} moduleName
 */
function reclassifyMessagesForModule(messages, severities, moduleName, deprecatedDowngradable) {
  for (const msg of messages) {
    if (msg.messageId && msg.severity !== 'Error')
      msg.severity = reclassifiedSeverity(msg.messageId, msg.severity, severities, moduleName, deprecatedDowngradable);
  }
}

/**
 * Compare two severities.  Returns 0 if they are the same, and <0 if
 * `a` has a lower `level` than `b` according to {@link severitySpecs},
 * where "lower" means: comes first when sorted.
 *
 *   compareSeverities('Error', 'Info')  =>  Error < Info  =>  -1
 *
 * @param {CSN.MessageSeverity} a
 * @param {CSN.MessageSeverity} b
 * @see severitySpecs
 */
function compareSeverities( a, b ) {
  // default: low priority
  const aSpec = severitySpecs[a.toLowerCase()] || { level: 10 };
  const bSpec = severitySpecs[b.toLowerCase()] || { level: 10 };
  return aSpec.level - bSpec.level;
}

/**
 * @todo This was copied from somewhere just to make CSN paths work.
 * @param {CSN.Model} model
 * @param {CSN.Path} path
 */
function searchForLocation( model, path ) {
  if (!model)
    return null;
  // Don't display a location if we cannot find one!
  let lastLocation = null;
  /** @type {object} */
  let currentStep = model;
  for (const step of path) {
    if (!currentStep)
      return lastLocation;
    currentStep = currentStep[step];
    if (currentStep && currentStep.$location)
      lastLocation = currentStep.$location;
  }

  return lastLocation;
}

/**
 * Create the `message` functions to emit messages.
 * See internalDoc/ReportingMessages.md for detail
 *
 * @example
 * ```
 *   const { createMessageFunctions } = require(‘../base/messages’);
 *   function module( …, options ) {
 *     const { message, info, throwWithError } = createMessageFunctions( options, moduleName );
 *     // [...]
 *     message( 'message-id', <location>, <text-arguments>, <severity>, <text> );
 *     info( 'message-id', <location>, [<text-arguments>,] <text> );
 *     // [...]
 *     throwWithError();
 *   }
 * ```
 * @param {CSN.Options} [options]
 * @param {string} [moduleName]
 * @param {object} [model=null] the CSN or XSN model, used for convenience
 */
function createMessageFunctions( options, moduleName, model = null ) {
  return makeMessageFunction( model, options, moduleName, true );
}

/**
 * Create the `message` function to emit messages.
 *
 * @example
 * ```
 *   const { makeMessageFunction } = require(‘../base/messages’);
 *   function module( …, options ) {
 *     const { message, info, throwWithError } = makeMessageFunction( model, options, moduleName );
 *     // [...]
 *     message( 'message-id', <location>, <text-arguments>, <severity>, <text> );
 *     info( 'message-id', <location>, [<text-arguments>,] <text> );
 *     // [...]
 *     throwWithError();
 *   }
 * ```
 * @param {object} model
 * @param {CSN.Options} [options]
 * @param {string} [moduleName]
 * @param {boolean} [throwOnlyWithNew=false] behave like createMessageFunctions
 */
function makeMessageFunction( model, options, moduleName = null, throwOnlyWithNew = false ) {
  // ensure message consistency during runtime with --test-mode
  if (options.testMode)
    _check$Init( options );

  const hasMessageArray = !!options.messages;
  const severities = options.severities || {};
  const deprecatedDowngradable = isDeprecatedEnabled( options, 'downgradableErrors' );
  /**
   * Array of collected compiler messages. Only use it for debugging. Will not
   * contain the messages created during a `callTransparently` call.
   *
   * @type {CSN.Message[]}
   */
  let messages = options.messages || [];
  let hasNewError = false;
  return {
    message, error, warning, info, debug, messages,
    throwWithError: (throwOnlyWithNew ? throwWithError : throwWithAnyError),
    callTransparently, moduleName,
  };

  function _message(id, location, textOrArguments, severity, texts = null) {
    _validateFunctionArguments(id, location, textOrArguments, severity, texts);

    // Special case for _info, etc.: textOrArguments may be a string.
    if (typeof textOrArguments === 'string') {
      texts = { std: textOrArguments };
      textOrArguments = {};
    }
    if (id) {
      if (options.testMode && !options.$recompile)
        _check$Consistency( id, moduleName, severity, texts, options )
      severity = reclassifiedSeverity( id, severity, severities, moduleName, deprecatedDowngradable );
    }

    const [ fileLocation, semanticLocation, definition ] = _normalizeMessageLocation(location);
    const text = messageText( texts || centralMessageTexts[id], textOrArguments );

    /** @type {CSN.Message} */
    const msg = new CompileMessage( fileLocation, text, severity, id, semanticLocation, moduleName );
    if (options.internalMsg)
      msg.error = new Error( 'stack' );
    if (definition)
      msg.$location.address = { definition };

    messages.push( msg );
    hasNewError = hasNewError || msg.severity === 'Error' &&
      !(options.testMode && msg.messageId && isDowngradable( msg.messageId, moduleName ));
    if (!hasMessageArray)
      console.error( messageString( msg ) );
    return msg;
  }

  /**
   * Validate the arguments for the message() function. This is needed during the transition
   * to the new makeMessageFunction().
   */
  function _validateFunctionArguments(id, location, textArguments, severity, texts) {
    if (!options.testMode)
      return;

    if (id !== null && typeof id !== 'string')
      _expectedType('id', id, 'string')

    if (location !== null && location !== undefined && !Array.isArray(location) && typeof location !== 'object')
      _expectedType('location', location, 'XSN/CSN location, CSN path')

    if (severity != null && typeof severity !== 'string')
      _expectedType('severity', severity, 'string')

    const isShortSignature = (typeof textArguments === 'string') // textArguments => texts

    if (isShortSignature) {
      if (texts)
        throw new Error('No "texts" argument expected because text was already provided as third argument.');
    } else {
      if (textArguments !== undefined && typeof textArguments !== 'object')
        _expectedType('textArguments', textArguments, 'object')
      if (texts !== undefined && typeof texts !== 'object' && typeof texts !== 'string')
        _expectedType('texts', texts, 'object or string')
    }

    function _expectedType(field, value, type) {
      throw new Error(`Invalid argument type for ${ field }! Expected ${ type } but got ${ typeof value }. Do you use the old function signature?`);
    }
  }

  /**
   * Normalize the given location. Location may be a CSN path, XSN/CSN location or an
   * array of the form `[CSN.Location, user, suffix]`.
   *
   * @param {any} location
   * @returns {[CSN.Location, string, string]} Location, semantic location and definition.
   */
  function _normalizeMessageLocation(location) {
    if (!location)
      // e.g. for general messages unrelated to code
      return [ null, null, null ]

    if (typeof location === 'object' && !Array.isArray(location))
      // CSN.Location (with line/endLine, col/endCol)
      return [ location, location.home || null, null ]

    const isCsnPath = (typeof location[0] === 'string');
    if (isCsnPath) {
      return [
        searchForLocation( model, location ),
        constructSemanticLocationFromCsnPath( location, model ),
        location[1] // location[0] is 'definitions'
      ];
    }

    let semanticLocation = location[1] ? homeName( location[1], false ) : null;
    if (location[2]) // optional suffix
      semanticLocation += '/' + location[2]

    const definition = location[1] ? homeName( location[1], true ) : null;

    // If no XSN location is given, check if we can use the one of the artifact
    let fileLocation = location[0];
    if (!fileLocation && location[1])
      fileLocation = location[1].location || location[1].$location || null;

    return [ fileLocation, semanticLocation, definition ];
  }

  /**
   * Create a compiler message for model developers.
   *
   * @param {string} id Message ID
   * @param {[CSN.Location, XSN.Artifact]|CSN.Path|CSN.Location|CSN.Location} location
   *            Either a (XSN/CSN-style) location, a tuple of file location
   *            and "user" (address) or a CSN path a.k.a semantic location path.
   * @param {object} [textArguments] Text parameters that are replaced in the texts.
   * @param {string|object} [texts]
   */
  function message(id, location, textArguments = null, texts = null) {
    if (!id)
      throw new Error('A message id is missing!');
    if (!centralMessages[id])
      throw new Error(`Message id '${ id }' is missing an entry in the central message register!`);
    return _message(id, location, textArguments, null, texts);
  }

  /**
   * Create a compiler error message.
   * @see message()
   */
  function error(id, location, textOrArguments = null, texts = null) {
    return _message(id, location, textOrArguments, 'Error', texts);
  }

  /**
   * Create a compiler warning message.
   * @see message()
   */
  function warning(id, location, textOrArguments = null, texts = null) {
    return _message(id, location, textOrArguments, 'Warning', texts);
  }

  /**
   * Create a compiler info message.
   * @see message()
   */
  function info(id, location, textOrArguments = null, texts = null) {
    return _message(id, location, textOrArguments, 'Info', texts);
  }

  /**
   * Create a compiler debug message (usually not shown).
   * @see message()
   */
  function debug(id, location, textOrArguments = null, texts = null) {
    return _message(id, location, textOrArguments, 'Debug', texts);
  }

  function throwWithError() {
    if (hasNewError)
      throw new CompilationError( messages, options.attachValidNames && model );
  }

  /**
   * Throws a CompilationError exception if there is at least one error message
   * in the model's messages after reclassifying existing messages according to
   * the module name.
   * If `--test-mode` is enabled, this function will only throw if the
   * error *cannot* be downgraded to a warning.  This is done to ensure that
   * developers do not rely on certain errors leading to an exception.
   */
  function throwWithAnyError() {
    if (!messages || !messages.length)
      return;
    reclassifyMessagesForModule( messages, severities, moduleName ); // TODO: no, at the beginning of the module
    const hasError = options.testMode ? hasNonDowngradableErrors : hasErrors;
    if (hasError( messages, moduleName ))
      throw new CompilationError( messages, options.attachValidNames && model );
  }

  /**
   * Collects all messages during the call of the callback function instead of
   * storing them in the model. Returns the collected messages.
   * Not yet in use.
   *
   * @param {Function} callback
   * @param  {...any} args
   * @returns {CSN.Message[]}
   */
  function callTransparently(callback, ...args) {
    const backup = messages;
    messages = [];
    callback(...args);
    const collected = messages;
    messages = backup;
    return collected;
  }
}

/**
 * Perform message consistency check during runtime with --test-mode
 */

function _check$Init( options ) {
  if (!test$severities && !options.severities)
    test$severities = Object.create(null);
  if (!test$texts) {
    test$texts = Object.create(null);
    for (const [id, texts] of Object.entries( centralMessageTexts ))
      test$texts[id] = (typeof texts === 'string') ? { std: texts } : { ...texts };
  }
}

function _check$Consistency( id, moduleName, severity, texts, options ) {
  if (id.length > 30 && !centralMessages[id])
    throw new Error( `The message ID "${id}" has more than 30 chars and must be listed centrally` );
  if (!options.severities)
    _check$Severities( id, moduleName || '?', severity );
  for (const [variant, text] of
       Object.entries( (typeof texts === 'string') ? { std: texts } : texts || {} ))
    _check$Texts( id, variant, text );
}

function _check$Severities( id, moduleName, severity ) {
  if (!severity)                // if just used message(), we are automatically consistent
    return;
  const spec = centralMessages[id];
  if (!spec) {
    const expected = test$severities[id];
    if (!expected)
      test$severities[id] = severity;
    else if (expected !== severity)
      throw new Error( `Expecting severity "${expected}" from previous call, not "${severity}" for message ID "${id}"` );
    return;
  }
  // now try whether the message could be something less than an Error in the module due to user wishes
  const user = reclassifiedSeverity( id, null, { [id]: 'Info' }, moduleName, false );
  if (user === 'Error') {       // always an error in module
    if (severity !== 'Error')
      throw new Error( `Expecting severity "Error", not "${severity}" for message ID "${id}" in module "${moduleName}"` );
  }
  else if (spec.severity === 'Error') {
    throw new Error( `Expecting the use of function message() when message ID "${id}" is a configurable error in module "${moduleName}"` );
  }
  else if (spec.severity !== severity) {
    throw new Error( `Expecting severity "${spec.severity}", not "${severity}" for message ID "${id}" in module "${moduleName}"` );
  }
}

function _check$Texts( id, prop, value ) {
  if (!test$texts[id])
    test$texts[id] = Object.create(null);
  const expected = test$texts[id][prop];
  if (!expected)
    test$texts[id][prop] = value;
  else if (expected !== value)
    throw new Error( `Expecting text "${expected}", not "${value}" for message ID "${id}" and text variant "${prop}"`);
}

const quote = {                 // could be an option in the future
  name: n => `“${ n }”`,
  prop: p => `‘${ p }’`,
  file: f => `‘${ f }’`,
  code: c => `«${ c }»`,
  meta: m => `‹${ m }›`,
  // TODO: probably use keyword as function name, but its name would not have length 4 :-(
  word: w => w.toUpperCase(),   // keyword
}

const paramsTransform = {
  // simple convenience:
  name: quoted,
  id: quoted,
  alias: quoted,
  anno: a => (a.charAt(0) === '@' ? quote.name( a ) : quote.name( '@' + a )),
  delimited: n => '![' + n + ']',
  file: quote.file,
  prop: quote.prop,
  otherprop: quote.prop,
  code: quote.code,
  newcode: quote.code,
  kind: quote.meta,
  keyword: quote.word,
  // more complex convenience:
  names: transformManyWith( quoted ),
  number: n => n,
  line: l => l,
  col: c => c,
  literal: l => l,
  art: transformArg,
  service: transformArg,
  sorted_arts: transformManyWith( transformArg, true ),
  target: transformArg,
  elemref: transformElementRef,
  type: transformArg,
  offending: tokenSymbol,
  expecting: transformManyWith( tokenSymbol ),
  // msg: m => m,
  $reviewed: ignoreTextTransform,
};

function ignoreTextTransform() {
  return null;
}

function transformManyWith( t, sorted ) {
  return function transformMany( many, r, args, texts ) {
    const prop = ['none','one'][ many.length ];
    if (!prop || !texts[prop] || args['#'] ) {
      const names = many.map(t);
      return (sorted ? names.sort() : names).join(', ');
    }
    r['#'] = prop;              // text variant
    return many.length && t( many[0] );
  };
}

function quoted( name ) {
  return (name) ? quote.name( name ) : '<?>'; // TODO: failure in --test-mode, then remove
}

function tokenSymbol( token ) {
  if (token.match( /^[A-Z][A-Z]/ )) // keyword
    return quote.word( token );
  else if (token.match( /^[A-Z][a-z]/ )) // Number, Identifier, ...
    return quote.meta( token );
  if (token.startsWith("'") && token.endsWith("'")) // operator token symbol
    return quote.prop( token.slice( 1, -1 ));
  else if (token === '<EOF>')
    return quote.meta( token.slice( 1, -1 ) );
  else
    return quote.code( token ); // should not happen
}

/**
 * Transform an element reference (/path), e.g. on-condition path.
 */
function transformElementRef(arg) {
  if (arg.ref) {
    // Can be used by CSN backends to create a simple path such as E:elem
    return quoted(arg.ref.map(ref => {
      if (ref.id) {
        // Indicate that the path has a filter.
        if (ref.where)
          return `${ ref.id }[…]`;
        return ref.id;
      }
      return ref;
    }).join('.'));
  }
  return quoted(arg);
}

function transformArg( arg, r, args, texts ) {
  if (!arg || typeof arg !== 'object')
    return quoted( arg );
  if (arg._artifact)
    arg = arg._artifact;
  if (arg._outer)
    arg = arg._outer;
  if (args['#'] || args.member )
    return shortArtName( arg );
  if (arg.ref) {
    // Can be used by CSN backends to create a simple path such as E:elem
    if (arg.ref.length > 1)
      return quoted(arg.ref[0] + ':' + arg.ref.slice(1).join('.'));
    return quoted(arg.ref);
  }
  let name = arg.name;
  if (!name)
    return quoted( name );
  let prop = ['element','param','action','alias'].find( p => name[p] );
  if (!prop || !texts[prop] )
    return shortArtName( arg );
  r['#'] = texts[ name.$variant ] && name.$variant || prop; // text variant (set by searchName)
  r.member = quoted( name[prop] );
  return artName( arg, prop );
}

const nameProp = {
  enum: 'element',
  key: 'element',
  function: 'action',
};

function searchName( art, id, variant ) {
  if (!variant) {
    // used to mention the "effective" type in the message, not the
    // originally provided one (TODO: mention that in the message text)
    let type = art._effectiveType && art._effectiveType.kind !== 'undefined' ? art._effectiveType : art;
    if (type.elements) {        // only mentioned elements
      art = type.target && type.target._artifact || type;
      variant = 'element';
    }
    else {
      variant = 'absolute';
    }
  }
  let prop = nameProp[variant] || variant;
  let name = Object.assign( { $variant: variant }, (art._artifact||art).name );
  name[prop] = (name[prop]) ? name[prop] + '.' + id : id || '?';
  return { name, kind: art.kind };
}

function messageText( texts, params, transform ) {
  if (typeof texts === 'string')
    texts = { std: texts };
  let args = {};
  for (let p in params) {
    let t = transform && transform[p] || paramsTransform[p];
    args[p] = (t) ? t( params[p], args, params, texts ) : params[p];
  }
  let variant = args['#'];
  return replaceInString( variant && texts[ variant ] || texts.std, args );
}

function replaceInString( text, params ) {
  let pattern = /\$\(([A-Z_]+)\)/g;
  let parts = [];
  let start = 0;
  for (let p = pattern.exec( text ); p; p = pattern.exec( text )) {
    let prop = p[1].toLowerCase();
    parts.push( text.substring( start, p.index ),
                (prop in params ? params[prop] : p[0]) );
    delete params[prop];
    start = pattern.lastIndex;
  }
  parts.push( text.substring( start ) );
  let remain = ('#' in params) ? [] : Object.keys( params ).filter( n => params[n] );
  return (remain.length)
         ? parts.join('') + '; ' +
           remain.map( n => n.toUpperCase() + ' = ' + params[n] ).join(', ')
         : parts.join('');
}

/**
 * @param {CSN.Location} loc
 * @returns {CSN.Location}
 */
function weakLocation( loc ) {
  // no endLine/endCol
  return { file: loc.file, line: loc.line, col: loc.col };
}

/**
 * Return message string with location if present in compact form (i.e. one line)
 *
 * Example:
 *   <source>.cds:3:11: Error message-id: Can't find type `nu` in this scope (in entity:“E”/element:“e”)
 *
 * @param {CSN.Message} err
 * @param {boolean} [normalizeFilename]
 * @param {boolean} [noMessageId]
 * @param {boolean} [noHome]
 * @returns {string}
 */
function messageString( err, normalizeFilename, noMessageId, noHome ) {
  return (err.$location && err.$location.file
          ? locationString( err.$location, normalizeFilename ) + ': '
          : '') +
         (err.severity||'Error') +
         // TODO: use [message-id]
         (err.messageId && !noMessageId ? ' ' + err.messageId + ': ' : ': ') +
         err.message +
         // even with noHome, print err.home if the location is weak
         (!err.home || noHome && err.$location && err.$location.endLine ? '' : ' (in ' + err.home + ')');
}

/**
 * Return message hash which is either the message string without the file location,
 * or the full message string if no semantic location is provided.
 *
 * @param {CSN.Message} msg
 * @returns {string} can be used to uniquely identify a message
 */
function messageHash(msg) {
  // parser messages do not provide semantic location, therefore we need to use the file location
  if(!msg.home)
    return messageString(msg);
  const copy = {...msg};
  copy.$location = undefined;
  return messageString(copy);
}

/**
 * Returns a message string with file- and semantic location if present
 * in multiline form.
 *
 * Example:
 * ```txt
 * Error[message-id]: Can't find type `nu` in this scope (in entity:“E”/element:“e”)
 *    |
 *   <source>.cds:3:11, at entity:“E”
 * ```
 * @param {CSN.Message} err
 * @param {object} [config = {}]
 * @param {boolean} [config.normalizeFilename] Replace windows `\` with forward slashes `/`.
 * @param {boolean} [config.noMessageId]
 * @param {boolean} [config.hintExplanation] If true, messages with explanations will get a "…" marker.
 * @param {boolean} [config.withLineSpacer] If true, an additional line (with `|`) will be inserted between message and location.
 * @returns {string}
 */
function messageStringMultiline( err, config = {} ) {
  const explainHelp = (config.hintExplanation && hasMessageExplanation(err.messageId)) ? '…' : '';
  const msgId = (err.messageId && !config.noMessageId) ? `[${ err.messageId }${ explainHelp }]` : '';
  const home = !err.home ? '' : ('at ' + err.home);
  const severity = err.severity || 'Error';

  let location = '';
  if (err.$location && err.$location.file) {
    location += locationString( err.$location, config.normalizeFilename )
    if (home)
      location += ', '
  }
  else if (!home)
    return term.asSeverity(severity, severity + msgId) + ' ' + err.message;

  let lineSpacer = '';
  if (config.withLineSpacer) {
    let additionalIndent = err.$location ? `${ err.$location.endLine || err.$location.line || 1 }`.length : 1;
    lineSpacer = `\n  ${ ' '.repeat( additionalIndent ) }|`;
  }

  // TODO: use ':' before text
  return term.asSeverity(severity, severity + msgId) + ': ' + err.message + lineSpacer + '\n  ' + location + home;
}

/**
 * Returns a context (code) string that is human readable (similar to rust's compiler)
 *
 * Example Output:
 *     |
 *   3 |     num * nu
 *     |           ^^
 *
 * @param {string[]} sourceLines The source code split up into lines, e.g. by `splitLines(src)`
 *                               from `lib/utils/file.js`
 * @param {CSN.Message} err Error object containing all details like line, message, etc.
 * @returns {string}
 */
function messageContext(sourceLines, err) {
  const MAX_COL_LENGTH = 100;

  const loc = err.$location;
  if (!loc || !loc.line) {
    return '';
  }

  // Lines are 1-based, we need 0-based ones for arrays
  const startLine = loc.line - 1;
  const endLine = loc.endLine ? loc.endLine - 1 : startLine;

  // check that source lines exists
  if (typeof sourceLines[startLine] !== 'string' || typeof sourceLines[endLine] !== 'string') {
    return '';
  }

  const digits = String(endLine + 1).length;
  const severity = err.severity || 'Error';
  const indent = ' '.repeat(2 + digits);

  // Columns are limited in width to avoid too long output.
  // "col" is 1-based but could still be set to 0, e.g. by CSN frontend.
  const startColumn = Math.min(MAX_COL_LENGTH, loc.col || 1);
  // end column points to the place *after* the last character index,
  // e.g. for single character locations it is "start + 1"
  let endColumn = (loc.endCol && loc.endCol > loc.col) ? loc.endCol - 1 : loc.col;
  endColumn = Math.min(MAX_COL_LENGTH, endColumn);

  /** Only print N lines even if the error spans more lines. */
  const maxLine = Math.min((startLine + 2), endLine);

  let msg = indent + '|\n';

  // print source line(s)
  for (let line = startLine; line <= maxLine; line++) {
    // Replaces tabs with 1 space
    let sourceCode = sourceLines[line].replace(/\t/g, ' ');
    if (sourceCode.length >= MAX_COL_LENGTH)
      sourceCode = sourceCode.slice(0, MAX_COL_LENGTH);
    // Only prepend space if the line contains any sources.
    sourceCode = sourceCode.length ? ' ' + sourceCode : '';
    msg +=  ' ' + String(line + 1).padStart(digits, ' ') + ' |' + sourceCode + '\n';
  }

  if (startLine === endLine && loc.col > 0) {
    // highlight only for one-line locations with valid columns
    // at least one character is highlighted
    let highlighter = ' '.repeat(startColumn - 1).padEnd(endColumn, '^');
    // Indicate that the error is further to the right.
    if (endColumn === MAX_COL_LENGTH)
      highlighter = highlighter.replace('  ^', '..^');
    msg += indent + '| ' + term.asSeverity(severity, highlighter);

  } else if (maxLine !== endLine) {
    // error spans more lines which we don't print
    msg +=  indent + '| ...';

  } else {
    msg +=  indent + '|';
  }

  return msg;
}

/**
 * Compare two messages `a` and `b`. Return 0 if they are equal, 1 if `a` is
 * larger than `b`, and -1 if `a` is smaller than `b`. Messages without a location
 * are considered larger than messages with a location.
 *
 * @param {CSN.Message} a
 * @param {CSN.Message} b
 */
function compareMessage( a, b ) {
  const aFile = a.$location && a.$location.file;
  const bFile = b.$location && b.$location.file;
  if (aFile && bFile) {
    const aEnd = a.$location.endLine && a.$location.endCol && a.$location || { endLine: Number.MAX_SAFE_INTEGER, endCol: Number.MAX_SAFE_INTEGER };
    const bEnd = b.$location.endLine && b.$location.endCol && b.$location || { endLine: Number.MAX_SAFE_INTEGER, endCol: Number.MAX_SAFE_INTEGER };
    return ( c( aFile, bFile ) ||
             c( a.$location.line, b.$location.line ) ||
             c( a.$location.col, b.$location.col ) ||
             c( aEnd.endLine, bEnd.endLine ) ||
             c( aEnd.endCol, bEnd.endCol ) ||
             c( homeSortName( a ), homeSortName( b ) ) ||
             c( a.message, b.message ) );
  }
  else if (!aFile && !bFile)
    return ( c( homeSortName( a ), homeSortName( b ) ) ||
             c( a.message, b.message ) );
  else if (!aFile)
    return (a.messageId && a.messageId.startsWith( 'api-' )) ? -1 : 1;
  else
    return (b.messageId && b.messageId.startsWith( 'api-' )) ? 1 : -1;

  function c( x, y ) {
    return (x === y) ? 0 : (x > y) ? 1 : -1;
  }
}

/**
 * Compare two messages `a` and `b`.  Return 0 if they are equal in both their
 * location and severity, >0 if `a` is larger than `b`, and <0 if `a` is smaller
 * than `b`. See `compareSeverities()` for how severities are compared.
 *
 * @param {CSN.Message} a
 * @param {CSN.Message} b
 */
function compareMessageSeverityAware( a, b ) {
  const c = compareSeverities(a.severity, b.severity);
  return c || compareMessage( a, b );
}

/**
 * Return sort-relevant part of semantic location (after the ':').
 * Messages without semantic locations are considered smaller (for syntax errors)
 * and (currently - should not happen in v2) larger for other messages.
 *
 * @param {CSN.Message} msg
 */
function homeSortName( { home, messageId } ) {
  return (!home)
    ? (messageId && /^(syntax|api)-/.test( messageId ) ? ' ' + messageId : '~')
    : home.substring( home.indexOf(':') ); // i.e. starting with the ':', is always there
}

/**
 * Removes duplicate messages from the given messages array without destroying
 * references to the array, i.e. removes them in-place.
 *
 * _Note_: Does NOT keep the original order!
 *
 * Two messages are the same if they have the same message hash. See messageHash().
 * If one of the two is more precise, then it replaces the other.
 * A message is more precise if it is contained in the other or if
 * the first does not have an endLine/endCol.
 *
 * @param {CSN.Message[]} messages
 */
function deduplicateMessages( messages ) {
  const seen = new Map();
  for (const msg of messages) {
    const hash = messageHash(msg);

    if (!seen.has(hash)) {
      seen.set(hash, msg);

    } else if (msg.$location) {
      const existing = seen.get(hash);
      // If this messages has an end but the existing does not, then the new message is more precise.
      // If both messages do (or don't) have an endLine, then compare them based on their location.
      // Assume that a message is more precise if it comes later (i.e. may be included in the other).
      if (msg.$location.endLine && !existing.$location.endLine ||
         (!msg.$location.endLine === !existing.$location.endLine && compareMessage(msg, existing) > 0)) {
        seen.set(hash, msg);
      }
    }
  }

  messages.length = 0;
  seen.forEach(msg => messages.push(msg));
}

function shortArtName( art ) {
  const { name } = art;
  if ([ 'select', 'action', 'alias', 'param' ].every( n => name[n] == null ) &&
      !name.absolute.includes(':'))
    return quote.name( name.element ? `${ name.absolute }:${ name.element }` : name.absolute );
  return artName( art );
}

function artName( art, omit ) {
  let name = art.name;
  let r = (name.absolute) ? [ quoted( name.absolute ) ] : [];
  if (name.select && name.select > 1 || name.select != null && art.kind !== 'element') // Yes, omit select:1 for element - TODO: re-check
    r.push( (art.kind === 'extend' ? 'block:' : 'query:') + name.select ); // TODO: rename to 'select:1' and consider whether there are more selects
  if (name.action && omit !== 'action')
    r.push( memberActionName(art) + ':' + quoted( name.action ) );
  if (name.alias)
    r.push( (art.kind === 'mixin' ? 'mixin:' : 'alias:') + quoted( name.alias ) )
  if (name.param != null && omit !== 'param')
    r.push( name.param ? 'param:' + quoted( name.param ) : 'returns' ); // TODO: join
  if (name.element && omit !== 'element')
    // r.push( `${ art.kind }: ${ quoted( name.element )}` ); or even better element:"assoc"/key:"i" same with enum
    r.push( (art.kind === 'enum' ? 'enum:' : 'element:') + quoted( name.element ) );
  return r.join('/');
}

function memberActionName( art ) {
  while (art && art._main) {
    if (art.kind === 'action' || art.kind === 'function')
      return art.kind;
    art = art._parent;
  }
  return 'action';
}

function homeName( art, absoluteOnly ) {
  if (!art)
    return art;
  if (art._outer)               // in returns / items property
    return homeName( art._outer, absoluteOnly );
  else if (art.kind === 'source' || !art.name) // error reported in parser or on source level
    return null;
  else if (art.kind === 'using')
    return 'using:' + quoted( art.name.id );
  else if (art.kind === 'extend')
    return !absoluteOnly && homeNameForExtend ( art );
  else if (art.name._artifact)             // block, extend, annotate
    return homeName( art.name._artifact, absoluteOnly ); // use corresponding definition
  else if (absoluteOnly)
    return art.name.absolute;
  else
    return (art._main ? art._main.kind : art.kind) + ':' + artName( art );
}

// The "home" for extensions is handled differently because `_artifact` is not
// set for unknown extensions and we could have nested extensions.
function homeNameForExtend( art ) {
  // TODO: fix the following - do like in collectArtifactExtensions() or
  // basically resolveUncheckedPath()
  const absoluteName = (art.name.id ? art.name.id :
      art.name.path.map(s => s && s.id).join('.'));

  // Surrounding parent may be another extension.
  const parent = art._parent;
  if (!parent)
    return 'extend:' + quoted(absoluteName);

  // And that extension's artifact could have been found.
  const parentArt = parent.name && parent.name._artifact;
  if (!parentArt)
    return artName(parent) + '/' + quoted(absoluteName);

  let extensionName;
  if (parentArt.enum || parentArt.elements) {
    const fakeArt = {
      kind: parentArt.enum ? 'enum' : 'element',
      name: { element: absoluteName }
    };
    extensionName = artName(fakeArt);
  }
  else {
    extensionName = 'extend:' + quoted(absoluteName);
  }
  // Even though the parent artifact was found, we use kind 'extend'
  // to make it clear that we are inside an (element) extension.
  return 'extend:' + artName(parentArt) + '/' + extensionName;
}

function constructSemanticLocationFromCsnPath(csnPath, model) {
  if (!model)
    return null;
  // Copy because this function shift()s from the path.
  csnPath = [ ...csnPath ];
  const csnDictionaries = [
    'args', 'params', 'enum', 'mixin', 'elements', 'actions', 'definitions',
  ];
  const queryProps = [ 'from', 'where', 'groupBy', 'having', 'orderBy', 'limit', 'offset' ];

  let { query } = analyseCsnPath(
    csnPath,
    model
  );

  // remove definitions
  csnPath.shift();
  const artName = csnPath.shift();
  let currentThing = model.definitions[artName];
  let result = `${ (currentThing && currentThing.kind) ? currentThing.kind : 'artifact' }:${ _quoted(artName) }`;

  if (!currentThing)
    return result;

  if (query)
    query = queryDepth(currentThing.query || { SELECT: currentThing.projection }, query);

  const elements = [];
  let inCsnDict = false;
  let inElement = false;
  let inAction = false;
  let inParam = false;
  let inKeys = false;
  let inRef = false;
  let inEnum = false;
  let inQuery = false;
  let inColumn = false;
  let inMixin = false;
  let inItems = false;

  // for top level actions
  if (currentThing.kind === 'action')
    inAction = true;
  for (const [ index, step ] of csnPath.entries()) {
    currentThing = currentThing[step];
    if (csnDictionaries.includes(step) && !inCsnDict) {
      inCsnDict = true;
      switch (step) {
        case 'elements':
          if (!inElement){
            inElement = true;
            // do not print intermediate items
            inItems = false;
          }
          break;
        case 'actions':
          inAction = true;
          break;
        case 'params':
          inParam = true;
          break;
        case 'enum':
          inElement = false;
          inEnum = true;
          break;
        case 'mixin':
          inMixin = true;
          inQuery = false;
          break;
        default:
          if (inElement) {
            // close element
            result += element();
            inElement = false;
          }
      }
    }
    else if ( inQuery ) {
      if (step === 'SELECT') {
        if (!csnPath[index + 1]) {
          result += select();
        }
        // only print last query prop for paths like
        // [... 'query', 'SELECT', 'from', 'SELECT', 'elements', 'struct'] -> select:2/element:"struct"
        // no from in the semantic location in this case
        else if (queryProps.includes(csnPath[index + 1]) && (!csnPath[index + 2] || query.isOnlySelect)) {
          const clause = csnPath[index + 1];
          result += select();
          result += `/${ clause }`;
        }
      }
      else if (step === 'columns') {
        result += select();
        result += '/column';
        inColumn = true;
        inQuery = false;
      }
      else if (inElement) {
        result += select();
        elements.push(step);
        inQuery = false;
      }
    }
    else if ( inMixin ) {
      if (step === 'on') {
        result += '/on';
        break;
      }
      else {
        result += selectAndMixin(step);
      }
    }
    else if (inEnum) {
      result += elementAndEnum(step);
    }
    else if (!inElement && step === 'query') {
      inQuery = true;
    }
    else if (inElement && step === 'keys') {
      // close element
      result += `${ element() }/key`;
      inElement = false;
      inKeys = true;
    }
    else if (inElement && step === 'on') {
      // close element
      result += `${ element() }/on`;
      inElement = false;
      break;
    }
    else if (inElement && step === 'items') {
      // this is an element called items
      if (csnPath[index - 1] === 'elements' && elements[elements.length - 1] !== 'elements') {
        elements.push(step);
      }
      else {
        inElement = false;
        inItems = true;
      }
    }
    else if (inElement && step === 'elements') {
      // this is an element called elements
      if (csnPath[index - 1] === 'elements')
        elements.push(step);
    }
    else if (inItems && step === 'elements') {
      inElement = true;
      inItems = false;
    }
    else if ( inKeys || inColumn) {
      if (typeof step === 'number') {
        if (currentThing.as)
          result += `:${ _quoted(currentThing.as) }`;
        else
          result += inRef ? `:${ _quoted(currentThing) }` : currentThing.ref ? `:${ _quoted(currentThing.ref.map(r => r.id ? r.id : r).join('.')) }` : '';

        break;
      }
      if ( step === 'ref')
        inRef = true;
    }
    else if (inAction && step === 'returns') {
      result += `/${ step }`;
      break;
    }
    else if (inCsnDict) {
      if (inElement)
        elements.push(step);
      else if (inParam)
        result += param(step);

      else if (inAction)
        result += func(step);

      inCsnDict = false;
    }
  }
  if ( inItems )
    result += `${ element() }/items`;
  else if ( inElement )
    result += element();
  return result;

  function select() {
    let s = '/select';
    s += query.isOnlySelect ? '' : `:${ query.depth }`;
    return s;
  }
  function selectAndMixin(name) {
    return `${ select() }/mixin:${ _quoted(name) }`;
  }
  function element() {
    return `/element:${ _quoted(elements.join('.')) }`;
  }
  function param(name) {
    return `/param:${ _quoted(name) }`;
  }
  function func(name) {
    return `/function:${ _quoted(name) }`;
  }
  function elementAndEnum(name) {
    return `${ element() }/enum:${ _quoted(name) }`;
  }

  /**
   * Traverse rootQuery until targetQuery is found and count the depth,
   * check if targetQuery is only select in entity.
   */
  function queryDepth(rootQuery, targetQuery) {
    let targetQueryDepth = 1;
    let totalQueryDepth = 0;

    let isFound = false;
    traverseQuery(rootQuery, null, null, (q, querySelect) => {
      if ( querySelect )
        totalQueryDepth += 1;
      if ( querySelect && !isFound)
        targetQueryDepth += 1;
      if (q === targetQuery)
        isFound = true;
    });
    return { depth: targetQueryDepth, isOnlySelect: totalQueryDepth === 1 };
  }
}


function _quoted( name ) {
  return (name) ? `"${ name.replace( /"/g, '""' ) }"` : '<?>'; // sync ";
}

/**
 * Get the explanation string for the given message-id.
 *
 * @param {string} messageId
 * @returns {string}
 * @throws May throw an ENOENT error if the file cannot be found.
 * @see hasMessageExplanation()
 */
function explainMessage(messageId) {
  const filename = path.join(__dirname, '..', '..', 'share', 'messages', `${messageId}.md`);
  return fs.readFileSync(filename, 'utf8');
}

/**
 * Returns true if the given message has an explanation file.
 *
 * @param {string} messageId
 * @returns {boolean}
 */
function hasMessageExplanation(messageId) {
  return messageId && _messageIdsWithExplanation.includes(messageId);
}

/**
 * Returns an array of message IDs that have an explanation text.
 */
function messageIdsWithExplanation() {
  return _messageIdsWithExplanation;
}

module.exports = {
  hasErrors,
  weakLocation,
  locationString,
  messageString,
  messageStringMultiline,
  messageContext,
  searchName,
  createMessageFunctions,
  makeMessageFunction,
  artName,
  handleMessages,
  sortMessages: (m => m.sort(compareMessage)),
  sortMessagesSeverityAware: (m => m.sort(compareMessageSeverityAware)),
  deduplicateMessages,
  CompileMessage,
  CompilationError,
  explainMessage,
  hasMessageExplanation,
  messageIdsWithExplanation,
  constructSemanticLocationFromCsnPath,
};
