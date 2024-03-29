// This is very similar to lib/model/enrichCsn - but the goal and the execution differ a bit:
// - enrichCsn is used to enhance ref files for testing.
// - this file is used as a "pre-loading" step of the CSN validations.

'use strict';

const { csnRefs } = require('../model/csnRefs');
const { setProp } = require('../base/model');
/**
 * The following properties are attached as non-enumerable where appropriate:
 *
 *- `_type`, `_includes` and `_targets` have as values the
 *  referred artifacts which are returned by function `artifactRef`.
 *- `_links`, `_art` and `$scope` as sibling properties of `ref` have as values
 *  the artifacts/members returned by function `inspectRef`.
 *- `$path` has the csnPath to reach that property.
 *
 * @param {CSN.Model} csn CSN to enrich in-place
 * @returns {{ csn: CSN.Model, cleanup: () => void }} CSN with all ref's pre-resolved
 */
function enrichCsn( csn ) {
  const transformers = {
    elements: dictionary,
    definitions: dictionary,
    actions: dictionary,
    params: dictionary,
    enum: dictionary,
    mixin: dictionary,
    ref: pathRef,
    type: simpleRef,
    target: simpleRef,
    includes: simpleRef,
    // Annotations are ignored.
    '@': () => { /* ignore annotations */ },
  };
  let cleanupCallbacks = [];

  const cleanup = () => {
    cleanupCallbacks.forEach(fn => fn());
    cleanupCallbacks = [];
  };

  const { inspectRef, artifactRef } = csnRefs( csn );
  const csnPath = [];
  if (csn.definitions)
    dictionary( csn, 'definitions', csn.definitions );
  return { csn, cleanup };

  // eslint-disable-next-line jsdoc/require-jsdoc
  function standard( parent, prop, node ) {
    if (!node || typeof node !== 'object' || !{}.propertyIsEnumerable.call( parent, prop ))
      return;

    csnPath.push( prop );
    setProp(node, '$path', [ ...csnPath ]);
    cleanupCallbacks.push(() => delete node.$path);

    if (Array.isArray(node)) {
      node.forEach( (n, i) => standard( node, i, n ) );
    }
    else {
      for (const name of Object.getOwnPropertyNames( node )) {
        const trans = transformers[name] || transformers[name.charAt(0)] || standard;
        trans( node, name, node[name] );
      }
    }
    csnPath.pop();
  }
  // eslint-disable-next-line jsdoc/require-jsdoc
  function dictionary( node, prop, dict ) {
    setProp(node, '$path', [ ...csnPath ]);
    cleanupCallbacks.push(() => delete node.$path);
    csnPath.push( prop );

    for (const name of Object.getOwnPropertyNames( dict ))
      standard( dict, name, dict[name] );

    if (!Object.prototype.propertyIsEnumerable.call( node, prop )) {
      setProp(node, `$${ prop }`, dict);
      cleanupCallbacks.push(() => delete node[`$${ prop }`]);
    }
    csnPath.pop();
  }

  // eslint-disable-next-line jsdoc/require-jsdoc
  function simpleRef( node, prop ) {
    setProp(node, '$path', [ ...csnPath ]);
    cleanupCallbacks.push(() => delete node.$path);

    const ref = node[prop];
    if (typeof ref === 'string') {
      const art = artifactRef( ref, null );
      if (art || !ref.startsWith( 'cds.')) {
        setProp(node, `_${ prop }`, art);
        cleanupCallbacks.push(() => delete node[`_${ prop }`]);
      }
    }
    else if (Array.isArray( ref )) {
      setProp(node, `_${ prop }`, ref.map( r => artifactRef( r, null ) ));
      cleanupCallbacks.push(() => delete node[`_${ prop }`]);
    }
  }

  // eslint-disable-next-line jsdoc/require-jsdoc
  function pathRef( node, prop, path ) {
    const {
      links, art, scope, $env,
    } = inspectRef( csnPath );
    if (links) {
      setProp(node, '_links', links);
      cleanupCallbacks.push(() => delete node._links);
    }
    if (art) {
      setProp(node, '_art', art );
      cleanupCallbacks.push(() => delete node._art);
    }
    if ($env) {
      setProp(node, '$env', $env );
      cleanupCallbacks.push(() => delete node.$env);
    }
    setProp(node, '$scope', scope);
    cleanupCallbacks.push(() => delete node.$scope);
    setProp(node, '$path', [ ...csnPath ]);
    cleanupCallbacks.push(() => delete node.$path);

    csnPath.push( prop );
    path.forEach( ( s, i ) => {
      if (s && typeof s === 'object') {
        csnPath.push( i );
        if (s.args)
          standard( s, 'args', s.args );
        if (s.where)
          standard( s, 'where', s.where );
        csnPath.pop();
      }
    } );
    csnPath.pop();
  }
}

module.exports = enrichCsn;
