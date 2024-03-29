// Common render functions for toCdl.js, toHdbcds.js and toSql.js

'use strict';

const functionsWithoutParams = {
  hana: {
    CURRENT_CONNECTION: {},
    CURRENT_SCHEMA: {},
    CURRENT_TRANSACTION_ISOLATION_LEVEL: {},
    CURRENT_UTCDATE: {},
    CURRENT_UTCTIME: {},
    CURRENT_UTCTIMESTAMP: {},
    SYSUUID: {},
  },
};

const {
  hasValidSkipOrExists, forEachDefinition, getNamespace, getUnderscoredName,
} = require('../../model/csnUtils');

const { implicitAs } = require('../../model/csnRefs');


/**
 * Render the given function
 *
 * @param {string} funcName Name of the function
 * @param {object} node Content of the function
 * @param {string} dialect One of 'hana', 'cap' or 'sqlite' - only 'hana' is relevant atm
 * @param {(a: string) => string} renderArgs Function to render function arguments
 * @returns {string} Function string
 */
function renderFunc( funcName, node, dialect, renderArgs) {
  if (funcWithoutParen( node, dialect ))
    return funcName;
  return `${funcName}(${renderArgs( node )})`;
}

/**
 * Checks wether the given function is to be rendered without parentheses
 *
 * @param {object} node Content of the function
 * @param {string} dialect One of 'hana', 'cap' or 'sqlite' - only 'hana' is relevant atm
 * @returns {boolean} True if without
 */
function funcWithoutParen( node, dialect ) {
  if (!node.args)
    return true;
  if (!Array.isArray( node.args ) || node.args.length)
    return false;
  const specials = functionsWithoutParams[dialect];
  return specials && specials[node.func.toUpperCase()];
}

/**
 * Process already rendered expression parts by joining them nicely
 *
 * @param {Array} tokens Array of expression tokens
 *
 * @returns {string} The rendered xpr
 */
function beautifyExprArray(tokens) {
  // Simply concatenate array parts with spaces (with a tiny bit of beautification)
  let result = '';
  for (let i = 0; i < tokens.length; i++) {
    result += tokens[i];
    // No space after last token, after opening parentheses, before closing parentheses, before comma
    if (i !== tokens.length - 1 && tokens[i] !== '(' && ![ ')', ',' ].includes(tokens[i + 1]))
      result += ' ';
  }
  return result;
}


/**
 * Get the part that is really the name of this artifact and not just prefix caused by a context/service
 *
 * @param {CSN.Model} csn CSN model
 * @param {string} artifactName Artifact name to use
 * @returns {string} non-prefix part of the artifact name
 */
function getRealName(csn, artifactName) {
  const parts = artifactName.split('.');
  // Length of 1 -> There can be no prefix
  if (parts.length === 1)
    return artifactName;


  const namespace = getNamespace(csn, artifactName);
  const startIndex = namespace ? namespace.split('.').length : 0;
  let indexOfLastParent = startIndex;
  const realParts = getUnderscoredName(startIndex, parts, csn);
  if (realParts)
    return realParts[realParts.length - 1];
  // With this loop, we find the name if the art is part of a context
  for (let i = startIndex; i < parts.length; i++) {
    const possibleParentName = parts.slice(0, i).join('.');
    const art = csn.definitions[possibleParentName];

    if (art && art.kind !== 'context' && art.kind !== 'service')
      return parts.slice(i).join('_');
    else if (art && (art.kind === 'context' || art.kind === 'service'))
      indexOfLastParent = i;
  }

  // With this, we find the name if it is shadowed by another definition or similar
  return parts.slice(indexOfLastParent, parts.length).join('.');
}

/**
   * For given artifact, return the name of the topmost context it is contained in (if any).
   *
   * Given context A and artifact A.B.C (with no context A.B) -> return A.
   *
   * Given context Namespace.A and artifact Namespace.A.B.C -> return Namespace.A.
   *
   * Given entity A and artifact
   *
   * @param {string} artifactName Name of the artifact to check for
   * @returns {string | null} Name of the topmost context or null
   */
function getParentContextName(csn, artifactName) {
  const parts = artifactName.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const name = parts.slice(0, i).join('.');
    const art = csn.definitions[name];

    if (art && (art.kind === 'context' || art.kind === 'service'))
      return name;
  }

  return null;
}

/**
 * If there is a namespace A.B.C, create context A and a context A.B.C.
 *
 * Context A.B will be created by addIntermediateContexts
 *
 * @param {Function[]} killList Array to add cleanup functions to
 */
function addContextMarkers(csn, killList) {
  const contextsToCreate = Object.create(null);
  forEachDefinition(csn, (art, artifactName) => {
    const namespace = getNamespace(csn, artifactName);
    if (namespace && !(art._ignore || hasValidSkipOrExists(art))) {
      const parts = namespace.split('.');
      contextsToCreate[parts[0]] = true;

      if (parts.length > 1)
        contextsToCreate[namespace] = true;
    }
  });

  Object.keys(contextsToCreate).forEach((contextName) => {
    if (!csn.definitions[contextName]) {
      csn.definitions[contextName] = {
        kind: 'context',
      };
      killList.push(() => delete csn.definitions[contextName]);
    }
  });
}


/**
  * For the given parent context and the current context, calculate all missing intermediate context names.
  * I.e. all the artifact names inbetween, that do not have a csn.definition.
  *
  * A and A.B.C.D -> A.B and A.B.C are possible candidates
  *
  *
  * @param {string} parentName Name of the parent context
  * @param {string} artifactName Name of the current context
  * @returns {string[]} All possible context names inbetween
  */
function getIntermediateContextNames(csn, parentName, artifactName) {
  const parentLength = parentName.split('.').length;
  const parts = artifactName.split('.');
  const names = [];
  for (let i = parentLength + 1; i < parts.length; i++) {
    const name = parts.slice(0, i).join('.');
    const art = csn.definitions[name];

    if (!art)
      names.push(name);
  }

  return names;
}

/**
 * For context A and entity A.B.C, create context A.B
 *
 * @param {CSN.Model} csn
 * @param {string} artifactName
 * @param {Function[]} killList Array to add cleanup functions to
 */
function addMissingChildContexts(csn, artifactName, killList) {
  // Get all other definitions sharing the same prefix, sorted by shortest first
  const possibleNames = Object.keys(csn.definitions).filter(name => name.startsWith(`${artifactName}.`)).sort((a, b) => a.length - b.length);
  for (const name of possibleNames) {
    const artifact = csn.definitions[name];
    if (!artifact._ignore && !hasValidSkipOrExists(artifact))
      addPossibleGaps(name.slice(artifactName.length + 1).split('.'), artifactName);
  }

  function addPossibleGaps(possibleGaps, artifactName) {
    let possibleGap = artifactName;
    for (const gap of possibleGaps) {
      possibleGap += `.${gap}`;
      if (!csn.definitions[possibleGap]) {
        const contextName = possibleGap;
        csn.definitions[contextName] = {
          kind: 'context',
        };
        killList.push(() => delete csn.definitions[contextName]);
      }
      else {
        return;
      }
    }
  }
}

// Type mapping from cds type names to DB type names:
// (in the future, we would introduce an option for the mapping table)
const cdsToSqlTypes = {
  standard: {
    // characters and binaries
    'cds.String': 'NVARCHAR',
    'cds.hana.NCHAR': 'NCHAR',
    'cds.LargeString': 'NCLOB',
    'cds.hana.VARCHAR': 'VARCHAR',
    'cds.hana.CHAR': 'CHAR',
    'cds.hana.CLOB': 'CLOB',
    'cds.Binary': 'VARBINARY',  // not a Standard SQL type, but HANA and MS SQL Server
    'cds.hana.BINARY': 'BINARY',
    'cds.LargeBinary': 'BLOB',
    // numbers: exact and approximate
    'cds.Decimal': 'DECIMAL',
    'cds.DecimalFloat': 'DECIMAL',
    'cds.Integer64': 'BIGINT',
    'cds.Integer': 'INTEGER',
    'cds.hana.SMALLINT': 'SMALLINT',
    'cds.hana.TINYINT': 'TINYINT', // not a Standard SQL type
    'cds.Double': 'DOUBLE',
    'cds.hana.REAL': 'REAL',
    // other: date/time, boolean
    'cds.Date': 'DATE',
    'cds.Time': 'TIME',
    'cds.DateTime': 'TIMESTAMP', // cds-compiler#2758
    'cds.Timestamp': 'TIMESTAMP',
    'cds.Boolean': 'BOOLEAN',
    'cds.UUID': 'NVARCHAR',  // changed to cds.String earlier
    // (TODO: do it later; TODO: why not CHAR or at least VARCHAR?)
  },
  hana: {
    'cds.hana.SMALLDECIMAL': 'SMALLDECIMAL',
    'cds.LocalDate': 'DATE',
    'cds.LocalTime': 'TIME',
    'cds.DateTime': 'SECONDDATE',
    'cds.UTCDateTime': 'SECONDDATE',
    'cds.UTCTimestamp': 'TIMESTAMP',
    'cds.hana.ST_POINT': 'ST_POINT',
    'cds.hana.ST_GEOMETRY': 'ST_GEOMETRY',
  },
  sqlite: {
    'cds.Date': 'DATE_TEXT',
    'cds.Time': 'TIME_TEXT',
    'cds.Timestamp': 'TIMESTAMP_TEXT',
    'cds.DateTime': 'TIMESTAMP_TEXT',
    'cds.Binary': 'BINARY_BLOB',
    'cds.hana.BINARY': 'BINARY_BLOB',
    'cds.hana.SMALLDECIMAL': 'SMALLDECIMAL',
  },
  plain: {
    'cds.Binary': 'VARBINARY',
    'cds.hana.BINARY': 'BINARY',
    'cds.hana.SMALLDECIMAL': 'DECIMAL',
  },
};

/**
   * Get the element matching the column
   *
   * @param {CSN.Elements} elements Elements of a query
   * @param {CSN.Column} column Column from the same query
   * @returns {CSN.Element}
   */
function findElement(elements, column) {
  if (!elements)
    return undefined;
  if (column.as)
    return elements[column.as];
  else if (column.ref)
    return elements[implicitAs(column.ref)];
  else if (column.func)
    return elements[column.func];

  return undefined;
}

/**
  * If there is a context A and a context A.B.C without a definition A.B, create an
  * intermediate context A.B to keep the context hierarchy intact.
  *
  * @param {Function[]} killList Array to add cleanup functions to
  */
function addIntermediateContexts(csn, killList) {
  for (const artifactName in csn.definitions) {
    const artifact = csn.definitions[artifactName];
    if ((artifact.kind === 'context') && !artifact._ignore) {
      // If context A.B.C and entity A exist, we still need generate context A_B.
      // But if no entity A exists, A.B is just a namespace.
      // For case 1 and 2, getParentContextName returns undefined - we then use the namespace as our "off-limits"
      // starting point for finding the intermediates.
      const parentContextName = getParentContextName(csn, artifactName) || getNamespace(csn, artifactName) || '';

      getIntermediateContextNames(csn, parentContextName, artifactName).forEach((name) => {
        if (!csn.definitions[name]) {
          csn.definitions[name] = {
            kind: 'context',
          };
          killList.push(() => delete csn.definitions[name]);
        }
      });

      addMissingChildContexts(csn, artifactName, killList);
    }
  }
}

/**
 * Check wether the given artifact or element has a comment that needs to be rendered.
 * Things annotated with @cds.persistence.journal (for HANA SQL), should not get a comment.
 *
 * @param {CSN.Artifact} obj
 * @param {CSN.Options} options To check for `disableHanaComments`
 * @returns {boolean}
 */
function hasHanaComment(obj, options) {
  return !options.disableHanaComments && typeof obj.doc === 'string';
}
/**
   * Return the comment of the given artifact or element.
   * Uses the first block (everything up to the first empty line (double \n)).
   * Remove leading/trailing whitespace.
   *
   * @param {CSN.Artifact|CSN.Element} obj
   * @returns {string}
   * @todo Warning/info to user?
   */
function getHanaComment(obj) {
  return obj.doc.split('\n\n')[0].trim().replace(/'/g, "''");
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

module.exports = {
  renderFunc,
  beautifyExprArray,
  getNamespace,
  getRealName,
  addIntermediateContexts,
  addContextMarkers,
  cdsToSqlTypes,
  hasHanaComment,
  getHanaComment,
  findElement,
  funcWithoutParen,
};
