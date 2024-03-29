// Error strategy with special handling for (non-reserved) keywords

// If a language has non-reserved keywords, any such keyword can be used at
// places where just a identifier is expected.  For doing so, we define a rule
//   ident : Identifier | NONRESERVED_1 | ... NONRESERVED_n ;
//
// Now consider another rule:
//   expected : RESERVED_j | NONRESERVED_k | ident ;
// If parsing fails at this place, you expect to see an message like
//   Mismatched input '?', expecting RESERVED_j, NONRESERVED_k, or Identifier
// With ANTLR's default error strategy, you unfortunately also see all other
// n-1 non-reserved keyword after "expecting"...
//
// The error strategy provided by this file gives you the expected message.
// The example above shows that it is not enough to just remove all
// non-reserved keywords from the expected-set.  The error strategy also allows
// you to match reserved keywords as identifiers at certain places (when there
// are no alternatives).

// For using this error strategy, the grammar for the parser/lexer must have a
// lexer rule `Number`, then rules for unreserved keywords, and finally a rule
// `Identifier`.  No tokens (which are used in parser rules) must be defined
// after that, no other rules must be defined in between those rules.

// This file is actually very ANTLR4 specific and should be checked against
// future versions of the ANTLR4-js runtime.  There is no need to look at this
// file if you just want to understand the rest of this compiler project.

'use strict';

const antlr4 = require('antlr4');
const IntervalSet = require('antlr4/IntervalSet');
const antlr4_error = require('antlr4/error/ErrorStrategy');
const antlr4_LL1Analyzer = require('antlr4/LL1Analyzer.js').LL1Analyzer;
const predictionContext = require('antlr4/PredictionContext').predictionContextFromRuleContext;
const { ATNState } = require('antlr4/atn/ATNState');
const { InputMismatchException } = antlr4.error;

const keywordRegexp = /^[a-zA-Z]+$/; // we don't have keywords with underscore

let SEMI = null;
let RBRACE = null;

// Match current token against token type `ttype` and consume it if successful.
// Also allow to match keywords as identifiers.  This function should be set as
// property `match` to the parser (prototype).  See also `recoverInline()`.
function match( ttype ) {
  const identType = this.constructor.Identifier;
  if (ttype !== identType)
    return antlr4.Parser.prototype.match.call( this, ttype );

  const token = this.getCurrentToken();
  if (token.type === identType || !keywordRegexp.test( token.text ))
    return antlr4.Parser.prototype.match.call( this, ttype );

  this.message( 'syntax-fragile-ident', token, { id: token.text, delimited: token.text },
                '$(ID) is a reserved name here - write $(DELIMITED) instead if you want to use it' );
  this._errHandler.reportMatch(this);
  this.consume();
  return token;
}

// Class which adapts ANTLR4s standard error strategy: do something special
// with (non-reserved) keywords.
//
// An instance of this class should be set as property `_errHandler` to the
// parser (prototype).
function KeywordErrorStrategy( ...args ) {
  antlr4_error.DefaultErrorStrategy.call( this, ...args );
}
const super1 = antlr4_error.DefaultErrorStrategy.prototype;

KeywordErrorStrategy.prototype = Object.assign(
  Object.create( super1 ), {
    sync,
    reportNoViableAlternative,
    reportInputMismatch,
    reportUnwantedToken,
    reportMissingToken,
    reportIgnoredWith,
    // getErrorRecoverySet,
    consumeUntil,
    recoverInline,
    getMissingSymbol,
    getExpectedTokensForMessage,
    getTokenDisplay,
    constructor: KeywordErrorStrategy,
  }
);

// Attemp to recover from problems in subrules, except if rule has defined a
// local variable `_sync` with value 'nop'
function sync( recognizer ) {
  // If already recovering, don't try to sync
  if (this.inErrorRecoveryMode(recognizer))
    return;

  const token = recognizer.getCurrentToken();
  if (!token)
    return;

  const s = recognizer._interp.atn.states[recognizer.state];
  // try cheaper subset first; might get lucky. seems to shave a wee bit off
  const nextTokens = recognizer.atn.nextTokens(s);
  // console.log('SYNC:', recognizer._ctx._sync, s.stateType, token.text, intervalSetToArray( recognizer, nextTokens ))

  if (nextTokens.contains(token.type)) { // we are sure the token matches
    if (token.text === '}' && recognizer.$nextTokensToken !== token &&
        nextTokens.contains(SEMI)) {
      // if the '}' could be matched alternative to ';', we had an opt ';' (rule requiredSemi)
      recognizer.$nextTokensToken = token;
      recognizer.$nextTokensState = recognizer.state;
      recognizer.$nextTokensContext = recognizer._ctx;
    }
    return;
  }
  // TODO: expected token is identifier, current is KEYWORD

  if (nextTokens.contains(antlr4.Token.EPSILON)) {
    if (recognizer.$nextTokensToken !== token) {
      // console.log('SET:',token.type,recognizer.state,recognizer.$nextTokensToken && recognizer.$nextTokensToken.type)
      recognizer.$nextTokensToken = token;
      recognizer.$nextTokensState = recognizer.state;
      recognizer.$nextTokensContext = recognizer._ctx;
    }
    return;
  }

  if (recognizer._ctx._sync === 'nop')
    return;
  switch (s.stateType) {
    case ATNState.BLOCK_START:
    case ATNState.STAR_BLOCK_START:
    case ATNState.PLUS_BLOCK_START:
    case ATNState.STAR_LOOP_ENTRY:
      // report error and recover if possible
      if ( token.text !== '}' &&                          // do not just delete a '}'
          this.singleTokenDeletion(recognizer) !== null) { // also calls reportUnwantedToken
        return;
      }
      else if (recognizer._ctx._sync === 'recover') {
        this.reportInputMismatch( recognizer, new InputMismatchException(recognizer) );
        this.consumeUntil( recognizer, nextTokens );
        return;
      }
      throw new InputMismatchException(recognizer);

    case ATNState.PLUS_LOOP_BACK:
    case ATNState.STAR_LOOP_BACK: {
      // TODO: do not delete a '}'
      this.reportUnwantedToken(recognizer);
      const expecting = new IntervalSet.IntervalSet();
      expecting.addSet(recognizer.getExpectedTokens());
      const whatFollowsLoopIterationOrRule = expecting.addSet(this.getErrorRecoverySet(recognizer));
      this.consumeUntil(recognizer, whatFollowsLoopIterationOrRule);
      break;
    }
    default:
    // do nothing if we can't identify the exact kind of ATN state
  }
}

// singleTokenInsertion called by recoverInline (called by match / in else),
// calls reportMissingToken

// Report `NoViableAltException e` signalled by parser `recognizer`
function reportNoViableAlternative( recognizer, e ) {
  // console.log('NOV:',this.getTokenErrorDisplay(e.startToken), this.getTokenErrorDisplay(e.offendingToken))
  if (e.startToken === e.offendingToken) { // mismatch at LA(1)
    this.reportInputMismatch( recognizer, e );
  }
  else {
    this.reportInputMismatch( recognizer, e, !e.deadEndConfigs || e.deadEndConfigs.configs );
    do {
      // console.log('CONSUME-NOVIA:',this.getTokenErrorDisplay(recognizer.getCurrentToken()));
      recognizer.consume();
    } while (recognizer.getCurrentToken() !== e.offendingToken);
    // this.lastErrorIndex = e.startToken.tokenIndex; // avoid another consume()
  }
}

// Report `InputMismatchException e` signalled by parser `recognizer``
function reportInputMismatch( recognizer, e, deadEnds ) {
  const expecting = deadEnds !== true && // true: cannot compute expecting
                  this.getExpectedTokensForMessage( recognizer, e.offendingToken, deadEnds );
  const offending = this.getTokenDisplay( e.offendingToken, recognizer );
  let err;
  if (expecting && expecting.length) {
    err = recognizer.error( 'syntax-mismatched-token', e.offendingToken,
                            { offending, expecting },
                            'Mismatched $(OFFENDING), expecting $(EXPECTING)' );
    err.expectedTokens = expecting;
  }
  else {                        // should not really happen anymore... -> no messageId !
    err = recognizer.error( null, e.offendingToken, { offending },
                            'Mismatched $(OFFENDING)' );
  }
  if (!recognizer.avoidErrorListeners) // with --trace-parser or --trace-parser-ambig
    recognizer.notifyErrorListeners( err.message, e.offendingToken, err );
}

// Report unwanted token when the parser `recognizer` tries to recover/sync
function reportUnwantedToken( recognizer ) {
  if (this.inErrorRecoveryMode(recognizer))
    return;
  this.beginErrorCondition(recognizer);

  const token = recognizer.getCurrentToken();
  const expecting = this.getExpectedTokensForMessage( recognizer, token );
  const offending = this.getTokenDisplay( token, recognizer );
  const err = recognizer.error( 'syntax-extraneous-token', token,
                                { offending, expecting },
                                'Extraneous $(OFFENDING), expecting $(EXPECTING)' );
  err.expectedTokens = expecting; // TODO: remove next token?
  if (!recognizer.avoidErrorListeners) // with --trace-parser or --trace-parser-ambig
    recognizer.notifyErrorListeners( err.message, token, err );
}

// Report missing token when the parser `recognizer` tries to recover/sync
function reportMissingToken( recognizer ) {
  if ( this.inErrorRecoveryMode(recognizer))
    return;
  this.beginErrorCondition(recognizer);

  const token = recognizer.getCurrentToken();
  const expecting = this.getExpectedTokensForMessage( recognizer, token );
  const offending = this.getTokenDisplay( token, recognizer );
  // TODO: if non-reserved keyword will not been parsed as keyword, use Identifier for offending
  const err = recognizer.error( 'syntax-missing-token', token,
                                { offending, expecting },
                                'Missing $(EXPECTING) before $(OFFENDING)' );
  err.expectedTokens = expecting;
  if (!recognizer.avoidErrorListeners) // with --trace-parser or --trace-parser-ambig
    recognizer.notifyErrorListeners( err.message, token, err );
}

function reportIgnoredWith( recognizer, t ) {
  const next = recognizer._interp.atn.states[recognizer.state].transitions[0].target;
  recognizer.state = next.stateNumber; // previous match() does not set the state
  const expecting = this.getExpectedTokensForMessage( recognizer, t );
  const m = recognizer.warning( 'syntax-ignored-with', t,
                                { offending: "';'", expecting },
                                'Unexpected $(OFFENDING), expecting $(EXPECTING) - ignored previous WITH' );
  m.expectedTokens = expecting;
}

function consumeUntil( recognizer, set ) {
  // TODO: add trace
  if (SEMI == null)
    SEMI = recognizer.literalNames.indexOf( "';'" );
  if (RBRACE == null)
    RBRACE = recognizer.literalNames.indexOf( "'}'" );

  // let s=this.getTokenDisplay( recognizer.getCurrentToken(), recognizer );
  if (SEMI < 1 || RBRACE < 1) {
    super1.consumeUntil.call( this, recognizer, set );
  }
  else if (set.contains(SEMI)) { // do not check for RBRACE here!
    super1.consumeUntil.call( this, recognizer, set );
    // console.log('CONSUMED-ORIG:',s,this.getTokenDisplay( recognizer.getCurrentToken(), recognizer ),recognizer.getCurrentToken().line,intervalSetToArray( recognizer, set ));
  }
  else {
    // DO NOT modify input param `set`, as the set might be cached in the ATN
    const stop = new IntervalSet.IntervalSet();
    stop.addSet( set );
    stop.removeOne( recognizer.constructor.Identifier );
    stop.addOne( SEMI );
    // I am not that sure whether to add RBRACE...
    stop.addOne( RBRACE );
    super1.consumeUntil.call( this, recognizer, stop );
    if (recognizer.getTokenStream().LA(1) === SEMI ||
        recognizer.getTokenStream().LA(1) === RBRACE && !set.contains(RBRACE)) {
      recognizer.consume();
      this.reportMatch(recognizer); // we know current token is correct
    }
    // if matched '}', also try to match next ';' (also matches double ';')
    if (recognizer.getTokenStream().LA(1) === SEMI) {
      recognizer.consume();
      this.reportMatch(recognizer); // we know current token is correct
    }
    // console.log('CONSUMED:',s,this.getTokenDisplay( recognizer.getCurrentToken(), recognizer ),recognizer.getCurrentToken().line);
    // throw new Error('Sync')
  }
}


// As the `match` function of the parser `recognizer` does not allow to check
// against a set of token types, the generated parser code checks against that
// set itself and calls this function if not successful.
// We now also allow keywords if the Identifier is expected.
// Called by match() and in generated parser in "else part" before consume()
// for ( TOKEN1 | TOKEN2 )
function recoverInline( recognizer ) {
  const identType = recognizer.constructor.Identifier;
  if (!identType || !recognizer.isExpectedToken( identType ))
    return super1.recoverInline.call( this, recognizer );

  const token = recognizer.getCurrentToken();
  if (!keywordRegexp.test( token.text ))
    return super1.recoverInline.call( this, recognizer );

  recognizer.message( 'syntax-fragile-ident', token, { id: token.text, delimited: token.text },
                      '$(ID) is a reserved name here - write $(DELIMITED) instead if you want to use it' );
  this.reportMatch(recognizer); // we know current token is correct
  recognizer.consume();
  return token;
}

// Conjure up a missing token during error recovery in parser `recognizer`.  If
// an identifier is expected, create one.
// Think about: we might want to prefer one of '}]);,'.
function getMissingSymbol( recognizer ) {
  const expectedTokenType = this.getExpectedTokens(recognizer).first(); // get any element
  const current = recognizer.getCurrentToken();
  return recognizer.getTokenFactory().create(
    current.source,             // do s/th special if EOF like in DefaultErrorStrategy ?
    expectedTokenType, '', antlr4.Token.DEFAULT_CHANNEL, // empty string as token text
    -1, -1, current.line, current.column
  );
}

function intervalSetToArray( recognizer, expected, excludesForNextToken ) {
  // similar to `IntervalSet#toTokenString`
  let names = [];
  const pc = recognizer.constructor;
  for (const v of expected.intervals) {
    for (let j = v.start; j < v.stop; j++) {
      // a generic keyword as such does not appear in messages, only its replacements,
      // which are function name and argument position dependent:
      if (j === pc.GenericArgFull)
        names.push( ...recognizer.$genericKeywords.argFull );
      // other expected tokens usually appear in messages, except the helper tokens
      // which are used to solve ambiguities via the parser method setLocalToken():
      else if (j !== pc.HelperToken1 && j !== pc.HelperToken2)
        names.push( expected.elementName(recognizer.literalNames, recognizer.symbolicNames, j ) );
    }
  }
  // The parser method excludeExpected() additionally removes some tokens from the message:
  if (recognizer.$adaptExpectedToken && recognizer.$nextTokensToken === recognizer.$adaptExpectedToken) {
    const excludes = (excludesForNextToken && Array.isArray(recognizer.$adaptExpectedExcludes[0]))
      ? recognizer.$adaptExpectedExcludes[0]
      : recognizer.$adaptExpectedExcludes;
    names = names.filter( n => !excludes.includes( n ) );
  }
  else if (names.includes("';'")) {
    names = names.filter( n => n !== "'}'" );
  }
  names.sort( (a, b) => (tokenPrecedence(a) < tokenPrecedence(b) ? -1 : 1) );
  return names;
}

const token1sort = {
  // 0: Identifier, Number, ...
  // 1: separators:
  ',': 1, '.': 1, ':': 1, ';': 1,
  // 2: parentheses:
  '(': 2, ')': 2, '[': 2, ']':2, '{': 2, '}': 2,
  // 3: special:
  '!': 3, '#': 3, '$': 3, '?': 3, '@': 3,
  // 4: operators:
  '*': 4, '+': 4, '-': 4, '/': 4, '<': 4, '=': 4, '>': 4, '|': 4,
  // 8: KEYWORD
  // 9: <EOF>
};

function tokenPrecedence( name ) {
  if (name.length < 2 || name === '<EOF>')
    return `9${ name }`;
  const prec = token1sort[name.charAt(1)];
  if (prec)
    return `${ prec }${ name }`;
  return (name.charAt(1) < 'a' ? '8' : '0') + name;
}

function getTokenDisplay( token, recognizer ) {
  if (!token)
    return '<EOF>';
  const t = token.type;
  if (t === antlr4.Token.EOF || t === antlr4.Token.EPSILON )
    return '<EOF>';
  else if (token.text === '.')  // also for DOTbeforeBRACE
    return "'.'";
  return recognizer.literalNames[t] || recognizer.symbolicNames[t];
}

// Return an IntervalSet of token types which the parser had expected.  Do not
// include non-reserved keywords if not mentioned explicitly (i.e. other than
// from rule `ident`).
//
// We actually define something like a corrected version of function
// `LL1Analyzer.prototype.getDecisionLookahead`.  We cannot just redefine
// `getExpectedTokens`, because that function is also used to decide whether
// to consume in `DefaultErrorStrategy#singleTokenDeletion`.
function getExpectedTokensForMessage( recognizer, offendingToken, deadEnds ) {
  const { atn } = recognizer._interp;
  if (recognizer.state < 0)
    return [];
  if (recognizer.state >= atn.states.length) {
    throw ( `Invalid state number ${ recognizer.state } for ${
      this.getTokenErrorDisplay( offendingToken ) }`);
  }

  const identType = recognizer.constructor.Identifier;
  const hideAltsType = recognizer.constructor.HideAlternatives;
  const beforeUnreserved = recognizer.constructor.Number;
  if (!identType || !beforeUnreserved || beforeUnreserved + 2 > identType)
    return intervalSetToArray( recognizer, super1.getExpectedTokens.call( this, recognizer ) );

  const ll1 = new antlr4_LL1Analyzer(atn);
  const expected = new IntervalSet.IntervalSet();
  const orig_addInterval = expected.addInterval;
  const orig_addSet = expected.addSet;
  expected.addInterval = addInterval;
  expected.addSet = addSet;
  const lookBusy = new antlr4.Utils.Set();
  const calledRules = new antlr4.Utils.BitSet();

  if (deadEnds) {
    // "No viable alternative" by adaptivePredict() not on first token
    for (const trans of deadEnds) {
      ll1._LOOK( trans.state, null, predictionContext( atn, recognizer._ctx ),
                 expected, lookBusy, calledRules, true, true );
    }
    return intervalSetToArray( recognizer, expected, true );
  }
  else if (offendingToken && recognizer.$nextTokensContext &&
           offendingToken === recognizer.$nextTokensToken) {
    // We have a state (via sync())  with more "expecting" for the same token
    ll1._LOOK( atn.states[recognizer.$nextTokensState], null,
               predictionContext( atn, recognizer.$nextTokensContext ),
               expected, lookBusy, calledRules, true, true );
  }
  else {
    // Use current state to compute "expecting"
    ll1._LOOK( atn.states[recognizer.state], null,
               predictionContext( atn, recognizer._ctx ),
               expected, lookBusy, calledRules, true, true );
  }
  // console.log(state, recognizer.$nextTokensState, expected.toString(recognizer.literalNames, recognizer.symbolicNames));
  return intervalSetToArray( recognizer, expected );

  function addSet(other) {
    if (!other.contains( hideAltsType ))
      orig_addSet.call( this, other );
  }

  // Add an interval `v` to the IntervalSet `this`.  If `v` contains the token
  // type `Identifier`, do not add non-reserved keywords in `v`.
  function addInterval(v) {
    if (v.stop <= identType) {
      orig_addInterval.call(this, v);
    }
    else if (v.start >= identType) {
      if (v.stop === identType + 1 || !recognizer.tokenRewrite) {
        orig_addInterval.call(this, v);
      }
      else {
        for (let j = v.start; j < v.stop; j++)
          addRange( this, recognizer.tokenRewrite[j - identType] || j );
      }
    }
    else {
      if (v.start <= beforeUnreserved)
        addRange( this, v.start, beforeUnreserved + 1 );
      addRange( this, identType );
    }
  }

  function addRange( interval, start, stop ) {
    orig_addInterval.call( interval, new IntervalSet.Interval( start, stop || start + 1 ) );
  }
}

module.exports = {
  match,
  KeywordErrorStrategy,
};
