// Render functions for toSql.js

'use strict';

const { getResultingName } = require('../../model/csnUtils');
const { smartId, delimitedId } = require('../../sql-identifier');

/**
 * Render a given referential constraint as part of a SQL CREATE TABLE statement, or as .hdbconstraint artefact.
 *
 * @param {CSN.ReferentialConstraint} constraint Content of the constraint
 * @param {string} indent Indent to render the SQL with
 * @param {boolean} toUpperCase Wether to uppercase the identifier
 * @param {CSN.Model} csn CSN
 * @param {CSN.Options} options is needed for the naming mode and the sql dialect
 * @param {boolean} alterConstraint whether the constraint should be rendered as part of an ALTER TABLE statement
 *
 * @returns {string} SQL statement which can be used to create the referential constraint on the db.
 */
function renderReferentialConstraint(constraint, indent, toUpperCase, csn, options, alterConstraint) {
  let quoteId;
  // for to.hana we can't utilize the sql identifier utils
  if (options.transformation === 'hdbcds') {
    quoteId = (id) => {
      if (options.sqlMapping === 'plain')
        return id.replace(/\./g, '_');
      return `"${id}"`;
    };
  }
  else {
    quoteId = getIdentifierUtils(options).quoteSqlId;
  }
  if (toUpperCase) {
    constraint.identifier = constraint.identifier.toUpperCase();
    constraint.foreignKey = constraint.foreignKey.map(fk => fk.toUpperCase());
    constraint.parentKey = constraint.parentKey.map(fk => fk.toUpperCase());
    constraint.dependentTable = constraint.dependentTable.toUpperCase();
    constraint.parentTable = constraint.parentTable.toUpperCase();
  }

  const renderAsHdbconstraint = options.transformation === 'hdbcds' ||
                                (options.toSql && options.toSql.src === 'hdi') ||
                                (options.manageConstraints && options.manageConstraints.src === 'hdi');

  const { names } = options.forHana;
  const forSqlite = options.toSql && options.toSql.dialect === 'sqlite';
  let result = '';
  result += `${indent}CONSTRAINT ${quoteId(constraint.identifier)}\n`;
  if (renderAsHdbconstraint)
    result += `${indent}ON ${quoteId(getResultingName(csn, names, constraint.dependentTable))}\n`;
  if (!alterConstraint) {
    result += `${indent}FOREIGN KEY(${constraint.foreignKey.map(quoteId).join(', ')})\n`;
    result += `${indent}REFERENCES ${quoteId(getResultingName(csn, names, constraint.parentTable))}(${constraint.parentKey.map(quoteId).join(', ')})\n`;
    // omit 'RESTRICT' action for ON UPDATE / ON DELETE, because it interferes with deferred constraint check
    if (forSqlite) {
      if (constraint.onDelete === 'CASCADE' )
        result += `${indent}ON DELETE ${constraint.onDelete}${constraint.onDeleteRemark ? ` -- ${constraint.onDeleteRemark}` : ''}\n`;
    }
    else {
      result += `${indent}ON UPDATE RESTRICT\n`;
      result += `${indent}ON DELETE ${constraint.onDelete}${constraint.onDeleteRemark ? ` -- ${constraint.onDeleteRemark}` : ''}\n`;
    }
  }
  // constraint enforcement / validation must be switched off using sqlite pragma statement
  if (options.toSql && options.toSql.dialect !== 'sqlite') {
    result += `${indent}${!constraint.validated ? 'NOT ' : ''}VALIDATED\n`;
    result += `${indent}${!constraint.enforced ? 'NOT ' : ''}ENFORCED\n`;
  }
  // for sqlite, the DEFERRABLE keyword is required
  result += `${indent}${options.toSql && options.toSql.dialect === 'sqlite' ? 'DEFERRABLE ' : ''}INITIALLY DEFERRED`;
  return result;
}

/**
 * Get functions which can be used to prepare and quote SQL identifiers based on the options provided.
 *
 * @param {CSN.Options} options
 * @returns quoteSqlId and prepareIdentifier function
 */
function getIdentifierUtils(options) {
  return { quoteSqlId, prepareIdentifier };
  /**
   * Return 'name' with appropriate "-quotes.
   * Additionally perform the following conversions on 'name'
   * If 'options.toSql.names' is 'plain'
   *   - replace '.' or '::' by '_'
   * else if 'options.toSql.names' is 'quoted'
   *   - replace '::' by '.'
   * Complain about names that collide with known SQL keywords or functions
   *
   * @param {string} name Identifier to quote
   * @returns {string} Quoted identifier
   */
  function quoteSqlId(name) {
    name = prepareIdentifier(name);

    switch (options.toSql.names) {
      case 'plain':
        return smartId(name, options.toSql.dialect);
      case 'quoted':
        return delimitedId(name, options.toSql.dialect);
      case 'hdbcds':
        return delimitedId(name, options.toSql.dialect);
      default:
        return undefined;
    }
  }

  /**
     * Prepare an identifier:
     * If 'options.toSql.names' is 'plain'
     *   - replace '.' or '::' by '_'
     * else if 'options.toSql.names' is 'quoted'
     *  - replace '::' by '.'
     *
     * @param {string} name Identifier to prepare
     * @returns {string} Identifier prepared for quoting
     */
  function prepareIdentifier(name) {
    // Sanity check
    if (options.toSql.dialect === 'sqlite' && options.toSql.names !== 'plain')
      throw new Error(`Not expecting ${options.toSql.names} names for 'sqlite' dialect`);


    switch (options.toSql.names) {
      case 'plain':
        return name.replace(/(\.|::)/g, '_');
      case 'quoted':
        return name.replace(/::/g, '.');
      case 'hdbcds':
        return name;
      default:
        throw new Error(`No matching rendering found for naming mode ${options.toSql.names}`);
    }
  }
}


module.exports = {
  renderReferentialConstraint,
  getIdentifierUtils,
};
