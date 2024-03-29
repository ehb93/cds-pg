'use strict';

const { otherSideIsExpandableStructure, resolveArtifactType } = require('./utils');

/**
 * Check the given expression for non-expandable structure usage
 *
 * @param {object} parent Object with the expression as a property
 * @param {string} name Name of the expression property on parent
 * @param {Array} expression Expression to check - .on .xpr .having and .where
 */
function nonexpandableStructuredInExpression(parent, name, expression) {
  for (let i = 0; i < expression.length; i++) {
    if (expression[i].ref) {
      const { ref } = expression[i];
      // eslint-disable-next-line prefer-const
      let { _art, $scope } = expression[i];
      if (!_art)
        continue;
      const validStructuredElement = otherSideIsExpandableStructure.call(this, expression, i);
      if (_art) {
        _art = resolveArtifactType.call(this, _art);
        // Paths of an expression may end on a structured element only if both operands in the expression end on a structured element
        if (_art.elements && !validStructuredElement && $scope !== '$self') { // TODO: Use $self to navigate to struct
          this.error(null, expression[i].$path, { elemref: { ref } },
                     'Unexpected usage of structured type $(ELEMREF)');
        }
      }
    }
  }
}

module.exports = {
  on: nonexpandableStructuredInExpression,
  having: nonexpandableStructuredInExpression,
  where: nonexpandableStructuredInExpression,
  xpr: nonexpandableStructuredInExpression,
};
