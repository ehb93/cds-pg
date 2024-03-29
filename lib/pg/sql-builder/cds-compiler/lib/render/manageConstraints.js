
'use strict';

const {
  forEachDefinition,
  getResultingName,
} = require('../model/csnUtils');

const {
  renderReferentialConstraint, getIdentifierUtils,
} = require('./utils/sql');

/**
 * This render middleware can be used to generate SQL DDL ALTER TABLE <table> ALTER / ADD / DROP CONSTRAINT <constraint> statements for a given CDL model.
 * Moreover, it can be used to generate .hdbconstraint artifacts.
 * Depending on the options.manageConstraints provided,the VALIDATED / ENFORCED flag of the constraints can be adjusted.
 *
 * @param {CSN.Model} csn
 * @param {CSN.Options} options
 * @returns a map holding the constraint identifier as key and the corresponding, rendered SQL statement / hdbconstraint artifact as value.
 */
function manageConstraints(csn, options) {
  const {
    drop, alter, src,
  } = options.manageConstraints || {};
  const indent = '';
  // either ALTER TABLE statements or .hdbconstraint artifacts
  const resultArtifacts = {};
  const { quoteSqlId } = getIdentifierUtils(options);
  forEachDefinition(csn, (artifact) => {
    if (artifact.$tableConstraints && artifact.$tableConstraints.referential) {
      Object.entries(artifact.$tableConstraints.referential)
        .forEach(([ fileName, constraint ]) => {
          const renderAlterConstraintStatement = alter && src !== 'hdi';
          const renderedConstraint = renderReferentialConstraint(constraint, indent, false, csn, options, renderAlterConstraintStatement);
          if (src === 'hdi') {
            resultArtifacts[fileName] = renderedConstraint;
            return;
          }
          let alterTableStatement = '';
          alterTableStatement += `${indent}ALTER TABLE ${quoteSqlId(getResultingName(csn, options.toSql.names, constraint.dependentTable))}`;
          if (renderAlterConstraintStatement)
            alterTableStatement += `\n${indent}ALTER ${renderedConstraint};`;
          else if (drop)
            alterTableStatement += `${indent} DROP CONSTRAINT ${quoteSqlId(constraint.identifier)};`;
          else
            alterTableStatement += `\n${indent}ADD ${renderedConstraint};`;

          resultArtifacts[fileName] = alterTableStatement;
        });
    }
  });
  return resultArtifacts;
}

/**
 * For a given csn model with foreign keys constraints, generate SELECT statements
 * which can be used to SELECT all rows of the dependent table which violate the referential integrity.
 *
 * @param {CSN.Model} csn
 * @returns a map holding the constraint identifier as key and the corresponding rendered SQL-SELECT statement as value.
 */
function listReferentialIntegrityViolations(csn, options) {
  const { quoteSqlId } = getIdentifierUtils(options);
  const referentialConstraints = getListOfAllConstraints(csn);
  const resultArtifacts = {};
  const indent = '    ';
  const increaseIndent = indent => `${indent}    `;
  // helper function to reduce parent key / foreign key array to a comma separated string which can be used in a select clause
  const keyStringReducer = prefix => (prev, curr, index) => (index > 0 ? `${prev},\n${curr} AS "${prefix}:${curr}"` : prev);
  // helper function to reduce the parent key / foreign key arrays of a referential constraint to a join list which can be used in a where clause
  const joinPkWithFkReducer = (constraint, subQueryAlias, mainQueryAlias) => (prev, curr, index) => (index > 0
    ? `${prev} AND
    ${increaseIndent(indent)}${mainQueryAlias}.${quoteSqlId(constraint.foreignKey[index])} = ${subQueryAlias}.${quoteSqlId(constraint.parentKey[index])}`
    : increaseIndent(increaseIndent(indent)) + prev);

  Object.entries(referentialConstraints).forEach(([ identifier, constraint ]) => {
    let selectViolations = 'SELECT\n';
    // SELECT <primary_key>,
    const primaryKeyList = selectPrimaryKeyColumns(constraint);
    if (primaryKeyList)
      selectViolations += `${primaryKeyList},\n`;
    // ... <foreign_key>
    selectViolations += selectForeignKeyColumns(constraint);
    // ... FROM <dependent table> AS "MAIN"
    selectViolations += `\nFROM ${quoteAndGetResultingName(constraint.dependentTable)} AS "MAIN"\n`;
    // ... WHERE NOT (<(part of) foreign key is null>)
    selectViolations += whereNotForeignKeyIsNull(constraint);
    /*
    ... AND NOT EXISTS (
            SELECT * FROM <parent_table> WHERE <dependent_table>.<foreign_key> = <parent_table>.<parent_key>
        )
    */
    selectViolations += andNoMatchingPrimaryKeyExists(constraint);
    resultArtifacts[identifier] = selectViolations;
  });

  /**
   * Generate a SELECT list holding all primary key columns of the dependent table found in the referential constraint.
   *
   * @param {CSN.ReferentialConstraint} constraint
   * @returns comma separated list of primary key columns
   */
  function selectPrimaryKeyColumns(constraint) {
    const pkReducer = keyStringReducer('K');
    const primaryKeyOfDependentTable = Object.keys(csn.definitions[constraint.dependentTable].elements)
      .filter((key) => {
        const element = csn.definitions[constraint.dependentTable].elements[key];
        return element.key && element.type !== 'cds.Association' && element.type !== 'cds.Composition';
      });
    // if no primary key is set in the table
    if (primaryKeyOfDependentTable.length === 0)
      return '';
    return primaryKeyOfDependentTable.reduce(pkReducer, `${quoteSqlId(primaryKeyOfDependentTable[0])} AS "K:${primaryKeyOfDependentTable[0]}"`);
  }

  /**
   * Generate a SELECT list holding all foreign key columns found in the referential constraint.
   *
   * @param {CSN.ReferentialConstraint} constraint
   * @returns comma separated list of foreign key columns
   */
  function selectForeignKeyColumns(constraint) {
    const fkReducer = keyStringReducer('FK');
    return constraint.foreignKey.reduce(fkReducer, `${quoteSqlId(constraint.foreignKey[0])} AS "FK:${constraint.foreignKey[0]}"`);
  }

  /**
   * Generate SQL WHERE condition asserting to true if none of the foreign key parts has a NULL value in the DB.
   *
   * @param {CSN.ReferentialConstraint} constraint
   * @returns WHERE NOT ( <foreign_key IS NULL ... ) statement
   */
  function whereNotForeignKeyIsNull(constraint) {
    let whereNot = `${indent}WHERE NOT (\n`;
    whereNot += constraint.foreignKey
      .reduce((prev, curr, index) => {
        if (index > 0)
          return `${prev} OR \n${increaseIndent(indent)}${quoteSqlId(curr)} IS NULL`;
        return increaseIndent(indent) + prev;
      }, `${quoteSqlId(constraint.foreignKey[0])} IS NULL`);
    whereNot += `\n${indent})`;
    return whereNot;
  }

  /**
   * Generate SQL sub-SELECT, listing all rows of the parent table where no matching primary key column for the respective foreign key is found.
   *
   * @param {CSN.ReferentialConstraint} constraint
   * @returns AND NOT EXISTS ( SELECT * FROM <parent_table> WHERE <dependent_table>.<foreign_key> = <parent_table>.<parent_key> ) statement
   */
  function andNoMatchingPrimaryKeyExists(constraint) {
    let andNotExists = `\n${indent}AND NOT EXISTS (\n`;
    andNotExists += `${increaseIndent(indent)}SELECT * FROM ${quoteAndGetResultingName(constraint.parentTable)}`;
    // add an alias to both queries so that they can be distinguished at all times
    const subQueryAlias = '"SUB"';
    const mainQueryAlias = '"MAIN"';
    andNotExists += ` AS ${subQueryAlias}`;
    andNotExists += '\n';
    const joinListReducer = joinPkWithFkReducer(constraint, subQueryAlias, mainQueryAlias);
    andNotExists += `${increaseIndent(indent)}WHERE (\n`;
    andNotExists += constraint.foreignKey
      .reduce(joinListReducer,
              `${mainQueryAlias}.${quoteSqlId(constraint.foreignKey[0])} = ${subQueryAlias}.${quoteSqlId(constraint.parentKey[0])}`);
    andNotExists += `\n${increaseIndent(indent)})`;
    andNotExists += `\n${indent});`;
    return andNotExists;
  }

  function quoteAndGetResultingName(id) {
    return quoteSqlId(getResultingName(csn, options.toSql.names, id));
  }

  return resultArtifacts;
}


function getListOfAllConstraints(csn) {
  const referentialConstraints = {};
  forEachDefinition(csn, (artifact) => {
    if (artifact.$tableConstraints && artifact.$tableConstraints.referential) {
      Object.entries(artifact.$tableConstraints.referential)
        .forEach(([ identifier, referentialConstraint ]) => {
          referentialConstraints[identifier] = referentialConstraint;
        });
    }
  });
  return referentialConstraints;
}

module.exports = {
  manageConstraints,
  listReferentialIntegrityViolations,
};
