'use strict';

// Only to be used with validator.js - a correct this value needs to be provided!

/**
 * Validate the foreign keys of a managed association
 *
 * - no usage of array-like fields as foreign keys (also not transitively)
 * - no usage of unmanaged association as foreign keys (also not transitively)
 *
 * @param {object} member Member
 */
function validateForeignKeys(member) {
  // We have a managed association
  const isManagedAssoc = mem => mem && mem.target && !mem.on;
  // We have an unmanaged association
  const isUnmanagedAssoc = mem => mem && mem.target && mem.on && !mem.keys;

  // Declared as arrow-function to keep scope the same (this value)
  const handleAssociation = (mem) => {
    for (let i = 0; i < mem.keys.length; i++) {
      if (mem.keys[i].ref) {
        if (!mem.keys[i]._art)
          continue;
        // eslint-disable-next-line no-use-before-define
        checkForItems(mem.keys[i]._art);
      }
    }
  };

  // Declared as arrow-function to keep scope the same (this value)
  const handleStructured = (mem) => {
    for (const elementName of Object.keys(mem.elements)) {
      const element = mem.elements[elementName];
      // eslint-disable-next-line no-use-before-define
      checkForItems(element);
    }
  };

  // Recursively perform the checks on an element
  // Declared as arrow-function to keep scope the same (this value)
  const checkForItems = (mem) => {
    if (mem.items) {
      this.error(null, member.$path, 'Array-like properties must not be foreign keys');
    }
    else if (isUnmanagedAssoc(mem)) {
      this.error(null, member.$path, 'Unmanaged association must not be a foreign key');
    }
    else if (mem.keys) {
      handleAssociation(mem);
    }
    else if (mem.elements) {
      handleStructured(mem);
    }
    else if (mem.type && mem.type.ref) { // type of
      checkForItems(this.artifactRef(mem.type));
    }
    else { // type T where T might contain items
      const type = this.csn.definitions[mem.type];
      if (type) {
        if (type.keys)
          handleAssociation(type);

        else if (type.elements)
          handleStructured(type);
      }
    }
  };

  if (isManagedAssoc(member))
    checkForItems(member);
}

module.exports = validateForeignKeys;
