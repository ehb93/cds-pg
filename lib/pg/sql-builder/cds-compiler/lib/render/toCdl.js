'use strict';

const {
  getTopLevelArtifactNameOf, getLastPartOf,
  getLastPartOfRef,
} = require('../model/csnUtils');
const {
  isBuiltinType, generatedByCompilerVersion, getNormalizedQuery,
} = require('../model/csnUtils');
const keywords = require('../base/keywords');
const { renderFunc, beautifyExprArray, findElement } = require('./utils/common');
const { checkCSNVersion } = require('../json/csnVersion');
const timetrace = require('../utils/timetrace');
const { csnRefs } = require('../model/csnRefs');
const { forEachDefinition } = require('../model/csnUtils');
const enrichUniversalCsn = require('../transform/universalCsnEnricher');
const { isBetaEnabled } = require('../base/model');

/**
 * Render the CSN model 'model' to CDS source text. One source is created per
 * top-level artifact. Return a dictionary of top-level artifacts
 * by their names, like this:
 * { "foo" : "using XY; context foo {...};",
 *   "bar::wiz" : "namespace bar::; entity wiz {...};"
 * }
 * FIXME: This comment no longer tells the whole truth
 *
 * @param {CSN.Model} csn
 * @param {CSN.Options} [options]
 */
function toCdsSourceCsn(csn, options) {
  timetrace.start('CDL rendering');
  const { artifactRef } = csnRefs(csn);

  // Skip compactModel if already using CSN
  // const csn = cloneCsn(model, options);

  if (options.csnFlavor === 'universal' && isBetaEnabled(options, 'enableUniversalCsn'))
    enrichUniversalCsn(csn, options);

  checkCSNVersion(csn, options);

  const result = Object.create(null);

  const main = 'model';

  result[main] = `${options.testMode ? '' : `// ${generatedByCompilerVersion()} \n`}`;

  const subelementAnnotates = [];

  forEachDefinition(csn, (artifact, artifactName) => {
    const env = createEnv();
    const sourceStr = renderArtifact(artifactName, artifact, env); // Must come first because it populates 'env.topLevelAliases'
    if (sourceStr !== '')
      result[main] += `${sourceStr}\n`;
  });

  // Apply possible subelement/action return annotations with an "annotate X with"
  // Some of them appear in csn.extensions, some not...
  if (subelementAnnotates.length > 0) {
    for (const [ artName, element, elementName, suffix ] of subelementAnnotates) {
      // Suffix is used with action return annotations
      let sourceStr = `annotate ${artName} with ${suffix ? `${suffix} ` : ''}{\n`;
      if (elementName) // action returns do not have element name - we need less {} there
        sourceStr += `  ${elementName} {\n`;
      const env = increaseIndent(increaseIndent(createEnv()));
      const subelements = renderSubelementAnnotates(element, env);
      if (subelements !== '') {
        sourceStr += `${subelements}\n`;
        if (elementName) // action returns do not have element name - we need less {} there
          sourceStr += '  }\n';
        sourceStr += '}\n';
        result[main] += `${sourceStr}\n`;
      }
    }
  }

  /**
   * Render annotations for subelements as part of an "annotate X with" statement
   *
   * @param {CSN.Element} element The element to annotate the subelements for
   * @param {CdlRenderEnvironment} env Render environment
   * @returns {String}
   */
  function renderSubelementAnnotates(element, env) {
    const result = [];
    for (const [ name, subelement ] of Object.entries(element.elements)) {
      const subresult = [];
      const annos = renderAnnotationAssignments(subelement, env);
      if (annos !== '')
        subresult.push(annos.slice(0, -1));

      const quotedElementName = quoteOrUppercaseId(name);
      if (subelement.elements) {
        subresult.push(`${env.indent}${quotedElementName} {`);
        subresult.push(renderSubelementAnnotates(subelement, increaseIndent(env)));
        subresult.push(`${env.indent}};`);
      }
      else {
        subresult.push(`${env.indent}${quotedElementName};`);
      }
      // Only add result if there really was "something"
      if (annos || subelement.elements)
        result.push(...subresult);
    }
    return result.join('\n');
  }

  if (csn.vocabularies) {
    for (const annotationName of Object.keys(csn.vocabularies)) {
      // This environment is passed down the call hierarchy, for dealing with
      // indentation and name resolution issues
      const anno = csn.vocabularies[annotationName];
      const env = createEnv();
      let sourceStr;
      if (!anno._ignore)
        sourceStr = renderTypeOrAnnotation(annotationName, anno, env, 'annotation');

      if (sourceStr !== '')
        result[main] += `${sourceStr}\n`;
    }
  }

  if (csn.namespace) {
    result[csn.namespace] = `namespace ${renderArtifactName(csn.namespace)};\n`;
    result[csn.namespace] += `using from './${main}.cds';`;
  }


  // If there are unapplied 'extend' and 'annotate' statements, render them separately
  // FIXME: Clarify if we should also do this for HANA (probably not?)
  if (csn.extensions) {
    const env = createEnv();
    const sourceStr = renderUnappliedExtensions(csn.extensions, env);
    result.unappliedExtensions = renderUsings('', env) + sourceStr;
  }

  timetrace.stop();
  return result;

  /**
   * Render unapplied 'extend' and 'annotate' statements from the 'extensions array'
   *
   * @param {CSN.Extension[]} extensions
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderUnappliedExtensions(extensions, env) {
    return extensions.map((ext) => {
      // Top-level annotations of the artifact
      let result = renderAnnotationAssignments(ext, env);
      result += `annotate ${ext.annotate}`;
      // Element extensions and annotations (possibly nested)
      if (ext.elements)
        result += renderElementExtensions(ext.elements, env);

      // Returns annotations
      if (ext.returns) {
        const childEnv = increaseIndent(env);
        result += ` with returns${renderElementExtensions(ext.returns.elements, childEnv)}`;
      }

      // Action annotations
      if (ext.actions) {
        result += ' actions {\n';
        const childEnv = increaseIndent(env);
        for (const name in ext.actions) {
          const action = ext.actions[name];
          result += renderAnnotationAssignments(action, childEnv) + childEnv.indent + quoteIdIfRequired(name);
          // Action parameter annotations
          if (action.params) {
            result += '(\n';
            const grandChildEnv = increaseIndent(childEnv);
            const paramAnnotations = [];
            for (const paramName in action.params)
              paramAnnotations.push(renderAnnotationAssignments(action.params[paramName], grandChildEnv) + grandChildEnv.indent + quoteIdIfRequired(paramName));

            result += `${paramAnnotations.join(',\n')}\n${childEnv.indent})`;
          }
          // Annotations on action returns
          if (action.returns && action.returns.elements) {
            const grandChildEnv = increaseIndent(childEnv);
            result += ` returns${renderElementExtensions(action.returns.elements, grandChildEnv)}`;
          }


          result += ';\n';
        }
        result += `${env.indent}}`;
      }


      result += ';';
      return result;
    }).join('\n');
  }

  /**
   * Render the elements-specific part of an 'extend' or 'annotate' statement for an element dictionary
   * 'elements' (assuming that the surrounding parent has just been rendered, without trailing newline).
   * Return the resulting source string, ending without a trailing newline, too.
   *
   * @param {CSN.Elements} elements
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderElementExtensions(elements, env) {
    let result = ' {\n';
    const childEnv = increaseIndent(env);
    for (const name in elements) {
      const elem = elements[name];
      result += renderAnnotationAssignments(elem, childEnv) + childEnv.indent + quoteIdIfRequired(name);
      if (elem.elements)
        result += renderElementExtensions(elem.elements, childEnv);

      result += ';\n';
    }
    result += `${env.indent}}`;
    return result;
  }

  /**
   * Render an artifact. Return the resulting source string.
   *
   * @param {string} artifactName
   * @param {CSN.Artifact} art
   * @param {CdlRenderEnvironment} env
   */
  function renderArtifact(artifactName, art, env) {
    // FIXME: Correctly build the paths during runtime to give better locations
    env.path = [ 'definitions', artifactName ];
    env.artifactName = artifactName;

    switch (art.kind) {
      case 'entity':
      case 'view':
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
      case 'annotation':
        return renderTypeOrAnnotation(artifactName, art, env, art.$syntax);
      case 'action':
      case 'function':
        return renderActionOrFunction(artifactName, art, env);
      case 'event':
        return renderEventIfCDLMode(artifactName, art, env);
      default:
        throw new Error(`Unknown artifact kind: ${art.kind}`);
    }
  }

  /**
   * @param {string} artifactName
   * @param {CSN.Artifact} art
   * @param {CdlRenderEnvironment} env
   */
  function renderEventIfCDLMode(artifactName, art, env) {
    let result = renderDocComment(art, env) + renderAnnotationAssignments(art, env);
    const childEnv = increaseIndent(env);
    const normalizedArtifactName = renderArtifactName(artifactName);
    result += `${env.indent}event ${normalizedArtifactName}`;
    if (art.includes) {
      // Includes are never flattened (don't exist in HANA)
      result += ` : ${art.includes.map(name => renderAbsoluteNameWithQuotes(name)).join(', ')}`;
    }
    if (art.query || art.projection) {
      env._artifact = art;
      result += ' : ';
      result += renderQuery(getNormalizedQuery(art).query, true, 'projection', env,
                            [ 'definitions', artifactName, 'query' ]);
      result += ';\n';
      delete env._artifact;
    }
    else if (art.type) {
      // Derived type or annotation with non-anonymous type
      result += ` : ${renderTypeReference(art, env)};\n`;
    }
    else if (art.elements) {
      result += ' {\n';
      for (const name in art.elements)
        result += renderElement(name, art.elements[name], childEnv);

      result += `${env.indent}}`;
    }
    return result;
  }

  /**
   * Return a dictionary with the direct sub-artifacts of the artifact with name 'artifactName' in the csn
   *
   * @param {string} artifactName
   * @return {object}
   */
  function getSubArtifacts(artifactName) {
    const prefix = `${artifactName}.`;
    const result = Object.create(null);
    for (const name in csn.definitions) {
      // We have a direct child if its name starts with prefix and contains no more dots
      if (name.startsWith(prefix) && !name.substring(prefix.length).includes('.')) {
        result[getLastPartOf(name)] = csn.definitions[name];
      }
      else if (name.startsWith(prefix)) {
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
    return result;
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
   * @param {string} artifactName
   * @param {CSN.Artifact} art
   * @param {CdlRenderEnvironment} env
   */
  function renderContext(artifactName, art, env) {
    let result = renderDocComment(art, env) + renderAnnotationAssignments(art, env);
    result += `${env.indent + (art.abstract ? 'abstract ' : '') + art.kind} ${renderArtifactName(artifactName)}`;
    if (art.includes) {
      // Includes are never flattened (don't exist in HANA)
      result += ` : ${art.includes.map(name => renderAbsoluteNameWithQuotes(name)).join(', ')}`;
    }
    return `${result} {};\n`;
  }

  function updatePrefixForDottedName(env, name) {
    let innerEnv = env;
    if (name.indexOf('.') !== -1) {
      const parts = name.split('.');
      for (let i = 0; i < parts.length - 1; i++)
        innerEnv = addNamePrefix(innerEnv, parts[i]);
    }

    return innerEnv;
  }

  /**
   * Render a namespace. Return the resulting source string.
   *
   * @param {string} artifactName
   * @param {CSN.Artifact} art
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderNamespace(artifactName, art, env) {
    // We currently do not render anything for a namespace, we just append its id to
    // the environment's current name prefix and descend into its children
    let result = renderDocComment(art, env);
    const childEnv = addNamePrefix(env, getLastPartOf(artifactName));
    const subArtifacts = getSubArtifacts(artifactName);
    for (const name in subArtifacts)
      result += renderArtifact(`${artifactName}.${name}`, subArtifacts[name], updatePrefixForDottedName(childEnv, name));

    return result;
  }

  /**
   * Render a (non-projection, non-view) entity. Return the resulting source string.
   *
   * @param {string} artifactName
   * @param {CSN.Artifact} art
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderEntity(artifactName, art, env) {
    let result = renderDocComment(art, env) + renderAnnotationAssignments(art, env);
    const childEnv = increaseIndent(env);
    const normalizedArtifactName = renderArtifactName(artifactName);
    result += `${env.indent + (art.abstract ? 'abstract ' : '')}entity ${normalizedArtifactName}`;
    const parameters = Object.keys(art.params || []).map(name => renderParameter(name, art.params[name], childEnv)).join(',\n');
    result += (parameters === '') ? '' : ` (\n${parameters}\n${env.indent})`;
    if (art.includes) {
      // Includes are never flattened (don't exist in HANA)
      result += ` : ${art.includes.map(name => renderAbsoluteNameWithQuotes(name)).join(', ')}`;
    }
    result += ' {\n';
    for (const name in art.elements) {
      const element = art.elements[name];
      // For subelement annotations, this seems to be a pattern to recognize them
      // plus some other stuff unfortunately...
      if (element.type && element.elements)
        subelementAnnotates.push([ artifactName, element, name ]);
      result += renderElement(name, element, childEnv);
    }

    result += `${env.indent}}`;
    result += `${renderActionsAndFunctions(art, env) + renderTechnicalConfiguration(art.technicalConfig, env)};\n`;
    return result;
  }

  // Render the 'technical configuration { ... }' section 'tc' of an entity.
  // Return the resulting source string.
  function renderTechnicalConfiguration(tc, env) {
    let result = renderDocComment(tc, env);
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

    // Fuzzy indices are stored in compact CSN as they would appear in SQL after the column name,
    // i.e. the whole line in SQL looks somewhat like this:
    //   s nvarchar(10) FUZZY SEARCH INDEX ON FUZZY SEARCH MODE 'ALPHANUM'
    // But in CDL, we don't write fuzzy search indices together with the table column, so we need
    // to insert the name of the column after 'ON' in CDS syntax, making it look like this:
    //   fuzzy search mode on (s) search mode 'ALPHANUM'
    // This function expects an array with the original expression and returns an array with the modified expression
    function fixFuzzyIndex(fuzzyIndex, columnName) {
      return fuzzyIndex.map(token => (token === 'on' ? { xpr: [ 'on', '(', { ref: columnName.split('.') }, ')' ] } : token));
    }
  }

  /**
   * Render an element (of an entity, type or annotation, not a projection or view).
   * Return the resulting source string.
   *
   * @param {string} elementName
   * @param {CSN.Element} elm
   * @param {CdlRenderEnvironment} env
   * @param {Boolean} [isSubElement]
   */
  function renderElement(elementName, elm, env, isSubElement) {
    env.elementName = elementName;
    let result = renderDocComment(elm, env) + renderAnnotationAssignments(elm, env);
    const quotedElementName = quoteOrUppercaseId(elementName);
    result += `${env.indent + (elm.virtual ? 'virtual ' : '') +
                         (elm.key && !isSubElement ? 'key ' : '') +
                         ((elm.masked && !elm._ignoreMasked) ? 'masked ' : '') +
                         quotedElementName} : ${
      renderTypeReference(elm, env, undefined)
    }${elm.on ? '' : renderNullability(elm)}`;
    if (elm.default)
      result += ` default ${renderExpr(elm.default, env)}`;

    delete env.elementName;
    return `${result};\n`;
  }

  /**
   * Return the SELECT of the leading query of query 'query'
   *
   * @param {CSN.Query} query
   */
  function leadingQuerySelect(query) {
    if (query.SELECT)
      return query.SELECT;

    // Sanity checks
    if (!query.SET || !query.SET.args || !query.SET.args[0])
      throw new Error(`Expecting set with args in query: ${JSON.stringify(query)}`);

    return leadingQuerySelect(query.SET.args[0]);
  }

  /**
   * Render a query's actions and functions (if any) separately as extend-statements, so that actions
   * work not only for projections but also for views, which have no syntax (yet) to directly specify
   * actions and functions inline.
   * Return the resulting 'extend' statement or '' if no actions or functions
   * FIXME: Simplify once we have such a syntax
   *
   * @param {string} artifactName
   * @param {CSN.Artifact} art
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderQueryActionsAndFunctions(artifactName, art, env) {
    let result = renderDocComment(art, env) + renderActionsAndFunctions(art, env);
    // Even if we have seen actions/functions, they might all have been ignored
    if (result !== '')
      result = `${env.indent}extend entity ${artifactName} with${result};`;

    return result;
  }

  /**
   * Render annotations that were extended to a query element of a view or projection (they only
   * appear in the view's 'elements', not in their 'columns', because the element itself may not
   * even be in 'columns', e.g. if it was expanded from a '*'). Return the resulting 'annotate'
   * statement or an empty string if none required.
   *
   * @param {string} artifactName
   * @param {CSN.Artifact} art
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderQueryElementAnnotations(artifactName, art, env) {
    // For preparation, create a map from element names to column objects
    const columnMap = Object.create(null);
    const select = leadingQuerySelect(getNormalizedQuery(art).query);
    for (const col of select.columns || [ '*' ]) {
      // Ignore '*'
      if (col === '*')
        continue;

      // Column must have an alias or be a path - take last part of that as element name
      columnMap[col.as || col.func || getLastPartOfRef(col.ref)] = col;
    }
    // Now iterate elements - render an annotation if it is different from the column's
    const childEnv = increaseIndent(env);
    let result = renderDocComment(art, env);
    for (const elemName in art.elements) {
      let elemAnnotations = '';
      const elem = art.elements[elemName];
      for (const name in elem) {
        if (!name.startsWith('@'))
          continue;

        const annotationValue = renderAnnotationValue(elem[name], childEnv);
        // Skip annotation if column has the same
        if (columnMap[elemName] && columnMap[elemName][name] &&
            renderAnnotationValue(columnMap[elemName][name], childEnv) === annotationValue)
          continue;

        // Annotation names are never flattened
        elemAnnotations += `${childEnv.indent}${`@${renderAbsoluteNameWithQuotes(name.substring(1))}`} : ${annotationValue}\n`;
      }
      if (elemAnnotations !== '')
        result += `${elemAnnotations}${childEnv.indent}${quoteOrUppercaseId(elemName)};\n`;
    }
    if (result !== '')
      result = `${env.indent}annotate ${renderArtifactName(artifactName)} with {\n${result}${env.indent}};\n`;

    return result;
  }

  /**
   * Render the source of a query, which may be a path reference, possibly with an alias,
   * or a subselect, or a join operation, as seen from artifact 'art'.
   * Returns the source as a string.
   *
   * @param {object} source
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderViewSource(source, env) {
    // Sub-SELECT
    if (source.SELECT || source.SET) {
      let result = `(${renderDocComment(source, env)}${renderQuery(source, false, 'view', increaseIndent(env))})`;
      if (source.as)
        result += ` as ${quoteOrUppercaseId(source.as)}`;

      return result;
    }
    // JOIN
    else if (source.join) {
      // One join operation, possibly with ON-condition
      let result = `${renderDocComment(source, env)}${renderViewSource(source.args[0], env)}`;
      for (let i = 1; i < source.args.length; i++) {
        result = `(${result} ${source.join} `;
        result += renderJoinCardinality(source.cardinality);
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

  function renderJoinCardinality(card) {
    let result = '';
    if (card) {
      if (card.srcmin && card.srcmin === 1)
        result += 'exact ';
      result += card.src && card.src === 1 ? 'one ' : 'many ';
      result += 'to ';
      if (card.min && card.min === 1)
        result += 'exact ';
      if (card.max)
        result += (card.max === 1) ? 'one ' : 'many ';
    }
    return result;
  }

  /**
   * Render a path that starts with an absolute name (as used e.g. for the source of a query),
   * with plain or quoted names, depending on options. Expects an object 'path' that has a 'ref'.
   * Returns the name as a string.
   *
   * @param {object} path
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderAbsolutePath(path, env) {
    // Sanity checks
    if (!path.ref)
      throw new Error(`Expecting ref in path: ${JSON.stringify(path)}`);


    // Determine the absolute name of the first artifact on the path (before any associations or element traversals)
    const firstArtifactName = path.ref[0].id || path.ref[0];

    let result = renderDocComment(path, env);
    // Render the first path step (absolute name, with different quoting/naming ..)
    result += getResultingName(firstArtifactName);

    // Even the first step might have parameters and/or a filter
    if (path.ref[0].args)
      result += `(${renderArgs(path.ref[0], ':', env)})`;

    if (path.ref[0].where)
      result += `[${path.ref[0].cardinality ? (`${path.ref[0].cardinality.max}: `) : ''}${renderExpr(path.ref[0].where, env, true, true)}]`;

    // Add any path steps (possibly with parameters and filters) that may follow after that
    if (path.ref.length > 1)
      result += `:${renderExpr({ ref: path.ref.slice(1) }, env)}`;

    return result;
  }

  /**
   * Render a path that starts with an absolute name (as used for the source of a query),
   * possibly with an alias, with plain or quoted names, depending on options. Expects an object 'path' that has a
   * 'ref' and (in case of an alias) an 'as'. If necessary, an artificial alias
   * is created to the original implicit name.
   * Returns the name and alias as a string.
   *
   * @param {object} path
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderAbsolutePathWithAlias(path, env) {
    let result = renderAbsolutePath(path, env);
    if (path.as) {
      // Source had an alias - render it
      result += ` as ${quoteOrUppercaseId(path.as)}`;
    }
    return result;
  }

  /**
   * Render a single view or projection column 'col', as it occurs in a select list or
   * projection list within 'art', possibly with annotations.
   * Return the resulting source string (no trailing LF).
   *
   * @param {object} col
   * @param {CdlRenderEnvironment} env
   * @param {CSN.Element} element Element corresponding to the column. Generated by the compiler.
   */
  function renderViewColumn(col, env, element) {
    // Annotations and column
    let result = renderDocComment(col.doc ? col : element, env) + renderAnnotationAssignments(col, env);
    result += env.indent;

    // only if column is virtual, keyword virtual was present in the source text
    if (col.virtual)
      result += 'virtual ';

    const key = col.key ? 'key ' : '';
    // Use special rendering for .expand/.inline - renderExpr cannot easily handle some cases
    result += key + ((col.expand || col.inline) ? renderInlineExpand(col, env) : renderExpr(col, env, true));

    // Alias is already handled by renderInlineExpand
    if (!col.inline && !col.expand && col.as)
      result += ` as ${quoteOrUppercaseId(col.as)}`;

    // Explicit type provided for the view element?
    if (col.cast) {
      // Special case: Explicit association type is actually a redirect
      if (col.cast.target) {
        // Redirections are never flattened (don't exist in HANA)
        result += ` : redirected to ${renderAbsoluteNameWithQuotes(col.cast.target)}`;
        if (col.cast.on)
          result += ` on ${renderExpr(col.cast.on, env, true, true)}`;
      }
      else {
        result += ` : ${renderTypeReference(col.cast, env, true)}`;
      }
    }
    return result;
  }

  /**
   * For the current column, render a (nested) inline/expand. If the current column
   * does not have an .expand/.inline, '' is returned
   *
   * @param {object} col Thing with .expand or .inline
   * @param {CdlRenderEnvironment} parentEnv
   * @returns {string}
   */
  function renderInlineExpand(col, parentEnv) {
    if (!col.inline && !col.expand)
      return '';

    return renderIX(col, parentEnv);

    function renderIX(obj, env) {
      // No expression to render for { * } as alias
      let result = (obj.as && obj.expand && !obj.ref) ? '' : renderExpr(obj, env);

      // s as alias { * }
      if (obj.as && (obj.ref || obj.xpr || obj.val !== undefined || obj.func !== undefined))
        result += ` as ${obj.as}`;

      // We found a leaf - no further drilling
      if (!obj.inline && !obj.expand) {
        if (obj.cast && obj.cast.type) {
          result += ` : ${renderTypeReference(obj.cast, createEnv())}`;
        }
        else if (obj.cast && obj.cast.target) { // test tbd
          result += ` : redirected to ${renderAbsoluteNameWithQuotes(obj.cast.target)}`;
          if (obj.cast.on)
            result += ` on ${renderExpr(obj.cast.on, env, true, true)}`;
          else if (obj.cast.keys)
            result += ` { ${Object.keys(obj.cast.keys).map(name => renderForeignKey(obj.cast.keys[name], env)).join(', ')} }`;
        }
        return result;
      }

      if (obj.inline)
        result += '.{\n';
      else
        result += result !== '' ? ' {\n' : '{\n';

      // Drill down and render children of the expand/inline
      const childEnv = increaseIndent(env);
      const expandInline = obj.expand || obj.inline;
      expandInline.forEach((elm, i) => {
        result += `${childEnv.indent}${renderIX(elm, childEnv)}`;
        if (i < expandInline.length - 1)
          result += ',\n';
      });
      result += `\n${env.indent}}`;

      // Don't forget about the .excluding
      if (obj.excluding)
        result += ` excluding { ${obj.excluding.join(',')} }`;

      // { * } as expand
      if (!obj.ref && obj.as)
        result += ` as ${obj.as}`;

      return result;
    }
  }

  /**
   * Render .doc properties as comments in CDL
   *
   * @param {object} obj Object to render for
   * @param {object} env Env - for indent
   * @returns {String}
   */
  function renderDocComment(obj, env) {
    if (!obj || obj && obj.doc === undefined)
      return '';
    else if (obj && obj.doc === null) // empty doc comment needs to be rendered
      return `\n${env.indent}/** */\n`;

    return `\n${env.indent}/**\n${obj.doc.split('\n').map(line => `${env.indent} * ${line}`).join('\n')}\n${env.indent} */\n`;
  }

  /**
   * Render a view. If '$syntax' is set (to 'projection', 'view', 'entity'),
   * the view query is rendered in the requested syntax style, otherwise it
   * is rendered as a view.
   *
   * @param {string} artifactName
   * @param {CSN.Artifact} art
   * @param {CdlRenderEnvironment} env
   */
  function renderView(artifactName, art, env) {
    const syntax = (art.projection) ? 'projection' : 'entity';
    let result = renderDocComment(art, env) + renderAnnotationAssignments(art, env);
    result += `${env.indent}${art.abstract ? 'abstract ' : ''}${syntax === 'projection' ? 'entity' : syntax} ${renderArtifactName(artifactName)}`;
    if (art.params) {
      const childEnv = increaseIndent(env);
      const parameters = Object.keys(art.params).map(name => renderParameter(name, art.params[name], childEnv)).join(',\n');
      result += `(\n${parameters}\n${env.indent}) as `;
    }
    else {
      result += ' as ';
    }
    env._artifact = art;
    result += renderQuery(getNormalizedQuery(art).query, true, syntax, env, [ 'definitions', artifactName, 'query' ], art.elements);
    result += ';\n';
    result += renderQueryElementAnnotations(artifactName, art, env);
    result += renderQueryActionsAndFunctions(artifactName, art, env);
    return result;
  }

  /**
   * Render a query 'query', i.e. a select statement with where-condition etc.
   * If 'isLeadingQuery' is true, mixins, actions and functions of 'art' are
   * also rendered into the query. Use 'syntax' style ('projection', 'view',
   * or 'entity')
   *
   * @param {CSN.Query} query
   * @param {boolean} isLeadingQuery
   * @param {string} syntax The query syntax, either "projection", "entity" or "view"
   * @param {CdlRenderEnvironment} env
   * @param {CSN.Path} [path=[]]
   */
  function renderQuery(query, isLeadingQuery, syntax, env, path = [], elements = query.elements || Object.create(null)) {
    let result = renderDocComment(query, env);
    // Set operator, like UNION, INTERSECT, ...
    if (query.SET) {
      // First arg may be leading query
      result += `(${renderQuery(query.SET.args[0], isLeadingQuery, 'view', env, path.concat([ 'SET', 'args', 0 ]), elements)}`;
      // FIXME: Clarify if set operators can be n-ary (assuming binary here)
      if (query.SET.op) {
        // Loop over all other arguments, i.e. for A UNION B UNION C UNION D ...
        for (let i = 1; i < query.SET.args.length; i++)
          result += `\n${env.indent}${query.SET.op}${query.SET.all ? ' all' : ''} ${renderQuery(query.SET.args[i], false, 'view', env, path.concat([ 'SET', 'args', i ]), elements)}`;
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

    if (syntax === 'projection')
      result += `projection on ${renderViewSource(select.from, env)}`;
    else if (syntax === 'view' || syntax === 'entity')
      result += `select from ${renderViewSource(select.from, env)}`;
    else
      throw new Error(`Unknown query syntax: ${syntax}`);

    if (select.mixin) {
      let elems = '';
      for (const name in select.mixin) {
        if (!select.mixin[name]._ignore)
          elems += renderElement(name, select.mixin[name], childEnv);
      }
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
      result += ` excluding {\n${select.excluding.map(id => `${childEnv.indent}${quoteOrUppercaseId(id)}`).join(',\n')}\n`;
      result += `${env.indent}}`;
    }
    // FIXME: Currently, only projections can have actions and functions, but we cannot distinguish
    // a projection from a view any more
    if (isLeadingQuery)
      result += renderActionsAndFunctions(query, env);

    if (select.where)
      result += `${continueIndent(result, env)}where ${renderExpr(select.where, env, true, true)}`;

    if (select.groupBy)
      result += `${continueIndent(result, env)}group by ${select.groupBy.map(expr => renderExpr(expr, env)).join(', ')}`;

    if (select.having)
      result += `${continueIndent(result, env)}having ${renderExpr(select.having, env, true, true)}`;

    if (select.orderBy)
      result += `${continueIndent(result, env)}order by ${select.orderBy.map(entry => renderOrderByEntry(entry, env)).join(', ')}`;

    if (select.limit)
      result += `${continueIndent(result, env)}${renderLimit(select.limit, env)}`;

    return result;

    /**
     * Utility function to make sure that we continue with the same indentation in WHERE, GROUP BY, ... after a closing curly brace and beyond
     *
     * @param {string} result
     * @param {CdlRenderEnvironment} env
     * @return {string}
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
     * @param {CSN.QueryLimit} limit
     * @param {CdlRenderEnvironment} env
     * @return {string}
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
   * @param {object} entry
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderOrderByEntry(entry, env) {
    let result = renderDocComment(entry, env) + renderExpr(entry, env);
    if (entry.sort)
      result += ` ${entry.sort}`;

    if (entry.nulls)
      result += ` nulls ${entry.nulls}`;

    return result;
  }

  /**
   * Render an entity's actions and functions (if any)
   * (expect an entity with trailing '}' or an 'extend' statement ending with 'with'
   * to have just been rendered).
   * Return the resulting source string.
   *
   * @param {CSN.Artifact} art
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderActionsAndFunctions(art, env) {
    let result = '';
    const childEnv = increaseIndent(env);
    for (const name in art.actions)
      result += renderDocComment(art.actions[name], childEnv) + renderActionOrFunction(name, art.actions[name], childEnv);

    // Even if we have seen actions/functions, they might all have been ignored
    if (result !== '')
      result = ` actions {\n${result}${env.indent}}`;

    return result;
  }

  /**
   * Render an action or function 'act' with name 'actName'. Return the resulting source string.
   *
   * @param {string} actionName
   * @param {CSN.Action} act
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderActionOrFunction(actionName, act, env) {
    let result = `${renderDocComment(act, env) + renderAnnotationAssignments(act, env) + env.indent + act.kind} ${renderArtifactName(actionName)}`;
    const childEnv = increaseIndent(env);
    const parameters = Object.keys(act.params || []).map(name => renderParameter(name, act.params[name], childEnv)).join(',\n');
    result += (parameters === '') ? '()' : `(\n${parameters}\n${env.indent})`;
    if (act.returns) {
      if (act.returns.type && act.returns.elements) // action returns annotations
        subelementAnnotates.push([ actionName, act.returns, '', 'returns' ]);
      result += ` returns ${renderTypeReference(act.returns, env)}${renderNullability(act.returns)}`;
    }

    result += ';\n';
    return result;
  }

  /**
   * Render an action or function parameter 'par' with name 'parName'. Return the resulting source string (no trailing LF).
   *
   * @param {string} parName
   * @param {object} par
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderParameter(parName, par, env) {
    let result = `${renderDocComment(par, env) + renderAnnotationAssignments(par, env) + env.indent + quoteOrUppercaseId(parName)} : ${renderTypeReference(par, env)}`;
    if (par.default)
      result += ` default ${renderExpr(par.default, env)}`;

    result += renderNullability(par);
    return result;
  }

  /**
   * Render a type (derived or structured) or an annotation decl with name 'artifactName'.
   * Return the resulting source string.
   *
   * @param {string} artifactName
   * @param {CSN.Artifact} art
   * @param {CdlRenderEnvironment} env
   * @param {String} artType - used for rendering csn.vocabularies, as the annotations there do not have a kind. Only in toCdl mode
   * @return {string}
   */
  function renderTypeOrAnnotation(artifactName, art, env, artType) {
    if (!options.toCdl && art.kind === 'aspect')
      return '';
    let result = renderDocComment(art, env) + renderAnnotationAssignments(art, env);
    result += `${env.indent + (options.toCdl && (artType || art.$syntax) || art.kind )} ${renderArtifactName(artifactName)}`;
    if (art.includes) {
      // Includes are never flattened (don't exist in HANA)
      result += ` : ${art.includes.map(name => renderAbsoluteNameWithQuotes(name)).join(', ')}`;
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
   * @param {CSN.Element} elm
   * @param {CdlRenderEnvironment} env
   * @param {boolean} [noEnum=false]
   * @return {string}
   */
  function renderTypeReference(elm, env, noEnum = false) {
    let result = '';

    // Array type: Render items instead
    if (elm.items && !elm.type) {
      // HANA CDS does not support keyword many
      let rc = `many ${renderTypeReference(elm.items, env)}`;
      if (elm.items.notNull != null)
        rc += elm.items.notNull ? ' not null' : ' null';
      // many sub element annotates
      if (elm.items.type && elm.items.elements && env.artifactName)
        subelementAnnotates.push([ env.artifactName, elm.items, env.elementName ]);

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
      for (const name in elm.elements)
        result += renderElement(name, elm.elements[name], childEnv, null);

      result += `${env.indent}}`;
      return result;
    }

    const comp = 'cds.Composition';
    // Association type
    if ([ 'cds.Association', comp ].includes(elm.type)) {
      // Type, cardinality and target; CAPire uses CamelCase
      result += (elm.type === comp) ? 'Composition' : 'Association';

      if (isSimpleCardinality(elm.cardinality)) {
        result += renderSimpleCardinality(elm);
      }
      else {
        result += renderCardinality(elm.cardinality) +
          ((elm.type === comp) ? ' of ' : ' to ');
      }

      // normal target or named aspect
      if (elm.target || elm.targetAspect && typeof elm.targetAspect === 'string') {
        result += renderAbsolutePath({ ref: [ elm.target || elm.targetAspect ] }, env);
      }
      else if (elm.targetAspect && elm.targetAspect.elements) { // anonymous aspect
        const childEnv = increaseIndent(env);
        result += '{\n';
        for (const name in elm.targetAspect.elements)
          result += renderElement(name, elm.targetAspect.elements[name], childEnv);

        result += `${env.indent}}`;
      }
      else {
        throw new Error('Association/Composition is missing its target! Throwing exception to trigger recompilation.');
      }


      // ON-condition (if any)
      if (elm.on)
        result += ` on ${renderExpr(elm.on, env, true, true)}`;


      // Foreign keys (if any, unless we also have an ON_condition (which means we have been transformed from managed to unmanaged)
      if (elm.keys && !elm.on)
        result += ` { ${Object.keys(elm.keys).map(name => renderForeignKey(elm.keys[name], env)).join(', ')} }`;

      return result;
    }

    // Reference to another element
    if (elm.type.ref) {
      if (elm.enum) {
        const source = artifactRef(elm.type);
        if (!source.enum) {
          // enum was defined at this element and not at the referenced one
          result += renderAbsolutePath(elm.type, env) + renderEnum(elm.enum, env);
        }
        else {
          result += renderAbsolutePath(elm.type, env);
        }
      }
      else {
        result += renderAbsolutePath(elm.type, env);
      }
      return result;
    }

    // If we get here, it must be a named type
    if (isBuiltinType(elm.type)) {
      result += renderBuiltinType(elm);
    }
    else {
      // Simple absolute name
      // Type names are never flattened (derived types are unraveled in HANA)
      result += getResultingName(elm.type);
    }
    if (elm.enum && !noEnum)
      result += renderEnum(elm.enum, env);

    return result;
  }

  /**
   * @param {CSN.Element} elm
   * @return {string}
   */
  function renderBuiltinType(elm) {
    // If there is a user-defined type with the same short name (cds.Integer -> Integer),
    // we render the full name, including the leading "cds."
    if (csn.definitions[elm.type.slice(4)])
      return elm.type + renderTypeParameters(elm);

    return elm.type.slice(4) + renderTypeParameters(elm);
  }

  /**
   * Render the 'enum { ... } part of a type declaration
   *
   * @param {CSN.EnumElements} enumPart
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderEnum(enumPart, env) {
    let result = ' enum {\n';
    const childEnv = increaseIndent(env);
    for (const name in enumPart) {
      const enumConst = enumPart[name];
      result += renderDocComment(enumConst, childEnv);
      result += renderAnnotationAssignments(enumConst, childEnv);
      result += childEnv.indent + quoteIdIfRequired(name);
      if (enumConst.val !== undefined)
        result += ` = ${renderExpr(enumConst, childEnv)}`;
      else if (enumConst['#'] !== undefined)
        result += ` = #${enumConst['#']}`;
      result += ';\n';
    }
    result += `${env.indent}}`;
    return result;
  }

  /**
   * Render an annotation value (somewhat like a simplified expression, with slightly different
   * representation)
   *
   * @param {any} x
   * @param {CdlRenderEnvironment} env
   */
  function renderAnnotationValue(x, env) {
    if (Array.isArray(x)) {
      // Render array parts as values
      return `[${x.map(item => renderAnnotationValue(item, env)).join(', ')}]`;
    }
    else if (typeof x === 'object' && x !== null) {
      // Enum symbol
      if (x['#'])
        return `#${x['#']}`;

      // Shorthand for absolute path (as string)
      else if (x['='])
        return quotePathString(x['=']);

      // Struct value (can actually only occur within an array)

      // Note that we have to quote the struct keys here manually and not use quoteIdIfRequired, because they may even contain dots (yuc!)
      // FIXME: Should that really be allowed?
      return `{${Object.keys(x).map(key => `![${key}]: ${renderAnnotationValue(x[key], env)}`).join(', ')}}`;
    }
    // Null
    else if (x === null) {
      return 'null';
    }
    // Primitive: string, number, boolean

    // Quote strings, leave all others as they are
    return (typeof x === 'string') ? `'${x.replace(/'/g, '\'\'')}'` : x;
  }

  /**
   * Render an expression (including paths and values) or condition 'x'.
   * (no trailing LF, don't indent if inline)
   *
   * @param {any} x
   * @param {CdlRenderEnvironment} env
   * @param {boolean} [inline=true]
   * @param {boolean} [inExpr=false] Whether the expression is already inside another expression
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
     * @returns {string}
     */
    function renderExprObject() {
      if (x.list) {
        // set "inExpr" to false: treat list elements as new expressions
        return `(${x.list.map(item => renderExpr(item, env, inline, false)).join(', ')})`;
      }
      else if (x.val !== undefined) {
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
      // Enum symbol
      else if (x['#']) {
        return `#${x['#']}`;
      }
      // Reference: Array of path steps, possibly preceded by ':'
      else if (x.ref) {
        // FIXME: no extra magic with x.param or x.global
        return `${(x.param || x.global) ? ':' : ''}${x.ref.map(renderPathStep).join('.')}`;
      }
      // Function call, possibly with args (use '=>' for named args)
      else if (x.func) {
        // test for non-regular HANA identifier that needs to be quoted
        // identifier                  {letter}({letter_or_digit}|[#$])*
        // letter                      [A-Za-z_]
        // letter_or_digit             [A-Za-z_0-9]

        const regex = RegExp(/^[a-zA-Z][\w#$]*$/, 'g');
        const funcName = regex.test(x.func) ? x.func : quoteIdIfRequired(x.func);
        return renderFunc( funcName, x, 'cap', a => renderArgs(a, '=>', env) );
      }
      // Nested expression
      else if (x.xpr) {
        // Ensure `exists` is always enclosed by parentheses
        if ((inExpr && !x.cast ) || x.xpr.some(s => s === 'exists'))
          return `(${renderExpr(x.xpr, env, inline, true)})`;

        return renderExpr(x.xpr, env, inline, true);
      }
      // Sub-select
      else if (x.SELECT) {
        // renderQuery for SELECT does not bring its own parentheses (because it is also used in renderView)
        return `(${renderQuery(x, false, 'view', increaseIndent(env))})`;
      }
      else if (x.SET) {
        // renderQuery for SET always brings its own parentheses (because it is also used in renderViewSource)
        return `${renderQuery(x, false, 'view', increaseIndent(env))}`;
      }
      else {
        throw new Error(`Unknown expression: ${JSON.stringify(x)}`);
      }
    }

    /**
     * Renders an explicit `cast()` inside an 'xpr'.
     * @param {string} value
     * @returns {string}
     */
    function renderExplicitTypeCast(value) {
      const typeRef = renderTypeReference(x.cast, env, true);
      return `cast(${value} as ${typeRef})`;
    }

    /**
     * Render a single path step 's' at path position 'idx', which can have filters or parameters or be a function
     *
     * @param {string|object} s
     * @param {number} idx
     * @returns {string}
     */
    function renderPathStep(s, idx) {
      // Simple id or absolute name
      if (typeof s === 'string') {
        // In first path position, do not quote $projection and magic $-variables like CURRENT_DATE, $now etc.
        // FIXME: We should rather explicitly recognize quoting somehow

        if (idx === 0 &&
            s.startsWith('$'))
          return s;

        return quoteOrUppercaseId(s);
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
        let result = `${quoteOrUppercaseId(s.id)}`;
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
   * @param {string} sep
   * @param {CdlRenderEnvironment} env
   * @returns {string}
   */
  function renderArgs(node, sep, env) {
    const args = node.args ? node.args : {};
    // Positional arguments
    if (Array.isArray(args))
      return args.map(arg => renderExpr(arg, env)).join(', ');

    // Named arguments (object/dict)
    else if (typeof args === 'object')
      return Object.keys(args).map(key => `${quoteOrUppercaseId(key)} ${sep} ${renderExpr(args[key], env)}`).join(', ');


    throw new Error(`Unknown args: ${JSON.stringify(args)}`);
  }

  /**
   * Render a cardinality (only those parts that were actually provided)
   *
   * @param {CSN.Cardinality} card
   * @return {string}
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
   * A "simple" cardinality is one that only has a "max" cardinality property
   * which is either '*' or 1.
   *
   * @param {CSN.Cardinality} cardinality
   * @return {boolean}
   */
  function isSimpleCardinality(cardinality) {
    return !cardinality || (
      cardinality.min === undefined &&
      cardinality.src === undefined &&
      cardinality.srcmin === undefined &&
      (cardinality.max === '*' || cardinality.max === 1)
    );
  }

  /**
   * Renders the simple cardinality of an association/composition, i.e. "many"/"one",
   * including the "of"/"to" part.
   *
   * @param {CSN.Element} elem
   * @return {string}
   */
  function renderSimpleCardinality(elem) {
    let result = (elem.type === 'cds.Association' ? ' to ' : ' of ');
    if (!elem.cardinality)
      return result;
    if (elem.cardinality.max === '*')
      result += 'many ';
    else if (elem.cardinality.max === 1)
      result += 'one ';
    return result;
  }

  // Render the nullability of an element or parameter (can be unset, true, or false)
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
   * @param {object} fKey
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderForeignKey(fKey, env) {
    return `${renderExpr(fKey, env)}${fKey.as ? (` as ${fKey.as}`) : ''}`;
  }

  /**
   * Render (primitive) type parameters of element 'elm', i.e.
   * length, precision and scale (even if incomplete), plus any other unknown ones.
   *
   * @param {CSN.Element} elm
   * @returns {string}
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
   * Render all annotation assignments of annotatable object 'obj'.
   *
   * @param {object} obj Object that has annotations
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderAnnotationAssignments(obj, env) {
    let result = '';
    for (const name in obj) {
      if (name.startsWith('@'))
        result += renderAnnotationAssignment(obj[name], name, env);
    }
    return result;
  }

  /**
   * Render a single annotation assignment 'ann' with fully qualified name 'name' (no trailing LF).
   * We might see variants like 'A.B.C#foo' or even 'A.B#foo.C'. In both cases, the #foo must be ignored
   * when resolving the name, but must stay in the rendered output (quoted as necessary).
   *
   * @param {any} ann Annotation value
   * @param {string} name Annotation name, e.g. `@A.B.C#foo.C`
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderAnnotationAssignment(ann, name, env) {
    // Take the annotation assignment apart into <nameBeforeVariant>[#<variant>[.<nameAfterVariant>]]
    //                      @1111111  3333333   5555
    const parts = name.match(/@([^#]+)(#([^.]+)(\.(.+))?)?/);
    const nameBeforeVariant = parts[1];
    const variant = parts[3];
    const nameAfterVariant = parts[5];
    const topLevelName = getTopLevelArtifactNameOf(nameBeforeVariant, csn);
    let result = `${env.indent}@`;
    if (topLevelName) {
      // Checked annotation, with declaration - must render top-level absolute name with proper using and alias
      // Annotation names are never flattened
      result += renderAbsoluteNameWithQuotes(topLevelName);
      if (topLevelName !== nameBeforeVariant)
        result += `.${quotePathString(nameBeforeVariant.substring(topLevelName.length + 1))}`;
    }
    else {
      // Unchecked annotation, just render the name as it is
      result += nameBeforeVariant;
    }
    // Append '#'-variant if any
    if (variant) {
      // FIXME: Unfortunately, the compiler does not yet understand an inner variant with proper quoting,
      // i.e. like "__A"."B"#"foo"."C". As a workaround, we present the '#'-variant as a quoted part of the
      // previous path step, i.e as "__A"."B#foo"."C" (which yields the same result). This hack is only necessary
      // for inner '#'-variants, i.e. for those followed by a <nameAfterVariant>.
      // FIXME: Won't work for inner variants on the top-level artifact, because the USING no longer matches
      // for something like "__A#foo"."B"."C"
      if (nameAfterVariant) {
        const resultSteps = result.split('.');
        // Take all paths steps from the result (which is now essentially 'nameBeforeVariant' with USING
        // adaptations) except the last step
        result = resultSteps.slice(0, -1).join('.');
        // Append a combination of last path step and '#'-variant (quoted)
        let lastStep = resultSteps[resultSteps.length - 1];
        if (lastStep.includes('"')) {
          // Last step was already quoted - strip off the existing quotes
          lastStep = lastStep.slice(1, -1);
        }
        result += `.${quoteIdIfRequired(`${lastStep}#${variant}`)}`;
      }
      else {
        // No hack required for trailing '#'-variant
        result += `#${quoteIdIfRequired(variant)}`;
      }
    }
    // Append anything that might have come after the variant
    if (nameAfterVariant)
      result += `.${quotePathString(nameAfterVariant)}`;

    result += ` : ${renderAnnotationValue(ann, env)}`;
    return `${result}\n`;
  }

  /**
   * Render an absolute name 'absName', with appropriate quotes. Also record the
   * fact that 'absName' is used in 'env', so that an appropriate USING can be constructed
   * if necessary.
   *
   * @param {string} absName
   * @return {string}
   */
  function renderAbsoluteNameWithQuotes(absName) {
    return absName;
  }

  /**
   * Render appropriate USING directives for all artifacts used by artifact 'artifactName' in 'env'.
   *
   * @param {string} artifactName
   * @param {CdlRenderEnvironment} env
   * @return {string}
   */
  function renderUsings(artifactName, env) {
    const distinct = {};
    Object.keys(env.topLevelAliases)
      .forEach((name) => {
        distinct[`using ${env.topLevelAliases[name].quotedName} as ${env.topLevelAliases[name].quotedAlias};\n`] = '';
      });

    return Object.keys(distinct).join('');
  }

  /**
   * Returns a newly created default environment (which keeps track of indentation, required USING
   * declarations and name prefixes.
   *
   * @return {CdlRenderEnvironment}
   */
  function createEnv() {
    return {
      // Current indentation string
      indent: '',
      // Dictionary of aliases for used artifact names, each entry like 'name' : { quotedName, quotedAlias }
      topLevelAliases: Object.create(null),
      // Current name prefix (including trailing dot if not empty)
      namePrefix: '',
    };
  }

  /**
   * Returns a copy of 'env' with (quoted) name prefix 'id' and a dot appended to the current name prefix
   *
   * @param {CdlRenderEnvironment} env
   * @param {string} id
   * @returns {CdlRenderEnvironment}
   */
  function addNamePrefix(env, id) {
    return Object.assign({}, env, { namePrefix: `${env.namePrefix + quoteIdIfRequired(id)}.` });
  }

  /**
   * Returns a copy of 'env' with increased indentation (and resetted name prefix)
   *
   * @param {CdlRenderEnvironment} env
   * @returns {CdlRenderEnvironment}
   */
  function increaseIndent(env) {
    return Object.assign({}, env, { namePrefix: '', indent: `${env.indent}  ` });
  }

  /**
   * Return a path string 'path' with appropriate "-quotes.
   *
   * @param {string} path
   * @returns {string}
   */
  function quotePathString(path) {
    // "foo"."bar"."wiz"."blub"
    return path.split('.').map(quoteIdIfRequired).join('.');
  }

  /**
   * Return an id 'id' with appropriate "-quotes
   *
   * @param {string} id
   * @return {string}
   */
  function quoteIdIfRequired(id) {
    // Quote if required for CDL
    if (requiresQuotingForCdl(id))
      return `![${id.replace(/]/g, ']]')}]`;

    return id;
  }

  /**
   * Returns true if 'id' requires quotes for CDL, i.e. if 'id'
   *  1. starts with a digit
   *  2. contains chars different than:
   *   - uppercase letters
   *   - lowercase letters
   *   - digits
   *   - underscore
   *  3. is a CDL keyword or a CDL function without parentheses (CURRENT_*, SYSUUID, ...)
   *
   * @param {string} id
   * @return {boolean}
   */
  function requiresQuotingForCdl(id) {
    return /^\d/.test(id) ||
        /\W/g.test(id.replace(/\./g, '')) ||
        keywords.cdl.includes(id.toUpperCase()) ||
        keywords.cdl_functions.includes(id.toUpperCase());
  }

  /**
   * Quote or uppercase an identifier 'id', depending on naming strategy
   *
   * @todo Remove: Now part of toHdbcds.js
   * @param {string} id
   * @return {string}
   */
  function quoteOrUppercaseId(id) {
    return quoteIdIfRequired(id);
  }

  /**
   * Render the name of an artifact, using the current name prefix from 'env'
   * and the real name of the artifact. In case of plain names, this
   * is equivalent to simply flattening and uppercasing the whole name.
   *
   * In cdlMode, the prefix is extended to handle cases like an entity shadowing the prefix
   * of another entity -> Service.E and Service.E.Sub
   *
   * To handle such cases for hdbcds in quoted/hdbcds, we:
   * - Find the part of the name that is no longer prefix (context/service/namespace)
   * - For Service.E -> E, for Service.E.Sub -> E.Sub
   * - Replace all dots in this "real name" with underscores
   * - Join with the env prefix
   *
   *
   * @param {string} artifactName Artifact name to render
   * @return {string} Artifact name ready for rendering
   */
  function renderArtifactName(artifactName) {
    const realname = getRealName(artifactName);
    const prefix = (realname !== artifactName) ? artifactName.slice(0, artifactName.length - realname.length - 1) : '';
    return prefix ? `${quoteIdIfRequired(prefix)}.${realname.split('.').map(quoteIdIfRequired).join('.')}` : realname.split('.').map(quoteIdIfRequired).join('.');
  }

  /**
   * Get the name that the artifact definition has been rendered as.
   * Without quoting/escaping stuff.
   *
   * @param {String} artifactName Artifact name to use
   * @returns {String}
   */
  function getResultingName(artifactName) {
    return renderArtifactName(artifactName);
  }

  /**
   * Get the part that is really the name of this artifact and not just prefix caused by a context/service/namespace
   *
   * @param {String} artifactName Artifact name to use
   * @returns {String} non-prefix part of the artifact name
   */
  function getRealName(artifactName) {
    const parts = artifactName.split('.');
    // Lenght of 1 -> There can be no prefix
    if (parts.length === 1)
      return artifactName;


    let seen = '';
    for (let i = 0; i < parts.length; i++) {
      if (seen !== '')
        seen = `${seen}.${parts[i]}`;
      else
        seen = parts[i];


      const art = csn.definitions[seen];
      if (!art || ![ 'service', 'context', 'namespace' ].includes(art.kind)) {
        // We found a case where the prefix ended
        // Return everything following
        return parts.slice(i).join('.');
      }
    }

    // we seem to have a normal case - just return the last part
    return getLastPartOf(artifactName);
  }
}

/**
 * @typedef CdlRenderEnvironment Rendering environment used throughout the render process.
 *
 * @property {string}   indent Current indentation as a string, e.g. '  ' for two spaces.
 * @property {CSN.Path} [path] CSN path to the current artifact
 * @property {string}   artifactName Name of the artifact - set in renderArtifact
 * @property {string}   elementName Name of the element being rendered - set in renderElement
 * @property {{[name: string]: {
      quotedName: string,
      quotedAlias: string
    }}} topLevelAliases Dictionary of aliases for used artifact names
 *
 * @property {string} namePrefix Current name prefix (including trailing dot if not empty)
 * @property {boolean} [skipKeys]
 * @property {CSN.Artifact} [_artifact]
 */

module.exports = { toCdsSourceCsn };
