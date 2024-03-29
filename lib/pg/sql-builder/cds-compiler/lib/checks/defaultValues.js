'use strict';

// Only to be used with validator.js - a correct this value needs to be provided!

/**
 * OData allows simple values only (val, -val, enum), no expressions or functions
 * Leave the default value check to the Database.
 * E.g. HANA allows functions on columns but only simple values on parameter definitions
 *
 * @param {CSN.Element} member Member to validate
 * @param {string} memberName Name of the member
 * @param {string} prop Property being looped over
 * @param {CSN.Path} path Path to the member
 */
function validateDefaultValues(member, memberName, prop, path) {
  if (member.default && this.options.toOdata) {
    // unary minus is xpr: [ "-", { val: ... } ]
    if (member.default.xpr) {
      let i = 0;
      // consume all unary signs
      while (member.default.xpr[i] === '-' || member.default.xpr[i] === '+')
        i++;
      if (i > 1)
        this.error(null, path, `Illegal number of unary '+/-' operators`);
    }
  }
}

/**
 * For HANA CDS specifically, reject any default parameter values, as these are not supported.
 *
 * @param {CSN.Element} member Member to validate
 * @param {string} memberName Name of the member
 * @param {string} prop Property being looped over
 * @param {CSN.Path} path Path to the member
 */
function rejectParamDefaultsInHanaCds(member, memberName, prop, path) {
  if (member.default && prop === 'params' && this.options.transformation === 'hdbcds')
    this.error(null, path, 'Parameter default values are not supported in SAP HANA CDS');
}

/**
 * For HANA CDS, we render a default for a mixin if the projected entity contains
 * a derived association with a default defined on it. This leads to a deployment error
 * and should be warned about.
 *
 * @param {CSN.Element} member Member to validate
 * @param {string} memberName Name of the member
 * @param {string} prop Property being looped over
 * @param {CSN.Path} path Path to the member
 */
function warnAboutDefaultOnAssociationForHanaCds(member, memberName, prop, path) {
  const art = this.csn.definitions[path[1]];
  if (!art.query && this.options.transformation === 'hdbcds' && member.target && member.default) {
    this.warning(null, path, { '#': member._type.type === 'cds.Association' ? 'std' : 'comp' },
                 {
                   std: 'Unexpected default defined on association',
                   comp: 'Unexpected default defined on composition',
                 });
  }
}

module.exports = {
  validateDefaultValues,
  rejectParamDefaultsInHanaCds,
  warnAboutDefaultOnAssociationForHanaCds,
};
