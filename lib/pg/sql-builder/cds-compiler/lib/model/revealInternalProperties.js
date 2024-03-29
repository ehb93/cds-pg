// Make internal properties of the XSN / augmented CSN visible
//
//  * Display links like _artifact as 'entity:"A"/element:"k"'.
//  * Use this form at other places to avoid listing the same property value twice.
//  * Use shorter display of the location, like in messages.
//  * Attach integer as __unique_id__ property value to all objects.
//
// This function should return a meaningful result in all circumstances:
//  * with --parse-only, with both CDL and CSN input,
//  * for the core compiler output and all transformations working on the XSN.

'use strict';

const msg = require('../base/messages');

class NOT_A_DICTIONARY {}       // used for consol.log display

function locationString( loc ) {
  if (Array.isArray(loc))
    return loc.map( locationString );
  if (loc == null)
    return '';
  return (typeof loc === 'object' && loc.file)
    ? msg.locationString(loc)
    : (typeof loc) + ':' + msg.locationString(loc);
}

var unique_id = 0;

// some (internal) kinds are normally represented as links
const kindsRepresentedAsLinks = {
  // represent SELECTs in query / SET-args property as link:
  select: (art, parent) => art._main && parent !== art._main.$queries,
  // represent table alias in from / join-args property as link:
  $tableAlias: (art, parent) => art._parent && parent !== art._parent.$tableAliases,
  // represent table alias in JOIN node as link:
  $navElement: (art, parent) => art._parent && parent !== art._parent.elements,
  // represent mixin in $tableAliases as link:
  mixin: (art, parent) => art._parent && parent !== art._parent.mixin,
  // represent $projection as link, as it is just another search name for $self:
  $self: (_a, _p, name) => name !== '$self',
}

function revealInternalProperties( model, name ) {
  const transformers = {
    messages: m => m,
    name: shortenName,
    location: locationString,
    $parens: locationString,    // array
    options: revealOptions,
    sources: dictionary,
    artifacts: artifactDictionary,
    definitions: artifactDictionary,
    vocabularies: dictionary,
    elements,
    columns,
    expand: columns,
    inline: columns,
    actions: dictionary,
    params: dictionary,
    enum: dictionary,
    foreignKeys: dictionary,
    excludingDict: dictionary,
    struct: dictionary,
    mixin: dictionary,
    args: dictionary,
    $tableAliases: dictionary,
    $keysNavigation: dictionary,
    $layerNumber: n => n,
    $extra: e => e,
    _layerRepresentative: s => s.realname,
    _layerExtends: layerExtends,
    _origin: origin,
    $compositionTargets: d => d,   // dictionary( boolean )
    _extend: reveal,
    _annotate: reveal,
    _deps: dependencyInfo,
    _status: primOrString,       // is a string anyway
    $messageFunctions: () => '‹some functions›',
  }
  unique_id = 1;
  return revealXsnPath(name, model);

  // Returns the desired artifact/dictionary in the XSN.
  //
  // Usage:
  //   1. Whole Model
  //      Simply pass `+`.
  //   2. Entity (e.g. in service)
  //      Use `S.E`, i.e. the artifact's name in XSN.
  //   3. Specific Element
  //      To get an element `e` of `S.E`, use `S.E/elements/e`, i.e. the
  //      JSON path delimited by "/" instead of "." (to avoid conflicts with artifact's FQN).
  //   4. All elements
  //      To list all elements, use `S.E/elements/`. The final slash is important.
  //   5. Other dictionaries or internal properties
  //      Use the JSON-like path delimited by "/". Add a final slash, e.g. `E.elements.a.kind/`.
  //
  // The string before the last slash ("/") is used as the property name to
  // reveal the properties. So if the last path segment is an element name, do
  // not add a slash or the name may be mistaken as a property name.
  //
  // Examples:
  //   `name.space/S/E/elements/a/kind/`
  //   `name.space/S/E/elements/a/type/scope/`
  function revealXsnPath(path, xsn) {
    if (!path || path === '+')
      return reveal( xsn );

    path = path.split('/');
    if (path.length === 1) {
      return reveal( xsn.definitions[path] );
    }

    // with the code below, we might miss the right transformer function
    path.unshift('definitions');

    for (const segment of path) {
      if (xsn[segment])
        xsn = xsn[segment]
      else if (segment)         // huh, this should be a call error
        throw new Error(`Raw Output: Path segment "${ segment }" could not be found. Path: ${ JSON.stringify(path) }!"`)
    }
    const propName = path[path.length > 1 ? path.length - 2 : 0 ];
    const obj = {};
    obj[propName] = xsn;
    return reveal( obj );
  }

  function shortenName( node, parent ) {
    const name = reveal( node, parent );
    if (name && typeof name === 'object' && name.absolute) {
      const text = artifactIdentifier( parent );
      delete name.absolute;
      delete name.select;
      delete name.action;
      delete name.parameter;
      delete name.alias;
      delete name.element;
      name['-->'] = text;
    }
    return name;
  }
  function dependencyInfo( deps ) {
    if (!Array.isArray(deps))
      return primOrString( deps );
    return deps
      .filter( d => d.location )
      .map( d => artifactIdentifier( d.art ) );
  }

  function layerExtends( dict ) {
    const r = Object.create( Object.getPrototypeOf(dict)
                             ? NOT_A_DICTIONARY.prototype
                             : Object.prototype );
    for (let name in dict)
      r[name] = true;
    return r;
  }

  function columns( nodes, query ) {
    // If we will have specified elements, we need another test to see columns in --parse-cdl
    return nodes && nodes.map( c => (c._parent && c._parent.elements)
                                    ? artifactIdentifier( c, query )
                                    : reveal( c, nodes ) );
  }

  function elements( dict, parent ) {
    // do not display elements of leading query as they are the same as the view elements:
    return (parent._main && parent._main._leadingQuery === parent)
      ? '{ ... }'
      : dictionary( dict );
  }

  function revealOptions( node, parent ) {
    return (parent === model || node !== model.options) ? reveal( node, parent ) : '{ ... }';
  }

  function artifactDictionary( node, parent ) {
    if (!node || typeof node !== 'object' || !model.definitions || parent === model )
      return dictionary( node );    // no dictionary or no definitions section
    const dict = Object.create( Object.getPrototypeOf(node)
                                ? NOT_A_DICTIONARY.prototype
                                : Object.prototype );
    for (let name in node) {
      const art = node[name];
      dict[name] = (art.kind !== 'using')
        ? artifactIdentifier( art )
        : reveal( art, parent );
    }
    return dict;
  }

  function dictionary( node ) {
    if (!node || typeof node !== 'object')
      return primOrString( node );
    if (Array.isArray(node))  // with args
      return node.map( n => reveal( n, node ) );
    // Make unexpected prototype visible with node-10+:
    const r = Object.create( Object.getPrototypeOf(node)
                             ? NOT_A_DICTIONARY.prototype
                             : Object.prototype );
    for (let prop of Object.getOwnPropertyNames( node )) { // also non-enumerable
      r[prop] = reveal( node[prop], node, prop );
    }
    return r;
  }

  function origin( node, parent ) {
    if (!node || node.$inferred === 'REDIRECTED')
      return reveal( node, parent );
    else
      return artifactIdentifier( node, parent );
  }

  function revealNonEnum( node, parent ) {
    if (node == null || typeof node !== 'object' )
      return primOrString( node );
    if (Array.isArray(node))
      return node.map( n => revealNonEnum( n, node ) );

    if (Object.getPrototypeOf( node ))
      return artifactIdentifier( node, parent );
    return artifactDictionary( node, parent );
  }

  function reveal( node, parent, name ) {
    if (node == null || typeof node !== 'object' )
      return node
    if (Array.isArray(node))
      return node.map( n => reveal( n, node ) );

    const asLinkTest = kindsRepresentedAsLinks[ node.kind ];
    if (asLinkTest && asLinkTest( node, parent, name ))
      return artifactIdentifier( node, parent );

    let r = Object.create( Object.getPrototypeOf( node ) );
    // property to recognize === objects
    if (node.kind && node.__unique_id__ == null)
      Object.defineProperty( node, '__unique_id__', { value: ++unique_id } );

    for (let prop of Object.getOwnPropertyNames( node )) { // also non-enumerable
      const func = transformers[prop] ||
            ({}.propertyIsEnumerable.call( node, prop ) ? reveal : revealNonEnum);
      r[prop] = func( node[prop], node );
    }
    return r;
  }
}

function artifactIdentifier( node, parent ) {
  if (Array.isArray(node))
    return node.map( a => artifactIdentifier( a, node ) );
  if (unique_id && node.__unique_id__ == null)
    Object.defineProperty( node, '__unique_id__', { value: ++unique_id } );
  let outer = unique_id ? '##' + node.__unique_id__ : '';
  if (node._outer) {
    outer = (node._outer.items === node) ? '/items'
      : (node._outer.returns === node) ? '/returns' : '/returns/items';
    node = node._outer;
  }
  else if (node.$inferred === 'REDIRECTED')
    outer = '/redirected';
  if (node === parent)
    return 'this';
  if (node.kind === 'source')
    return 'source:' + quoted( node.location.file );
  if (node.kind === '$magicVariables')
    return '$magicVariables';
  if (!node.name) {
    try {
      return (locationString( node.location ) || '') + '##' + node.__unique_id__;
      // return JSON.stringify(node);
    }
    catch (e) {
      return e.toString();
    }
  }
  switch (node.kind) {
    case undefined:
      return (node._artifact && node._artifact.kind)
        ? artifactIdentifier( node._artifact )
        : JSON.stringify(node.name);
    case 'builtin':
      return '$magicVariables/' + msg.artName(node);
    case 'source':
    case 'using':
      return 'source:' + quoted( node.location && node.location.file ) +
        '/using:' + quoted( node.name.id )
    default: {
      return ((node._main || node).kind || '<kind>') + ':' + msg.artName( node ) + outer;
    }
  }
}

function primOrString( node ) {
  if (node == null || typeof node !== 'object')
    return node
  if (Array.isArray(node))
    return node.map( primOrString );
  if (Object.getPrototypeOf( node ))
    return '' + node;
  else
    return '<dict>';
}

function quoted( name, undef = '‹undefined›' ) {
  return (typeof name === 'number')
    ? name
    : name ? '“' + name + '”' : undef;
}

// To be used for tracing, e.g. by
// require('../model/revealInternalProperties').log(model, 'E_purposes')
function logXsnModel( model, name ) {
  console.log( require('util').inspect( revealInternalProperties( model, name ), false, null ) );
}

// To be used for tracing, e.g. by
// console.log(require('../model/revealInternalProperties').ref(type._artifact))
function xsnRef( node ) {
  unique_id = 0;
  return artifactIdentifier( node );
}

module.exports = { reveal: revealInternalProperties, log: logXsnModel, ref: xsnRef };
