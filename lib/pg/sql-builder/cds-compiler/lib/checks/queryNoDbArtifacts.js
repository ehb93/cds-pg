'use strict';

const { hasAnnotationValue, isPersistedOnDatabase, isBuiltinType } = require('../model/csnUtils');
/**
 * Make sure that all source artifacts and association targets reach the database
 * (otherwise the view can't be activated), but only if the source artifact is NOT activated against the database
 * Check the given query for:
 * - Associations-traversal over skipped/abstract things
 * - Associations (indirectly) using managed associations without foreign keys
 *
 * Currently checked:
 * - "columns" for something like toF.id, where F is skipped. But publishing toF is fine, will be ignored later on
 * - "from" for something like "select from E.toF" where E, F or E AND F are no-db.
 *
 *
 * @param {CSN.Query} query Query to check
 */
function checkQueryForNoDBArtifacts(query) {
  /**
   * Count the leaf-elements resulting from a given element.
   *
   * @param {CSN.Element} def Definition to check
   * @returns {number} Number of leaf elements
   */
  const leafCount = (def) => {
    let c = 0;
    if (def.elements) {
      c += Object.values(def.elements).reduce((acc, e) => {
        acc += leafCount(e);
        return acc;
      }, 0);
    }
    else if (def.keys) {
      c += def.keys.reduce((acc, e) => {
        acc += leafCount(e._art);
        return acc;
      }, 0);
    }
    else if (def.type) {
      if (isBuiltinType(def.type) && !(def.target))
        return 1;
      c += leafCount(this.csn.definitions[def.type]);
    }
    return c;
  };
  /**
   * Check the given ref for usage of skipped/abstract assoc targets
   *
   * @param {object} obj CSN "thing" to check
   * @param {boolean} inColumns True if the ref is part of a from
   */
  const checkRef = (obj, inColumns) => {
    if (!(obj && obj.ref) || !obj._links || obj.$scope === 'alias')
      return;

    const links = obj._links;

    // Don't check the last element - to allow association publishing in columns
    for (let i = 0; i < (inColumns ? links.length - 1 : links.length); i++) {
      const link = links[i];
      if (!link)
        continue;

      const { art } = link;
      if (!art)
        continue;

      const endArtifact = art.target ? this.csn.definitions[art.target] : art;
      const pathStep = obj.ref[i].id ? obj.ref[i].id : obj.ref[i];
      const name = art.target ? art.target : pathStep;
      if (!isPersistedOnDatabase(endArtifact)) {
        const nextElement = obj.ref[i + 1];
        /**
         * if we only navigate to foreign keys of the managed association in a view, we do not need to join,
         * thus we can produce the view even if the target of the association is not persisted
         *
         * @param {CSN.Element} assoc association in ref
         * @param {string} nextStep the ref step following the association
         * @returns {boolean} true if no join will be generated
         */
        const isJoinRelevant = (assoc, nextStep) => {
          if (!assoc.keys)
            return true;
          const isExposedColumnAssocOrComposition = this.csnUtils.isAssocOrComposition(obj._art.type);
          return !assoc.keys
            .some(fk => fk.ref[0] === nextStep && !isExposedColumnAssocOrComposition);
        };
        if (isJoinRelevant(art, nextElement)) {
          const cdsPersistenceSkipped = hasAnnotationValue(endArtifact, '@cds.persistence.skip');
          this.error( null, obj.$path, {
            id: pathStep, elemref: obj, name, '#': cdsPersistenceSkipped ? 'std' : 'abstract',
          }, {
            std: 'Unexpected “@cds.persistence.skip” annotation on association target $(NAME) of $(ID) in path $(ELEMREF)',
            abstract: 'Unexpected “abstract” association target $(NAME) of $(ID) in path $(ELEMREF)',
          } );
        }
      }
      // check managed association to have foreign keys array filled
      if (art.keys && leafCount(art) === 0) {
        this.error(null,
                   obj.$path,
                   { id: pathStep, elemref: obj },
                   `Path step $(ID) of $(ELEMREF) has no foreign keys`);
      }

      if (art.on) {
        for (let j = 0; j < art.on.length; j++) {
          if (j < art.on.length - 2 && art.on[j].ref && art.on[j + 1] === '=' && art.on[j + 2].ref) {
            const [ fwdAssoc, fwdPath ] = getForwardAssociation(pathStep, art.on[j], art.on[j + 2]);
            if (fwdAssoc && fwdAssoc.keys && leafCount(fwdAssoc) === 0) {
              this.error(null, obj.$path,
                         { name: pathStep, elemref: obj, id: fwdPath },
                         'Path step $(NAME) of $(ELEMREF) is a $self comparison with $(ID) that has no foreign keys');
              j += 2;
            }
          }
        }
      }
    }
  };

  if (isPersistedOnDatabase(this.artifact) && !hasAnnotationValue(this.artifact, '@cds.persistence.table')) {
    const generalQueryProperties = [ 'from', 'columns', 'where', 'groupBy', 'orderBy', 'having', 'limit' ];
    for (const prop of generalQueryProperties) {
      const queryPart = (query.SELECT || query.SET)[prop];
      if (Array.isArray(queryPart)) {
        for (let i = 0; i < queryPart.length; i++) {
          const part = queryPart[i];
          checkRef(part, prop === 'columns');
        }
      }
      else if (typeof queryPart === 'object') {
        checkRef(queryPart, prop === 'columns');
      }
    }
  }
}

/**
 * Get the forward association from a backling $self association.
 *
 * @param {string} prefix Name of the association
 * @param {object} lhs Left hand side of the on-condition part
 * @param {object} rhs Right hand side of the on-condition part
 * @returns {Array} Return the association object (index 0) and the corresponding path (index 1).
 */
function getForwardAssociation(prefix, lhs, rhs) {
  if (lhs && rhs) {
    if (rhs.ref.length === 1 && rhs.ref[0] === '$self' &&
       lhs.ref.length > 1 && lhs.ref[0] === prefix)
      return [ lhs._links[lhs._links.length - 1].art, lhs.ref.join('.') ];
    if (lhs.ref.length === 1 && lhs.ref[0] === '$self' &&
       rhs.ref.length > 1 && rhs.ref[0] === prefix)
      return [ rhs._links[rhs._links.length - 1].art, rhs.ref.join('.') ];
  }
  return [ undefined, undefined ];
}

module.exports = checkQueryForNoDBArtifacts;
