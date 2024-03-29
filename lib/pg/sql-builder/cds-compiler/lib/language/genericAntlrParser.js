// Generic ANTLR parser class with AST-building functions

// To have an AST also in the case of syntax errors, produce it by adding
// sub-nodes to a parent node, not by returning sub-ASTs (the latter is fine
// for secondary attachments).

'use strict';

const antlr4 = require('antlr4');
const { ATNState } = require('antlr4/atn/ATNState');
const { dictAdd, dictAddArray } = require('../base/dictionaries');
const locUtils = require('../base/location');
const { parseDocComment } = require('./docCommentParser');
const { functionsWithoutParens, specialFunctions } = require('../compiler/builtins');


// Push message `msg` with location `loc` to array of errors:
function _message( parser, severity, id, loc, ...args ) {
  const msg = parser.$messageFunctions[severity]; // set in antlrParser.js
  return msg( id,
              (loc instanceof antlr4.CommonToken) ? parser.tokenLocation(loc) : loc, ...args );
}

// Class which is to be used as grammar option with
//   grammar <name> options { superclass = genericAntlrParser; }
//
// The individual AST building functions are to be used with
//   this.<function>(...)
// in the actions inside the grammar.
//
function GenericAntlrParser( ...args ) {
  // ANTLR restriction: we cannot add parameters to the constructor.
  antlr4.Parser.call( this, ...args );
  this.buildParseTrees = false;
  return this;
}

// When we define this class with the ES6 `class` syntax, we get
//   TypeError: Class constructors cannot be invoked without 'new'
// Reason: the generated ANTLR constructor calls its super constructor via
// old-style `<super>.call(this,...)`, not via `super(...)`.

GenericAntlrParser.prototype = Object.assign(
  Object.create( antlr4.Parser.prototype ), {
    message: function(...args) { return _message( this, 'message', ...args ); },
    error: function(...args) { return _message( this, 'error', ...args ); },
    warning: function(...args) { return _message( this, 'warning', ...args ); },
    info: function(...args) { return _message( this, 'info', ...args ); },
    attachLocation,
    startLocation,
    tokenLocation,
    combinedLocation,
    surroundByParens,
    unaryOpForParens,
    leftAssocBinaryOp,
    classifyImplicitName,
    fragileAlias,
    identAst,
    functionAst,
    valuePathAst,
    signedExpression,
    numberLiteral,
    quotedLiteral,
    pathName,
    docComment,
    addDef,
    addItem,
    assignProps,
    createPrefixOp,
    setOnce,
    setMaxCardinality,
    pushIdent,
    handleComposition,
    reportExpandInline,
    notSupportedYet,
    csnParseOnly,
    noAssignmentInSameLine,
    noSemicolonHere,
    setLocalToken,
    setLocalTokenIfBefore,
    excludeExpected,
    isStraightBefore,
    meltKeywordToIdentifier,
    prepareGenericKeywords,
    constructor: GenericAntlrParser, // keep this last
  }
);

// Patterns for literal token tests and creation.  The value is a map from the
// `prefix` argument of function `quotedliteral` to the following properties:
//  - `test_msg`: error message which is issued if `test_fn` or `test_re` fail.
//  - `test_fn`: function called with argument `value`, fails falsy return value
//  - `test_re`: regular expression, fails if it does not match argument `value`
//  - `unexpected_msg`: error message which is issued if `unexpected_char` matches
//  - `unexpected_char`: regular expression matching an illegal character in `value`,
//    the error location is only correct for a literal <prefix>'<value>'
//  - `literal`: the value which is used instead of `prefix` in the AST
//  - `normalized`: function called with argument `value`, return value is used
//    instead of `value` in the AST
// TODO: think about laxer regexp for date/time/timestamp - normalization?
const quotedLiteralPatterns = {
  x: {
    test_msg: 'A binary literal must have an even number of characters',
    test_fn: (str => Number.isInteger(str.length / 2)),
    unexpected_msg: 'A binary literal must only contain characters 0-9, a-f and A-F',
    unexpected_char: /[^0-9a-f]/i,
  },
  time: {
    test_msg: 'Expected time\'HH:MM:SS\' where H, M and S are numbers and \':SS\' is optional',
    test_re: /^[0-9]{1,2}:[0-9]{1,2}(:[0-9]{1,2})?$/,
  },
  date: {
    test_msg: 'Expected date\'YYYY-MM-DD\' where Y, M and D are numbers',
    test_re: /^[0-9]{1,4}-[0-9]{1,2}-[0-9]{1,2}$/,
  },
  timestamp: {
    test_msg: 'Expected timestamp\'YYYY-MM-DD HH:MM:SS.u…u\' where Y, M, D, H, S and u are numbers (optional 1-7×u)',
    test_re: /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,7})?)?$/,
  },
};

// Use the following function for language constructs which we (currently)
// just being able to parse, in able to run tests from HANA CDS.  As soon as we
// create ASTs for the language construct and put it into a CSN, a
// corresponding check should actually be inside the compiler, because the same
// language construct can come from a CSN as source.
// TODO: this is not completely done this way

function notSupportedYet( text, ...tokens ) {
  if (!text)
    return;
  if (typeof text !== 'string') {
    tokens = [ text, ...tokens ];
    text = `${ tokens.map( t => t.text.toUpperCase() ).join(' ') } is not supported`;
  }
  this.error( null, this.tokenLocation( tokens[0], tokens[tokens.length - 1] ), text );
}

// Use the following function for language constructs which we (currently) do
// not really compile, just use to produce a CSN for functions parseToCqn() and
// parseToExpr().
function csnParseOnly( text, ...tokens ) {
  if (!text || this.options.parseOnly)
    return;
  if (typeof text !== 'string') {
    tokens = [ text, ...tokens ];
    text = `${ tokens.map( t => t.text.toUpperCase() ).join(' ') } is not supported`;
  }
  this.error( null, this.tokenLocation( tokens[0], tokens[tokens.length - 1] ), text );
}

 /** @this {object} */
function noSemicolonHere() {
  const handler = this._errHandler;
  const t = this.getCurrentToken();
  this.$adaptExpectedToken = t;
  this.$adaptExpectedExcludes = [ "';'", "'}'" ];
  this.$nextTokensToken = t;
  this.$nextTokensContext = null; // match() of WITH does not reset
  this.$nextTokensState = ATNState.INVALID_STATE_NUMBER;
  if (t.text === ';' && handler && handler.reportIgnoredWith )
    handler.reportIgnoredWith( this, t );
}

// Using this function "during ATN decision making" has no effect
// In front of an ATN decision, you might specify dedicated excludes
// for non-LA1 tokens via a sub-array in excludes[0].
function excludeExpected( excludes ) {
  if (excludes) {
    // @ts-ignore
    const t = this.getCurrentToken();
    this.$adaptExpectedToken = t;
    this.$adaptExpectedExcludes = Array.isArray(excludes) ? excludes : [ excludes ];
    this.$nextTokensToken = t;
    this.$nextTokensContext = null;
  }
}

function setLocalToken( string, tokenName, notBefore, inSameLine ) {
  const ll1 = this.getCurrentToken();
  if (ll1.text.toUpperCase() === string &&
      (!inSameLine || this._input.LT(-1).line === ll1.line) &&
      (!notBefore || !notBefore.test( this._input.LT(2).text )))
    ll1.type = this.constructor[tokenName];
}

function setLocalTokenIfBefore( string, tokenName, before, inSameLine ) {
  const ll1 = this.getCurrentToken();
  if (ll1.text.toUpperCase() === string &&
      (!inSameLine || this._input.LT(-1).line === ll1.line) &&
      (!before || before && before.test( this._input.LT(2).text )))
    ll1.type = this.constructor[tokenName];
}

// // Special function for rule `requiredSemi` before return $ctx
// function braceForSemi() {
//   if (RBRACE == null)
//     RBRACE = this.literalNames.indexOf( "'}'" );
//   console.log(RBRACE)
//   // we are called before match('}') and this.state = ...
//   let atn = this._interp.atn;
//   console.log( atn.nextTokens( atn.states[ this.state ], this._ctx ) )
//   let next = atn.states[ this.state ].transitions[0].target;
//   // if a '}' is not possible in the grammar after the fake-'}', throw error
//   if (!atn.nextTokens( next, this._ctx ).contains(RBRACE))
//     console.log( atn.nextTokens( next, this._ctx ) )
//     // throw new antlr4.error.InputMismatchException(this);
// }

function noAssignmentInSameLine() {
  const t = this.getCurrentToken();
  if (t.text === '@' && t.line <= this._input.LT(-1).line) {
    this.warning( 'syntax-anno-same-line', t, {},
                  'Annotation assignment belongs to next statement' );
  }
}

// Use after matching ',' to allow ',' in front of the closing paren.  Be sure
// that you know what to do if successful - break/return/... = check the
// generated grammar; inside loops, you can use `break`.  This function is
// still the preferred way to express an optional ',' at the end, because it
// does not influence the error reporting.  It might also allow to match
// reserved keywords, because there is no ANTLR generated decision in front of it.
function isStraightBefore( closing ) {
  return this.getCurrentToken().text === closing;
}

function meltKeywordToIdentifier( exceptTrueFalseNull = false ) {
  const { Identifier } = this.constructor;
  const token = this.getCurrentToken() || { type: Identifier };
  if (token.type < Identifier && /^[a-z]+$/i.test( token.text ) &&
      !(exceptTrueFalseNull && /^(true|false|null)$/i.test( token.text )))
    token.type = Identifier;
}

function prepareGenericKeywords( pathItem ) {
  this.$genericKeywords = { argFull: [] };
  if (!pathItem)
    return;
  const func = pathItem.id && specialFunctions[pathItem.id.toUpperCase()];
  const spec = func && func[pathItem.args ? pathItem.args.length : 0];
  if (!spec)
    return;
  // currently, we only have 'argFull', i.e. a keyword which is alternative to expression
  // TODO: If not just at the beginning, we need a stack for $genericKeywords,
  // as we can have nested special functions
  this.$genericKeywords.argFull = Object.keys( spec );
  const token = this.getCurrentToken() || { text: '' };
  if (spec[token.text.toUpperCase()] === 'argFull')
    token.type = this.constructor.GenericArgFull;
}

// Attach location matched by current rule to node `art`.  If a location is
// already provided, only set the end location.  Use this function only
// in @after actions of parser rules, as the end position is only available
// there.
function attachLocation( art ) {
  if (!art || art.$parens)
    return art;
  if (!art.location)
    art.location = this.startLocation();
  const { stop } = this._ctx;
  art.location.endLine = stop.line;
  art.location.endCol = stop.stop - stop.start + stop.column + 2; // after the last char (special for EOF?)
  return art;
}

/**
 * Return start location of `token`, or the first token matched by the current
 * rule if `token` is undefined
 *
 * @returns {CSN.Location}
 */
function startLocation( token = this._ctx.start ) {
  return {
    file: this.filename,
    line: token.line,
    col: token.column + 1,
  };
}

/**
 * Return location of `token`.  If `endToken` is provided, use its end
 * location as end location in the result.
 *
 * @param {object} token
 * @param {object} endToken
 * @param {any} val
 */
function tokenLocation( token, endToken, val ) {
  if (!token)
    return undefined;
  if (!endToken)                // including null
    endToken = token;
  /** @type {CSN.Location} */
  const r = {
    file: this.filename,
    line: token.line,
    col: token.column + 1,
    // we only have single-line tokens
    endLine: endToken.line,
    endCol: endToken.stop - endToken.start + endToken.column + 2, // after the last char (special for EOF?)
  };
  if (val !== undefined)
    return { location: r, val };
  return r;
}

// Create a location with location properties `filename` and `start` from
// argument `start`, and location property `end` from argument `end`.
function combinedLocation( start, end ) {
  if (!start || !start.location)
    start = { location: this.startLocation() };
  return locUtils.combinedLocation( start, end );
}

function surroundByParens( expr, open, close, asQuery = false ) {
  if (!expr)
    return expr;
  const location = this.tokenLocation( open, close );
  if (expr.$parens)
    expr.$parens.push( location );
  else
    expr.$parens = [ location ];
  return (asQuery) ? { query: expr, location } : expr;
}

function unaryOpForParens( query, val ) {
  const parens = query.$parens;
  if (!parens)
    return query;
  const location = parens[parens.length - 1];
  return { op: { val, location }, location, args: [query] };
}

// If the token before the current one is a doc comment (ignoring other tokens
// on the hidden channel), put its "cleaned-up" text as value of property `doc`
// of arg `node` (which could be an array).  Complain if `doc` is already set.
//
// The doc comment token is not a non-hidden token for the following reasons:
//  - misplaced doc comments would lead to a parse error (incompatible),
//  - would influence the prediction, probably even induce adaptivePredict() calls,
//  - is only slightly "more declarative" in the grammar.
function docComment( node ) {
  if (!this.options.docComment)
    return;
  const token = this._input.getHiddenTokenToLeft( this.constructor.DocComment );
  if (!token)
    return;
  if (node.doc) {
    this.warning( 'syntax-duplicate-doc-comment', token, {},
                  'Repeated doc comment - previous doc is replaced' );
  }
  node.doc = this.tokenLocation( token, token, parseDocComment( token.text ) );
}

// Classify token (identifier category) for implicit names,
// to be used in the empty alternative to AS <explicitName>.
function classifyImplicitName( category, ref ) {
  if (!ref || ref.path && this.getCurrentToken().text !== '.') {
    const implicit = this._input.LT(-1);
    if (implicit.isIdentifier)
      implicit.isIdentifier = category;
  }
}

function fragileAlias( ast, safe = false ) {
  if (safe || ast.$delimited || !/^[a-zA-Z][a-zA-Z_]+$/.test( ast.id ))
    this.warning( 'syntax-sloppy-alias', ast.location, { keyword: 'as' },
                  'Please add the keyword $(KEYWORD) in front of the alias name' );
  else                          // configurable error
    this.message( 'syntax-fragile-alias', ast.location, { keyword: 'as' },
                  'Please add the keyword $(KEYWORD) in front of the alias name' );
  return ast;
}

// Return AST for identifier token `token`.  Also check that identifer is not empty.
function identAst( token, category ) {
  token.isIdentifier = category;
  let id = token.text;
  if (token.type !== this.constructor.Identifier && !/^[a-zA-Z]+$/.test( id ))
    id = '';
  if (token.text[0] === '!') {
    id = id.slice( 2, -1 ).replace( /]]/g, ']' );
    if (!id) {
      this.error( 'syntax-empty-ident', token, {},
                  'Delimited identifier must contain at least one character' );
    }
    // $delimited is used to complain about ![$self] and other magic vars usage;
    // we might complain about that already here via @arg{category}
    return { id, $delimited: true, location: this.tokenLocation( token ) };
  }
  if (token.text[0] !== '"')
    return { id, location: this.tokenLocation( token ) };
  // delimited:
  id = id.slice( 1, -1 ).replace( /""/g, '"' );
  if (!id) {
    this.error( 'syntax-empty-ident', token, {},
                'Delimited identifier must contain at least one character' );
  }
  else {
    this.message( 'syntax-deprecated-ident', token, { delimited: id },
                  'Deprecated delimited identifier syntax, use $(DELIMITED) - strings are delimited by single quotes' );
  }
  return { id, $delimited: true, location: this.tokenLocation( token ) };
}

function functionAst( token, xprToken ) {
  // TODO: XSN func cleanup
  const location = this.tokenLocation( token );
  const args = xprToken
    ? [ { op: { location, val: 'xpr' }, args: [], location: this.tokenLocation( xprToken ) } ]
    : [];
  return {
    op: { location, val: 'call' },
    func: { path: [ { id: token.text, location, args } ], location },
    args,
    location,
  };
}

function valuePathAst( ref ) {
  // TODO: XSN representation of functions is a bit strange - rework if methods
  // are introduced
  const { path } = ref;
  if (!path || path.broken)
    return ref;
  if (path.length !== 1) {
    const item = path.find( i => i.args && i.$syntax !== ':' );
    if (!item)
      return ref;
    this.error( 'syntax-not-supported', item.location,
                'Methods in expressions are not supported yet' );
    path.broken = true;
    path.length = 1;
  }
  const { args, id, location } = path[0];
  if (args) {
    if (path[0].$syntax !== ':')
      return { op: { location, val: 'call' }, func: ref, location: ref.location, args };
  }
  else if (!path[0].$delimited && functionsWithoutParens.includes( id.toUpperCase() )) {
    return { op: { location, val: 'call' }, func: ref, location: ref.location };
  }
  return ref;
}

// If a '-' is directly before an unsigned number, consider it part of the number;
// otherwise (including for '+'), represent it as extra unary prefix operator.
function signedExpression( signToken, expr ) {
  const sign = this.tokenLocation( signToken, undefined, signToken.text );
  const nval =
        (signToken.text === '-' &&
        expr && // expr may be null if `-` rule can't be parsed
        expr.literal === 'number' &&
        sign.location.endLine === expr.location.line &&
        sign.location.endCol === expr.location.col &&
        (typeof expr.val === 'number'
         ? expr.val >= 0 && -expr.val
         : !expr.val.startsWith('-') && `-${ expr.val }`)) || false;
  if (nval === false)
    return { op: sign, args: expr ? [ expr ] : [] };
  expr.val = nval;
  --expr.location.col;
  return expr;
}

// Return AST for number token `token` with optional token `sign`.  Represent
// the number as number in property `val` if the number can safely be
// represented as an integer.  Otherwise, represent the number by a string, the
// token lexeme.
function numberLiteral( token, sign, text = token.text ) {
  let location = this.tokenLocation( token );
  if (sign) {
    // TODO: warning for space in between
    const { endLine, endCol } = location;
    location = this.startLocation( sign );
    location.endLine = endLine;
    location.endCol = endCol;
    text = sign.text + text;
  }
  const num = Number.parseFloat( text || '0' ); // not Number.parseInt() !
  if (!Number.isSafeInteger(num)) {
    if (sign == null) {
      this.error( 'syntax-no-integer', token, {},
                  'An integer number is expected here' );
    }
    else if (text !== `${num}`) {
      return { literal: 'number', val: text, location };
    }
  }
  return { literal: 'number', val: num, location };
}

// Create AST node for quoted literals like string and e.g. date'2017-02-22'.
// This function might issue a message and might change the `literal` and
// `val` property according to `quotedLiteralPatterns` above.
function quotedLiteral( token, literal ) {
  /** @type {CSN.Location} */
  const location = this.tokenLocation( token );
  const pos = token.text.search( '\'' ) + 1; // pos of char after quote
  const val = token.text.slice( pos, -1 ).replace( /''/g, '\'' );

  if (!literal)
    literal = token.text.slice( 0, pos - 1 ).toLowerCase();
  const p = quotedLiteralPatterns[literal] || {};

  // TODO: make tests available for CSN parser
  if ((p.test_fn && !p.test_fn(val) || p.test_re && !p.test_re.test(val)) &&
      !this.options.parseOnly)
    this.error( null, location, p.test_msg ); // TODO: message id

  if (p.unexpected_char) {
    const idx = val.search(p.unexpected_char);
    if (~idx) {
      this.error( null, {     // TODO: message id
        file: location.file,
        line: location.line,
        endLine: location.line,
        col: atChar(idx),
        endCol: atChar( idx + (val[idx] === '\'' ? 2 : 1) ),
      }, p.unexpected_msg );
    }
  }
  return {
    literal: p.literal || literal,
    val: p.normalize && p.normalize(val) || val,
    location,
  };

  function atChar(i) {
    return location.col + pos + i;
  }
}

function pathName( path, brokenName ) {
  return (path && !path.broken) ? path.map( id => id.id ).join('.') : brokenName;
}

function pushIdent( path, ident, prefix ) {
  if (!ident) {
    path.broken = true;
  }
  else if (!prefix) {
    path.push( ident );
  }
  else {
    const tokenLoc = this.tokenLocation( prefix );
    if (tokenLoc.endLine !== ident.location.line ||
        tokenLoc.endCol !== ident.location.col) {
      const wsLocation = {
        file: ident.location.file,
        line: tokenLoc.endLine,           // !
        col: tokenLoc.endCol,             // !
        endLine: ident.location.line,
        endCol: ident.location.col,
      };
      this.error( 'syntax-anno-space', wsLocation, {}, // TODO: really Error?
                  'Expected identifier after \'@\' but found whitespace' );
    }
    ident.location.line = tokenLoc.line;
    ident.location.col = tokenLoc.col;
    ident.id = prefix.text + ident.id;
    path.push( ident );
  }
}

// Add new definition to dictionary property `env` of node `parent` and return
// that definition.  Also attach the following properties to the new definition:
//  - `name`: argument `name`, which is used as key in the dictionary
//  - `kind`: argument `kind` if that is truthy
//  - `location`: argument `location` or the start location of source matched by
//    current rule
//  - properties in argument `props` which are no empty (undefined, null, {},
//    []), ANTLR tokens are replaced by their locations
//
// Hack: if argument `location` is exactly `true`, do not set `location`
// (except if part of `props`), but also include the empty properties of
// `props`.
function addDef( parent, env, kind, name, annos, props, location ) {
  if (Array.isArray(name)) {
    // XSN TODO: clearly say: definitions have name.path, members have name.id
    const last = name.length && name[name.length - 1];
    if (last && last.id) {       // // A.B.C -> 'C'
      name = {
        id: last.id, location: last.location, $inferred: 'as',
      };
    }
  }
  else if (name && name.id == null) {
    name.id = pathName(name.path ); // A.B.C -> 'A.B.C'
  }
  const art = this.assignProps( { name }, annos, props, location );
  if (kind)
    art.kind = kind;
  if (!parent[env])
    parent[env] = Object.create(null);
  if (!art.name || art.name.id == null) {
    // no id was parsed, but with error recovery: no further error
    // TODO: add to  parent[env]['']
    // which could be tested in name search (then no undefined-ref error)
    return art;
  }
  else if (env === 'artifacts') {
    dictAddArray( parent[env], art.name.id, art );
  }
  else if (kind || this.options.parseOnly) {
    dictAdd( parent[env], art.name.id, art );
  }
  else {
    dictAdd( parent[env], art.name.id, art, ( name, loc ) => {
      // do not use function(), otherwise `this` is wrong:
      if (kind === 0) {
        this.error( 'duplicate-argument', loc, { name },
                    'Duplicate value for parameter $(NAME)' );
      }
      else if (kind === '') {
        this.error( 'duplicate-excluding', loc, { name, keyword: 'excluding' },
                    'Duplicate $(NAME) in the $(KEYWORD) clause' );
      }
      else {
        this.error( 'duplicate-prop', loc, { name },
                    'Duplicate value for structure property $(NAME)' );
      }
    } );
  }
  return art;
}

// Add new definition to array property `env` of node `parent` and return
// that definition.  Also attach the following properties to the new definition:
//  - `kind`: argument `kind` if that is truthy
//  - `location`: argument `location` or the start location of source matched by
//    current rule
//  - properties in argument `props` which are no empty (undefined, null, {},
//    []); ANTLR tokens are replaced by their locations
//
// Hack: if argument `location` is exactly `true`, do not set `location`
// (except if part of `props`), but also include the empty properties of
// `props`.
function addItem( parent, env, kind, annos, props, location ) {
  const art = this.assignProps( {}, annos, props, location );
  if (kind)
    art.kind = kind;
  if (!env)
    parent.push( art );
  else if (!parent[env])
    parent[env] = [ art ];
  else
    parent[env].push( art );
  return art;
}

/** Assign all non-empty (undefined, null, {}, []) properties in argument
 * `props` and argument `annos` as property `$annotations` to `target`
 * and return it.  Hack: if argument `annos` is exactly `true`, return
 * `Object.assign( target, props )`, for rule `namedValue`.  ANTLR tokens are
 * replaced by their locations.
 *
 * @param {any} target
 * @param {any[]|true} [annos=[]]
 * @param {any} [props]
 * @param {any} [location]
 */
function assignProps( target, annos = [], props = null, location = null) {
  if (annos === true)
    return Object.assign( target, props );
  target.location = location || this.startLocation( this._ctx.start );
  // Object.assign without "empty" elements/properties and with mappings:
  //  - token instanceof antlr4.CommonToken => location of token
  for (const key in props) {
    let val = props[key];
    if (val instanceof antlr4.CommonToken)
      val = this.tokenLocation( val, undefined, true);
    // only copy properties which are not undefined, null, {} or []
    if (val != null &&
        (typeof val !== 'object' ||
         (Array.isArray(val) ? val.length : Object.getOwnPropertyNames(val).length) ) )
      target[key] = val;
  }
  if (annos)
    target.$annotations = annos;
  return target;
}

// Create AST node for prefix operator `op` and arguments `args`
function createPrefixOp( token, args ) {
  const op = this.tokenLocation( token, undefined, token.text.toLowerCase() );
  return { op, args, location: this.combinedLocation( op, args[args.length - 1] ) };
}

// Create AST node for binary operator `op` and arguments `args`
function leftAssocBinaryOp( left, opToken, eToken, right, extraProp = 'quantifier' ) {
  const op = this.tokenLocation( opToken, undefined, opToken.text.toLowerCase() );
  const extra = eToken
        ? this.tokenLocation( eToken, undefined, eToken.text.toLowerCase() )
        : undefined;
  if (!left.$parens &&
      (left.op && left.op.val) === (op && op.val) &&
      (left[extraProp] && left[extraProp].val) === (extra && extra.val)) {
    left.args.push( right );
    return left;
  }
  else if (extra) {
    return { op, [extraProp]: extra, args: [ left, right ], location: left.location };
  }
  else {
    return { op, args: [ left, right ], location: left.location };
  }
}

// Set property `prop` of `target` to value `value`.  Issue error if that
// property has been set before, while mentioning the keywords previously
// provided (as arguments `tokens`).
function setOnce( target, prop, value, ...tokens ) {
  const loc = this.tokenLocation( tokens[0], tokens[tokens.length - 1] );
  const prev = target[prop];
  if (prev) {
    this.error( 'syntax-repeated-option', loc, { option: prev.option },
                  'Option $(OPTION) has already been specified' );
  }
  if (typeof value === 'boolean') {
    if (!value)
      loc.value = false;
    value = loc;
  }
  value.option = tokens.map( t => t.text.toUpperCase() ).join(' ');
  target[prop] = value;
}

function setMaxCardinality( art, token, max, inferred ) {
  const location = this.tokenLocation( token );
  if (!art.cardinality) {
    art.cardinality = { targetMax: Object.assign( { location }, max ), location };
    if (inferred)
      art.cardinality.$inferred = inferred;
  }
  else if (!inferred) {
    this.warning( 'syntax-repeated-cardinality', location, { keyword: token.text },
                  'The target cardinality has already been specified - ignored $(KEYWORD)' );
  }
}

function handleComposition( cardinality, isComposition ) {
  if (isComposition && !cardinality) {
    const lt1 = this._input.LT(1).type;
    const la2 = this._input.LT(2);
    if (la2.text === '{' && (lt1 === this.constructor.MANY || lt1 === this.constructor.ONE))
      la2.type = this.constructor.COMPOSITIONofBRACE;
  }
  const brace1 = (isComposition) ? 'COMPOSITIONofBRACE' : "'{'";
  const manyOne = (cardinality) ? [ 'MANY', 'ONE' ] : [];
  this.excludeExpected( [ [ "'}'", 'COMPOSITIONofBRACE' ], brace1, ...manyOne ] );
}

function reportExpandInline( clauseName ) {
  let token = this.getCurrentToken();
  // improve error location when using "inline" `.{…}` after ref (arguments and
  // filters not covered, not worth the effort); after an expression where
  // the last token is an identifier, not the `.` is wrong, but the `{`:
  if (token.text === '.' && this._input.LT(-1).type >= this.constructor.Identifier)
    token = this._input.LT(2);
  this.error( 'syntax-unexpected-refclause', token, { prop: clauseName },
              'Unexpected nested $(PROP), can only be used after a reference' );
}

module.exports = {
  genericAntlrParser: GenericAntlrParser,
};
