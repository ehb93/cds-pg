'use strict';

const { makeMessageFunction } = require('../base/messages');
const { setProp } = require('../base/model');
const { hasErrors } = require('../base/messages');
const { cloneCsnDictionary } = require('../model/csnUtils');
const { cleanSymbols } = require('../base/cleanSymbols.js');
const { rejectManagedAssociationsAndStructuresForHdbcsNames } = require('../checks/selectItems');
const {
  cloneCsn,
  forEachDefinition,
  forEachGeneric,
  forAllQueries,
  sortCsnDefinitionsForTests,
  getUtils,
} = require('../model/csnUtils');

/**
 * Indicator that a definition is localized and has a convenience view.
 * art[_hasLocalizedView]'s value should be the name of the convenience view.
 */
const _hasLocalizedView = Symbol('_hasLocalizedView');
/**
 * Whether a convenience view was generated for another view.
 * In that case we have a _vertical_ view.
 */
const _isViewForView = Symbol('_isViewForView');     // $inferred = 'LOCALIZED-VERTICAL'
/**
 * Whether a convenience view was generated for an entity that is localized.
 * In that case we have a _horizontal_ view.
 */
const _isViewForEntity = Symbol('_isViewForEntity'); // $inferred = 'LOCALIZED-HORIZONTAL'
/**
 * List of artifacts for which the view/entity is a target.
 * Used to transitively create convenience views.
 */
const _targetFor = Symbol('_targetFor');

/**
 * Callback function returning `true` if the localization view should be created.
 * @callback acceptLocalizedView
 * @param {string} viewName localization view name
 * @param {string} originalName Artifact name of the original view
 */

/**
 * Create transitive localized convenience views
 *
 * INTERNALS:
 * We have three kinds of localized convenience views:
 *
 *  1. "direct ones" using coalesce() for the table entities with localized
 *     elements: as projection on the original (created in definer.js)
 *  2. for table entities with associations to entities which have a localized
 *     convenience views or redirections thereon: as projection on the original
 *  3. for view entities with associations to entities which have a localized
 *     convenience views or redirections thereon: as entity using the same
 *     query as the original, but replacing all sources by their localized
 *     convenience view variant if present
 *
 * First, all "direct ones" are built (1).  Then we build all 2 and 3
 * transitively (i.e. as long as an entity has an association which directly or
 * indirectly leads to an entity with localized elements, we create a localized
 * variant for it), and finally make sure via redirection that associations in
 * localized convenience views have as target the localized convenience view
 * variant if present.
 *
 * @param {CSN.Model} csn
 * @param {CSN.Options} options
 * @param {boolean} useJoins If true, rewrite the "localized" association to a
 *                           join in direct convenience views.
 * @param {acceptLocalizedView} [acceptLocalizedView] optional callback function returning true if the localized view name and its parent name provided as parameter should be created
 */
function _addLocalizationViews(csn, options, useJoins, acceptLocalizedView = null) {
  // Don't try to create convenience views with errors.
  if (hasErrors(options.messages))
    return csn;

  if (hasExistingLocalizationViews(csn, options))
    return csn;

  const { info, error } = makeMessageFunction(csn, options);

  const noCoalesce = (options.localizedLanguageFallback === 'none' ||
                      options.localizedWithoutCoalesce);

  createDirectConvenienceViews();     // 1
  createTransitiveConvenienceViews(); // 2 + 3

  forEachDefinition(csn, (definition, artName, prop, path) => {
    cleanSymbols(definition, _hasLocalizedView, _isViewForEntity, _isViewForView, _targetFor)
    if(definition.query) {
      // reject managed association and structure publishing for to-hdbcds.hdbcds
      const that = { csnUtils: getUtils(csn), options, error };
      rejectManagedAssociationsAndStructuresForHdbcsNames.call(that, definition, path)
    }
  });



  sortCsnDefinitionsForTests(csn, options);
  return csn;

  /**
   * Create direct convenience localization views for entities that have localized elements.
   * Only entities that have `localized` elements are used.  `localized` in types or sub-elements
   * are not respected.
   */
  function createDirectConvenienceViews() {
    forEachDefinition(csn, (art, artName) => {
      if (art.kind !== 'entity' || art.query || art.projection)
        // Ignore non-entities and views.  The latter are handled at a later point (step 2+3).
        return;

      if (isInLocalizedNamespace(artName))
        // We already issued a warning for it in warnAboutExistingLocalizationViews()
        return;

      const localized = getLocalizedTextElements( artName );
      if (localized)
        addLocalizedView( artName, localized );
    });
  }

  /**
   * Add a localized convenience view for the given artifact.
   * Can either be an entity or view.  `textElements` are the elements which
   * are needed for creating a horizontal convenience view, i.e. only required
   * for entities.
   *
   * @param {string} artName
   * @param {string[]} [textElements=[]]
   */
  function addLocalizedView( artName, textElements = [] ) {
    const art = csn.definitions[artName];
    const artPath = [ 'definitions', artName ];
    const viewName = `localized.${ artName }`;

    if (csn.definitions[viewName]) {
      // Already exists, skip creation.
      info( null, artPath, null, 'Convenience view can\'t be created due to conflicting names' );
      return;
    }

    art[_hasLocalizedView] = viewName;

    if(acceptLocalizedView && !acceptLocalizedView(viewName, artName))
      return;

    let view;
    if (art.query || art.projection)
      view = createLocalizedViewForView(art);
    else
      view = createLocalizedViewForEntity(art, artName, textElements);

    csn.definitions[viewName] = view;

    copyPersistenceAnnotations(csn.definitions[viewName], art);
  }

  /**
   * Create a localized data view for the given entity `art` with `textElements`.
   * In JOIN mode the FROM query is rewritten to remove associations and the
   * columns are expanded.
   *
   * @param {CSN.Definition} entity
   * @param {string} entityName
   * @param {string[]} [textElements]
   * @returns {CSN.View}
   */
  function createLocalizedViewForEntity( entity, entityName, textElements = [] ) {
    // Only use joins if requested and text elements are provided.
    const shouldUseJoin = useJoins && !!textElements.length;
    const columns = [ ];

    const convenienceView = {
      '@odata.draft.enabled': false,
      kind: 'entity',
      query: { // TODO: Use projection
        SELECT: {
          from: createFromClauseForEntity(),
          columns,
        },
      },
      elements: cloneCsnDictionary(entity.elements, options),
      [_isViewForEntity]: true,
    };
    copyLocation(convenienceView, entity);
    copyLocation(convenienceView.query, entity);

    if (shouldUseJoin)
      // Expand elements:
      columns.push( ...columnsForEntityWithExcludeList( entity, 'L_0', textElements ) )
    else
      columns.push( '*' );

    for (const originalElement of textElements) {
      const elem = entity.elements[originalElement];
      // Note: $key is used by forHanaNew.js to indicate that this element was a key in the original,
      //      user's entity.  Keys may have been changed by the backends (e.g. by `@cds.valid.key`)
      if (!elem.key && !elem.$key)
        columns.push( createColumnLocalizedElement( originalElement, shouldUseJoin ) );
      else if (shouldUseJoin)
        // In JOIN mode we also want to add keys.
        columns.push( createColumnRef( [ 'L_0', originalElement ] ));

      addCoreComputedIfNecessary(convenienceView.elements, originalElement);
    }

    return convenienceView;


    function createFromClauseForEntity() {
      if (!shouldUseJoin) {
        return createColumnRef( [ entityName ], 'L');
      }

      const from = {
        join: 'left',
        args: [
          createColumnRef( [ entityName ], 'L_0'),
          createColumnRef( [ textsEntityName(entityName) ], 'localized_1' ),
        ],
        on: []
      };

      for (const originalElement of textElements) {
        const elem = entity.elements[originalElement];
        if (elem.key || elem.$key) {
          from.on.push( createColumnRef( [ 'localized_1', originalElement ] ));
          from.on.push( '=' );
          from.on.push( createColumnRef( [ 'L_0', originalElement ] ));
          from.on.push( 'and' );
        }
      }

      from.on.push( createColumnRef( [ 'localized_1', 'locale' ] ) );
      from.on.push( '=' );
      from.on.push( createColumnRef( [ '$user', 'locale' ] ) );

      return from;
    }

  }

  /**
   * Create a localized convenience view for the given definition `view`.
   * Does _not_ rewrite references.
   *
   * @param {CSN.Definition} view
   * @returns {CSN.View}
   */
  function createLocalizedViewForView( view ) {
    const convenienceView = {
      kind: 'entity',
      '@odata.draft.enabled': false
    };

    if (view.query)
      convenienceView.query = cloneCsn(view.query, options);
    else if (view.projection)
      convenienceView.projection = cloneCsn(view.projection, options);

    convenienceView.elements = cloneCsnDictionary(view.elements, options);
    convenienceView[_isViewForView] = true;
    copyLocation(convenienceView, view);

    Object.keys(convenienceView.elements).forEach((elemName) => {
      addCoreComputedIfNecessary(convenienceView.elements, elemName);
    });

    if (view.params)
      convenienceView.params = cloneCsnDictionary(view.params, options);

    return convenienceView;
  }

  /** @return {CSN.Column} */
  function createColumnLocalizedElement(elementName, shouldUseJoins) {
    // In JOIN mode the association is removed.  We use `_N` suffixes for minimal
    // test-ref-diffs.
    // TODO: Remove `L_0` special handling.
    const mainName = shouldUseJoins ? 'L_0' : 'L';
    const localizedNames = shouldUseJoins ? [ 'localized_1' ] : [ 'L', 'localized' ];

    if (noCoalesce) {
      return createColumnRef( [...localizedNames, elementName], elementName );
    }

    return {
      func: 'coalesce',
      args: [
        createColumnRef( [ ...localizedNames, elementName] ),
        createColumnRef( [ mainName, elementName ] ),
      ],
      as: elementName,
    };
  }

  /**
   * Update the view element in such a way that it is compatible to the old XSN
   * based localized functionality.
   * Also, because `coalesce` is a function, mark the element `@Core.Computed`
   * if necessary.
   *
   * @param {object} elementsDict
   * @param {string} elementName
   */
  function addCoreComputedIfNecessary(elementsDict, elementName) {
    const element = elementsDict[elementName];
    if (!element.localized)
      return;

    if (noCoalesce) {
      // In the XSN based localized functionality, `localized` was set to `false`
      // because of the propagator and the `texts` entity.  The element is not
      // computed because it is directly referenced.
      // We imitate this behavior here to get a smaller test-file diff.
      element.localized = false;
    }
    else if (!element.key && !element.$key) {
      // Because in coalesce mode a function is used, localized non-key elements
      // are not directly referenced which results in a `@Core.Computed` annotation.
      element['@Core.Computed'] = true;
    }
  }

  /**
   * Returns all text element names for a definition `<artName>` if its texts entity
   * exists and `<artName>` has localized fields.  Otherwise `null` is returned.
   * Text elements are localized elements as well as keys.
   *
   * @param {string} artName Artifact name
   * @return {string[] | null}
   */
  function getLocalizedTextElements( artName ) {
    const art = csn.definitions[artName];
    const artPath = [ 'definitions', artName ];

    let keyCount = 0;
    let textElements = [];

    forEachGeneric(art, 'elements', (elem, elemName /*, prop, path*/) => {
      if (elem._ignore) // from HANA backend
        return;

      if (elem.key || elem.$key)
        keyCount += 1;

      if (elem.key || elem.$key || elem.localized)
        textElements.push( elemName );

      // TODO: Already warned about in definer.js
      // if (elem.key && isLocalized)
      //   warning( 'localized-key', path, {}, 'Keyword "localized" is ignored for primary keys' );
    }, artPath);

    if (textElements.length <= keyCount || keyCount <= 0)
      // Nothing to do: no localized fields or all localized fields are keys
      return null;

    if (!isEntityPreprocessed( art )) {
      info( null, artPath, { name: artName },
             'Skipped creation of convenience view for $(NAME) because the artifact is missing localization elements' );
      return null;
    }

    const textsName = textsEntityName( artName );
    const textsEntity = csn.definitions[textsName];

    if (!textsEntity) {
      info( null, artPath, { name: artName },
             'Skipped creation of convenience view for $(NAME) because its texts entity could not be found' );
      return null;
    }

    if (!isValidTextsEntity( textsEntity )) {
      info( null, [ 'definitions', textsName ], { name: artName },
             'Skipped creation of convenience view for $(NAME) because its texts entity does not appear to be valid' );
      return null;
    }

    // There may be keys in the original artifact that were added by the core compiler,
    // for example elements that are marked @cds.valid.from.
    // These keys are not present in the texts entity generated by the compiler.
    // So if we don't filter them out, we may generate invalid SQL.
    textElements = textElements.filter((elemName) => {
      const hasElement = !!textsEntity.elements[elemName];
      if (!hasElement && (art.elements[elemName].key || art.elements[elemName].$key))
        keyCount--;
      return hasElement;
    });

    if (textElements.length <= keyCount || keyCount <= 0)
      // Repeat the check already used above as the number of keys may have changed.
      return null;

    return textElements;
  }

  /**
   * Transitively create convenience views for entities/views that have
   * associations to localized entities or to views that themselves have such
   * a dependency.
   *
   * The algorithm is as follows:
   *
   *  1. For each view/entity with associations:
   *    - If target is NOT localized => add view/entity to target's `_targetFor` property
   *    - If target is     localized => add view/entity to array `entities`
   *  2. As long as `entities` has entries:
   *     a. For each entry in `entities`
   *        - Create a convenience view
   *        - If the entry has a `_targetFor` property, add its entries to
   *          `nextEntities` because they now have a transitive dependency on a
   *          localized view.
   *     b. Copy all entries from `nextEntities` to `entities`.
   *     c. Clear `nextEntities`.
   *  3. Rewrite all references to the localized variants.
   */
  function createTransitiveConvenienceViews() {
    let entities = [];
    forEachDefinition( csn, collectLocalizedEntities );

    let nextEntities = [];
    while (entities.length) {
      entities.forEach( createViewAndCollectSources );
      entities = [ ...nextEntities ];
      nextEntities = [];
    }
    forEachDefinition( csn, rewriteToLocalized );
    return;

    function collectLocalizedEntities( art, artName ) {
      if (art.kind !== 'entity')
        // Ignore non-entities but also process entities because of associations.
        return;
      if (isInLocalizedNamespace(artName))
        // Ignore existing `localized.` views.
        return;
      if (art[_hasLocalizedView])
        // Entity already has a convenience view.
        return;

      _collectFromElements(art.elements);

      function _collectFromElements(elements) {
        if (!elements)
          return;

        // Element may be localized or has an association to localized entity.
        for (const elemName in elements) {
          const elem = elements[elemName];

          if ((art.query || art.projection) && elem.localized && !elem.key && !elem.$key) {
            // e.g. projections ; ignore if key is present (warning already issued) or
            // if the artifact is an entity (already processed in (1))
            entities.push(artName);
          }
          else if (elem.target) {
            // If the target has a localized view then we are localized as well.
            const def = csn.definitions[elem.target];
            // TODO: What if elem.target cannot be found? Could this happen after flattening, ...?
            if (!def)
              continue;

            if (def[_hasLocalizedView]) {
              // The target may already be localized and if so, then add the artifact
              // to the to-be-processed entities.
              entities.push(artName);
            }
            else {
              // Otherwise the target view may become localized at a later point so
              // we should add it to a reverse-dependency list.
              if (!def[_targetFor])
                def[_targetFor] = [];
              def[_targetFor].push(artName);
            }

          } else {
            // recursive check
            _collectFromElements(elem.elements);
          }
        }
      }
    }

    /**
     * Create a localization view for `artName` and add views/entities that depend
     * on `artName` to `nextEntities`
     *
     * @param {string} artName
     */
    function createViewAndCollectSources( artName ) {
      const art = csn.definitions[artName];
      if (art[_hasLocalizedView])
        // view/entity was already processed
        return;

      addLocalizedView(artName);

      if (art[_targetFor])
        nextEntities.push(...art[_targetFor]);
      delete art[_targetFor];
    }
  }

  /**
   * Rewrites query/association references inside `art` to "localized"-ones if they exist.
   *
   * @param {CSN.Definition} art
   * @param {string} artName
   */
  function rewriteToLocalized( art, artName ) {
    if (art[_isViewForEntity]) {
      // For entity convenience views only references in elements need to be rewritten.
      // a.k.a 'LOCALIZED-HORIZONTAL'
      forEachGeneric(art, 'elements', elem => rewriteDirectRefPropsToLocalized(elem));
    }
    else if (art[_isViewForView]) {
      // For view convenience views (i.e. transitive views) we need to rewrite `from`
      // references as well as need to handle `mixin` elements.
      // a.k.a 'LOCALIZED-VERTICAL'
      forAllQueries(art.query || art.projection, (query) => {
        query = query.SELECT || query.SET || query;
        if (query.from)
          rewriteFrom(query.from);
        if (query.mixin)
          forEachGeneric(query, 'mixin', elem => rewriteDirectRefPropsToLocalized(elem));

        (query.columns || []).forEach((column) => {
          if (column && typeof column === 'object' && column.cast)
            rewriteDirectRefPropsToLocalized(column.cast);
        });
      }, [ 'definitions', artName ]);

      forEachGeneric(art, 'elements', elem => rewriteDirectRefPropsToLocalized(elem));
    }
  }

  /**
   * A query's FROM clause may be a simple ref but could also be more complex
   * and contain `args` that themselves are JOINs with `args`.
   * So rewrite the references recursively.
   *
   * @param {CSN.QueryFrom} from
   */
  function rewriteFrom(from) {
    rewriteRefToLocalized( from );
    if (Array.isArray(from.args))
      from.args.forEach(arg => rewriteFrom(arg));
  }

  /**
   * Rewrites type references in `obj[ 'ref' | 'target' | 'on' ]]`.
   * Does _not_ do so recursively!
   *
   * @param {object} obj
   */
  function rewriteDirectRefPropsToLocalized( obj ) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj))
      return;

    for (const prop of [ 'ref', 'target', 'on' ]) {
      const val = obj[prop];
      if (prop === 'ref') {
        rewriteRefToLocalized(obj);
      }
      else if (Array.isArray(val)) {
        val.forEach(rewriteDirectRefPropsToLocalized);
      }
      else if (typeof val === 'string') {
        const def = csn.definitions[val];
        if (def && def[_hasLocalizedView])
          obj[prop] = def[_hasLocalizedView];
      }
    }
  }

  /**
   * Rewrites the type reference `obj.ref`.
   *
   * @param {object} obj
   * @todo Aliases?
   */
  function rewriteRefToLocalized( obj ) {
    if (!obj || !obj.ref)
      return;
    const ref = Array.isArray(obj.ref) ? obj.ref[0] : obj.ref;
    if (typeof ref !== 'string')
      return;
    const def = csn.definitions[ref];
    if (def && def[_hasLocalizedView]) {
      if (Array.isArray(obj.ref))
        obj.ref[0] = def[_hasLocalizedView];
      else
        obj.ref = def[_hasLocalizedView];
    }
  }

  /**
   * @param {string} artName
   */
  function textsEntityName(artName) {
    // We can assume, that the element exists.  This is checked in isEntityPreprocessed()
    return csn.definitions[artName].elements.texts.target;
  }
}

/**
 * Create transitive localized convenience views to the given CSN.
 *
 * @param {CSN.Model} csn
 * @param {CSN.Options} options
 * @param [acceptLocalizedView] optional callback function returning true if the localized view name and its parent name provided as parameter should be created
 */
function addLocalizationViews(csn, options, acceptLocalizedView = null) {
  return _addLocalizationViews(csn, options, false, acceptLocalizedView);
}

/**
 * Create transitive localized convenience views to the given CSN but
 * rewrite the "localized" association to joins in direct entity convenience
 * views.  This is needed by e.g. SQL for SQLite where A2J is used.
 *
 * @param {CSN.Model} csn
 * @param {CSN.Options} options
 * @param [acceptLocalizedView] optional callback function returning true if the localized view name and its parent name provided as parameter should be created
 */
function addLocalizationViewsWithJoins(csn, options, acceptLocalizedView = null) {
  return _addLocalizationViews(csn, options, true, acceptLocalizedView);
}

/**
 * @param {string[]} ref Reference path
 * @param {string} [as] Alias for path.
 * @return {CSN.Column}
 */
function createColumnRef(ref, as = null) {
  const column = { ref };
  if (as)
    column.as = as;
  // @ts-ignore
  return column;
}

/**
 * Create columns for the given entity's elements.
 * Only create columns for elements that are not part of the excludeList.
 *
 * @param {CSN.Definition} entity
 * @param {string} entityName
 * @param {string[]} excludeList
 * @returns {CSN.Column[]}
 */
function columnsForEntityWithExcludeList(entity, entityName, excludeList) {
  // @ts-ignore
  return Object.keys(entity.elements)
    .filter(elementName => !excludeList.includes(elementName))
    .map(elementName => {
      return { ref: [ entityName, elementName ] };
    });
}

/**
 * Copy `source.$location` as a non-enumerable to `target.$location`.
 *
 * @param {object} target
 * @param {object} source
 */
function copyLocation(target, source) {
  if (source.$location)
    setProp(target, '$location', source.$location);
}

/**
 * Copy some @cds.persistence.* annotations from the source to
 * the target.  Ignores existing annotations on the target.
 *
 * @param {CSN.Artifact} target
 * @param {CSN.Artifact} source
 */
function copyPersistenceAnnotations(target, source) {
  Object.keys(source)
    .forEach(anno => {
      // Do NOT copy ".exists" at the moment.  ".exists" is not propagated
      // and this would lead to some localization views referencing not-existing
      // "localized.XYZ" views.
      if (anno === '@cds.persistence.skip')
        target[anno] = source[anno];
    });
}

/**
 * Warns about the first existing `localized.` view.
 *
 * @param {CSN.Model} csn
 * @param {CSN.Options} options
 */
function hasExistingLocalizationViews(csn, options) {
  const firstLocalizedView = Object.keys(csn.definitions).find(isInLocalizedNamespace);
  if (firstLocalizedView) {
    const { info } = makeMessageFunction(csn, options);
    info( null, [ 'definitions', firstLocalizedView ], {},
          'Input CSN already contains expansions for localized data' );
    return true;
  }
  return false;
}

/**
 * Returns true if the given entity appears to be a valid texts entity.
 *
 * @param {CSN.Artifact} entity
 */
function isValidTextsEntity(entity) {
  if (!entity)
    return false;
  const requiredTextsProps = [ 'locale' ];
  return requiredTextsProps.some( prop => !!entity.elements[prop])
}

/**
 * Returns true if the localized entity has elements that are generated by
 * the core-compiler.  If elements are missing but the entity is localized
 * then the pre-processing by the core-compiler was not done.
 *
 * @param {CSN.Artifact} entity
 */
function isEntityPreprocessed(entity) {
  if (!entity)
    return false;
  if (!entity.elements.localized)
    return false;
  return entity.elements.texts && entity.elements.texts.target;
}

/**
 * @param {string} name
 */
function isInLocalizedNamespace(name) {
  return name.startsWith('localized.');
}

/**
 * Return true if the given artifact has a localized convenience view in the CSN model.
 *
 * @param {CSN.Model} csn
 * @param {string} artifactName
 */
function hasLocalizedConvenienceView(csn, artifactName) {
  return !isInLocalizedNamespace(artifactName) && !!csn.definitions[`localized.${ artifactName }`];
}

module.exports = {
  addLocalizationViews,
  addLocalizationViewsWithJoins,
  isInLocalizedNamespace,
  hasLocalizedConvenienceView,
};
