
'use strict';

const {
  getLastPartOf, getLastPartOfRef,
  hasValidSkipOrExists, isBuiltinType, generatedByCompilerVersion, getNormalizedQuery,
  forEachDefinition, getResultingName,
} = require('../model/csnUtils');
const {
  renderFunc, beautifyExprArray, cdsToSqlTypes, getHanaComment, hasHanaComment,
} = require('./utils/common');
const {
  renderReferentialConstraint, getIdentifierUtils,
} = require('./utils/sql');
const DuplicateChecker = require('./DuplicateChecker');
const { checkCSNVersion } = require('../json/csnVersion');
const { makeMessageFunction } = require('../base/messages');
const timetrace = require('../utils/timetrace');
const { isBetaEnabled, isDeprecatedEnabled } = require('../base/model');
const { smartFuncId } = require('../sql-identifier');
const { sortCsn } = require('../json/to-csn');


/**
 * Render the CSN model 'model' to SQL DDL statements. One statement is created
 * per top-level artifact into dictionaries 'hdbtable', 'hdbview', ..., without
 * leading CREATE, without trailing semicolon. All corresponding statements (in
 * proper order) are copied into dictionary 'sql', with trailing semicolon.
 * Also included in the result are dictionaries 'deletions' and 'migrations',
 * keyed by entity name, which reflect statements needed for deleting or changing
 * (migrating) entities.
 * In the case of 'deletions', each entry contains the corresponding DROP statement.
 * In the case of 'migrations', each entry is an array of objects representing
 * changes to the entity. Each change object contains one or more SQL statements
 * (concatenated to one string using \n) and information whether these incur
 * potential data loss.
 *
 * Return an object like this:
 * { "hdbtable": {
 *     "foo" : "COLUMN TABLE foo ...",
 *    },
 *   "hdbview": {
 *     "bar::wiz" : "VIEW \"bar::wiz\" AS SELECT \"x\" FROM ..."
 *   },
 *   "sql: {
 *     "foo" : "CREATE TABLE foo ...;\n",
 *     "bar::wiz" : "CREATE VIEW \"bar::wiz\" AS SELECT \"x\" FROM ...;\n"
 *   },
 *   "deletions": {
 *     "baz": "DROP TABLE baz"
 *   },
 *   "migrations": {
 *     "foo": [
 *       {
 *         "drop": false,
 *         "sql": "ALTER TABLE foo ALTER (elm DECIMAL(12, 9));"
 *       },
 *       {
 *         "drop": true,
 *         "sql": "ALTER TABLE foo DROP (eln);"
 *       },
 *       {
 *         "drop": false,
 *         "sql": "ALTER TABLE foo ADD (elt NVARCHAR(99));"
 *       }
 *     ]
 *   }
 * }
 *
 * @param {CSN.Model} csn HANA transformed CSN
 * @param {CSN.Options} options Transformation options
 * @returns {object} Dictionary of artifact-type:artifacts, where artifacts is a dictionary of name:content
 */
function toSqlDdl(csn, options) {
  timetrace.start('SQL rendering');
  const {
    error, warning, info, throwWithError,
  } = makeMessageFunction(csn, options, 'to.sql');
  const { quoteSqlId, prepareIdentifier } = getIdentifierUtils(options);

  // Utils to render SQL statements.
  const render = {
    /*
      Render column additions as HANA SQL. Checks for duplicate elements.
      Only HANA SQL is currently supported.
     */
    addColumns: {
      fromElementStrings(tableName, eltStrings) {
        return [ `ALTER TABLE ${tableName} ADD (${eltStrings.join(', ')});` ];
      },
      fromElementsObj(artifactName, tableName, elementsObj, env, duplicateChecker) {
        // Only extend with 'ADD' for elements/associations
        // TODO: May also include 'RENAME' at a later stage
        const elements = Object.entries(elementsObj)
          .map(([ name, elt ]) => renderElement(artifactName, name, elt, duplicateChecker, null, env))
          .filter(s => s !== '');

        if (elements.length)
          return render.addColumns.fromElementStrings(tableName, elements);

        return [];
      },
    },
    /*
      Render association additions as HANA SQL.
      TODO duplicity check
     */
    addAssociations(artifactName, tableName, elementsObj, env) {
      return Object.entries(elementsObj)
        .map(([ name, elt ]) => renderAssociationElement(name, elt, env))
        .filter(s => s !== '')
        .map(eltStr => `ALTER TABLE ${tableName} ADD ASSOCIATION (${eltStr});`);
    },
    /*
      Render key addition as HANA SQL.
     */
    addKey(tableName, elementsObj) {
      return [ `ALTER TABLE ${tableName} ADD ${render.primaryKey(elementsObj)}` ];
    },
    /*
      Render column removals as HANA SQL.
     */
    dropColumns(tableName, sqlIds) {
      return [ `ALTER TABLE ${tableName} DROP (${sqlIds.join(', ')});` ];
    },
    /*
      Render association removals as HANA SQL.
     */
    dropAssociation(tableName, sqlId) {
      return [ `ALTER TABLE ${tableName} DROP ASSOCIATION ${sqlId};` ];
    },
    /*
      Render primary-key removals as HANA SQL.
     */
    dropKey(tableName) {
      return [ `ALTER TABLE ${tableName} DROP PRIMARY KEY;` ];
    },
    /*
      Render column modifications as HANA SQL.
     */
    alterColumns(tableName, definitionsStr) {
      return [ `ALTER TABLE ${tableName} ALTER (${definitionsStr});` ];
    },
    /*
      Render primary keys as HANA SQL.
     */
    primaryKey(elementsObj) {
      const primaryKeys = Object.keys(elementsObj)
        .filter(name => elementsObj[name].key)
        .filter(name => !elementsObj[name].virtual)
        .map(name => quoteSqlId(name))
        .join(', ');
      return primaryKeys && `PRIMARY KEY(${primaryKeys})`;
    },
    /*
      Render entity-comment modifications as HANA SQL.
     */
    alterEntityComment(tableName, comment) {
      return [ `COMMENT ON TABLE ${tableName} IS ${render.comment(comment)};` ];
    },
    /*
      Render column-comment modifications as HANA SQL.
     */
    alterColumnComment(tableName, columnName, comment) {
      return [ `COMMENT ON COLUMN ${tableName}.${columnName} IS ${render.comment(comment)};` ];
    },
    /*
      Render comment string.
     */
    comment(comment) {
      return comment && `'${comment.replace(/'/g, '\'\'')}'` || 'NULL';
    },
    /*
      Concatenate multiple statements which are to be treated as one by the API caller.
     */
    concat(...statements) {
      return [ statements.join('\n') ];
    },
  };

  // FIXME: Currently requires 'options.forHana', because it can only render HANA-ish SQL dialect
  if (!options.forHana)
    throw new Error('toSql can currently only be used with HANA preprocessing');

  checkCSNVersion(csn, options);

  // The final result in hdb-kind-specific form, without leading CREATE, without trailing newlines
  // (note that the order here is relevant for transmission into 'resultObj.sql' below and that
  // the attribute names must be the HDI plugin names for --src hdi)
  // The result object may have a `sql` dictionary for `toSql`.
  const resultObj = {
    hdbtabletype: Object.create(null),
    hdbtable: Object.create(null),
    hdbindex: Object.create(null),
    hdbfulltextindex: Object.create(null),
    hdbview: Object.create(null),
    hdbconstraint: Object.create(null),
    deletions: Object.create(null),
    migrations: Object.create(null),
  };

  // Registries for artifact and element names per CSN section
  const definitionsDuplicateChecker = new DuplicateChecker(options.toSql.names);
  const deletionsDuplicateChecker = new DuplicateChecker();
  const extensionsDuplicateChecker = new DuplicateChecker();
  const removeElementsDuplicateChecker = new DuplicateChecker();
  const changeElementsDuplicateChecker = new DuplicateChecker();

  // Render each artifact on its own
  forEachDefinition((options && options.testMode) ? sortCsn(csn, options) : csn, (artifact, artifactName) => {
    // This environment is passed down the call hierarchy, for dealing with
    // indentation issues
    const env = {
      // Current indentation string
      indent: '',
    };
    renderArtifactInto(artifactName, artifact, resultObj, env);
  });

  // Render each deleted artifact
  for (const artifactName in csn.deletions)
    renderArtifactDeletionInto(artifactName, csn.deletions[artifactName], resultObj);


  // Render each artifact extension
  // Only HANA SQL is currently supported.
  // Note that extensions may contain new elements referenced in migrations, thus should be compiled first.
  if (csn.extensions && options.toSql.dialect === 'hana') {
    for (const extension of options && options.testMode ? sortCsn(csn.extensions) : csn.extensions) {
      if (extension.extend) {
        const artifactName = extension.extend;
        const _artifact = csn.definitions[artifactName];
        const env = { indent: '', _artifact };
        renderArtifactExtensionInto(artifactName, _artifact, extension, resultObj, env);
      }
    }
  }

  // Render each artifact change
  // Only HANA SQL is currently supported.
  if (csn.migrations && options.toSql.dialect === 'hana') {
    for (const migration of options && options.testMode ? sortCsn(csn.migrations) : csn.migrations) {
      if (migration.migrate) {
        const artifactName = migration.migrate;
        const _artifact = csn.definitions[artifactName];
        const env = { indent: '', _artifact };
        renderArtifactMigrationInto(artifactName, migration, resultObj, env);
      }
    }
  }

  // trigger artifact and element name checks
  definitionsDuplicateChecker.check(error, options);
  extensionsDuplicateChecker.check(error);
  deletionsDuplicateChecker.check(error);

  // Throw exception in case of errors
  throwWithError();

  // Transfer results from hdb-specific dictionaries into 'sql' dictionary in proper order if toSql.src === 'sql'
  // (relying on the order of dictionaries above)
  // FIXME: Should consider inter-view dependencies, too
  const sql = Object.create(null);
  const sqlVersionLine = `-- ${generatedByCompilerVersion()}\n`;

  // Handle hdbKinds separately from alterTable case
  // eslint-disable-next-line no-unused-vars
  const { deletions, migrations, ...hdbKinds } = resultObj;
  for (const hdbKind of Object.keys(hdbKinds)) {
    for (const name in resultObj[hdbKind]) {
      if (options.toSql.src === 'sql') {
        let sourceString = resultObj[hdbKind][name];
        // Hack: Other than in 'hdbtable' files, in HANA SQL COLUMN is not mandatory but default.
        if (options.toSql.dialect === 'hana' && hdbKind === 'hdbtable' && sourceString.startsWith('COLUMN '))
          sourceString = sourceString.slice('COLUMN '.length);

        sql[name] = `${options.testMode ? '' : sqlVersionLine}CREATE ${sourceString};`;
      }
      else if (!options.testMode) {
        resultObj[hdbKind][name] = sqlVersionLine + resultObj[hdbKind][name];
      }
    }
    if (options.toSql.src === 'sql')
      delete resultObj[hdbKind];
  }

  if (options.toSql.src === 'sql')
    resultObj.sql = sql;

  for (const name in deletions)
    deletions[name] = `${options.testMode ? '' : sqlVersionLine}${deletions[name]}`;


  timetrace.stop();
  return resultObj;

  /**
   * Render an artifact into the appropriate dictionary of 'resultObj'.
   *
   * @param {string} artifactName Name of the artifact to render
   * @param {CSN.Artifact} art Artifact to render
   * @param {object} resultObj Result collector
   * @param {object} env Render environment
   */
  function renderArtifactInto(artifactName, art, resultObj, env) {
    // Ignore whole artifacts if forHana says so
    if (art.abstract || hasValidSkipOrExists(art))
      return;

    switch (art.kind) {
      case 'entity':
      case 'view':
        if (getNormalizedQuery(art).query) {
          const result = renderView(artifactName, art, env);
          if (result)
            resultObj.hdbview[artifactName] = result;
        }
        else {
          renderEntityInto(artifactName, art, resultObj, env);
        }
        break;
      case 'type':
      case 'context':
      case 'service':
      case 'namespace':
      case 'annotation':
      case 'action':
      case 'function':
      case 'event':
      case 'aspect':
        // Ignore: not SQL-relevant
        return;
      default:
        throw new Error(`Unknown artifact kind: ${art.kind}`);
    }
  }

  /**
   * Render an artifact extension into the appropriate dictionary of 'resultObj'.
   * Only HANA SQL is currently supported.
   *
   * @param {string} artifactName Name of the artifact to render
   * @param {CSN.Artifact} artifact The complete artifact
   * @param {CSN.Artifact} ext Extension to render
   * @param {object} resultObj Result collector
   * @param {object} env Render environment
   */
  function renderArtifactExtensionInto(artifactName, artifact, ext, resultObj, env) {
    // Property kind is always omitted for elements and can be omitted for
    // top-level type definitions, it does not exist for extensions.
    if (artifactName && !ext.query)
      renderExtendInto(artifactName, artifact.elements, ext.elements, resultObj, env, extensionsDuplicateChecker);

    if (!artifactName)
      throw new Error(`Undefined artifact name: ${artifactName}`);
  }

  // Render an artifact deletion into the appropriate dictionary of 'resultObj'.
  function renderArtifactDeletionInto(artifactName, art, resultObj) {
    const tableName = renderArtifactName(artifactName);
    deletionsDuplicateChecker.addArtifact(tableName, art.$location, artifactName);

    addDeletion(resultObj, artifactName, `DROP TABLE ${tableName}`);
  }

  /**
   * Given the following artifact name: namespace.prefix.entity.with.dot, render the following,
   * depending on the naming mode:
   * - plain: NAMESPACE_PREFIX_ENTITY_WITH_DOT
   * - quoted: namespace.prefix.entity_with_dot
   * - hdbcds: namespace::prefix.entity_with_dot
   *
   *
   * @param {string} artifactName Artifact name to render
   *
   * @returns {string} Artifact name
   */
  function renderArtifactName(artifactName) {
    return quoteSqlId(getResultingName(csn, options.toSql.names, artifactName));
  }

  // Render an artifact migration into the appropriate dictionary of 'resultObj'.
  // Only HANA SQL is currently supported.
  function renderArtifactMigrationInto(artifactName, migration, resultObj, env) {
    function reducesTypeSize(def) {
      // HANA does not allow decreasing the value of any of those type parameters.
      return def.old.type === def.new.type &&
        [ 'length', 'precision', 'scale' ].some(param => def.new[param] < def.old[param]);
    }
    function getEltStr(defVariant, eltName) {
      return defVariant.target
        ? renderAssociationElement(eltName, defVariant, env)
        : renderElement(artifactName, eltName, defVariant, null, null, env);
    }
    function getEltStrNoProp(defVariant, prop, eltName) {
      const defNoProp = Object.assign({}, defVariant);
      delete defNoProp[prop];
      return getEltStr(defNoProp, eltName);
    }

    const tableName = renderArtifactName(artifactName);

    // Change entity properties
    if (migration.properties) {
      for (const [ prop, def ] of Object.entries(migration.properties)) {
        if (prop === 'doc') {
          const alterComment = render.alterEntityComment(tableName, def.new);
          addMigration(resultObj, artifactName, false, alterComment);
        }
      }
    }

    // Drop columns (unsupported in sqlite)
    if (migration.remove) {
      const entries = Object.entries(migration.remove);
      if (entries.length) {
        const removeCols = entries.filter(([ , value ]) => !value.target).map(([ key ]) => quoteSqlId(key));
        const removeAssocs = entries.filter(([ , value ]) => value.target).map(([ key ]) => quoteSqlId(key));

        removeElementsDuplicateChecker.addArtifact(tableName, undefined, artifactName);
        [ ...removeCols, ...removeAssocs ].forEach(element => removeElementsDuplicateChecker.addElement(quoteSqlId(element), undefined, element));

        // Remove columns.
        if (removeCols.length)
          addMigration(resultObj, artifactName, true, render.dropColumns(tableName, removeCols));

        // Remove associations.
        removeAssocs.forEach(assoc => addMigration(resultObj, artifactName, true, render.dropAssociation(tableName, assoc)));
      }
    }

    // Change column types (unsupported in sqlite)
    if (migration.change) {
      changeElementsDuplicateChecker.addArtifact(tableName, undefined, artifactName);
      for (const [ eltName, def ] of Object.entries(migration.change)) {
        const sqlId = quoteSqlId(eltName);
        changeElementsDuplicateChecker.addElement(sqlId, undefined, eltName);

        const eltStrOld = getEltStr(def.old, eltName);
        const eltStrNew = getEltStr(def.new, eltName);
        if (eltStrNew === eltStrOld)
          return; // Prevent spurious migrations, where the column DDL does not change.

        if (def.old.doc !== def.new.doc) {
          const eltStrOldNoDoc = getEltStrNoProp(def.old, 'doc', eltName);
          const eltStrNewNoDoc = getEltStrNoProp(def.new, 'doc', eltName);
          if (eltStrOldNoDoc === eltStrNewNoDoc) { // only `doc` changed
            const alterComment = render.alterColumnComment(tableName, sqlId, def.new.doc);
            addMigration(resultObj, artifactName, false, alterComment);
            continue;
          }
        }

        if (options.sqlChangeMode === 'drop' || def.old.target || def.new.target || reducesTypeSize(def)) {
          // Lossy change because either an association is removed and/or added, or the type size is reduced.
          // Drop old element and re-add it in its new shape.
          const drop = def.old.target
            ? render.dropAssociation(tableName, sqlId)
            : render.dropColumns(tableName, [ sqlId ]);
          const add = def.new.target
            ? render.addAssociations(artifactName, tableName, { [eltName]: def.new }, env)
            : render.addColumns.fromElementsObj(artifactName, tableName, { [eltName]: def.new }, env);
          addMigration(resultObj, artifactName, true, render.concat(...drop, ...add));
        }
        else {
          // Lossless change: no associations directly affected, no size reduction.
          addMigration(resultObj, artifactName, false, render.alterColumns(tableName, eltStrNew));
        }
      }
    }
  }

  /**
   * Render a (non-projection, non-view) entity (and possibly its indices) into the appropriate
   * dictionaries of 'resultObj'.
   *
   * @param {string} artifactName Name of the artifact to render
   * @param {CSN.Artifact} art Artifact to render
   * @param {object} resultObj Result collector
   * @param {object} env Render environment
   */
  function renderEntityInto(artifactName, art, resultObj, env) {
    env._artifact = art;
    const childEnv = increaseIndent(env);
    const hanaTc = art.technicalConfig && art.technicalConfig.hana;
    let result = '';
    // Only HANA has row/column tables
    if (options.toSql.dialect === 'hana') {
      if (hanaTc && hanaTc.storeType) {
        // Explicitly specified
        result += `${art.technicalConfig.hana.storeType.toUpperCase()} `;
      }
      else {
        // in 'hdbtable' files, COLUMN or ROW is mandatory, and COLUMN is the default
        result += 'COLUMN ';
      }
    }
    const tableName = renderArtifactName(artifactName);
    definitionsDuplicateChecker.addArtifact(art['@cds.persistence.name'], art.$location, artifactName);
    result += `TABLE ${tableName}`;
    result += ' (\n';
    const elements = Object.keys(art.elements).map(eltName => renderElement(artifactName, eltName, art.elements[eltName], definitionsDuplicateChecker, getFzIndex(eltName, hanaTc), childEnv)).filter(s => s !== '').join(',\n');
    if (elements !== '') {
      result += elements;
    }
    else {
      // TODO: Already be handled by 'empty-entity' reclassification; better location
      error(null, [ 'definitions', artifactName ], 'Entities must have at least one element that is non-virtual');
    }
    const uniqueFields = Object.keys(art.elements).filter(name => art.elements[name].unique && !art.elements[name].virtual)
      .map(name => quoteSqlId(name))
      .join(', ');
    if (uniqueFields !== '')
      result += `,\n${childEnv.indent}UNIQUE(${uniqueFields})`;

    const primaryKeys = render.primaryKey(art.elements);
    if (primaryKeys !== '')
      result += `,\n${childEnv.indent}${primaryKeys}`;

    if (art.$tableConstraints && art.$tableConstraints.referential) {
      const renderReferentialConstraintsAsHdbconstraint = options.toSql.src === 'hdi';
      const referentialConstraints = {};
      Object.entries(art.$tableConstraints.referential)
        .forEach(([ fileName, referentialConstraint ]) => {
          referentialConstraints[fileName] = renderReferentialConstraint(referentialConstraint, childEnv.indent, false, csn, options);
        });
      if (renderReferentialConstraintsAsHdbconstraint) {
        Object.entries(referentialConstraints).forEach(([ fileName, constraint ]) => {
          resultObj.hdbconstraint[fileName] = constraint;
        });
      }
      else {
        Object.values(referentialConstraints).forEach((constraint) => {
          result += `,\n${constraint}`;
        });
      }
    }
    // Append table constraints if any
    // 'CONSTRAINT <name> UNIQUE (<column_list>)
    // OR create a unique index for HDI
    const uniqueConstraints = art.$tableConstraints && art.$tableConstraints.unique;
    for (const cn in uniqueConstraints) {
      const c = uniqueConstraints[cn];
      if (options.toSql.src === 'hdi') {
        resultObj.hdbindex[`${artifactName}.${cn}`]
          = `UNIQUE INVERTED INDEX ${renderArtifactName(`${artifactName}_${cn}`)} ON ${tableName} (${c.map(cpath => quoteSqlId(cpath.ref[0])).join(', ')})`;
      }
      else {
        result += `,\n${childEnv.indent}CONSTRAINT ${renderArtifactName(`${artifactName}_${cn}`)} UNIQUE (${c.map(cpath => quoteSqlId(cpath.ref[0])).join(', ')})`;
      }
    }
    result += `${env.indent}\n)`;

    if (options.toSql.dialect === 'hana')
      result += renderTechnicalConfiguration(art.technicalConfig, childEnv);


    const associations = Object.keys(art.elements).map(name => renderAssociationElement(name, art.elements[name], childEnv))
      .filter(s => s !== '')
      .join(',\n');
    if (associations !== '' && options.toSql.dialect === 'hana') {
      result += `${env.indent} WITH ASSOCIATIONS (\n${associations}\n`;
      result += `${env.indent})`;
    }
    // Only HANA has indices
    // FIXME: Really? We should provide a DB-agnostic way to specify that
    if (options.toSql.dialect === 'hana')
      renderIndexesInto(art.technicalConfig && art.technicalConfig.hana.indexes, artifactName, resultObj, env);

    if (options.toSql.dialect === 'hana' && hasHanaComment(art, options, art))
      result += ` COMMENT '${getHanaComment(art)}'`;

    resultObj.hdbtable[artifactName] = result;
  }


  /**
   * Render an extended entity into the appropriate dictionaries of 'resultObj'.
   * Only HANA SQL is currently supported.
   *
   * @param {string} artifactName Name of the artifact to render
   * @param {object} artifactElements Elements comprising the artifact
   * @param {object} extElements Elements comprising the extension
   * @param {object} resultObj Result collector
   * @param {object} env Render environment
   * @param {DuplicateChecker} duplicateChecker
   */
  function renderExtendInto(artifactName, artifactElements, extElements, resultObj, env, duplicateChecker) {
    const tableName = renderArtifactName(artifactName);
    if (duplicateChecker)
      duplicateChecker.addArtifact(tableName, undefined, artifactName);
    const elements = render.addColumns.fromElementsObj(artifactName, tableName, extElements, env, duplicateChecker);
    const associations = render.addAssociations(artifactName, tableName, extElements, env);
    if (elements.length + associations.length > 0)
      addMigration(resultObj, artifactName, false, [ ...elements, ...associations ]);

    if (Object.values(extElements).some(elt => elt.key)) {
      const drop = render.dropKey(tableName);
      const add = render.addKey(tableName, artifactElements);
      addMigration(resultObj, artifactName, true, render.concat(...drop, ...add));
    }
  }

  function addMigration(resultObj, artifactName, drop, sqlArray) {
    if (!(artifactName in resultObj.migrations))
      resultObj.migrations[artifactName] = [];

    const migrations = sqlArray.map(sql => ({ drop, sql }));
    resultObj.migrations[artifactName].push(...migrations);
  }

  function addDeletion(resultObj, artifactName, sql) {
    resultObj.deletions[artifactName] = sql;
  }

  /**
   * Retrieve the 'fzindex' (fuzzy index) property (if any) for element 'elemName' from hanaTc (if defined)
   *
   * @param {string} elemName Element to retrieve the index for
   * @param {object} hanaTc Technical configuration object
   * @returns {object} fzindex for the element
   */
  function getFzIndex(elemName, hanaTc) {
    if (!hanaTc || !hanaTc.fzindexes || !hanaTc.fzindexes[elemName])
      return undefined;

    if (Array.isArray(hanaTc.fzindexes[elemName][0])) {
      // FIXME: Should we allow multiple fuzzy search indices on the same column at all?
      // And if not, why do we wrap this into an array?
      return hanaTc.fzindexes[elemName][hanaTc.fzindexes[elemName].length - 1];
    }

    return hanaTc.fzindexes[elemName];
  }


  /**
   * Render an element 'elm' with name 'elementName' (of an entity or type, not of a
   * projection or view), optionally with corresponding fuzzy index 'fzindex' from the
   * technical configuration.
   * Ignore association elements (those are rendered later by renderAssociationElement).
   * Use 'artifactName' only for error output.
   * Return the resulting source string (no trailing LF).
   *
   * @param {string} artifactName Name of the artifact containing the element
   * @param {string} elementName Name of the element to render
   * @param {CSN.Element} elm CSN element
   * @param {DuplicateChecker} duplicateChecker Utility for detecting duplicates
   * @param {object} fzindex Fzindex object for the element
   * @param {object} env Render environment
   * @returns {string} Rendered element
   */
  function renderElement(artifactName, elementName, elm, duplicateChecker, fzindex, env) {
    if (elm.virtual || elm.target)
      return '';

    const quotedElementName = quoteSqlId(elementName);
    if (duplicateChecker)
      duplicateChecker.addElement(quotedElementName, elm.$location, elementName);

    let result = `${env.indent + quotedElementName} ${renderTypeReference(artifactName, elementName, elm)
    }${renderNullability(elm, true)}`;
    if (elm.default)
      result += ` DEFAULT ${renderExpr(elm.default, env)}`;

    // Only HANA has fuzzy indices
    if (fzindex && options.toSql.dialect === 'hana')
      result += ` ${renderExpr(fzindex, env)}`;

    if (options.toSql.dialect === 'hana' && hasHanaComment(elm, options, env._artifact))
      result += ` COMMENT '${getHanaComment(elm)}'`;

    return result;
  }


  /**
   * Render an element 'elm' with name 'elementName' if it is an association, in the style required for
   * HANA native associations (e.g. 'MANY TO ONE JOIN "source" AS "assoc" ON (condition)').
   * Return a string with one line per association element, or an empty string if the element
   * is not an association.
   * Any change to the cardinality rendering must be reflected in A2J mapAssocToJoinCardinality() as well.
   *
   * @todo Duplicate check
   * @param {string} elementName Name of the element to render
   * @param {CSN.Element} elm CSN element
   * @param {object} env Render environment
   * @returns {string} Rendered association element
   */
  function renderAssociationElement(elementName, elm, env) {
    let result = '';
    if (elm.target) {
      result += env.indent;
      if (elm.cardinality) {
        if (isBetaEnabled(options, 'hanaAssocRealCardinality') && elm.cardinality.src && elm.cardinality.src === 1)
          result += 'ONE TO ';
        else
          result += 'MANY TO ';

        if (elm.cardinality.max && (elm.cardinality.max === '*' || Number(elm.cardinality.max) > 1))
          result += 'MANY';
        else
          result += 'ONE';
      }
      else {
        result += 'MANY TO ONE';
      }
      result += ' JOIN ';
      result += `${renderArtifactName(elm.target)} AS ${quoteSqlId(elementName)} ON (`;
      result += `${renderExpr(elm.on, env, true, true)})`;
    }
    return result;
  }


  /**
   * Render the 'technical configuration { ... }' section of an entity that comes as a suffix
   * to the CREATE TABLE statement (includes migration, unload prio, extended storage,
   * auto merge, partitioning, ...).
   * Return the resulting source string.
   *
   * @param {object} tc Technical configuration
   * @param {object} env Render environment
   * @returns {string} Rendered technical configuration
   */
  function renderTechnicalConfiguration(tc, env) {
    let result = '';

    if (!tc)
      return result;


    // FIXME: How to deal with non-HANA technical configurations?
    // This also affects renderIndexes
    tc = tc.hana;
    if (!tc)
      throw new Error('Expecting a HANA technical configuration');

    if (tc.tableSuffix) {
      // Although we could just render the whole bandwurm as one stream of tokens, the
      // compactor has kindly stored each part (e.g. `migration enabled` `row store`, ...)
      // in its own `xpr` (for the benefit of the `toCdl` renderer, which needs semicolons
      // between parts). We use this here for putting each one one line)

      // The ignore array contains technical configurations that are illegal in HANA SQL
      const ignore = [
        'PARTITION BY KEEPING EXISTING LAYOUT',
        'ROW STORE',
        'COLUMN STORE',
        'MIGRATION ENABLED',
        'MIGRATION DISABLED',
      ];
      for (const xpr of tc.tableSuffix) {
        const clause = renderExpr(xpr, env);
        if (!ignore.includes(clause.toUpperCase()))
          result += `\n${env.indent}${clause}`;
      }
    }
    return result;
  }

  /**
   * Render the array `indexes` from the technical configuration of an entity 'artifactName'
   *
   * @param {object} indexes Indices to render
   * @param {string} artifactName Artifact to render indices for
   * @param {object} resultObj Result collector
   * @param {object} env Render environment
   */
  function renderIndexesInto(indexes, artifactName, resultObj, env) {
    // Indices and full-text indices
    for (const idxName in indexes || {}) {
      let result = '';
      if (Array.isArray(indexes[idxName][0])) {
        // FIXME: Should we allow multiple indices with the same name at all? (last one wins)
        for (const index of indexes[idxName])
          result = renderExpr(insertTableName(index), env);
      }
      else {
        result = renderExpr(insertTableName(indexes[idxName]), env);
      }
      // FIXME: Full text index should already be different in compact CSN
      if (result.startsWith('FULLTEXT'))
        resultObj.hdbfulltextindex[`${artifactName}.${idxName}`] = result;

      else
        resultObj.hdbindex[`${artifactName}.${idxName}`] = result;
    }


    /**
     * Insert 'artifactName' (quoted according to naming style) into the index
     * definition 'index' in two places:
     *   CDS:  unique index            "foo" on             (x, y)
     * becomes
     *   SQL:  unique index "<artifact>.foo" on "<artifact>"(x, y)
     * CDS does not need this because the index lives inside the artifact, but SQL does.
     *
     * @param {Array} index Index definition
     * @returns {Array} Index with artifact name inserted
     */
    function insertTableName(index) {
      const i = index.indexOf('index');
      const j = index.indexOf('(');
      if (i > index.length - 2 || !index[i + 1].ref || j < i || j > index.length - 2)
        throw new Error(`Unexpected form of index: "${index}"`);

      let indexName = renderArtifactName(`${artifactName}.${index[i + 1].ref}`);
      if (options.toSql.names === 'plain')
        indexName = indexName.replace(/(\.|::)/g, '_');

      const result = index.slice(0, i + 1); // CREATE UNIQUE INDEX
      result.push({ ref: [ indexName ] }); // "<artifact>.foo"
      result.push(...index.slice(i + 2, j)); // ON
      result.push({ ref: [ renderArtifactName(artifactName) ] }); // <artifact>
      result.push(...index.slice(j)); // (x, y)
      return result;
    }
  }

  /**
   * Render the source of a query, which may be a path reference, possibly with an alias,
   * or a subselect, or a join operation. Use 'artifactName' only for error output.
   *
   * Returns the source as a string.
   *
   * @todo Misleading name, should be something like 'renderQueryFrom'. All the query parts should probably also be rearranged.
   * @param {string} artifactName Name of the artifact containing the query
   * @param {object} source Query source
   * @param {object} env Render environment
   * @returns {string} Rendered view source
   */
  function renderViewSource(artifactName, source, env) {
    // Sub-SELECT
    if (source.SELECT || source.SET) {
      let result = `(${renderQuery(artifactName, source, increaseIndent(env))})`;
      if (source.as)
        result += ` AS ${quoteSqlId(source.as)}`;

      return result;
    }
    // JOIN
    else if (source.join) {
      // One join operation, possibly with ON-condition
      let result = `${renderViewSource(artifactName, source.args[0], env)}`;
      for (let i = 1; i < source.args.length; i++) {
        result = `(${result} ${source.join.toUpperCase()} `;
        if (options.toSql.dialect === 'hana')
          result += renderJoinCardinality(source.cardinality);
        result += `JOIN ${renderViewSource(artifactName, source.args[i], env)}`;
        if (source.on)
          result += ` ON ${renderExpr(source.on, env, true, true)}`;

        result += ')';
      }
      return result;
    }
    // Ordinary path, possibly with an alias

    // Sanity check
    if (!source.ref)
      throw new Error(`Expecting ref in ${JSON.stringify(source)}`);

    return renderAbsolutePathWithAlias(artifactName, source, env);
  }

  /**
   * Render the cardinality of a join/association
   *
   * @param {object} card CSN cardinality representation
   * @returns {string} Rendered cardinality
   */
  function renderJoinCardinality(card) {
    let result = '';
    if (card) {
      if (card.srcmin && card.srcmin === 1)
        result += 'EXACT ';
      result += card.src && card.src === 1 ? 'ONE ' : 'MANY ';
      result += 'TO ';
      if (card.min && card.min === 1)
        result += 'EXACT ';
      if (card.max)
        result += (card.max === 1) ? 'ONE ' : 'MANY ';
    }
    return result;
  }


  /**
   * Render a path that starts with an absolute name (as used for the source of a query),
   * possibly with an alias, with plain or quoted names, depending on options. Expects an object 'path' that has a
   * 'ref' and (in case of an alias) an 'as'. If necessary, an artificial alias
   * is created to the original implicit name.  Use 'artifactName' only for error output.
   * Returns the name and alias as a string.
   *
   * @param {string} artifactName Name of the artifact containing the path - used for error output
   * @param {object} path Path to render
   * @param {object} env Render environment
   * @returns {string} Rendered path
   */
  function renderAbsolutePathWithAlias(artifactName, path, env) {
    // This actually can't happen anymore because assoc2joins should have taken care of it
    if (path.ref[0].where)
      throw new Error(`"${artifactName}": Filters in FROM are not supported for conversion to SQL`);


    // SQL needs a ':' after path.ref[0] to separate associations
    let result = renderAbsolutePath(path, ':', env);

    // Take care of aliases
    const implicitAlias = path.ref.length === 0 ? getLastPartOf(getResultingName(csn, options.toSql.names, path.ref[0])) : getLastPartOfRef(path.ref);
    if (path.as) {
      // Source had an alias - render it
      result += ` AS ${quoteSqlId(path.as)}`;
    }
    else {
      const quotedAlias = quoteSqlId(implicitAlias);
      if (getLastPartOf(result) !== quotedAlias) {
        // Render an artificial alias if the result would produce a different one
        result += ` AS ${quotedAlias}`;
      }
    }
    return result;
  }


  /**
   * Render a path that starts with an absolute name (as used e.g. for the source of a query),
   * with plain or quoted names, depending on options. Expects an object 'path' that has a 'ref'.
   * Uses <separator> (typically ':': or '.') to separate the first artifact name from any
   * subsequent associations.
   * Returns the name as a string.
   *
   * @param {object} path Path to render
   * @param {string} sep Separator between path steps
   * @param {object} env Render environment
   * @returns {string} Rendered path
   */
  function renderAbsolutePath(path, sep, env) {
    // Sanity checks
    if (!path.ref)
      throw new Error(`Expecting ref in path: ${JSON.stringify(path)}`);

    // Determine the absolute name of the first artifact on the path (before any associations or element traversals)
    const firstArtifactName = path.ref[0].id || path.ref[0];

    let result = renderArtifactName(firstArtifactName);
    // store argument syntax hint in environment
    // $syntax is set only by A2J and only at the first path step after FROM clause rewriting
    const syntax = path.ref[0].$syntax;
    // Even the first step might have parameters and/or a filter
    // Render the actual parameter list. If the path has no actual parameters,
    // the ref is not rendered as { id: ...; args: } but as short form of ref[0] ;)
    // An empty actual parameter list is rendered as `()`.
    const ref = csn.definitions[path.ref[0].id] || csn.definitions[path.ref[0]];
    if (ref && ref.params) {
      result += `(${renderArgs(path.ref[0] || {}, '=>', env, syntax)})`;
    }
    else if ([ 'udf' ].includes(syntax)) {
      // if syntax is user defined function, render empty argument list
      // CV without parameters is called as simple view
      result += '()';
    }
    if (path.ref[0].where)
      result += `[${path.ref[0].cardinality ? (`${path.ref[0].cardinality.max}: `) : ''}${renderExpr(path.ref[0].where, env, true, true)}]`;

    // Add any path steps (possibly with parameters and filters) that may follow after that
    if (path.ref.length > 1)
      result += `${sep}${renderExpr({ ref: path.ref.slice(1) }, env)}`;

    return result;
  }


  /**
   * Render function arguments or view parameters (positional if array, named if object/dict),
   * using 'sep' as separator for positional parameters
   *
   * @param {object} node with `args` to render
   * @param {string} sep Separator between args
   * @param {object} env Render environment
   * @param {string} syntax Some magic A2J paramter - for calcview parameter rendering
   * @returns {string} Rendered arguments
   * @throws Throws if args is not an array or object.
   */
  function renderArgs(node, sep, env, syntax) {
    const args = node.args ? node.args : {};
    // Positional arguments
    if (Array.isArray(args))
      return args.map(arg => renderExpr(arg, env)).join(', ');

    // Named arguments (object/dict)
    else if (typeof args === 'object')
      // if this is a function param which is not a reference to the model, we must not quote it
      return Object.keys(args).map(key => `${node.func ? key : decorateParameter(key, syntax)} ${sep} ${renderExpr(args[key], env)}`).join(', ');


    throw new Error(`Unknown args: ${JSON.stringify(args)}`);


    /**
     * Render the given argument/parameter correctly.
     *
     * @param {string} arg Argument to render
     * @param {string} syntax Some magic A2J paramter - for calcview parameter rendering
     * @returns {string} Rendered argument
     */
    function decorateParameter(arg, syntax) {
      if (syntax === 'calcview')
        return `PLACEHOLDER."$$${arg}$$"`;


      return quoteSqlId(arg);
    }
  }

  /**
   * Render a single view column 'col', as it occurs in a select list or projection list.
   * Return the resulting source string (one line per column item, no CR).
   *
   * @param {object} col Column to render
   * @param {object} env Render environment
   * @returns {string} Rendered column
   */
  function renderViewColumn(col, env) {
    let result = '';
    const leaf = col.as || col.ref && col.ref[col.ref.length - 1] || col.func;
    if (leaf && env._artifact.elements[leaf] && env._artifact.elements[leaf].virtual) {
      if (isDeprecatedEnabled(options, 'renderVirtualElements'))
        // render a virtual column 'null as <alias>'
        result += `${env.indent}NULL AS ${quoteSqlId(col.as || leaf)}`;
    }
    else {
      result = env.indent + renderExpr(col, env, true);
      if (col.as)
        result += ` AS ${quoteSqlId(col.as)}`;
      else if (col.func)
        result += ` AS ${quoteSqlId(col.func)}`;
    }
    return result;
  }

  /**
   * Render a view
   *
   * @param {string} artifactName Name of the view
   * @param {CSN.Artifact} art CSN view
   * @param {object} env Render environment
   * @returns {string} Rendered view
   */
  function renderView(artifactName, art, env) {
    env._artifact = art;
    const viewName = renderArtifactName(artifactName);
    definitionsDuplicateChecker.addArtifact(art['@cds.persistence.name'], art && art.$location, artifactName);
    let result = `VIEW ${viewName}`;

    if (options.toSql.dialect === 'hana' && hasHanaComment(art, options, art))
      result += ` COMMENT '${getHanaComment(art)}'`;

    result += renderParameterDefinitions(artifactName, art.params);
    result += ` AS ${renderQuery(artifactName, getNormalizedQuery(art).query, env)}`;

    const childEnv = increaseIndent(env);
    const associations = Object.keys(art.elements).filter(name => !!art.elements[name].target)
      .map(name => renderAssociationElement(name, art.elements[name], childEnv))
      .filter(s => s !== '')
      .join(',\n');
    if (associations !== '' && options.toSql.dialect === 'hana') {
      result += `${env.indent}\nWITH ASSOCIATIONS (\n${associations}\n`;
      result += `${env.indent})`;
    }

    return result;
  }

  /**
   * Render the parameter definition of a view if any. Return the parameters in parentheses, or an empty string
   *
   * @param {string} artifactName Name of the view
   * @param {Array} params Array of parameters
   * @returns {string} Rendered parameters
   */
  function renderParameterDefinitions(artifactName, params) {
    let result = '';
    if (params) {
      const parray = [];
      for (const pn in params) {
        const p = params[pn];
        if (p.notNull === true || p.notNull === false)
          info(null, [ 'definitions', artifactName, 'params', pn ], 'Not Null constraints on SQL view parameters are not allowed and are ignored');
        // do not quote parameter identifiers for naming mode "quoted" / "hdbcds"
        // this would be an incompatible change, as non-uppercased, quoted identifiers
        // are rejected by the HANA compiler.
        let pIdentifier;
        if (options.toSql.names === 'quoted' || options.toSql.names === 'hdbcds')
          pIdentifier = prepareIdentifier(pn);
        else
          pIdentifier = quoteSqlId(pn);
        let pstr = `IN ${pIdentifier} ${renderTypeReference(artifactName, pn, p)}`;
        if (p.default)
          pstr += ` DEFAULT ${renderExpr(p.default)}`;

        parray.push(pstr);
      }
      result = `(${parray.join(', ')})`;
    }
    return result;
  }

  /**
   * Render a query 'query', i.e. a select statement with where-condition etc. Use 'artifactName' only for error messages.
   *
   * @param {string} artifactName Artifact containing the query
   * @param {CSN.Query} query CSN query
   * @param {object} env Render environment
   * @returns {string} Rendered query
   */
  function renderQuery(artifactName, query, env) {
    let result = '';
    // Set operator, like UNION, INTERSECT, ...
    if (query.SET) {
      result += query.SET.args
        .map((arg) => {
          // Wrap each query in the SET in parentheses that
          // - is a SET itself (to preserve precedence between the different SET operations),
          // - has an ORDER BY/LIMIT (because UNION etc. can't stand directly behind an ORDER BY)
          const queryString = renderQuery(artifactName, arg, env);
          return (arg.SET || arg.SELECT && (arg.SELECT.orderBy || arg.SELECT.limit)) ? `(${queryString})` : queryString;
        })
        .join(`\n${env.indent}${query.SET.op && query.SET.op.toUpperCase()}${query.SET.all ? ' ALL ' : ' '}`);
      // Set operation may also have an ORDER BY and LIMIT/OFFSET (in contrast to the ones belonging to
      // each SELECT)
      // If the whole SET has an ORDER BY/LIMIT, wrap the part before that in parentheses
      // (otherwise some SQL implementations (e.g. sqlite) would interpret the ORDER BY/LIMIT as belonging
      // to the last SET argument, not to the whole SET)
      if (query.SET.orderBy || query.SET.limit) {
        result = `(${result})`;
        if (query.SET.orderBy)
          result += `\n${env.indent}ORDER BY ${query.SET.orderBy.map(entry => renderOrderByEntry(entry, env)).join(', ')}`;

        if (query.SET.limit)
          result += `\n${env.indent}${renderLimit(query.SET.limit, env)}`;
      }
      return result;
    }
    // Otherwise must have a SELECT
    else if (!query.SELECT) {
      throw new Error(`Unexpected query operation ${JSON.stringify(query)}`);
    }
    const select = query.SELECT;
    const childEnv = increaseIndent(env);
    result += `SELECT${select.distinct ? ' DISTINCT' : ''}`;
    // FIXME: We probably also need to consider `excluding` here ?
    result += `\n${(select.columns || [ '*' ])
      .filter(col => !(select.mixin || Object.create(null))[firstPathStepId(col.ref)]) // No mixin columns
      .map(col => renderViewColumn(col, childEnv))
      .filter(s => s !== '')
      .join(',\n')}\n`;
    result += `${env.indent}FROM ${renderViewSource(artifactName, select.from, env)}`;
    if (select.where)
      result += `\n${env.indent}WHERE ${renderExpr(select.where, env, true, true)}`;

    if (select.groupBy)
      result += `\n${env.indent}GROUP BY ${select.groupBy.map(expr => renderExpr(expr, env)).join(', ')}`;

    if (select.having)
      result += `\n${env.indent}HAVING ${renderExpr(select.having, env, true, true)}`;

    if (select.orderBy)
      result += `\n${env.indent}ORDER BY ${select.orderBy.map(entry => renderOrderByEntry(entry, env)).join(', ')}`;

    if (select.limit)
      result += `\n${env.indent}${renderLimit(select.limit, env)}`;

    return result;
  }

  /**
   * Returns the id of the first path step in 'ref' if any, otherwise undefined
   *
   * @param {Array} ref Array of refs
   * @returns {string|undefined} Id of first path step
   */
  function firstPathStepId(ref) {
    return ref && ref[0] && (ref[0].id || ref[0]);
  }

  /**
   * Render a query's LIMIT clause, which may have also have OFFSET.
   *
   * @param {CSN.QueryLimit} limit Limit clause
   * @param {object} env Renderenvironment
   * @returns {string} Rendered LIMIT clause
   */
  function renderLimit(limit, env) {
    let result = '';
    if (limit.rows !== undefined)
      result += `LIMIT ${renderExpr(limit.rows, env)}`;

    if (limit.offset !== undefined)
      result += `${result !== '' ? `\n${env.indent}` : ''}OFFSET ${renderExpr(limit.offset, env)}`;

    return result;
  }

  /**
   * Render one entry of a query's ORDER BY clause (which always has a 'value' expression, and may
   * have a 'sort' property for ASC/DESC and a 'nulls' for FIRST/LAST
   *
   * @param {object} entry Part of an ORDER BY
   * @param {object} env Render environment
   * @returns {string} Rendered ORDER BY entry
   */
  function renderOrderByEntry(entry, env) {
    let result = renderExpr(entry, env);
    if (entry.sort)
      result += ` ${entry.sort.toUpperCase()}`;

    if (entry.nulls)
      result += ` NULLS ${entry.nulls.toUpperCase()}`;

    return result;
  }

  /**
   * Render a reference to the type used by 'elm' (with name 'elementName' in 'artifactName', both used only for error messages).
   *
   * @param {string} artifactName Artifact containing the element
   * @param {string} elementName Element referencing the type
   * @param {CSN.Element} elm CSN element
   * @returns {string} Rendered type reference
   */
  function renderTypeReference(artifactName, elementName, elm) {
    let result = '';

    // Anonymous structured type: Not supported with SQL (but shouldn't happen anyway after forHana flattened them)
    if (!elm.type) {
      if (!elm.elements)
        throw new Error(`Missing type of: ${elementName}`);

      // TODO: Signal is not covered by tests + better location
      error(null, [ 'definitions', artifactName, 'elements', elementName ],
            'Anonymous structured types are not supported for conversion to SQL');
      return result;
    }

    // Association type
    if (elm.target) {
      // TODO: Signal is not covered by tests + better location
      // We can't do associations yet
      error(null, [ 'definitions', artifactName, 'elements', elementName ],
            'Association and composition types are not yet supported for conversion to SQL');
      return result;
    }

    // If we get here, it must be a primitive (i.e. builtin) type
    if (isBuiltinType(elm.type)) {
      // cds.Integer => render as INTEGER (no quotes)
      result += renderBuiltinType(elm.type);
    }
    else {
      throw new Error(`Unexpected non-primitive type of: ${artifactName}.${elementName}`);
    }
    result += renderTypeParameters(elm);
    return result;
  }


  /**
   * Render the name of a builtin CDS type
   *
   * @param {string} typeName Name of the type
   * @returns {string} Rendered type
   */
  function renderBuiltinType(typeName) {
    const forHanaRenamesToEarly = {
      'cds.UTCDateTime': 'cds.DateTime',
      'cds.UTCTimestamp': 'cds.Timestamp',
      'cds.LocalDate': 'cds.Date',
      'cds.LocalTime': 'cds.Time',
    };
    const tName = forHanaRenamesToEarly[typeName] || typeName;
    const types = cdsToSqlTypes[options.toSql.dialect];
    return types && types[tName] || cdsToSqlTypes.standard[tName] || 'CHAR';
  }

  /**
   * Render the nullability of an element or parameter (can be unset, true, or false)
   *
   * @param {object} obj Object to render for
   * @param {boolean} treatKeyAsNotNull Wether to render KEY as not null
   * @returns {string} NULL/NOT NULL or ''
   */
  function renderNullability(obj, treatKeyAsNotNull = false) {
    if (obj.notNull === undefined && !(obj.key && treatKeyAsNotNull)) {
      // Attribute not set at all
      return '';
    }
    return obj.notNull || obj.key ? ' NOT NULL' : ' NULL';
  }

  /**
   * Render (primitive) type parameters of element 'elm', i.e.
   * length, precision and scale (even if incomplete), plus any other unknown ones.
   *
   * @param {CSN.Element} elm CSN element
   * @returns {string} Rendered type parameters
   */
  function renderTypeParameters(elm) {
    const params = [];
    // Length, precision and scale (even if incomplete)
    if (elm.length !== undefined)
      params.push(elm.length);

    if (elm.precision !== undefined)
      params.push(elm.precision);

    if (elm.scale !== undefined)
      params.push(elm.scale);

    if (elm.srid !== undefined) {
      // SAP HANA Geometry types translate into CHAR in plain/sqlite (give them the default length of 2000)
      if (options.toSql.dialect !== 'hana')
        params.push(2000);
      else
        params.push(elm.srid);
    }
    return params.length === 0 ? '' : `(${params.join(', ')})`;
  }

  /**
   * Render an expression (including paths and values) or condition 'x'.
   * (no trailing LF, don't indent if inline)
   *
   * @todo Reuse this with toCdl
   * @param {Array|object|string} x Expression to render
   * @param {object} env Render environment
   * @param {boolean} inline Wether to render the expression inline
   * @param {boolean} nestedExpr Wether to treat the expression as nested
   * @returns {string} Rendered expression
   */
  function renderExpr(x, env, inline = true, nestedExpr = false) {
    // Compound expression
    if (Array.isArray(x)) {
      const tokens = x.map(item => renderExpr(item, env, inline, nestedExpr));
      return beautifyExprArray(tokens);
    }
    else if (typeof x === 'object' && x !== null) {
      if (nestedExpr && x.cast && x.cast.type)
        return renderExplicitTypeCast(renderExprObject());
      return renderExprObject();
    }
    // Not a literal value but part of an operator, function etc - just leave as it is
    // FIXME: For the sake of simplicity, we should get away from all this uppercasing in toSql

    return String(x).toUpperCase();


    /**
     * Various special cases represented as objects
     *
     * @returns {string} String representation of the expression
     */
    function renderExprObject() {
      if (x.list) {
        return `(${x.list.map(item => renderExpr(item)).join(', ')})`;
      }
      else if (x.val !== undefined) {
        return renderExpressionLiteral(x);
      }
      // Enum symbol
      else if (x['#']) {
        // #foo
        // TODO: Signal is not covered by tests + better location
        // FIXME: We can't do enums yet because they are not resolved (and we don't bother finding their value by hand)
        error(null, x.$location, 'Enum values are not yet supported for conversion to SQL');
        return '';
      }
      // Reference: Array of path steps, possibly preceded by ':'
      else if (x.ref) {
        return renderExpressionRef(x);
      }
      // Function call, possibly with args (use '=>' for named args)
      else if (x.func) {
        const funcName = smartFuncId(prepareIdentifier(x.func), options.toSql.dialect);
        return renderFunc(funcName, x, options.toSql.dialect, a => renderArgs(a, '=>', env, null));
      }
      // Nested expression
      else if (x.xpr) {
        if (nestedExpr && !x.cast)
          return `(${renderExpr(x.xpr, env, inline, true)})`;

        return renderExpr(x.xpr, env, inline, true);
      }
      // Sub-select
      else if (x.SELECT) {
        // renderQuery for SELECT does not bring its own parentheses (because it is also used in renderView)
        return `(${renderQuery('<subselect>', x, increaseIndent(env))})`;
      }
      else if (x.SET) {
        // renderQuery for SET always brings its own parentheses (because it is also used in renderViewSource)
        return `${renderQuery('<union>', x, increaseIndent(env))}`;
      }

      throw new Error(`Unknown expression: ${JSON.stringify(x)}`);
    }

    function renderExpressionLiteral(x) {
      // Literal value, possibly with explicit 'literal' property
      switch (x.literal || typeof x.val) {
        case 'number':
        case 'boolean':
        case 'null':
          // 17.42, NULL, TRUE
          return String(x.val).toUpperCase();
        case 'x':
          // x'f000'
          return `${x.literal}'${x.val}'`;
        case 'date':
        case 'time':
        case 'timestamp':
          if (options.toSql.dialect === 'sqlite') {
            // simple string literal '2017-11-02'
            return `'${x.val}'`;
          }
          // date'2017-11-02'
          return `${x.literal}'${x.val}'`;

        case 'string':
          // 'foo', with proper escaping
          return `'${x.val.replace(/'/g, '\'\'')}'`;
        case 'object':
          if (x.val === null)
            return 'NULL';

        // otherwise fall through to
        default:
          throw new Error(`Unknown literal or type: ${JSON.stringify(x)}`);
      }
    }

    function renderExpressionRef(x) {
      if (!x.param && !x.global) {
        if (x.ref[0] === '$user') {
          const result = render$user(x);
          // Invalid second path step doesn't cause a return
          if (result)
            return result;
        }
        else if (x.ref[0] === '$at') {
          const result = render$at(x);
          // Invalid second path step doesn't cause a return
          if (result)
            return result;
        }
      }
      // FIXME: We currently cannot distinguish whether '$parameters' was quoted or not - we
      // assume that it was not if the path has length 2 (
      if (firstPathStepId(x.ref) === '$parameters' && x.ref.length === 2) {
        // Parameters must be uppercased and unquoted in SQL
        return `:${x.ref[1].toUpperCase()}`;
      }
      if (x.param)
        return `:${x.ref[0].toUpperCase()}`;

      return x.ref.map(renderPathStep)
        .filter(s => s !== '')
        .join('.');
    }

    /**
     * @param {object} x
     * @returns {string|null} Null in case of an invalid second path step
     */
    function render$user(x) {
      // FIXME: this is all not enough: we might need an explicit select item alias
      if (x.ref[1] === 'id') {
        if (options.toSql.user && typeof options.toSql.user === 'string' || options.toSql.user instanceof String)
          return `'${options.toSql.user}'`;

        else if ((options.toSql.user && options.toSql.user.id) && (typeof options.toSql.user.id === 'string' || options.toSql.user.id instanceof String))
          return `'${options.toSql.user.id}'`;

        if (options.toSql.dialect === 'sqlite' || options.toSql.dialect === 'plain') {
          warning(null, null, 'The "$user" variable is not supported. Use the "toSql.user" option to set a value for "$user.id"');
          return '\'$user.id\'';
        }
        return 'SESSION_CONTEXT(\'APPLICATIONUSER\')';
      }
      else if (x.ref[1] === 'locale') {
        if (options.toSql.dialect === 'sqlite' || options.toSql.dialect === 'plain') {
          return (options.toSql.user && options.toSql.user.locale)
            ? `'${options.toSql.user && options.toSql.user.locale}'` : '\'en\'';
        }
        return 'SESSION_CONTEXT(\'LOCALE\')';
      }
      // Basically: Second path step was invalid, do nothing
      return null;
    }
    /**
     * For a given reference starting with $at, render a 'current_timestamp' literal for plain.
     * For the sql-dialect hana, we render the TO_TIMESTAMP(SESSION_CONTEXT(..)) function.
     *
     *
     * For sqlite, we render the string-format-time (strftime) function.
     * Because the format of `current_timestamp` is like that: '2021-05-14 09:17:19' whereas
     * the format for TimeStamps (at least in Node.js) is like that: '2021-01-01T00:00:00.000Z'
     * --> Therefore the comparison in the temporal where clause doesn't work properly.
     *
     * @param {object} x
     * @returns {string|null} Null in case of an invalid second path step
     */
    function render$at(x) {
      if (x.ref[1] === 'from') {
        switch (options.toSql.dialect) {
          case 'sqlite': {
            const dateFromFormat = '%Y-%m-%dT%H:%M:%S.000Z';
            return `strftime('${dateFromFormat}', 'now')`;
          }
          case 'hana':
            return 'TO_TIMESTAMP(SESSION_CONTEXT(\'VALID-FROM\'))';
          case 'plain':
            return 'current_timestamp';
          default:
            break;
        }
      }

      if (x.ref[1] === 'to') {
        switch (options.toSql.dialect) {
          case 'sqlite': {
            // + 1ms compared to $at.from
            const dateToFormat = '%Y-%m-%dT%H:%M:%S.001Z';
            return `strftime('${dateToFormat}', 'now')`;
          }
          case 'hana':
            return 'TO_TIMESTAMP(SESSION_CONTEXT(\'VALID-TO\'))';
          case 'plain':
            return 'current_timestamp';
          default:
            break;
        }
      }
      return null;
    }

    /**
     * Renders an explicit `cast()` inside an 'xpr'.
     *
     * @param {string} value Value to cast
     * @returns {string} CAST statement
     */
    function renderExplicitTypeCast(value) {
      const typeRef = renderBuiltinType(x.cast.type) + renderTypeParameters(x.cast);
      return `CAST(${value} AS ${typeRef})`;
    }

    /**
     * Render a single path step 's' at path position 'idx', which can have filters or parameters or be a function
     *
     * @param {string|object} s Path step to render
     * @param {number} idx index of the path step in the overall path
     * @returns {string} Rendered path step
     */
    function renderPathStep(s, idx) {
      // Simple id or absolute name
      if (typeof (s) === 'string') {
        // TODO: When is this actually executed and not handled already in renderExpr?
        const magicForHana = {
          $now: 'CURRENT_TIMESTAMP',
          '$user.id': 'SESSION_CONTEXT(\'APPLICATIONUSER\')',
          '$user.locale': 'SESSION_CONTEXT(\'LOCALE\')',
        };
        // Some magic for first path steps
        if (idx === 0) {
          // HANA-specific translation of '$now' and '$user'
          // FIXME: this is all not enough: we might need an explicit select item alias
          if (magicForHana[s])
            return magicForHana[s];

          // Ignore initial $projection and initial $self
          if (s === '$projection' || s === '$self')
            return '';
        }
        return quoteSqlId(s);
      }
      // ID with filters or parameters
      else if (typeof s === 'object') {
        // Sanity check
        if (!s.func && !s.id)
          throw new Error(`Unknown path step object: ${JSON.stringify(s)}`);

        // Not really a path step but an object-like function call
        if (s.func)
          return `${s.func}(${renderArgs(s, '=>', env, null)})`;

        // Path step, possibly with view parameters and/or filters
        let result = `${quoteSqlId(s.id)}`;
        if (s.args) {
          // View parameters
          result += `(${renderArgs(s, '=>', env, null)})`;
        }
        if (s.where) {
          // Filter, possibly with cardinality
          // FIXME: Does SQL understand filter cardinalities?
          result += `[${s.cardinality ? (`${s.cardinality.max}: `) : ''}${renderExpr(s.where, env, true, true)}]`;
        }
        return result;
      }

      throw new Error(`Unknown path step: ${JSON.stringify(s)}`);
    }
  }

  /**
   * Returns a copy of 'env' with increased indentation
   *
   * @param {object} env Render environment
   * @returns {object} Render environment with increased indent
   */
  function increaseIndent(env) {
    return Object.assign({}, env, { indent: `${env.indent}  ` });
  }
}

module.exports = {
  toSqlDdl,
};
