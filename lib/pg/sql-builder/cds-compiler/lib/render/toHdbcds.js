'use strict';

const {
  getParentNameOf, getLastPartOf, getLastPartOfRef,
  hasValidSkipOrExists, isBuiltinType, generatedByCompilerVersion, getNormalizedQuery,
  getRootArtifactName, getResultingName, getNamespace, forEachMember,
} = require('../model/csnUtils');
const keywords = require('../base/keywords');
const {
  renderFunc, beautifyExprArray, getRealName, addContextMarkers, addIntermediateContexts, cdsToSqlTypes,
  hasHanaComment, getHanaComment, findElement, funcWithoutParen,
} = require('./utils/common');
const {
  renderReferentialConstraint,
} = require('./utils/sql');
const DuplicateChecker = require('./DuplicateChecker');
const { isDeprecatedEnabled, forEachDefinition } = require('../base/model');
const { checkCSNVersion } = require('../json/csnVersion');
const { makeMessageFunction } = require('../base/messages');
const timetrace = require('../utils/timetrace');

const { smartId, delimitedId } = require('../sql-identifier');

const $PROJECTION = '$projection';
const $SELF = '$self';

/**
 * Get the comment and in addition escape \n so HANA CDS can handle it.
 *
 * @param {CSN.Artifact} obj
 * @returns {string}
 */
function getEscapedHanaComment(obj) {
  return getHanaComment(obj).replace(/\n/g, '\\n');
}

/**
 * Render the CSN model 'model' to CDS source text. One source is created per
 * top-level artifact. Return a dictionary of top-level artifacts
 * by their names, like this:
 * { "foo" : "using XY; context foo {...};",
 *   "bar::wiz" : "namespace bar::; entity wiz {...};"
 * }
 *
 * FIXME: This comment no longer tells the whole truth
 *
 * @param {CSN.Model} csn HANA transformed CSN
 * @param {CSN.Options} [options] Transformation options
 * @returns {object} Dictionary of filename: content
 */
function toHdbcdsSource(csn, options) {
  timetrace.start('HDBCDS rendering');
  const plainNames = options.sqlMapping === 'plain';
  const quotedNames = options.sqlMapping === 'quoted';
  const hdbcdsNames = options.sqlMapping === 'hdbcds';

  const {
    info, warning, error, throwWithError,
  } = makeMessageFunction(csn, options, 'to.hdbcds');

  checkCSNVersion(csn, options);

  const result = Object.create(null);


  const globalDuplicateChecker = new DuplicateChecker(options.sqlMapping); // registry for all artifact names and element names

  const killList = [];
  if (quotedNames)
    addContextMarkers(csn, killList);

  if (!plainNames)
    addIntermediateContexts(csn, killList);

  // Render each top-level artifact on its own
  const hdbcds = Object.create(null);
  for (const artifactName in getTopLevelArtifacts()) {
    const art = csn.definitions[artifactName];
    // This environment is passed down the call hierarchy, for dealing with
    // indentation and name resolution issues
    const env = createEnv();
    const sourceStr = renderArtifact(artifactName, art, env); // Must come first because it populates 'env.topLevelAliases'
    if (sourceStr !== '') {
      const name = plainNames ? artifactName.replace(/\./g, '_').toUpperCase() : artifactName;
      hdbcds[name] = [
        !options.testMode ? `// ${generatedByCompilerVersion()} \n` : '',
        renderNamespaceDeclaration(name, env),
        renderUsings(name, env),
        sourceStr,
      ].join('');
    }
  }

  // render .hdbconstraint into result
  const hdbconstraint = Object.create(null);
  forEachDefinition(csn, (art) => {
    if (art.$tableConstraints && art.$tableConstraints.referential) {
      const renderToUppercase = plainNames;
      const referentialConstraints = {};
      Object.entries(art.$tableConstraints.referential)
        .forEach(([ fileName, referentialConstraint ]) => {
          referentialConstraints[fileName] = renderReferentialConstraint(
            referentialConstraint, '', renderToUppercase, csn, options, false
          );
        });
      Object.entries(referentialConstraints)
        .forEach( ([ fileName, constraint ]) => {
          hdbconstraint[fileName] = constraint;
        });
    }
  });
  result.hdbcds = hdbcds;
  result.hdbconstraint = hdbconstraint;

  if (globalDuplicateChecker)
    globalDuplicateChecker.check(error, options); // perform duplicates check

  killList.forEach(fn => fn());

  throwWithError();
  timetrace.stop();
  return options.testMode ? sort(result) : result;

  /**
   * Sort the given object alphabetically
   *
   * @param {Object} obj Object to sort
   * @returns {Object} With keys sorted
   */
  function sort(obj) {
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
    const sortedResult = Object.create(null);
    for (let i = 0; i < keys.length; i++)
      sortedResult[keys[i]] = obj[keys[i]];

    return sortedResult;
  }

  /**
   * Render an artifact. Return the resulting source string.
   *
   * @param {string} artifactName Name of the artifact to render
   * @param {CSN.Artifact} art Content of the artifact to render
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} The rendered artifact
   */
  function renderArtifact(artifactName, art, env) {
    // FIXME: Correctly build the paths during runtime to give better locations
    env.path = [ 'definitions', artifactName ];
    // Ignore whole artifacts if toHana says so
    if (art.abstract || hasValidSkipOrExists(art))
      return '';

    switch (art.kind) {
      case 'entity':
      case 'view':
        // FIXME: For HANA CDS, we need to replace $self at the beginning of paths in association ON-condition
        // by the full name of the artifact we are rendering (should actually be done by forHana, but that is
        // somewhat difficult because this kind of absolute path is quite unusual). In order not to have to pass
        // the current artifact name down through the stack to renderExpr, we just put it into the env.
        env.currentArtifactName = artifactName;
        if (art.query || art.projection)
          return renderView(artifactName, art, env);

        return renderEntity(artifactName, art, env);

      case 'context':
      case 'service':
        return renderContext(artifactName, art, env);
      case 'namespace':
        return renderNamespace(artifactName, art, env);
      case 'type':
      case 'aspect':
        return renderType(artifactName, art, env);
      case 'annotation':
      case 'action':
      case 'function':
      case 'event':
        return '';
      default:
        throw new Error(`Unknown artifact kind: ${art.kind}`);
    }
  }

  /**
   * Return a dictionary with the direct sub-artifacts of the artifact with name 'artifactName' in the csn
   *
   * @param {string} artifactName Find all children of this artifact
   * @returns {object} Dictionary with direct sub-artifacts
   */
  function getSubArtifacts(artifactName) {
    const prefix = `${artifactName}.`;
    const result = Object.create(null);
    for (const name in csn.definitions) {
      // We have a direct child if its name starts with prefix and contains no more dots
      if (name.startsWith(prefix) && !name.substring(prefix.length).includes('.')) {
        result[getLastPartOf(name)] = csn.definitions[name];
      }
      else if (name.startsWith(prefix) && !isContainedInOtherContext(name, artifactName)) {
        const prefixPlusNextPart = name.substring(0, name.substring(prefix.length).indexOf('.') + prefix.length);
        if (csn.definitions[prefixPlusNextPart]) {
          const art = csn.definitions[prefixPlusNextPart];
          if (![ 'service', 'context', 'namespace' ].includes(art.kind)) {
            const nameWithoutPrefix = name.substring(prefix.length);
            result[nameWithoutPrefix] = csn.definitions[name];
          }
        }
        else {
          result[name.substring(prefix.length)] = csn.definitions[name];
        }
      }
    }
    return options && options.testMode ? sort(result) : result;
  }

  /**
   * Check wether the given context is the direct parent of the containee.
   *
   * @param {string} containee Name of the contained artifact
   * @param {string} contextName Name of the (grand?)parent context
   * @returns {boolean} True if there is another context inbetween
   */
  function isContainedInOtherContext(containee, contextName) {
    const parts = containee.split('.');
    const prefixLength = contextName.split('.').length;

    for (let i = parts.length - 1; i > prefixLength; i-- ) {
      const prefix = parts.slice(0, i).join('.');
      const art = csn.definitions[prefix];
      if (art && (art.kind === 'context' || art.kind === 'service'))
        return true;
    }

    return false;
  }

  /* FIXME: Not yet required
  // Returns the artifact or element that constitutes the final type of
  // construct 'node', i.e. the object in which we would find type properties for
  // 'node'. Note that this may well be 'node' itself.
  function getFinalTypeOf(node) {
    if (node && node.type) {
      if (isBuiltinType(node.type)) {
        return node;
      }
      return getFinalTypeOf(node.type);
    }
    return node;
  }

  // Resolve path array 'ref' against artifact 'base' (or against 'csn.definitions'
  // if no 'base' given).
  // Return the resulting artifact or element (or 'undefined' if not found).
  function resolveRef(ref, base) {
    let result = base;
    for (let i = 0; i < ref.length; i++) {
      let pathStep = ref[i].id || ref[i];
      // Only first path step may be looked up in 'definitions'
      if (i === 0 && !base) {
        result = csn.definitions[pathStep];
        continue;
      }
      // Structured type
      else if (result && result.elements) {
        result = getFinalTypeOf(result.elements[pathStep]);
      }
      // Association
      else if (result && result.target) {
        result = resolveRef([pathStep], csn.definitions[result.target]);
      }
      // Not resolvable
      else {
        return undefined;
      }
    }
    return result;
  }
*/

  /**
   * Render a context or service. Return the resulting source string.
   *
   * If the context is shadowed by another entity, the context itself is not rendered,
   * but any contained (and transitively contained) entites and views are.
   *
   * @param {string} artifactName Name of the context/service
   * @param {CSN.Artifact} art Content of the context/service
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} The rendered context/service
   */
  function renderContext(artifactName, art, env, isShadowed) {
    let result = '';
    if (!isShadowed)
      isShadowed = contextIsShadowed(artifactName, csn);
    if (isShadowed) {
      const subArtifacts = getSubArtifacts(artifactName);
      for (const name in subArtifacts)
        result += renderArtifact(`${artifactName}.${name}`, subArtifacts[name], env);

      return `${result}\n`;
    }

    const childEnv = increaseIndent(env);
    result += `${env.indent}context ${renderArtifactName(artifactName, env, true)}`;
    result += ' {\n';
    const subArtifacts = getSubArtifacts(artifactName);
    let renderedSubArtifacts = '';
    for (const name in subArtifacts)
      renderedSubArtifacts += renderArtifact(`${artifactName}.${name}`, subArtifacts[name], updatePrefixForDottedName(childEnv, name));

    if (renderedSubArtifacts === '')
      return '';

    return `${result + renderedSubArtifacts + env.indent}};\n`;
  }
  /**
   * Check wether the given context is shadowed, i.e. part of his name prefix is shared by a
   *  non-context/service/namespace definition
   *
   * @param {string} artifactName
   * @param {CSN.Model} csn
   * @returns {boolean}
   */
  function contextIsShadowed(artifactName, csn) {
    if (artifactName.indexOf('.') === -1)
      return false;

    const parts = artifactName.split('.');

    for (let i = 0; i < parts.length; i++) {
      const art = csn.definitions[parts.slice(0, i).join('.')];
      if (art && art.kind !== 'context' && art.kind !== 'service' && art.kind !== 'namespace')
        return true;
    }
    return false;
  }

  /**
   * In case of an artifact with . in the name (that are not a namespace/context part),
   * we need to update the env to correctly render the artifact name.
   *
   * @param {CdlRenderEnvironment} env Environment
   * @param {string} name Possibly dotted artifact name
   * @returns {CdlRenderEnvironment} Updated env or original instance
   */
  function updatePrefixForDottedName(env, name) {
    if (plainNames) {
      let innerEnv = env;
      if (name.indexOf('.') !== -1) {
        const parts = name.split('.');
        for (let i = 0; i < parts.length - 1; i++)
          innerEnv = addNamePrefix(innerEnv, parts[i]);
      }

      return innerEnv;
    }
    return env;
  }

  /**
   * Render a namespace. Return the resulting source string.
   *
   * @param {string} artifactName Name of the namespace
   * @param {CSN.Artifact} art Content of the namespace
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} The rendered children of the namespace
   */
  function renderNamespace(artifactName, art, env) {
    // We currently do not render anything for a namespace, we just append its id to
    // the environment's current name prefix and descend into its children
    let result = '';
    const childEnv = addNamePrefix(env, getLastPartOf(artifactName));
    const subArtifacts = getSubArtifacts(artifactName);
    for (const name in subArtifacts)
      result += renderArtifact(`${artifactName}.${name}`, subArtifacts[name], updatePrefixForDottedName(childEnv, name));

    return result;
  }

  /**
   * Render a (non-projection, non-view) entity. Return the resulting source string.
   *
   * @param {string} artifactName Name of the entity
   * @param {CSN.Artifact} art Content of the entity
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} The rendered entity
   */
  function renderEntity(artifactName, art, env) {
    let result = '';
    const childEnv = increaseIndent(env);
    const normalizedArtifactName = renderArtifactName(artifactName, env);

    globalDuplicateChecker.addArtifact(art['@cds.persistence.name'], env.path, artifactName);

    if (hasHanaComment(art, options))
      result += `${env.indent}@Comment: '${getEscapedHanaComment(art)}'\n`;

    result += `${env.indent + (art.abstract ? 'abstract ' : '')}entity ${normalizedArtifactName}`;
    if (art.includes) {
      // Includes are never flattened (don't exist in HANA)
      result += ` : ${art.includes.map(name => renderAbsoluteNameWithQuotes(name, env)).join(', ')}`;
    }
    result += ' {\n';
    const duplicateChecker = new DuplicateChecker(); // registry for all artifact names and element names
    duplicateChecker.addArtifact(artifactName, env.path, artifactName);
    childEnv.path = env.path.concat('elements');
    // calculate __aliases which must be used in case an association
    // has the same identifier as it's target
    createTopLevelAliasesForArtifact(artifactName, art, env);
    for (const name in art.elements)
      result += renderElement(name, art.elements[name], childEnv, duplicateChecker);

    duplicateChecker.check(error);
    result += `${env.indent}}`;
    result += `${renderTechnicalConfiguration(art.technicalConfig, env)};\n`;
    return result;
  }

  /**
   * If an association/composition has the same identifier as it's target
   * we must render an "using target as __target" and use the alias to refer to the target
   *
   * @param {string} artName
   * @param {CSN.Artifact} art
   * @param {CdlRenderEnvironment} env
   */
  function createTopLevelAliasesForArtifact(artName, art, env) {
    forEachMember(art, (element) => {
      if (!element.target)
        return;

      let alias = element['@cds.persistence.name'];
      if (uppercaseAndUnderscore(element.target) === element['@cds.persistence.name']) {
        alias = createTopLevelAliasName(element['@cds.persistence.name']);
        // calculate new alias if it would conflict with other csn.Artifact
        while (csn.definitions[alias])
          alias = createTopLevelAliasName(alias);
        env.topLevelAliases[element['@cds.persistence.name']] = {
          quotedName: formatIdentifier(element['@cds.persistence.name']),
          quotedAlias: formatIdentifier(alias),
        };
      }
    });
  }

  /**
   * Render the 'technical configuration { ... }' section 'tc' of an entity.
   *
   * @param {object} tc content of the technical configuration
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} Return the resulting source string.
   */
  function renderTechnicalConfiguration(tc, env) {
    let result = '';
    const childEnv = increaseIndent(env);

    if (!tc)
      return result;


    // FIXME: How to deal with non-HANA technical configurations? We should probably just iterate all entries
    // in 'tc' that we find and render them all (is it syntactically allowed yet to have more than one?)
    tc = tc.hana;
    if (!tc)
      throw new Error('Expecting a HANA technical configuration');

    result += `\n${env.indent}technical ${tc.calculated ? '' : 'hana '}configuration {\n`;

    // Store type (must be separate because SQL wants it between 'CREATE' and 'TABLE')
    if (tc.storeType)
      result += `${tc.storeType} store;\n`;

    // Fixed parts belonging to the table (includes migration, unload prio, extended storage,
    // auto merge, partitioning, ...)
    if (tc.tableSuffix) {
      // Unlike SQL, CDL and HANA CDS require a semicolon after each table-suffix part
      // (e.g. `migration enabled; row store; ...`). In order to keep both
      // the simplicity of "the whole bandwurm is just one expression that can be
      // rendered to SQL without further knowledge" and at the same time telling
      // CDS about the boundaries, the compactor has put each part into its own `xpr`
      // object. Semantically equivalent because a "trivial" SQL renderer would just
      // concatenate them.
      for (const xpr of tc.tableSuffix)
        result += `${childEnv.indent + renderExpr(xpr, childEnv)};\n`;
    }

    // Indices and full-text indices
    for (const idxName in tc.indexes || {}) {
      if (Array.isArray(tc.indexes[idxName][0])) {
        // FIXME: Should we allow multiple indices with the same name at all?
        for (const index of tc.indexes[idxName])
          result += `${childEnv.indent + renderExpr(index, childEnv)};\n`;
      }
      else {
        result += `${childEnv.indent + renderExpr(tc.indexes[idxName], childEnv)};\n`;
      }
    }
    // Fuzzy search indices
    for (const columnName in tc.fzindexes || {}) {
      if (Array.isArray(tc.fzindexes[columnName][0])) {
        // FIXME: Should we allow multiple fuzzy search indices on the same column at all?
        // And if not, why do we wrap this into an array?
        for (const index of tc.fzindexes[columnName])
          result += `${childEnv.indent + renderExpr(fixFuzzyIndex(index, columnName), childEnv)};\n`;
      }
      else {
        result += `${childEnv.indent + renderExpr(fixFuzzyIndex(tc.fzindexes[columnName], columnName), childEnv)};\n`;
      }
    }
    result += `${env.indent}}`;
    return result;


    /**
     *  Fuzzy indices are stored in compact CSN as they would appear in SQL after the column name,
     *  i.e. the whole line in SQL looks somewhat like this:
     *    s nvarchar(10) FUZZY SEARCH INDEX ON FUZZY SEARCH MODE 'ALPHANUM'
     *  But in CDL, we don't write fuzzy search indices together with the table column, so we need
     *  to insert the name of the column after 'ON' in CDS syntax, making it look like this:
     *    fuzzy search mode on (s) search mode 'ALPHANUM'
     *  This function expects an array with the original expression and returns an array with the modified expression
     *
     * @param {Array} fuzzyIndex Expression array representing the fuzzy index
     * @param {string} columnName Name of the SQL column
     * @returns {Array} Modified expression array
     */
    function fixFuzzyIndex(fuzzyIndex, columnName) {
      return fuzzyIndex.map(token => (token === 'on' ? { xpr: [ 'on', '(', { ref: columnName.split('.') }, ')' ] } : token));
    }
  }

  /**
   * Render an element (of an entity, type or annotation, not a projection or view).
   * Return the resulting source string.
   *
   * @param {string} elementName Name of the element
   * @param {CSN.Element} elm Content of the element
   * @param {CdlRenderEnvironment} env Environment
   * @param {DuplicateChecker} [duplicateChecker] Utility for detecting duplicates
   * @param {boolean} [isSubElement] Wether the given element is a subelement or not - subelements cannot be key!
   * @returns {string} The rendered element
   */
  function renderElement(elementName, elm, env, duplicateChecker, isSubElement) {
    // Ignore if toHana says so
    if (elm.virtual)
      return '';

    // Special handling for HANA CDS: Must omit the ':' before anonymous structured types (for historical reasons)
    const omitColon = (!elm.type && elm.elements);
    let result = '';
    const quotedElementName = formatIdentifier(elementName);
    if (duplicateChecker)
      duplicateChecker.addElement(quotedElementName, env.path, elementName);

    if (hasHanaComment(elm, options))
      result += `${env.indent}@Comment: '${getEscapedHanaComment(elm)}'\n`;

    result += env.indent + (elm.key && !isSubElement ? 'key ' : '') +
                         (elm.masked ? 'masked ' : '') +
                         quotedElementName + (omitColon ? ' ' : ' : ') +
                         renderTypeReference(elm, env, undefined) +
                         renderNullability(elm);
    if (elm.default)
      result += ` default ${renderExpr(elm.default, env)}`;

    return `${result};\n`;
  }

  /**
   * Render the source of a query, which may be a path reference, possibly with an alias,
   * or a subselect, or a join operation, as seen from artifact 'art'.
   * Returns the source as a string.
   *
   * @param {object} source Source to render
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} Rendered view source
   */
  function renderViewSource(source, env) {
    // Sub-SELECT
    if (source.SELECT || source.SET) {
      let result = `(${renderQuery(source, false, increaseIndent(env))})`;
      if (source.as)
        result += ` as ${formatIdentifier(source.as)}`;

      return result;
    }
    // JOIN
    else if (source.join) {
      // One join operation, possibly with ON-condition
      let result = `${renderViewSource(source.args[0], env)}`;
      for (let i = 1; i < source.args.length; i++) {
        result = `(${result} ${source.join} `;
        result += `join ${renderViewSource(source.args[i], env)}`;
        if (source.on)
          result += ` on ${renderExpr(source.on, env, true, true)}`;

        result += ')';
      }
      return result;
    }
    // Ordinary path, possibly with an alias

    return renderAbsolutePathWithAlias(source, env);
  }

  /**
   * Render a path that starts with an absolute name (as used e.g. for the source of a query),
   * with plain or quoted names, depending on options. Expects an object 'path' that has a 'ref'.
   * Returns the name as a string.
   *
   * @param {object} path Path to render
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} Rendered path
   */
  function renderAbsolutePath(path, env) {
    // Sanity checks
    if (!path.ref)
      throw new Error(`Expecting ref in path: ${JSON.stringify(path)}`);


    // Determine the absolute name of the first artifact on the path (before any associations or element traversals)
    const firstArtifactName = path.ref[0].id || path.ref[0];

    let result = '';
    // Render the first path step (absolute name, with different quoting/naming ..)
    if (plainNames)
      result += renderAbsoluteNamePlain(firstArtifactName, env);
    else
      result += renderAbsoluteNameWithQuotes(firstArtifactName, env);

    // Even the first step might have parameters and/or a filter
    if (path.ref[0].args)
      result += `(${renderArgs(path.ref[0], ':', env)})`;

    if (path.ref[0].where)
      result += `[${path.ref[0].cardinality ? (`${path.ref[0].cardinality.max}: `) : ''}${renderExpr(path.ref[0].where, env, true, true)}]`;

    // Add any path steps (possibly with parameters and filters) that may follow after that
    if (path.ref.length > 1)
      result += `.${renderExpr({ ref: path.ref.slice(1) }, env)}`;

    return result;
  }

  /**
   * Render a path that starts with an absolute name (as used for the source of a query),
   * possibly with an alias, with plain or quoted names, depending on options. Expects an object 'path' that has a
   * 'ref' and (in case of an alias) an 'as'. If necessary, an artificial alias
   * is created to the original implicit name.
   * Returns the name and alias as a string.
   *
   * @param {object} path Path to render
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} Rendered path including alias
   */
  function renderAbsolutePathWithAlias(path, env) {
    let result = renderAbsolutePath(path, env);
    // Take care of aliases - for artifact references, use the resulting name (multi-dot joined with _)
    const implicitAlias = path.ref.length === 0 ? getLastPartOf(getResultingName(csn, options.sqlMapping, path.ref[0])) : getLastPartOfRef(path.ref);
    if (path.as) {
      // Source had an alias - render it
      result += ` as ${formatIdentifier(path.as)}`;
    }
    else if (getLastPartOf(result) !== formatIdentifier(implicitAlias)) {
      // Render an artificial alias if the result would produce a different one
      result += ` as ${formatIdentifier(implicitAlias)}`;
    }
    return result;
  }

  /**
   * Render a single view or projection column 'col', as it occurs in a select list or
   * projection list within 'art', possibly with annotations.
   * Return the resulting source string (no trailing LF).
   *
   * @param {object} col Column to render
   * @param {CdlRenderEnvironment} env Environment
   * @param {CSN.Element} [element] Element (non-enum from subquery possibly) corresponding to the column ref
   * @returns {string} Rendered column
   */
  function renderViewColumn(col, env, element) {
    // Annotations and column
    let result = element && hasHanaComment(element, options) ? `${env.indent}@Comment: '${getEscapedHanaComment(element)}'\n` : '';

    const leaf = col.as || col.ref && col.ref[col.ref.length - 1];
    // Render 'null as <alias>' only for database and if element is virtual

    if (element && element.virtual || env._artifact.elements[leaf] && env._artifact.elements[leaf].virtual) {
      if (isDeprecatedEnabled(options, 'renderVirtualElements'))
        return `${result}${env.indent}null as ${formatIdentifier(leaf)}`;
    }
    else {
      return renderNonVirtualColumn();
    }

    return result;

    function renderNonVirtualColumn() {
      result += env.indent;
      // only if column is virtual, keyword virtual was present in the source text
      if (col.virtual)
        result += 'virtual ';
      // If key is explicitly set in a non-leading query, issue an error.
      if (col.key && env.skipKeys)
        error(null, env.path, { tokensymbol: 'key', $reviewed: true }, 'Unexpected $(TOKENSYMBOL) in subquery');

      const key = (!env.skipKeys && (col.key || (element && element.key)) ? 'key ' : '');
      result += key + renderExpr(col, env, true);
      let alias = col.as || col.func;
      // HANA requires an alias for 'key' columns just for syntactical reasons
      // FIXME: This will not complain for non-refs (but that should be checked in forHana)
      // Explicit or implicit alias?
      // Shouldn't we simply generate an alias all the time?
      if ((key || col.cast) && !alias)
        alias = leaf;

      if (alias)
        result += ` as ${formatIdentifier(alias)}`;

      // Explicit type provided for the view element?
      if (col.cast && col.cast.target) {
        // Special case: Explicit association type is actually a redirect
        // Redirections are never flattened (don't exist in HANA)
        result += ` : redirected to ${renderAbsoluteNameWithQuotes(col.cast.target, env)}`;
        if (col.cast.on)
          result += ` on ${renderExpr(col.cast.on, env, true, true)}`;
      }

      return result;
    }
  }

  /**
   * Render a view. If '$syntax' is set (to 'projection', 'view', 'entity'),
   * the view query is rendered in the requested syntax style, otherwise it
   * is rendered as a view.
   *
   * @param {string} artifactName Name of the artifact
   * @param {CSN.Artifact} art Content of the artifact
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} The rendered view
   */
  function renderView(artifactName, art, env) {
    let result = '';
    const artifactPath = [ 'definitions', artifactName ];
    globalDuplicateChecker.addArtifact(art['@cds.persistence.name'], artifactPath, artifactName);

    if (hasHanaComment(art, options))
      result += `${env.indent}@Comment: '${getEscapedHanaComment(art)}'\n`;

    result += `${env.indent}${art.abstract ? 'abstract ' : ''}view ${renderArtifactName(artifactName, env)}`;
    if (art.params) {
      const childEnv = increaseIndent(env);
      const parameters = Object.keys(art.params).map(name => renderParameter(name, art.params[name], childEnv)).join(',\n');
      // HANA only understands the 'with parameters' syntax'
      result += ` with parameters\n${parameters}\n${env.indent}as `;
    }
    else {
      result += ' as ';
    }
    env._artifact = art;
    result += renderQuery(getNormalizedQuery(art).query, true, env, artifactPath.concat(art.projection ? 'projection' : 'query'), art.elements);
    result += ';\n';
    return result;
  }

  /**
   * Render a query 'query', i.e. a select statement with where-condition etc.
   * If 'isLeadingQuery' is true, mixins, actions and functions of 'art' are
   * also rendered into the query. Use 'syntax' style ('projection', 'view',
   * or 'entity')
   *
   * @param {CSN.Query} query Query object
   * @param {boolean} isLeadingQuery Wether the query is the leading query or not
   * @param {CdlRenderEnvironment} env Environment
   * @param {CSN.Path} [path=[]] CSN path to the query
   * @param {object} [elements] For leading query, the elements of the artifact
   * @returns {string} The rendered query
   */
  function renderQuery(query, isLeadingQuery, env, path = [], elements) {
    let result = '';
    env.skipKeys = !isLeadingQuery;
    // Set operator, like UNION, INTERSECT, ...
    if (query.SET) {
      // First arg may be leading query
      result += `(${renderQuery(query.SET.args[0], isLeadingQuery, env, path.concat([ 'SET', 'args', 0 ]), elements)}`;
      // FIXME: Clarify if set operators can be n-ary (assuming binary here)
      if (query.SET.op) {
        // Loop over all other arguments, i.e. for A UNION B UNION C UNION D ...
        for (let i = 1; i < query.SET.args.length; i++)
          result += `\n${env.indent}${query.SET.op}${query.SET.all ? ' all' : ''} ${renderQuery(query.SET.args[i], false, env, path.concat([ 'SET', 'args', i ]))}`;
      }
      result += ')';
      // Set operation may also have an ORDER BY and LIMIT/OFFSET (in contrast to the ones belonging to
      // each SELECT)
      if (query.SET.orderBy)
        result += `${continueIndent(result, env)}order by ${query.SET.orderBy.map(entry => renderOrderByEntry(entry, env)).join(', ')}`;

      if (query.SET.limit)
        result += `${continueIndent(result, env)}${renderLimit(query.SET.limit, env)}`;

      return result;
    }
    // Otherwise must have a SELECT
    else if (!query.SELECT) {
      throw new Error(`Unexpected query operation ${JSON.stringify(query)}`);
    }
    const select = query.SELECT;
    const childEnv = increaseIndent(env);
    childEnv.currentArtifactName = $PROJECTION; // $self to be replaced by $projection
    result += `select from ${renderViewSource(select.from, env)}`;
    if (select.mixin) {
      let elems = '';
      for (const name in select.mixin)
        elems += renderElement(name, select.mixin[name], childEnv);

      if (elems) {
        result += ' mixin {\n';
        result += elems;
        result += `${env.indent}} into`;
      }
    }
    result += select.distinct ? ' distinct' : '';
    if (select.columns) {
      result += ' {\n';
      result += `${select.columns.map(col => renderViewColumn(col, childEnv, findElement(elements, col)))
        .filter(s => s !== '')
        .join(',\n')}\n`;
      result += `${env.indent}}`;
    }
    if (select.excluding) {
      result += ` excluding {\n${select.excluding.map(id => `${childEnv.indent}${formatIdentifier(id)}`).join(',\n')}\n`;
      result += `${env.indent}}`;
    }

    return renderSelectProperties(select, result);

    /**
     * Render WHERE, GROUP BY, HAVING, ORDER BY and LIMIT clause
     *
     * @param {CSN.QuerySelect} select
     * @param {string} alreadyRendered The query as it has been rendered so far
     * @returns {string} The query with WHERE etc. added
     */
    function renderSelectProperties(select, alreadyRendered) {
      if (select.where)
        alreadyRendered += `${continueIndent(alreadyRendered, env)}where ${renderExpr(select.where, env, true, true)}`;

      if (select.groupBy)
        alreadyRendered += `${continueIndent(alreadyRendered, env)}group by ${select.groupBy.map(expr => renderExpr(expr, env)).join(', ')}`;

      if (select.having)
        alreadyRendered += `${continueIndent(alreadyRendered, env)}having ${renderExpr(select.having, env, true, true)}`;

      if (select.orderBy)
        alreadyRendered += `${continueIndent(alreadyRendered, env)}order by ${select.orderBy.map(entry => renderOrderByEntry(entry, env)).join(', ')}`;

      if (select.limit)
        alreadyRendered += `${continueIndent(alreadyRendered, env)}${renderLimit(select.limit, env)}`;

      return alreadyRendered;
    }


    /**
     * Utility function to make sure that we continue with the same indentation in WHERE, GROUP BY, ... after a closing curly brace and beyond
     *
     * @param {string} result Result of a previous render step
     * @param {CdlRenderEnvironment} env Environment
     * @returns {string} String to join with
     */
    function continueIndent(result, env) {
      if (result.endsWith('}') || result.endsWith('})')) {
        // The preceding clause ended with '}', just append after that
        return ' ';
      }
      // Otherwise, start new line and indent normally
      return `\n${increaseIndent(env).indent}`;
    }

    /**
     * Render a query's LIMIT clause, which may have also have OFFSET.
     *
     * @param {CSN.QueryLimit} limit CSN limit clause
     * @param {CdlRenderEnvironment} env Environment
     * @returns {string} Rendered limit clause
     */
    function renderLimit(limit, env) {
      let result = '';
      if (limit.rows !== undefined)
        result += `limit ${renderExpr(limit.rows, env)}`;

      if (limit.offset !== undefined)
        result += `${result !== '' ? `\n${increaseIndent(env).indent}` : ''}offset ${renderExpr(limit.offset, env)}`;

      return result;
    }
  }

  /**
   * Render one entry of a query's ORDER BY clause (which always has a 'value' expression, and may
   * have a 'sort' property for ASC/DESC and a 'nulls' for FIRST/LAST
   *
   * @param {object} entry CSN order by
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} Rendered order by
   */
  function renderOrderByEntry(entry, env) {
    let result = renderExpr(entry, env);
    if (entry.sort)
      result += ` ${entry.sort}`;

    if (entry.nulls)
      result += ` nulls ${entry.nulls}`;

    return result;
  }

  /**
   * Render a view parameter.
   *
   * @param {string} parName Name of the parameter
   * @param {object} par CSN parameter
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} The resulting parameter as source string (no trailing LF).
   */
  function renderParameter(parName, par, env) {
    if (par.notNull === true || par.notNull === false)
      info(null, env.path.concat([ 'params', parName ]), 'Not Null constraints on HDBCDS view parameters are not allowed and are ignored');
    return `${env.indent + formatParamIdentifier(parName, env.path.concat([ 'params', parName ]))} : ${renderTypeReference(par, env)}`;
  }

  /**
   * Render a type (derived or structured).
   * Return the resulting source string.
   *
   * @param {string} artifactName Name of the artifact
   * @param {CSN.Artifact} art Content of the artifact
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} Rendered type/annotation
   */
  function renderType(artifactName, art, env) {
    if (art.kind === 'aspect' || art.kind === 'type' && !hdbcdsNames || art.kind === 'type' && hdbcdsNames && !art.elements)
      return '';
    let result = '';
    result += `${env.indent + (art.kind )} ${renderArtifactName(artifactName, env, true)}`;
    if (art.includes) {
      // Includes are never flattened (don't exist in HANA)
      result += ` : ${art.includes.map(name => renderAbsoluteNameWithQuotes(name, env)).join(', ')}`;
    }
    const childEnv = increaseIndent(env);
    if (art.elements && !art.type) {
      // Structured type or annotation with anonymous struct type
      result += ' {\n';
      for (const name in art.elements)
        result += renderElement(name, art.elements[name], childEnv);

      result += `${env.indent}};\n`;
    }
    else {
      // Derived type or annotation with non-anonymous type
      result += ` : ${renderTypeReference(art, env, false)};\n`;
    }
    return result;
  }

  /**
   * Render a reference to a type used by 'elm' (named or inline)
   * Allow suppressing enum-rendering - used in columns for example
   *
   * @param {CSN.Element} elm Element using the type reference
   * @param {CdlRenderEnvironment} env Environment
   * @param {boolean} [noEnum=false] If true, do not render enums
   * @returns {string} Rendered type reference
   */
  function renderTypeReference(elm, env, noEnum = false) {
    let result = '';

    // Array type: Render items instead
    if (elm.items && !elm.type) {
      // HANA CDS does not support keyword many
      let rc = `array of ${renderTypeReference(elm.items, env)}`;
      if (elm.items.notNull != null)
        rc += elm.items.notNull ? ' not null' : ' null';
      return rc;
    }

    // FIXME: Is this a type attribute?
    result += (elm.localized ? 'localized ' : '');

    // Anonymous structured type
    if (!elm.type) {
      if (!elm.elements)
        throw new Error(`Missing type of: ${JSON.stringify(elm)}`);

      result += '{\n';
      const childEnv = increaseIndent(env);
      // omit "key" keyword for nested elements, as this will result in a deployment error in naming mode 'hdbcds'
      const dontRenderKeyForNestedElement = hdbcdsNames;
      for (const name in elm.elements)
        result += renderElement(name, elm.elements[name], childEnv, null, dontRenderKeyForNestedElement);

      result += `${env.indent}}`;
      return result;
    }

    // Association type
    if ([ 'cds.Association', 'cds.Composition' ].includes(elm.type))
      return result + renderAssociationType(elm, env);

    // Reference to another element
    if (elm.type.ref) {
      // For HANA CDS, we need a 'type of'
      let result = `type of ${renderAbsolutePath(elm.type, env)}`;
      if (elm.enum)
        result += renderEnum(elm.enum, env);

      return result;
    }

    // If we get here, it must be a named type
    if (isBuiltinType(elm.type)) {
      result += renderBuiltinType(elm);
    }
    else {
      // Simple absolute name
      // Type names are never flattened (derived types are unraveled in HANA)
      result += renderAbsoluteNameWithQuotes(elm.type, env);
    }
    if (elm.enum && !noEnum)
      result += renderEnum(elm.enum, env);

    return result;
  }

  /**
   * @param {CSN.Element} elm
   * @param {CdlRenderEnvironment} env
   * @returns {string}
   */
  function renderAssociationType(elm, env) {
    // Type, cardinality and target
    let result = 'association';

    result += `${renderCardinality(elm.cardinality)} to `;


    // normal target or named aspect
    if (elm.target || elm.targetAspect && typeof elm.targetAspect === 'string') {
      // we might have a "using target as __target"
      const targetArtifact = csn.definitions[elm.target];
      const targetAlias = env.topLevelAliases[targetArtifact['@cds.persistence.name']];
      if (targetAlias) {
        result += targetAlias.quotedAlias;
      }
      else {
        result += plainNames ? renderAbsoluteNamePlain(elm.target || elm.targetAspect, env)
          : renderAbsoluteNameWithQuotes(elm.target || elm.targetAspect, env);
      }
    }

    // ON-condition (if any)
    if (elm.on) {
      result += ` on ${renderExpr(elm.on, env, true, true)}`;
    }
    else if (elm.targetAspect && elm.targetAspect.elements) { // anonymous aspect
      const childEnv = increaseIndent(env);
      result += '{\n';
      for (const name in elm.targetAspect.elements)
        result += renderElement(name, elm.targetAspect.elements[name], childEnv);

      result += `${env.indent}}`;
    }


    // Foreign keys (if any, unless we also have an ON_condition (which means we have been transformed from managed to unmanaged)
    if (elm.keys && !elm.on)
      result += ` { ${Object.keys(elm.keys).map(name => renderForeignKey(elm.keys[name], env)).join(', ')} }`;

    return result;
  }

  /**
   * Render a builtin type. cds.Integer => render as Integer (no quotes)
   * Map Decimal (w/o Prec/Scale) to cds.DecimalFloat for HANA CDS
   *
   * @param {CSN.Element} elm Element with the type
   * @returns {string} The rendered type
   */
  function renderBuiltinType(elm) {
    if (elm.type === 'cds.Decimal' && elm.scale === undefined && elm.precision === undefined)
      return 'DecimalFloat';

    return elm.type.replace(/^cds\./, '') + renderTypeParameters(elm);
  }

  /**
   * Render the 'enum { ... } part of a type declaration
   *
   * @param {CSN.EnumElements} enumPart Enum part of a type declaration
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} Rendered enum
   */
  function renderEnum(enumPart, env) {
    let result = ' enum {\n';
    const childEnv = increaseIndent(env);
    for (const name in enumPart) {
      const enumConst = enumPart[name];
      result += childEnv.indent + quoteId(name);
      if (enumConst.val !== undefined)
        result += ` = ${renderExpr(enumConst, childEnv)}`;
      result += ';\n';
    }
    result += `${env.indent}}`;
    return result;
  }

  /**
   * Render an expression (including paths and values) or condition 'x'.
   * (no trailing LF, don't indent if inline)
   *
   * @param {any} x Expression to render
   * @param {CdlRenderEnvironment} env Environment
   * @param {boolean} [inline=true] Wether to render inline
   * @param {boolean} [inExpr=false] Whether the expression is already inside another expression
   * @returns {string} Rendered expression
   */
  function renderExpr(x, env, inline = true, inExpr = false) {
    // Compound expression
    if (Array.isArray(x))
      return beautifyExprArray(x.map(item => renderExpr(item, env, inline, inExpr)));

    if (typeof x === 'object' && x !== null) {
      if (inExpr && x.cast && x.cast.type)
        return renderExplicitTypeCast(renderExprObject());
      return renderExprObject();
    }

    // Not a literal value but part of an operator, function etc - just leave as it is
    return x;


    /**
     * Various special cases represented as objects
     *
     * @returns {string} Rendered expression object
     */
    function renderExprObject() {
      if (x.list) {
        // set "inExpr" to false: treat list elements as new expressions
        return `(${x.list.map(item => renderExpr(item, env, inline, false)).join(', ')})`;
      }
      else if (x.val !== undefined) {
        return renderExpressionLiteral(x);
      }
      // Enum symbol
      else if (x['#']) {
        return `#${x['#']}`;
      }
      // Reference: Array of path steps, possibly preceded by ':'
      else if (x.ref) {
        return renderExpressionRef(x);
      }
      // Function call, possibly with args (use '=>' for named args)
      else if (x.func) {
        // test for non-regular HANA identifier that needs to be quoted
        // identifier                  {letter}({letter_or_digit}|[#$])*
        // letter                      [A-Za-z_]
        // letter_or_digit             [A-Za-z_0-9]

        const regex = RegExp(/^[a-zA-Z][\w#$]*$/, 'g');
        const funcName = regex.test(x.func) ? x.func : quoteId(x.func);
        // we can't quote functions with parens, issue warning if it is a reserved keyword
        if (!funcWithoutParen(x, 'hana') && keywords.hdbcds.includes(uppercaseAndUnderscore(funcName)))
          warning(null, x.$location, `The identifier “${uppercaseAndUnderscore(funcName)}“ is a SAP HANA keyword`);
        return renderFunc( funcName, x, 'hana', a => renderArgs(a, '=>', env) );
      }
      // Nested expression
      else if (x.xpr) {
        if (inExpr && !x.cast)
          return `(${renderExpr(x.xpr, env, inline, true)})`;

        return renderExpr(x.xpr, env, inline, true);
      }
      // Sub-select
      else if (x.SELECT) {
        // renderQuery for SELECT does not bring its own parentheses (because it is also used in renderView)
        return `(${renderQuery(x, false, increaseIndent(env))})`;
      }
      else if (x.SET) {
        // renderQuery for SET always brings its own parentheses (because it is also used in renderViewSource)
        return `${renderQuery(x, false, increaseIndent(env))}`;
      }

      throw new Error(`Unknown expression: ${JSON.stringify(x)}`);
    }
    /**
     * @param {object} x Expression with a val and/or literal property
     * @returns {string} Rendered expression
     */
    function renderExpressionLiteral(x) {
      // Literal value, possibly with explicit 'literal' property
      switch (x.literal || typeof x.val) {
        case 'number':
        case 'boolean':
        case 'null':
          return x.val;
        case 'x':
        case 'date':
        case 'time':
        case 'timestamp':
          return `${x.literal}'${x.val}'`;
        case 'string':
          return `'${x.val.replace(/'/g, '\'\'')}'`;
        case 'object':
          if (x.val === null)
            return 'null';

        // otherwise fall through to
        default:
          throw new Error(`Unknown literal or type: ${JSON.stringify(x)}`);
      }
    }

    /**
     * @param {object} x Expression with a ref property
     * @returns {string} Rendered expression
     * @todo no extra magic with x.param or x.global
     */
    function renderExpressionRef(x) {
      if (!x.param && !x.global) {
        if (x.ref[0] === '$user') {
          // FIXME: this is all not enough: we might need an explicit select item alias
          if (x.ref[1] === 'id') {
            if (options.magicVars && options.magicVars.user && (typeof options.magicVars.user === 'string' || options.magicVars.user instanceof String))
              return `'${options.magicVars.user}'`;

            else if ((options.magicVars && options.magicVars.user && options.magicVars.user.id) && (typeof options.magicVars.user.id === 'string' || options.magicVars.user.id instanceof String))
              return `'${options.magicVars.user.id}'`;

            return 'SESSION_CONTEXT(\'APPLICATIONUSER\')';
          }
          else if (x.ref[1] === 'locale') {
            return 'SESSION_CONTEXT(\'LOCALE\')';
          }
        }
        else if (x.ref[0] === '$at') {
          if (x.ref[1] === 'from')
            return 'TO_TIMESTAMP(SESSION_CONTEXT(\'VALID-FROM\'))';

          else if (x.ref[1] === 'to')
            return 'TO_TIMESTAMP(SESSION_CONTEXT(\'VALID-TO\'))';
        }
      }
      return `${(x.param || x.global) ? ':' : ''}${x.ref.map((step, index) => renderPathStep(step, index, x.ref)).join('.')}`;
    }

    /**
     * Renders an explicit `cast()` inside an 'xpr'.
     *
     * @param {string} value Value to cast
     * @returns {string} Rendered cast()
     */
    function renderExplicitTypeCast(value) {
      let typeRef = renderTypeReference(x.cast, env, true);

      // inside a cast expression, the cds and hana cds types need to be mapped to hana sql types
      const hanaSqlType = cdsToSqlTypes.hana[x.cast.type] || cdsToSqlTypes.standard[x.cast.type];
      if (hanaSqlType) {
        const typeRefWithoutParams = typeRef.substring(0, typeRef.indexOf('(')) || typeRef;
        typeRef = typeRef.replace(typeRefWithoutParams, hanaSqlType);
      }
      return `CAST(${value} AS ${typeRef})`;
    }

    /**
     * Render a single path step 's' at path position 'idx', which can have filters or parameters or be a function
     *
     * @param {string|object} s Path step
     * @param {number} idx Path position
     * @returns {string} Rendered path step
     */
    function renderPathStep(s, idx, ref) {
      // Simple id or absolute name
      if (typeof s === 'string') {
        // HANA-specific extra magic (should actually be in forHana)
        // In HANA, we replace leading $self by the absolute name of the current artifact
        // (see FIXME at renderArtifact)
        if (idx === 0 && s === $SELF) {
          // do not produce USING for $projection
          if (env.currentArtifactName === $PROJECTION && env._artifact && env._artifact.projection)
            return env.currentArtifactName;

          return plainNames ? renderAbsoluteNamePlain(env.currentArtifactName, env)
            : renderAbsoluteNameWithQuotes(env.currentArtifactName, env);
        }
        // HANA-specific translation of '$now' and '$user'
        if (s === '$now' && ref.length === 1)
          return 'CURRENT_TIMESTAMP';

        // In first path position, do not quote $projection and magic $-variables like CURRENT_DATE, $now etc.
        // FIXME: We should rather explicitly recognize quoting somehow

        // TODO: quote $parameters if it doesn't reference a parameter, this requires knowledge about the kind
        // Example: both views are correct in HANA CDS
        // entity E { key id: Integer; }
        // view EV with parameters P1: Integer as select from E { id, $parameters.P1 };
        // view EVp as select from E as "$parameters" { "$parameters".id };

        if (idx === 0 &&
          [ $SELF, $PROJECTION, '$session' ].includes(s))
          return s;

        return formatIdentifier(s);
      }
      // ID with filters or parameters
      else if (typeof s === 'object') {
        // Sanity check
        if (!s.func && !s.id)
          throw new Error(`Unknown path step object: ${JSON.stringify(s)}`);

        // Not really a path step but an object-like function call
        if (s.func)
          return `${s.func}(${renderArgs(s, '=>', env)})`;

        // Path step, possibly with view parameters and/or filters
        let result = `${formatIdentifier(s.id)}`;
        if (s.args) {
          // View parameters
          result += `(${renderArgs(s, ':', env)})`;
        }
        if (s.where) {
          // Filter, possibly with cardinality
          result += `[${s.cardinality ? (`${s.cardinality.max}: `) : ''}${renderExpr(s.where, env, inline, true)}]`;
        }
        return result;
      }

      throw new Error(`Unknown path step: ${JSON.stringify(s)}`);
    }
  }

  /**
   * Render function arguments or view parameters (positional if array, named if object/dict),
   * using 'sep' as separator for positional parameters
   *
   * @param {object} node with `args` to render
   * @param {string} sep Seperator between arguments
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} Rendered arguments
   */
  function renderArgs(node, sep, env) {
    const args = node.args ? node.args : {};
    // Positional arguments
    if (Array.isArray(args))
      return args.map(arg => renderExpr(arg, env)).join(', ');

    // Named arguments (object/dict)
    else if (typeof args === 'object')
      // if this is a function param which is not a reference to the model, we must not quote it
      return Object.keys(args).map(key => `${node.func ? key : formatIdentifier(key)} ${sep} ${renderExpr(args[key], env)}`).join(', ');


    throw new Error(`Unknown args: ${JSON.stringify(args)}`);
  }

  /**
   * Render a cardinality (only those parts that were actually provided)
   *
   * @param {CSN.Cardinality} card Cardinality
   * @returns {string} Rendered cardinality
   */
  function renderCardinality(card) {
    if (!card)
      return '';

    let result = '[';
    if (card.src !== undefined)
      result += `${card.src}, `;

    if (card.min !== undefined)
      result += `${card.min}..`;

    if (card.max !== undefined)
      result += card.max;

    return `${result}]`;
  }

  /**
   * Render the nullability of an element or parameter (can be unset, true, or false)
   *
   * @param {object} obj Thing to render for
   * @returns {string} null/not null
   */
  function renderNullability(obj /* , env */) {
    if (obj.notNull === undefined) {
      // Attribute not set at all
      return '';
    }
    return obj.notNull ? ' not null' : ' null';
  }

  /**
   * Render a foreign key (no trailing LF)
   *
   * @todo Can this still happen after Hana transformation?
   *
   * @param {object} fKey Foreign key to render
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} Rendered foreign key
   */
  function renderForeignKey(fKey, env) {
    return `${renderExpr(fKey, env)}${fKey.as ? (` as ${fKey.as}`) : ''}`;
  }

  /**
   * Render (primitive) type parameters of element 'elm', i.e.
   * length, precision and scale (even if incomplete), plus any other unknown ones.
   *
   * @param {CSN.Element} elm Element to render type parameters for
   * @returns {string} Rendered type parameters
   */
  function renderTypeParameters(elm /* , env */) {
    const params = [];
    // Length, precision and scale (even if incomplete)
    if (elm.length !== undefined)
      params.push(elm.length);

    if (elm.precision !== undefined)
      params.push(elm.precision);

    if (elm.scale !== undefined)
      params.push(elm.scale);

    if (elm.srid !== undefined)
      params.push(elm.srid);

    return params.length === 0 ? '' : `(${params.join(', ')})`;
  }

  /**
   * Render an absolute name in 'plain' mode, i.e. uppercased and underscored. Also record the
   * fact that 'absName' is used in 'env', so that an appropriate USING can be constructed
   * if necessary.
   *
   * @param {string} absName Absolute name
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} Uppercased and underscored absName
   */
  function renderAbsoluteNamePlain(absName, env) {
    // Add using declaration
    env.topLevelAliases[absName] = {
      quotedName: formatIdentifier(uppercaseAndUnderscore(absName)),
      quotedAlias: formatIdentifier(uppercaseAndUnderscore(absName)),
    };
    return formatIdentifier(uppercaseAndUnderscore(absName));
  }

  /**
   * Render an absolute name 'absName', with appropriate quotes. Also record the
   * fact that 'absName' is used in 'env', so that an appropriate USING can be constructed
   * if necessary.
   *
   * @param {string} absName absolute name
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} absName, with correct quotes
   */
  function renderAbsoluteNameWithQuotes(absName, env) {
    // Special case: If the top-level artifact name is not a valid artifact name, it came from an unchecked annotation
    // and must be left as it is (just quoted)
    let topLevelName = getRootArtifactName(absName, csn);
    const realName = getRealName(csn, absName);

    if (realName === absName)
      topLevelName = absName;

    if (!csn.definitions[topLevelName])
      return quotePathString(absName);


    // Another special case: If we are rendering for HANA, and if the first path step is an artifact that is
    // 'implemented in' something, we need to treat the whole name like a top-level id.
    if (csn.definitions[absName] && csn.definitions[absName]['@cds.persistence.exists']) {
      env.topLevelAliases[absName] = {
        quotedName: quoteAbsoluteNameAsId(absName),
        quotedAlias: quoteId(createTopLevelAliasName(absName)),
      };
      return env.topLevelAliases[absName].quotedAlias;
    }

    // Retrieve or create a suitable alias name for the surrounding top-level artifact
    let topLevelAlias = env.topLevelAliases[topLevelName];
    if (!topLevelAlias) {
      env.topLevelAliases[topLevelName] = {
        quotedName: quoteAbsolutePathString(topLevelName),
        quotedAlias: quoteId(createTopLevelAliasName(topLevelName)),
      };
      topLevelAlias = env.topLevelAliases[topLevelName];
    }

    // Replace the top-level name with its alias
    if (absName === topLevelName) {
      return topLevelAlias.quotedAlias;
    }
    else if (csn.definitions[absName] && realName !== absName) {
      // special handling for names with dots

      const prefix = absName.slice(0, absName.length - realName.length);
      const nonTopLevelPrefix = prefix.slice(topLevelName.length + 1, -1); // also trim off .
      if (nonTopLevelPrefix)
        return `${topLevelAlias.quotedAlias}.${quotePathString(nonTopLevelPrefix)}.${quotePathString(realName)}`;

      return `${topLevelAlias.quotedAlias}.${quotePathString(realName)}`;
    }
    return `${topLevelAlias.quotedAlias}.${quotePathString(realName)}`;
  }

  /**
   * Create a suitable alias name for a top-level artifact name. Ideally, it should not conflict with
   * any other identifier in the model and be somewhat recognizable and un-ugly...
   *
   * @todo check for conflicts instead of praying that it works...
   * @param {string} topLevelName Name of a top-level artifact
   * @returns {string} Appropriate __alias
   */
  function createTopLevelAliasName(topLevelName) {
    // FIXME: We should rather check for conflicts than just using something obscure like this ...
    return `__${topLevelName.replace(/::/g, '__').replace(/\./g, '_')}`;
  }

  /**
   * Render appropriate USING directives for all artifacts used by artifact 'artifactName' in 'env'.
   *
   * @param {string} artifactName Artifact to render usings for
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} Usings for the given artifact
   */
  function renderUsings(artifactName, env) {
    const distinct = {};
    Object.keys(env.topLevelAliases)
      .filter(name => env.topLevelAliases[name].quotedAlias !== formatIdentifier(uppercaseAndUnderscore(artifactName))) // avoid "using FOO as FOO" in FOO.cds
      .forEach((name) => {
        distinct[`using ${env.topLevelAliases[name].quotedName} as ${env.topLevelAliases[name].quotedAlias};\n`] = '';
      });

    return Object.keys(distinct).join('');
  }

  /**
   * Depending on the naming style, render the namespace declaration for a top-level artifact 'name'
   * if it has a namespace parent. Assume that this is only called for top-level artifacts.
   *  - For 'quoted' and 'hdbcds' names, render the namespace declaration (resulting in '.' or '::' style names)
   *  - For 'plain' names, do not render anything (namespace already part of flattened names).
   * Return the namespace declaration (with trailing LF) or an empty string.
   *
   * @param {string} topLevelName Name of a top-level artifact
   * @param {CdlRenderEnvironment} env Environment
   * @returns {string} Rendered namespace declaration
   */
  function renderNamespaceDeclaration(topLevelName, env) {
    if (plainNames) {
      // No namespaces in plain mode
      return '';
    }
    // The top-level artifact's parent would be the namespace (if any)
    const namespace = getNamespace(csn, topLevelName) || '';
    if (namespace)
      return `${env.indent}namespace ${quotePathString(namespace)};\n`;

    return '';
  }

  /**
   * Return a dictionary of top-level artifacts contained in the model (by their name)
   *
   * @returns {CSN.Definitions} Dictionary of top-level artifacts name:content
   */
  function getTopLevelArtifacts() {
    const result = Object.create(null);
    for (const name in csn.definitions) {
      if (plainNames) {
        const art = csn.definitions[name];
        // For 'plain' naming, take all entities and views, nothing else
        if (art.kind === 'entity' || art.kind === 'view')
          result[name] = art;
      }
      else {
        // For all other naming conventions, take all top-level artifacts except namespaces
        const topLevelName = getRootArtifactName(name, csn);
        const topLevelArtifact = csn.definitions[topLevelName];
        if (topLevelArtifact && topLevelArtifact.kind !== 'namespace')
          result[topLevelName] = topLevelArtifact;
      }
    }
    return options && options.testMode ? sort(result) : result;
  }

  /**
   * Returns a newly created default environment (which keeps track of indentation, required USING
   * declarations and name prefixes.
   *
   * @returns {CdlRenderEnvironment} Fresh environment
   */
  function createEnv() {
    return {
      // Current indentation string
      indent: '',
      // Dictionary of aliases for used artifact names, each entry like 'name' : { quotedName, quotedAlias }
      topLevelAliases: Object.create(null),
      // Current name prefix (including trailing dot if not empty)
      namePrefix: '',
      // CSN path - should at least point to the correct artifact
      path: [],
    };
  }

  /**
   * Returns a copy of 'env' with (quoted) name prefix 'id' and a dot appended to the current name prefix
   *
   * @param {CdlRenderEnvironment} env Current environment
   * @param {string} id Name prefix to add
   * @returns {CdlRenderEnvironment} New environment with added prefix
   */
  function addNamePrefix(env, id) {
    return Object.assign({}, env, { namePrefix: `${env.namePrefix + quoteId(id)}.` });
  }

  /**
   * Returns a copy of 'env' with increased indentation (and resetted name prefix)
   *
   * @param {CdlRenderEnvironment} env Current environment
   * @returns {CdlRenderEnvironment} New environment with increased indent
   */
  function increaseIndent(env) {
    return Object.assign({}, env, { namePrefix: '', indent: `${env.indent}  ` });
  }

  /**
   * Return a path string 'path' with appropriate "-quotes.
   *
   * @param {string} path Path to quote
   * @returns {string} Quoted path
   */
  function quotePathString(path) {
    // "foo"."bar"."wiz"."blub"
    return path.split('.').map(quoteId).join('.');
  }

  /**
   * Return an absolute path 'abspath', with '::' inserted if required by naming strategy 'hdbcds',
   * with appropriate "-quotes
   *
   * @param {string} abspath Absolute path to quote
   * @returns {string} Quoted path
   */
  function quoteAbsolutePathString(abspath) {
    const namespace = getNamespace(csn, abspath);
    const resultingName = getResultingName(csn, options.sqlMapping, abspath);

    if (hdbcdsNames && namespace)
      return `${quotePathString(namespace)}::${quotePathString(resultingName.slice(namespace.length + 2))}`;

    return quotePathString(resultingName);
  }

  /**
   * Return an id 'id' with appropriate "-quotes
   *
   * @param {string} id Identifier to quote
   * @returns {string} Properly quoted identifier
   */
  function quoteId(id) {
    // Should only ever be called for real IDs (i.e. no dots inside)
    if (id.indexOf('.') !== -1)
      throw new Error(id);

    // FIXME: Somewhat arbitrary magic: Do not quote $projection (because HANA CDS doesn't recognize it otherwise).  Similar for $self.
    // FIXME: The test should not be on the name, but by checking the _artifact.
    if (id === $PROJECTION || id === $SELF)
      return id;


    switch (options.forHana.names) {
      case 'plain':
        return smartId(id, 'hdbcds');
      case 'quoted':
        return delimitedId(id, 'hdbcds');
      case 'hdbcds':
        return delimitedId(id, 'hdbcds');
      default:
        return null;
    }
  }

  /*
   * Return an absolute name 'absname', with '::' inserted if required by naming strategy 'hdbcds', quoted
   * as if it was a single identifier (required only for native USINGs)
   *
   * @param {string} absname Absolute name
   * @returns {string} Correctly quoted absname
   */
  function quoteAbsoluteNameAsId(absname) {
    if (hdbcdsNames) {
      const topLevelName = getRootArtifactName(absname, csn);
      const namespace = getParentNameOf(topLevelName);
      if (namespace)
        return `"${(`${namespace}::${absname.substring(namespace.length + 1)}`).replace(/"/g, '""')}"`;
    }
    return `"${absname.replace(/"/g, '""')}"`;
  }

  /**
   * Quote and/or uppercase an identifier 'id', depending on naming strategy
   *
   * @param {string} id Identifier
   * @returns {string} Quoted/uppercased id
   */
  function formatIdentifier(id) {
    id = options.forHana.names === 'plain' ? id.toUpperCase() : id;
    return quoteId(id);
  }

  /**
   * Quote or uppercase a parameter identifier 'id', depending on naming strategy
   * Smart quoting cannot be applied to the parameter identifiers, issue warning instead.
   *
   *
   * @param {string} id Identifier
   * @param {CSN.Path} [location] Optional location for the warning.
   * @returns {string} Quoted/uppercased id
   */
  function formatParamIdentifier(id, location) {
    // Warn if colliding with HANA keyword, but do not quote for plain
    // --> quoted reserved words as param lead to a weird deployment error
    if (keywords.hdbcds.includes(uppercaseAndUnderscore(id)))
      warning(null, location, { id }, 'The identifier $(ID) is a SAP HANA keyword');

    if (plainNames)
      return uppercaseAndUnderscore(id);

    return quoteId(id);
  }

  /**
   * Render the name of an artifact, using the current name prefix from 'env'
   * and the real name of the artifact. In case of plain names, this
   * is equivalent to simply flattening and uppercasing the whole name.
   *
   * To handle such cases for hdbcds in quoted/hdbcds, we:
   * - Find the part of the name that is no longer prefix (context/service/namespace)
   * - For Service.E -> E, for Service.E.Sub -> E.Sub
   * - Replace all dots in this "real name" with underscores
   * - Join with the env prefix
   *
   *
   * @param {string} artifactName Artifact name to render
   * @param {CdlRenderEnvironment} env Render environment
   * @param {boolean} [fallthrough=false] For certain artifacts, plain-rendering is supposed to look like quoted/hdbcds
   * @returns {string} Artifact name ready for rendering
   */
  function renderArtifactName(artifactName, env, fallthrough = false) {
    if (plainNames && !fallthrough)
      return formatIdentifier(uppercaseAndUnderscore(artifactName));
      // hdbcds with quoted or hdbcds naming
    return env.namePrefix + quoteId(getRealName(csn, artifactName).replace(/\./g, '_'));
  }

  /**
   * For 'name', replace '.' by '_', convert to uppercase, and add double-quotes if
   * required because of non-leading '$' (but do not consider leading '$', other special
   * characters, or SQL keywords/functions - somewhat weird but this retains maximum
   * compatibility with a future hdbtable-based solution and with sqlite, where non-leading
   * '$' is legal again but nothing else)
   *
   * @param {string} name Name to transform
   * @returns {string} Uppercased and underscored name
   */
  function uppercaseAndUnderscore(name) {
    // Always replace '.' by '_' and uppercase
    return name.replace(/\./g, '_').toUpperCase();
  }
}

/**
 * @typedef CdlRenderEnvironment Rendering environment used throughout the render process.
 *
 * @property {string}   indent Current indentation as a string, e.g. '  ' for two spaces.
 * @property {CSN.Path} [path] CSN path to the current artifact
 * @property {string}   [currentArtifactName] Name of the current artifact
 * @property {{[name: string]: {
      quotedName: string,
      quotedAlias: string
    }}} topLevelAliases Dictionary of aliases for used artifact names
 *
 * @property {string} namePrefix Current name prefix (including trailing dot if not empty)
 * @property {boolean} [skipKeys] Skip rendering keys in subqueries
 * @property {CSN.Artifact} [_artifact] The original view artifact, used when rendering queries
 */

module.exports = { toHdbcdsSource };
