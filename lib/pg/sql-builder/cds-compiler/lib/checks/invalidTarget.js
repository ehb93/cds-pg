'use strict';

// Only to be used with validator.js - a correct this value needs to be provided!

/**
 * Assert that targets of associations and compositions are entities.
 *
 * @param {object} member Member
 */
function invalidTarget(member) {
  // Declared as arrow-function to keep scope the same (this value)
  const handleStructured = (mem) => {
    for (const elementName of Object.keys(mem.elements)) {
      const element = mem.elements[elementName];
      // eslint-disable-next-line no-use-before-define
      checkForInvalidTarget(element);
    }
  };

  // Declared as arrow-function to keep scope the same (this value)
  const checkForInvalidTarget = (mem) => {
    if (mem.target) {
      const target = this.csn.definitions[mem.target];
      if (!target)
        throw new Error(`Expected target ${ mem.target }`);
      if (target.kind !== 'entity') {
        const isAssoc = this.csnUtils.getFinalBaseType(member.type) !== 'cds.Composition';
        this.error(
          null,
          member.$path,
          { '#': isAssoc ? 'std' : 'comp', kind: target.kind },
          {
            std: 'Association target must be an entity but found: $(KIND)',
            comp: 'Composition target must be an entity but found: $(KIND)',
          }
        );
      }
    }
    else if (mem.type && mem.type.ref) {
      // type of
      checkForInvalidTarget(this.artifactRef(mem.type));
    }
    else {
      // type T
      const type = this.csn.definitions[mem.type];
      if (type) {
        if (type.elements)
          handleStructured(type);
        else
          checkForInvalidTarget(type);
      }
    }
  };

  if (
    this.artifact &&
    (this.artifact.kind === 'entity' || this.artifact.query) &&
    member.$path[2] === 'elements'
  )
    checkForInvalidTarget(member);
}

module.exports = invalidTarget;
