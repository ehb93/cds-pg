// Checks on XSN performed during compile()
//
// TODO: to be reworked.  It is not the intention to include more checks,
// rather the opposite.  Therefore, this file will become smaller.

// Major issues so far:
//  * Different ad-hoc value/type checks (associations, enum, ...) -
//    specify a proper one and use consistently
//  * Using name comparisons instead proper object comparisons.
//  * effectiveType issues.
//  * Often forgot to consider CSN input
//  * Bad message texts/locations.

'use strict';

// const { hasArtifactTypeInformation } = require('../model/csnUtils')
const builtins = require('../compiler/builtins');
const {
  forEachGeneric, forEachDefinition, forEachMember,
} = require('../base/model');

function check( model ) {       // = XSN
  const {
    error, warning, message,
  } = model.$messageFunctions;
  forEachDefinition( model, checkArtifact );
  return;

  function checkArtifact( art ) {
    checkGenericConstruct( art );
    forEachGeneric( art, 'elements', checkElement );
    if (art.$queries)
      art.$queries.forEach( checkQuery );
  }

  function checkGenericConstruct( art ) {
    checkName( art );
    if (model.vocabularies) {
      Object.keys( art )
        .filter( a => a.startsWith('@') )
        .forEach( a => checkAnnotationAssignment1( art, art[a] ) );
    }
    checkTypeStructure(art);
    if (art.kind === 'enum')
      checkEnum( art );
    checkEnumType( art );
    forEachMember( art, checkGenericConstruct );
  }

  function checkElement( elem ) {
    checkLocalizedSubElement(elem);
    if (elem.key && elem.key.val) {
      if (elem.virtual && elem.virtual.val)
        error(null, [ elem.location, elem ], 'Element can\'t be virtual and key');

      checkForUnmanagedAssociations( elem, elem.key );
    }
    checkAssociation( elem );
    checkLocalizedElement( elem );
    if (elem.on && !elem.on.$inferred)
      checkExpression(elem.on, true);
    if (elem.value)
      checkExpression(elem.value);
    checkCardinality(elem); // TODO: also for assoc types
    forEachGeneric( elem, 'elements', checkElement );
  }

  function checkName( construct ) {
    if (model.options.$skipNameCheck)
      return;
    // TODO: Move a corrected version of this check to definer (but do not rely
    // on it!): The code below misses to consider CSN input.
    if (construct.name.id && construct.name.id.indexOf('.') !== -1) {
      // TODO: No, we should not forbid this
      error(null, [ construct.name.location, construct ],
            'The character \'.\' is not allowed in identifiers');
    }
  }

  // TODO: move into definer.js
  function checkLocalizedElement(elem) {
    // if it is directly a localized element
    if (elem.localized && elem.localized.val) {
      const type = elem._effectiveType;
      if (!type || !type.builtin || type.category !== 'string') {
        warning(null, [ elem.localized.location, elem ], {},
                'Keyword “localized” may only be used in combination with string types');
      }
    }
  }

  function checkQuery( query ) {
    checkNoUnmanagedAssocsInGroupByOrderBy( query );
    // TODO: check too simple (just one source), as most of those in this file
    // Check expressions in the various places where they may occur
    if (query.from)
      checkExpressionsInPaths(query.from);

    if (query.where) {
      checkExpression(query.where);
      checkExpressionsInPaths(query.where);
    }
    if (query.groupBy) {
      for (const groupByEntry of query.groupBy) {
        checkExpression(groupByEntry);
        checkExpressionsInPaths(groupByEntry);
      }
    }
    if (query.having) {
      checkExpression(query.having);
      checkExpressionsInPaths(query.having);
    }
    if (query.orderBy) {
      for (const orderByEntry of query.orderBy) {
        checkExpression(orderByEntry);
        checkExpressionsInPaths(orderByEntry);
      }
    }
    if (query.mixin) {
      for (const mixinName in query.mixin) {
        if (query.mixin[mixinName].on)
          checkExpression(query.mixin[mixinName].on, true);
      }
    }
    if (query.elements) {
      for (const elemName in query.elements) {
        checkStructureCasting(query.elements[elemName]);
        checkExpressionsInPaths(query.elements[elemName].value);
      }
    }
  }

  // Individual checks -------------------------------------------------------

  /**
   * The enumNode is a single enum element and not the whole type.
   *
   * @param {XSN.Artifact} enumNode
   */
  function checkEnum(enumNode) {
    if (!enumNode.value)
      return;

    const type = enumNode.value.literal;
    const loc = enumNode.value.location;

    // Special handling to print a more detailed error message.
    // Other cases like `null` as enum value are handled in `checkEnumValueType()`
    if (type === 'enum') {
      warning('enum-value-ref', [ loc, enumNode ],
              'References to other values are not allowed as enum values');
      return;
    }
  }

  function checkEnumType(enumNode) {
    // Either the type is an enum or an arrayed enum.  We are only interested in
    // the enum and don't care whether the enum is arrayed.
    enumNode = enumNode.enum ? enumNode : enumNode.items;
    if (!enumNode || !enumNode.enum)
      return;
    const type = enumNode.type && enumNode.type._artifact &&
                 enumNode.type._artifact._effectiveType;

    // We can't distinguish (in CSN) between these two cases:
    //   type Base : String enum { b;a = 'abc'; };
    //   type ThroughRef : Base;            (1)
    //   type NotAllowed : Base enum { a }  (2)
    // (2) should not be allowed but (1) should be.  That's why we allow (2).
    if (!type || type.enum)
      return;

    const name = type.name.absolute;

    // All builtin types are allowed except binary and relational types.
    // The latter are "internal" types.
    const isBinary = builtins.isBinaryTypeName(name);

    if (!type.builtin || type.internal || isBinary) {
      let typeclass = 'std';

      if (isBinary)
        typeclass = 'binary';
      else if (builtins.isRelationTypeName(name))
        typeclass = 'relation';
      else if (type.elements)
        typeclass = 'struct';
      else if (type.items)
        typeclass = 'items';

      error('enum-invalid-type', [ enumNode.type.location, enumNode ], { '#': typeclass }, {
        std: 'Only builtin types are allowed as enums',
        binary: 'Binary types are not allowed as enums',
        relation: 'Relational types are not allowed as enums',
        struct: 'Structured types are not allowed as enums',
        items: 'Arrayed types are not allowed as enums',
      });
      return;
    }

    checkEnumValue(enumNode);
  }

  /**
   * Check the given enum's elements and their values.  For example
   * whether the value types are valid for the used enum type.
   * `enumNode` can be also be `type.items` if the type is an arrayed enum.
   *
   * @param {XSN.Definition} enumNode
   */
  function checkEnumValue(enumNode) {
    const type = enumNode.type && enumNode.type._artifact &&
                 enumNode.type._artifact._effectiveType;
    if (!enumNode.enum || !type || !type.builtin)
      return;

    const isNumeric = builtins.isNumericTypeName(type.name.absolute);
    const isString = builtins.isStringTypeName(type.name.absolute);

    if (!isString) {
      // Non-string enums MUST have a value as the value is only deducted for string types.
      const emptyValue = Object.keys(enumNode.enum).find(name => !enumNode.enum[name].value);
      if (emptyValue) {
        const failedEnum = enumNode.enum[emptyValue];
        warning('enum-missing-value', [ failedEnum.location, failedEnum ],
                { '#': isNumeric ? 'numeric' : 'std', name: emptyValue },
                {
                  std: 'Missing value for non-string enum element $(NAME)',
                  numeric: 'Missing value for numeric enum element $(NAME)',
                });
      }
    }

    // We only check string and numeric value types.
    // TODO: share value-type check with that of annotation assignments
    if (!isString && !isNumeric)
      return;

    const expectedType = isNumeric ? 'number' : 'string';

    // Do not check elements that don't have a value at all or are
    // references to other enum elements.  There are other checks for that.
    const hasWrongType = element => element.value &&
          (element.value.literal !== expectedType) &&
          (element.value.literal !== 'enum');

    for (const key of Object.keys(enumNode.enum)) {
      const element = enumNode.enum[key];
      if (!hasWrongType(element))
        continue;

      const actualType = element.value.literal;
      warning('enum-value-type', [ element.value.location, element ],
              { '#': expectedType, name: key, prop: actualType }, {
                std: 'Incorrect value type $(PROP) for enum element $(NAME)', // Not used
                number: 'Expected numeric value for enum element $(NAME) but was $(PROP)',
                string: 'Expected string value for enum element $(NAME) but was $(PROP)',
              });
    }
  }

  // TODO: check inside compiler as it is a compiler restriction - improve
  /**
   * Non-recursive check if sub-elements have a "localized" keyword since this is
   * not yet supported.
   *
   * This check is not recursive to avoid a runtime overhead. Because of this it fails
   * to detect scenarios with indirections, e.g.
   *
   *   type L : localized String;
   *   type L1 : L;
   *   type L2 : L1;
   *
   *   entity E {
   *     struct : {
   *       subElement : L2;
   *     }
   *   }
   *
   * @param {XSN.Artifact} element
   */
  function checkLocalizedSubElement(element) {
    if (element._parent.kind !== 'element')
      return;

    const isLocalizedSubElement = element.localized && element.localized.val;
    if (isLocalizedSubElement || (element.type && isTypeLocalized(element.type._artifact))) {
      const loc = isLocalizedSubElement ? element.localized.location : element.type.location;
      warning('localized-sub-element', [ loc, element ],
              { type: element.type, '#': isLocalizedSubElement ? 'std' : 'type' },
              {
                std: 'Keyword "localized" is ignored for sub elements',
                type: 'Keyword "localized" in type $(TYPE) is ignored for sub elements',
              } );
    }
    return;

    // TODO: Recursive check
    function isTypeLocalized(type) {
      return (type && type.localized && type.localized.val);
    }
  }

  /**
   * Check that a primary key element is not an unmanaged association or
   * contains unmanaged associations
   *
   * @param {any} element Element to check recursively
   */
  function checkForUnmanagedAssociations(element, keyObj) {
    if (element.targetAspect) {
      // TODO: bad location / message
      message('composition-as-key', [ keyObj.location, element ], {},
              // TODO: give semantics when error downgraded
              'Managed compositions can\'t be used as primary key');
    }
    else if (element.on) {
      // TODO: bad location / message
      message('unmanaged-as-key', [ keyObj.location, element ], {},
              // TODO: give semantics when error downgraded
              'Unmanaged associations can\'t be used as primary key');
    }
    // TODO: ease check for subelements: using unmanaged assocs is OK there, as
    // long as the whole key is "closed", i.e., no ref in ON refers to element
    // outside.
    forEachGeneric( element, 'elements', e => checkForUnmanagedAssociations( e, keyObj ) );
  }

  // Check that min and max cardinalities of 'elem' in 'art' have legal values
  function checkCardinality(elem) {
    if (!elem.cardinality)
      return;

    // Max cardinalities must be a positive number or '*'
    for (const prop of [ 'sourceMax', 'targetMax' ]) {
      if (elem.cardinality[prop]) {
        if (!(elem.cardinality[prop].literal === 'number' && elem.cardinality[prop].val > 0 ||
              elem.cardinality[prop].literal === 'string' && elem.cardinality[prop].val === '*')) {
          error(null, [ elem.cardinality[prop].location, elem ],
                { code: elem.cardinality[prop].val },
                'Illegal value $(CODE) for max cardinality (must be a positive number or "*")');
        }
      }
    }

    // Min cardinality must be a non-negative number
    // Note: Already checked by parser (syntax error if -1 is used) and
    //       from-csn.json (expected non-negative number)
    for (const prop of [ 'sourceMin', 'targetMin' ]) {
      if (elem.cardinality[prop]) {
        if (!(elem.cardinality[prop].literal === 'number' && elem.cardinality[prop].val >= 0)) {
          error(null, [ elem.cardinality[prop].location, elem ],
                { code: elem.cardinality[prop].val },
                'Illegal value $(CODE) for min cardinality (must be a non-negative number)');
        }
      }
    }

    // If provided, min cardinality must not exceed max cardinality (note that
    // '*' is considered to be >= any number)
    const pair = [ [ 'sourceMin', 'sourceMax', 'Source' ], [ 'targetMin', 'targetMax', 'Target' ] ];
    pair.forEach((p) => {
      if (elem.cardinality[p[0]] && elem.cardinality[p[1]] &&
          elem.cardinality[p[1]].literal === 'number' &&
          elem.cardinality[p[0]].val > elem.cardinality[p[1]].val) {
        error(null, [ elem.cardinality.location, elem ],
              `${ p[2] } minimum cardinality must not be greater than ${ p[2].toLowerCase() } maximum cardinality`);
      }
    });
  }

  // TODO: yes, a check similar to this could make it into the compiler)
  // Check that a structured element ist not casted to a different type
  function checkStructureCasting( elem ) {
    if (elem.type && !elem.type.$inferred) {
      const loc = elem.type.location || elem.location;

      if (elem._effectiveType && elem._effectiveType.elements) {
        error('type-cast-to-structured', [ loc, elem ], {},
              'Can\'t cast to structured element');
      }
      else if (elem.value && elem.value._artifact && elem.value._artifact._effectiveType &&
               elem.value._artifact._effectiveType.elements) {
        error('type-cast-structured', [ loc, elem ], {},
              'Structured elements can\'t be cast to a different type');
      }
    }
    if (elem.value && Array.isArray( elem.value.args)) { // TODO named args?
      elem.value.args.forEach(checkStructureCasting);
    }
  }

  // TODO: make this part of the the name resolution in the compiler
  // Check that queries in 'art' do not contain unmanaged associations in GROUP BY or ORDER BY
  function checkNoUnmanagedAssocsInGroupByOrderBy( query ) {
    const art = query._main;    // TODO - remove, use query for semantic location
    for (const groupByEntry of query.groupBy || []) {
      if (groupByEntry._artifact && groupByEntry._artifact._effectiveType &&
          groupByEntry._artifact._effectiveType.on) {
        // Unmanaged association - complain
        error(null, [ groupByEntry.location, art ],
              'Unmanaged associations are not allowed in GROUP BY');
      }
    }
    for (const orderByEntry of query.orderBy || []) {
      if (orderByEntry._artifact && orderByEntry._artifact._effectiveType &&
          orderByEntry._artifact._effectiveType.on) {
        // Unmanaged association - complain
        error(null, [ orderByEntry.location, art ],
              'Unmanaged associations are not allowed in ORDER BY');
      }
    }
  }

  // Traverses 'node' recursively and applies 'checkExpression' to all expressions
  // found within paths (e.g. filters, parameters, ...)
  function checkExpressionsInPaths(node) {
    foreachPath(node, (path) => {
      for (const pathStep of path) {
        if (pathStep.where)
          checkExpression(pathStep.where);

        // FIXME: I can't actually think of a way to make this check fail, because
        // params are limited to actual values and params
        if (pathStep.args)
          checkExpression(pathStep.args);

        if (!path[0] || !path[0]._navigation) { // TODO: Discuss (see #4108)
          checkPathForMissingArguments(pathStep);
        }
      }
    });
  }

  /**
   * Check whether the argument count of the given path expression matches its artifact.
   * If there is a mismatch, an error is issued.
   *
   * @param {object} pathStep The expression to check
   */
  function checkPathForMissingArguments(pathStep) {
    // _artifact may not be set, e.g. for functions like `convert_currency( amount => 3 )`
    // _navigation must not be set or we would (for example) check each field of an entity
    if (!pathStep._artifact || pathStep._navigation)
      return;

    const isAssociation = !!pathStep._artifact.target;
    if (isAssociation) {
      const targetFinalType = pathStep._artifact.target._artifact &&
            pathStep._artifact.target._artifact._effectiveType;
      const finalTypeParams = targetFinalType ? targetFinalType.params : null;
      compareActualNamedArgsWithFormalNamedArgs(pathStep.args, finalTypeParams);
    }
    else {
      // Parameters can only be provided when navigating along associations, so because this path
      // is for non-associations, checking arguments along a navigation is unnecessary and faulty.
      compareActualNamedArgsWithFormalNamedArgs(pathStep.args, pathStep._artifact.params);
    }

    /**
     * Compare two argument dictionaries for correct argument count.
     * @param {object}   actualArgs
     * @param {object}   formalArgs
     */
    function compareActualNamedArgsWithFormalNamedArgs(actualArgs, formalArgs) {
      actualArgs = actualArgs || {};
      formalArgs = formalArgs || {};

      const aArgsCount = Object.keys(actualArgs).length;
      const expectedNames = Object.keys(formalArgs);

      const missingArgs = [];
      for (const fAName in formalArgs) {
        if (!actualArgs[fAName] && !formalArgs[fAName].default)
          missingArgs.push(fAName);
      }

      if (missingArgs.length) {
        error(null, [ pathStep.location, pathStep ],
              { names: missingArgs, expected: expectedNames.length, given: aArgsCount },
              'Expected $(EXPECTED) arguments but $(GIVEN) given; missing: $(NAMES)');
      }
      // Note:
      // Unknown arguments are already handled by messages
      // args-expected-named and args-undefined-param
    }
  }


  function checkAssociation(elem) {
    // TODO: yes, a check similar to this could make it into the compiler)
    // when virtual element is part of association
    if (elem.foreignKeys) {
      for (const k in elem.foreignKeys) {
        const key = elem.foreignKeys[k].targetElement;
        if (key && key._artifact && key._artifact.virtual && key._artifact.virtual.val) {
          error(null, [ key.location, elem ],
                'Virtual elements can\'t be used as a foreign key for a managed association');
        }
      }
    }
    if (elem.on && !elem.on.$inferred)
      checkAssociationCondition(elem, elem.on);
  }

  function checkAssociationCondition(elem, onCond) {
    if (Array.isArray(onCond)) // condition in brackets results an array
      onCond.forEach(Cond => checkAssociationCondition(elem, Cond));
    else
      checkAssociationConditionArgs(elem, onCond.args, onCond.op);
  }

  function checkAssociationConditionArgs(elem, args, op) {
    if (args)
      args.forEach(Arg => checkAssociationOnCondArg(elem, Arg, op));
  }

  function checkAssociationOnCondArg(elem, arg, op) {
    if (Array.isArray(arg)) {
      arg.forEach(Arg => checkAssociationOnCondArg(elem, Arg, op));
    }
    else {
      checkAssociationConditionArgs(elem, arg.args, arg.op);
      singleCheckUnmanagedAssocCondArgumentNoFollowUnmanagedAssoc(elem, arg, op);
    }
  }

  // TODO: make it part of the name resolution in the compiler to check whether
  // associations can be followed (in the ON condition)
  //
  // TODO: this function must be completely reworked, probably even before
  // integration into name resulution - did the first step.
  // It is also incomplete, as associations in structures are not checked.
  // Additionally, `$self.assoc` references are also not found.
  function singleCheckUnmanagedAssocCondArgumentNoFollowUnmanagedAssoc(elem, arg, op) {
    if (!arg.path)
      return;
    const path0 = arg.path[0];
    if (!path0)
      return;
    if (path0.id === '$self' && arg.path.length === 1) { // $self (backlink) checks
      checkAssociationArgumentStartingWithSelf( op, elem );
      return;
    }
    const argTarget = path0._artifact;
    if (!argTarget) // not resolved
      return;
    // the check is valid for unmanaged associations

    // TODO clarify if the full resolved path to the target field should
    // consist of managed associations or just the first
    if (argTarget.on) {
      const same = path0._artifact === elem;
      if (!same) {
        error(null, [ path0.location, elem ],
              'Unmanaged association condition can\'t follow another unmanaged association');
      }
    }
  }

  function checkAssociationArgumentStartingWithSelf( op, elem ) {
    if (op && op.val === 'xpr') // no check for xpr
      return;
    if (op && op.val !== '=')
      error(null, [ op.location, elem ], '$self comparison is only allowed with \'=\'');
  }

  // A function like this could be part of the compiler
  /**
   * Check that the given type has no conflicts between its `type` property
   * and its `elements` or `items` property. For example if `type` is not
   * structured but the artifact has an `elements` property then the user
   * made a mistake. This scenario can only happen through CSN and not CDL.
   *
   * @param {XSN.Artifact} artifact
   */
  function checkTypeStructure(artifact) {
    // Just a basic check. We do not check that the inner structure of `items`
    // is the same as the type but only that all are arrayed or structured.
    if (artifact.type && artifact.type._artifact) {
      const finalType = artifact.type._artifact._effectiveType || artifact.type._artifact;

      if (artifact.items && !finalType.items) {
        warning('type-items-mismatch', [ artifact.type.location, artifact ],
                { type: artifact.type, prop: 'items' },
                'Used type $(TYPE) is not arrayed and conflicts with $(PROP) property');
      }
      else if (artifact.elements && !finalType.elements) {
        warning('type-elements-mismatch', [ artifact.type.location, artifact ],
                { type: artifact.type, prop: 'elements' },
                'Used type $(TYPE) is not structured and conflicts with $(PROP) property');
      }
    }
    if (artifact.items)
      checkTypeStructure(artifact.items);
  }

  // Former checkExpressions.js ----------------------------------------------

  /**
   * Check an expression (or condition) for semantic validity
   *
   * @param {any} xpr The expression to check
   * @param {Boolean} allowAssocTail
   * @returns {void}
   */
  function checkExpression(xpr, allowAssocTail = false) {
    // Since the checks for tree-like and token-stream expressions differ,
    // check here what kind of expression we are looking at
    if (xpr.op && xpr.op.val === 'xpr')
      return checkTokenStreamExpression(xpr, allowAssocTail);
    return checkTreeLikeExpression(xpr, allowAssocTail);
  }
  /**
   * Check wether the supplied argument is a virtual element
   *
   * TO CLARIFY: do we want the "no virtual element" check for virtual elements/columns, too?
   *
   * @param {any} arg Argument to check (part of an expression)
   * @returns {Boolean}
   */
  function isVirtualElement(arg) {
    return arg.path &&
      arg._artifact && arg._artifact.virtual && arg._artifact.virtual.val === true &&
      arg._artifact.kind && arg._artifact.kind === 'element';
  }

  /**
   * Check a token-stream expression for semantic validity
   *
   * @param {any} xpr The expression to check
   * @returns {void}
   */
  function checkTokenStreamExpression(xpr, allowAssocTail) {
    // Check for illegal argument usage within the expression
    for (const arg of xpr.args || []) {
      if (isVirtualElement(arg))
        error(null, arg.location, 'Virtual elements can\'t be used in an expression');


      // Recursively traverse the argument expression
      checkTokenStreamExpression(arg, allowAssocTail);
    }
  }

  /**
   * Check a tree-like expression for semantic validity
   *
   * @param {any} xpr The expression to check
   * @returns {void}
   */
  function checkTreeLikeExpression(xpr, allowAssocTail) {
    // No further checks regarding associations and $self required if this is a
    // backlink-like expression (a comparison of $self with an assoc)
    if (isBinaryDollarSelfComparisonWithAssoc(xpr))
      return;

    // Check for illegal argument usage within the expression
    for (const arg of Array.isArray(xpr.args) && xpr.args || []) { // TODO named args?
      if (isVirtualElement(arg))
        error(null, arg.location, 'Virtual elements can\'t be used in an expression');

      // Arg must not be an association and not $self
      // Only if path is not approved exists path (that is non-query position)
      if (arg.path && arg.$expected !== undefined) { // not 'approved-exists'
        if (arg.$expected === 'exists')
          error(null, arg.location, 'An association can\'t be used as a value in an expression');
      }
      else if (!allowAssocTail && isAssociationOperand(arg)) {
        error(null, arg.location, 'An association can\'t be used as a value in an expression');
      }

      if (isDollarSelfOrProjectionOperand(arg))
        error(null, arg.location, `"${ arg.path[0].id }" can only be used as a value in a comparison to an association`);

      // Recursively traverse the argument expression
      checkTreeLikeExpression(arg, allowAssocTail);
    }
  }
  // Return true if 'arg' is an expression argument of type association or composition
  function isAssociationOperand(arg) {
    if (!arg.path) {
      // Not a path, hence not an association (literal, expression, function, whatever ...)
      return false;
    }
    // If it has a target, it is an association or composition
    return (arg._artifact && arg._artifact.target) ||
      (arg._artifact && arg._artifact._effectiveType && arg._artifact._effectiveType.target);
  }

  // Return true if 'arg' is an expression argument denoting "$self" || "$projection"
  function isDollarSelfOrProjectionOperand(arg) {
    return arg.path && arg.path.length === 1 &&
      (arg.path[0].id === '$self' || arg.path[0].id === '$projection');
  }

  /**
   * Return true if 'xpr' is backlink-like expression (a comparison of "$self" with an assoc)
   *
   * @param {any} xpr The expression to check
   * @returns {Boolean}
   */
  function isBinaryDollarSelfComparisonWithAssoc(xpr) {
    // Must be an expression with arguments
    if (!xpr.op || !xpr.args)
      return false;


    // One argument must be "$self" and the other an assoc
    if (xpr.op.val === '=' && xpr.args.length === 2) {
      // Tree-ish expression from the compiler (not augmented)
      return (isAssociationOperand(xpr.args[0]) && isDollarSelfOrProjectionOperand(xpr.args[1]) ||
              isAssociationOperand(xpr.args[1]) && isDollarSelfOrProjectionOperand(xpr.args[0]));
    }

    // Nothing else qualifies
    return false;
  }


  // Former checkAnnotationAssignments.js ------------------------------------

  // Check the annotation assignments (if any) of 'annotatable', possibly using annotation
  // definitions from 'model'. Report errors on 'options.messages.
  //
  // TODO: rework completely

  // Has been slightly adapted for model.vocabularies but comments need to be
  // adapted, etc.
  function checkAnnotationAssignment1( art, anno ) {
    // Sanity checks (ignore broken assignments)
    if (!anno.name || !anno.name.path || !anno.name.path.length)
      return;
    // Annotation artifact for longest path step of annotation path
    let fromArtifact = null;
    let pathStepsFound = 0;
    for (let i = anno.name.path.length; i > 0; i--) {
      const absoluteName = anno.name.path.slice(0, i).map(path => path.id).join('.');
      if (model.vocabularies[absoluteName]) {
        fromArtifact = model.vocabularies[absoluteName];
        pathStepsFound = i;
        break;
      }
    }

    if (!fromArtifact) {
      // Unchecked annotation => nothing to check
      return;
    }

    const { artifact, endOfPath } = resolvePathFrom(anno.name.path.slice(pathStepsFound),
                                                    fromArtifact);

    // Check what we actually want to check
    checkAnnotationAssignment( anno, artifact, endOfPath, art );
  }

  // Perform checks for annotation assignment 'anno', using corresponding annotation declaration,
  // made of 'annoDecl' (artifact or undefined) and 'elementDecl' (annotation or element
  // or undefined). Report errors on 'options.messages.
  function checkAnnotationAssignment(anno, annoDecl, elementDecl, art) {
    // Nothing to check if no actual annotation declaration was found
    if (!annoDecl || annoDecl.artifacts && !elementDecl)
      return;


    // Must be an annotation if found
    if (annoDecl.kind !== 'annotation') // i.e namespace
      return;

    // Element must exist in annotation
    if (!elementDecl) {
      warning(null, anno.location || anno.name.location, `Element "${ anno.name.path.map(step => step.id).join('.') }" not found for annotation "${ annoDecl.name.absolute }"`);
      return;
    }

    // Sanity checks
    if (!elementDecl._effectiveType)
      throw new Error(`Expecting annotation declaration to have _finalType: ${ JSON.stringify(annoDecl) }`);


    // Must have literal or path unless it is a boolean
    if (!anno.literal && !anno.path && getFinalTypeNameOf(elementDecl) !== 'cds.Boolean') {
      if (elementDecl.type && elementDecl.type._artifact.name.absolute)
        warning(null, anno.location || anno.name.location, `Expecting a value of type "${ elementDecl.type._artifact.name.absolute }" for the annotation`);
      else
        warning(null, anno.location || anno.name.location, 'Expecting a value for the annotation');

      return;
    }

    // Value must be assignable to type
    checkValueAssignableTo(anno, elementDecl, art);
  }

  // Check that annotation assignment 'value' (having 'path or 'literal' and
  // 'val') is potentially assignable to element 'element'. Complain on 'loc'
  // if not
  function checkValueAssignableTo(value, elementDecl, art) {
    // FIXME: We currently do not have any element declaration that could match
    // a 'path' value, so we simply leave those alone
    if (value.path)
      return;


    const loc = [ value.location || value.name.location, art ];

    // Array expected?
    if (elementDecl._effectiveType.items) {
      // Make sure we have an array value
      if (value.literal !== 'array') {
        warning(null, loc, 'An array value is required here');
        return;
      }
      // Check each element
      for (const valueItem of value.val)
        checkValueAssignableTo(valueItem, elementDecl._effectiveType.items, art);

      return;
    }

    // Struct expected (can only happen within arrays)?
    if (elementDecl._effectiveType.elements) {
      if (value.literal !== 'struct') {
        warning(null, loc, 'A struct value is required here');
        return;
      }
      // FIXME: Should check each element
      return;
    }

    // Handle each (primitive) expected element type separately
    const type = getFinalTypeNameOf(elementDecl);
    if (builtins.isStringTypeName(type)) {
      if (value.literal !== 'string' && value.literal !== 'enum' &&
          !elementDecl._effectiveType.enum)
        warning(null, loc, `A string value is required for type "${ type }"`);
    }
    else if (builtins.isBinaryTypeName(type)) {
      if (value.literal !== 'string' && value.literal !== 'x')
        warning(null, loc, `A hexadecimal string value is required for type "${ type }"`);
    }
    else if (builtins.isNumericTypeName(type)) {
      if (value.literal !== 'number' && value.literal !== 'enum' &&
          !elementDecl._effectiveType.enum)
        warning(null, loc, `A numerical value is required for type "${ type }"`);
    }
    else if (builtins.isDateOrTimeTypeName(type)) {
      if (value.literal !== 'date' && value.literal !== 'time' &&
          value.literal !== 'timestamp' && value.literal !== 'string')
        warning(null, loc, `A date/time value or a string is required for type "${ type }"`);
    }
    else if (builtins.isBooleanTypeName(type)) {
      if (value.literal && value.literal !== 'boolean')
        warning(null, loc, `A boolean value is required for type "${ type }"`);
    }
    else if (builtins.isRelationTypeName(type) || builtins.isGeoTypeName(type)) {
      warning(null, loc, `Type "${ type }" can't be assigned a value`);
    }
    else {
      throw new Error(`Unknown primitive type name: ${ type }`);
    }

    // Check enums
    const expectedEnum = elementDecl._effectiveType.enum;
    if (value.literal === 'enum') {
      if (expectedEnum) {
        // Enum symbol provided and expected
        if (!expectedEnum[value.sym.id]) {
          // .. but no such constant
          warning(null, loc, `Enum symbol "#${ value.sym.id }" not found in enum`);
        }
      }
      else {
        // Enum symbol provided but not expected
        warning(null, loc, `Cannot use enum symbol "#${ value.sym.id }" for non-enum type "${ type }"`);
      }
    }
    else if (expectedEnum) {
      // Enum symbol not provided but expected
      if (!Object.keys(expectedEnum).some(symbol => expectedEnum[symbol].value.val === value.val)) {
        // ... and none of the valid enum symbols matches the value
        warning(null, loc, 'An enum value is required here');
      }
    }
  }

  // TODO: remove the following

  // Return the artifact (and possibly, its element) found by following 'path'
  // starting at 'from'.  The return value is an object { artifact, endOfPath }
  // with 'artifact' being the last artifact encountered on 'path' (or
  // 'undefined' if none found), and 'endOfPath' being the element or artifact
  // represented by the full path (or 'undefined' if not found).  Note that
  // only elements and artifacts are considered for path traversal (no actions,
  // functions, parameters etc.)
  function resolvePathFrom(path, from, result = {}) {
    // Keep last encountered artifacts
    if (from && !from._main)
      result.artifact = from;

    // Always keep current path end
    result.endOfPath = from;
    // Stop if found or failed
    if (path.length === 0 || !from)
      return result;

    // Continue search with next path step
    const nextStepEnv = (from._effectiveType || from).artifacts ||
          from._effectiveType.elements || [];
    return resolvePathFrom(path.slice(1), nextStepEnv[path[0].id], result);
  }

  // Return the absolute name of the final type of 'node'. May return 'undefined' for
  // anonymous types
  function getFinalTypeNameOf(node) {
    let type = node._effectiveType;
    if (type.type)
      type = type.type._artifact;
    return type && type.name && type.name.absolute;
  }
}

// For each property named 'path' in 'node' (recursively), call callback(path, node)
//
// TODO: remove - this is not a good way to traverse expressions
function foreachPath(node, callback) {
  if (node === null || typeof node !== 'object') {
    // Primitive node
    return;
  }
  for (const name in node) {
    // If path found within a non-dictionary, call callback
    if (name === 'path' && Object.getPrototypeOf(node))
      callback(node.path, node);
    // Descend recursively
    foreachPath(node[name], callback);
  }
}

module.exports = check;
