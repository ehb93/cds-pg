
'use strict';

const { CompilationError, hasErrors } = require('../base/messages');
const { checkCSNVersion } = require('../json/csnVersion');
const { getUtils } = require('../model/csnUtils');

// FIXME: This is not up-to-date in regards to the changes to hdbcds/sql quoting etc.

/**
 *
 * Render the augmented CSN 'model' to SQL DDL statements renaming existing tables and their
 * columns so that they match the result of "toHana" or "toSql" with the 'plain' option for names.
 * Expects the naming convention of the existing tables to be either 'quoted' or 'hdbcds' (default).
 * The following options control what is actually generated:
 *   options : {
 *     toRename.names      :  existing names, either 'quoted' or 'hdbcds' (default)
 *   }
 * Return a dictionary of top-level artifacts by their names, like this:
 * { "foo" : "RENAME TABLE \"foo\" ...",
 *   "bar::wiz" : "RENAME VIEW \"bar::wiz\" ..."
 * }
 *
 * @todo clarify input parameters
 * @param {CSN.Model} csn Augmented csn?
 * @param {CSN.Options} options Transformation options
 * @returns {object} A dictionary of name: rename statement
 */
function toRenameDdl(csn, options) {
  // Merge options (arguments first, then model options and default)
  const result = Object.create(null);

  checkCSNVersion(csn, options);

  const { getNamespaceOfArtifact } = getUtils(csn);
  // Render each artifact on its own
  for (const artifactName in csn.definitions) {
    const sourceStr = renameTableAndColumns(artifactName, csn.definitions[artifactName]);

    if (sourceStr !== '')
      result[artifactName] = sourceStr;
  }
  // Throw exception in case of errors
  if (hasErrors(options.messages))
    throw new CompilationError(options.messages);

  return result;


  /**
   * If 'art' is a non-view entity, generate SQL statements to rename the corresponding
   * table and its columns from the naming conventions given in 'options.toRename.name'
   * (either 'quoted' or 'hdbcds') to 'plain'. In addition, drop any existing associations
   * from the columns (they would likely become invalid anyway).
   * Do not rename anything if the names are identical.
   *
   * @param {string} artifactName Name of the artifact to rename
   * @param {CSN.Artifact} art CSN artifact
   * @returns {string} RENAME statements
   */
  function renameTableAndColumns(artifactName, art) {
    let resultStr = '';
    if (art.kind === 'entity' && !art.query) {
      const beforeTableName = quoteSqlId(absoluteCdsName(artifactName));
      const afterTableName = plainSqlId(artifactName);

      if (beforeTableName !== afterTableName)
        resultStr += `  EXEC 'RENAME TABLE ${beforeTableName} TO ${afterTableName}';\n`;


      resultStr += Object.keys(art.elements).map((name) => {
        const e = art.elements[name];
        let result = '';

        const beforeColumnName = quoteSqlId(name);
        const afterColumnName = plainSqlId(name);

        if (!e._ignore) {
          if (e.target) {
            resultStr += ' ';
            result = `  EXEC 'ALTER TABLE ${afterTableName} DROP ASSOCIATION ${beforeColumnName}';\n`;
          }
          else if (beforeColumnName !== afterColumnName) {
            resultStr += ' ';
            result = `    EXEC 'RENAME COLUMN ${afterTableName}.${beforeColumnName} TO ${afterColumnName}';\n`;
          }
        }
        return result;
      }).join('');
    }
    return resultStr;
  }

  /**
   * Return 'name' in the form of an absolute CDS name - for the 'hdbcds' naming convention,
   * this means converting '.' to '::' on the border between namespace and top-level artifact.
   * For all other naming conventions, this is a no-op.
   *
   * @param {string} name Name to absolutify
   * @returns {string} Absolute name
   */
  function absoluteCdsName(name) {
    if (options.toRename.names !== 'hdbcds')
      return name;

    const namespaceName = getNamespaceOfArtifact(name);
    if (namespaceName)
      return `${namespaceName}::${name.substring(namespaceName.length + 1)}`;

    return name;
  }

  /**
   * Return 'name' with appropriate "-quotes, also replacing '::' by '.' if 'options.toRename.names'
   * is 'quoted'
   *
   * @param {string} name Name to quote
   * @returns {string} Quoted string
   */
  function quoteSqlId(name) {
    if (options.toRename.names === 'quoted')
      name = name.replace(/::/g, '.');

    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Return 'name' with uppercasing and appropriate "-quotes, also replacing '::' and '.' by '_'
   * (to be used by 'plain' naming convention).
   *
   * @param {string} name Name to turn into a plain identifier
   * @returns {string} A plain SQL identifier
   */
  function plainSqlId(name) {
    return `"${name.toUpperCase().replace(/(::|\.)/g, '_').replace(/"/g, '""')}"`;
  }
}

module.exports = {
  toRenameDdl,
};
