'use strict';
const { setProp } = require('../base/model');
const { isBuiltinType, isEdmPropertyRendered } = require('../model/csnUtils');

/* eslint max-statements-per-line:off */
function validateOptions(_options)
{
  if(!_options.isV2 && !_options.isV4)
  {
    // csn2edm expects "version" to be a top-level property of options
    // set to 'v4' as default, override with value from incoming options
    // (here version comes inside "toOdata")
    const options = Object.assign({ version: 'v4'}, _options);
    if (options.toOdata) {
      if(options.toOdata.version)
        options.version = options.toOdata.version;
      if(options.toOdata.odataFormat)
        options.odataFormat = options.toOdata.odataFormat;
      if(options.toOdata.odataContainment)
        options.odataContainment = options.toOdata.odataContainment;
      if(options.toOdata.odataForeignKeys)
        options.odataForeignKeys = options.toOdata.odataForeignKeys;
      if(options.toOdata.odataV2PartialConstr)
        options.odataV2PartialConstr = options.toOdata.odataV2PartialConstr;
      // global flag that indicates wether or not FKs shall be rendered in general
      // V2/V4 flat: yes
      // V4/struct: depending on odataForeignKeys
      options.renderForeignKeys =
        options.version === 'v4' ? options.odataFormat === 'structured' &&  !!options.odataForeignKeys : true;

    }

    const v2 = options.version.match(/v2/i) != undefined;
    const v4 = options.version.match(/v4/i) != undefined;

    options.v = [v2, v4];
    options.isStructFormat = options.odataFormat && options.odataFormat === 'structured';
    options.isFlatFormat = !options.isStructFormat;

    if(options.v.filter(v=>v).length != 1)
      throw Error(`Please debug me: EDM V2:${v2}, V4:${v4}`);

    options.isV2 = function() { return this.v[0] == true; }
    options.isV4 = function() { return this.v[1] == true; }

    options.pathDelimiter = options.isStructFormat ? '/' : '_';

    return options;
  }
  else
    return _options;
}

// returns intersection of two arrays
function intersect(a,b)
{
  return [...new Set(a)].filter(x => new Set(b).has(x));
}

// Call func(art, name) for each artifact 'art' with name 'name' in 'dictionary' that returns true for 'filter(art)'
function foreach(dictionary, filter, func) {
  dictionary && Object.entries(dictionary).forEach(([name, value]) => {
    if (filter(value)) {
      if(Array.isArray(func))
        func.forEach(f=>f(value, name));
      else
          func(value, name);
    }
  });
}

// Call func(art, name) for each artifact 'art' with name 'name' in 'dictionary'
function forAll(dictionary, func) {
  foreach(dictionary, ()=>true, func);
}

// true if _containerEntity is unequal to artifact name (non-recursive containment association)
//      or if artifact belongs to an artificial parameter entity
function isContainee(artifact) {
  // if _containerEntity is present, it is guaranteed that it has at least one entry
  return (artifact._containerEntity && (artifact._containerEntity.length > 1 || artifact._containerEntity[0] != artifact.name));
}

// Return true if 'artifact' has an association type
function isAssociation(artifact) {
  return (artifact.type === 'cds.Association' || artifact.type === 'Association') &&  artifact.target != undefined;
  //return artifact.target != undefined;
}

function isComposition(artifact) {
  return (artifact.type === 'cds.Composition' || artifact.type === 'Composition') &&
    artifact.target != undefined;
}

function isAssociationOrComposition(artifact)
{
  return isAssociation(artifact) || isComposition(artifact);
}

function isManagedAssociation(artifact)
{
  return isAssociation(artifact) && artifact.on == undefined;
}

// Return true if the association 'assoc' has cardinality 'to-many'
function isToMany(assoc) {
  if (!assoc.cardinality) {
    return false;
  }
  // Different representations possible: array or targetMax property
  let targetMax = assoc.cardinality[1] ||assoc.cardinality.max;
  if (!targetMax) {
    return false;
  }
  return targetMax === '*' || Number(targetMax) > 1;
}

function isSingleton(entityCsn, v) {
  const singleton = entityCsn['@odata.singleton'];
  const hasNullable = entityCsn['@odata.singleton.nullable'] !== undefined && entityCsn['@odata.singleton.nullable'] !== null;
  return v && singleton || ((singleton === undefined || singleton === null) && hasNullable);
}

function isEntity(artifact)
{
  return ['entity'].includes(artifact.kind);
}

function isParameterizedEntity(artifact) {
  return isEntity(artifact) && artifact.params;
}

// Return true if 'artifact' is structured (i.e. has elements, like a structured type or an entity)
function isStructuredArtifact(artifact) {
  // FIXME: No derived types etc yet
  return (artifact.items && artifact.items.elements || artifact.elements);
}

// Return true if 'artifact' is a real structured type (not an entity)
function isStructuredType(artifact) {
  return ['type'].includes(artifact.kind) && isStructuredArtifact(artifact);
}

function isDerivedType(artifact) {
  return ['type'].includes(artifact.kind) && !isStructuredArtifact(artifact);
}

function isActionOrFunction(artifact) {
  return ['action', 'function'].includes(artifact.kind);
}

function resolveOnConditionAndPrepareConstraints(csn, assocCsn, messageFunctions) {
  if(!assocCsn._constraints)
    throw Error('Please debug me: need _constraints');

  const { info, warning } = messageFunctions;

  if(assocCsn.on)
  {
    // fill constraint array with [prop, depProp]
    getExpressionArguments(assocCsn.on);

    // for all $self conditions, fill constraints of partner (if any)
    let isBacklink = assocCsn._constraints.selfs.length === 1 && assocCsn._constraints.termCount === 1;

    /* example for _originalTarget:
    entity E (with parameters) {
      ... keys and all the stuff ...
      toE: association to E;
      back: association to E on back.toE = $self
    }
    toE target 'E' is redirected to 'EParameters' (must be as the new parameter list is required)
    back target 'E' is also redirected to 'EParameters' (otherwise backlink would fail)
    ON Condition back.toE => parter=toE cannot be resolved in EParameters, _originalTarget 'E' is
    required for that
    */
    assocCsn._constraints.selfs.filter(p => p).forEach(partnerPath => {
      // resolve partner path in target
      const originAssocCsn = resolveOriginAssoc(csn, (assocCsn._originalTarget || assocCsn._target), partnerPath);
      const parentName = assocCsn.$abspath[0];
      const parent = csn.definitions[parentName];
      if(originAssocCsn) {
        const originParentName = originAssocCsn.$abspath[0];
        if(originAssocCsn._originalTarget !== parent && originAssocCsn._target !== parent) {
          isBacklink = false;
          // Partnership is ambiguous
          setProp(originAssocCsn, '$noPartner', true);
          info(null, ['definitions', parentName, 'elements', assocCsn.name],
            `"${originParentName}:${partnerPath.join('.')}" with target "${originAssocCsn._target.name}" is compared with $self which represents "${parentName}"`);
        }
        if(isAssociationOrComposition(originAssocCsn)) {
          // Mark this association as backlink if $self appears exactly once
          // to surpress edm:Association generation in V2 mode
          if(isBacklink) {
            // use first backlink as partner
            if(originAssocCsn._selfReferences.length === 0) {
              assocCsn._constraints._partnerCsn = originAssocCsn;
            }
            else {
              isBacklink = false;
            }
          }
          // store all backlinks at forward, required to calculate rendering of foreign keys
          // if the termCount != 1 or more than one $self compare this is not a backlink
          if(assocCsn._constraints.selfs.length === 1 && assocCsn._constraints.termCount === 1) {
            originAssocCsn._selfReferences.push(assocCsn);
          }
          assocCsn._constraints._origins.push(originAssocCsn);
        }
        else {
          /*
            entity E  {
              key id : Integer;
              toMe: association to E on toMe.id = $self; };
            */
          throw Error('Backlink association element is not an association or composition: "' + originAssocCsn.name);
        }
      }
      else
      {
        warning(null, ['definitions', parentName],
        { partner: `${assocCsn._target.name}/${partnerPath}`, name: `${parentName}/${assocCsn.name}` },
        'Can\'t resolve backlink to $(PARTNER) from $(NAME)');
      }
    });
  }

  // nested functions
  function getExpressionArguments(expr)
  {
    let allowedTokens = [ '=', 'and', '(', ')' ];
    if(expr && Array.isArray(expr))
      // if some returns true, this term is not usable as a constraint term
      if(!expr.some(isNotAConstraintTerm))
        expr.forEach(fillConstraints)

    // return true if token is not one of '=', 'and', '(', ')' or object
    function isNotAConstraintTerm(tok)
    {
      if(tok.xpr)
        return tok.xpr.some(isNotAConstraintTerm);
      if(Array.isArray(tok))
        return tok.some(isNotAConstraintTerm);
      return !(typeof tok === 'object' && tok != null || allowedTokens.includes(tok));
    }

    // fill constraints object with [dependent, principal] pairs and collect all forward assocs for $self terms
    function fillConstraints(arg, pos)
    {
      if(arg.xpr)
        arg.xpr.map(fillConstraints);
      else if(pos > 0 && pos < expr.length)
      {
        let lhs = expr[pos-1];
        let rhs = expr[pos+1];
        if(['='].includes(arg))
        {
          assocCsn._constraints.termCount++;
          if(lhs.ref && rhs.ref) // ref is a path
          {
            lhs = lhs.ref;
            rhs = rhs.ref;
            // if exactly one operand starts with the prefix then this is potentially a constraint

            // strip of prefix '$self's
            if(lhs[0] === '$self' && lhs.length > 1)
              lhs = lhs.slice(1);
            if(rhs[0] === '$self' && rhs.length > 1)
              rhs = rhs.slice(1);

            if((lhs[0] === assocCsn.name && rhs[0] !== assocCsn.name) ||
              (lhs[0] !== assocCsn.name && rhs[0] === assocCsn.name))
            {
              // order is always [ property, referencedProperty ]
              //backlink         [ self, assocName ]

              let c;
              if(lhs[0] === assocCsn.name)
                c = [rhs, lhs.slice(1)];
              else
                c = [lhs, rhs.slice(1)];

              // do we have a $self id?
              // if so, store partner in selfs array
              if(c[0][0] === '$self' && c[0].length === 1) {
                assocCsn._constraints.selfs.push(c[1]);
              } else {
                const key = c.join(',');
                assocCsn._constraints.constraints[key] = c;
              }
            }
          }
        }
      }
    }
  }
}

function finalizeReferentialConstraints(csn, assocCsn, options, info)
{
  if(!assocCsn._constraints)
    throw Error('Please debug me: need _constraints');

  if(assocCsn.on)
  {
    /* example for originalTarget:
    entity E (with parameters) {
      ... keys and all the stuff ...
      toE: association to E;
      back: association to E on back.toE = $self
    }
    toE target 'E' is redirected to 'EParameters' (must be as the new parameter list is required)
    back target 'E' is also redirected to 'EParameters' (otherwise backlink would fail)
    ON Condition back.toE => parter=toE cannot be resolved in EParameters, originalTarget 'E' is
    required for that
    */
    assocCsn._constraints._origins.forEach(originAssocCsn => {
      // if the origin assoc is marked as primary key and if it's managed, add all its foreign keys as constraint
      // as they are also primary keys of the origin entity as well
      if(!assocCsn._target.$isParamEntity && originAssocCsn.key && originAssocCsn.keys) {
        for(let fk of originAssocCsn.keys) {
          let realFk = originAssocCsn._parent.elements[fk.$generatedFieldName];
          let pk = assocCsn._parent.elements[fk.ref[0]];
          if(isConstraintCandidate(pk) && isConstraintCandidate(realFk))
          {
            const c = [ [ fk.ref[0] ], [ fk.$generatedFieldName ] ];
            const key = c.join(',');
            assocCsn._constraints.constraints[key] = c;
          }
        }
      }
    });

    if(!assocCsn._target.$isParamEntity) {
      // Use $path to identify main artifact in case assocs parent was a nested type and deanonymized
      // Some (draft) associations don't have a $path, use _parent as last resort
      let dependentEntity = assocCsn.$path ? csn.definitions[assocCsn.$path[1]] : assocCsn._parent;
      let localDepEntity  = assocCsn._parent;
      // _target must always be a main artifact
      let principalEntity = assocCsn._target;
      if(assocCsn.type === 'cds.Composition') {
      // Header is composed of Items => Cds.Composition: Header is principal => use header's primary keys
        principalEntity = dependentEntity;
        localDepEntity = undefined;
        dependentEntity = assocCsn._target;
        // Swap the constraint elements to be correct on Composition [principal, dependent] => [dependent, principal]
        Object.keys(assocCsn._constraints.constraints).forEach(cn => {
          assocCsn._constraints.constraints[cn] = [ assocCsn._constraints.constraints[cn][1], assocCsn._constraints.constraints[cn][0] ] } );
      }
      // Remove all target elements that are not key in the principal entity
      // and all elements that annotated with '@cds.api.ignore'
      const remainingPrincipalRefs = [];
      foreach(assocCsn._constraints.constraints,
        c => {
          // rc === true will remove the constraint (positive filter expression)
          let rc = true;
          // concatenate all paths in flat mode to identify the correct element
          // in structured mode only resolve top level element (path rewriting is done elsewhere)
          const depEltName = ( options.isFlatFormat ? c[0].join('_') : c[0][0] );
          const principalEltName = ( options.isFlatFormat ? c[1].join('_') : c[1][0] );
          const fk = (isEntity(dependentEntity) && dependentEntity.elements[ depEltName ]) || 
            (localDepEntity && localDepEntity.elements && localDepEntity.elements[ depEltName ]);
          const pk = principalEntity.$keys && principalEntity.$keys[ principalEltName ];
          if(isConstraintCandidate(fk) && isConstraintCandidate(pk)) {
            if(options.isStructFormat) {
              // In structured mode it might be the association has a new _parent due to
              // type de-anonymization.
              // There are three cases for dependent ON condition paths:
              // 1) path is relative to assoc in same sub structure
              // 2) path is absolute and ends up in a different environment
              // 3) path is absolute and touches in assoc's environment

              // => 1) if _parents are equal, fk path is relative to assoc
              if(fk._parent === assocCsn._parent) {
                rc = false;
              }
              // => 2) & 3) if path is not relative to assoc, remove main entity (pos=0) and assoc (pos=n-1)
              // and check path identity: If absolute path touches assoc's _parent, add it
              else if(!assocCsn.$abspath.slice(1, assocCsn.$abspath.length-1).some((p,i) => c[0][i] !== p)) {
                // this was an absolute addressed path, remove environment prefix
                c[0].splice(0, assocCsn.$abspath.length-2);
                rc = false;
              }
            }
            else {
              // for flat mode isConstraintCandidate(fk) && isConstraintCandidate(pk) is sufficient
              rc = false;
            }
          }
          if(!rc)
            remainingPrincipalRefs.push(principalEltName);
          return rc;
        },
        (c, cn) => { delete assocCsn._constraints.constraints[cn]; }
      );

      // V2 check that ALL primary keys are constraints
      if(principalEntity.$keys) {
        const renderedKeys = Object.values(principalEntity.$keys).filter(isConstraintCandidate).map(v=>v.name);
        if(options.isV2() && intersect(renderedKeys, remainingPrincipalRefs).length !== renderedKeys.length)
          if(options.odataV2PartialConstr) {
            info('odata-spec-violation-constraints',
                    ['definitions', assocCsn._parent.name, 'elements', assocCsn.name], { api: 'OData V2' });
          }
          else {
            assocCsn._constraints.constraints = {};
          }
      }
    }

  }
  // Handle managed association, a managed composition is treated as association
  else
  {
    // If FK is key in target => constraint
    // Don't consider primary key associations (fks become keys on the source entity) as
    // this would impose a constraint against the target.
    // Filter out all elements that annotated with '@cds.api.ignore'

    // In structured format, foreign keys of managed associations are never rendered, so
    // there are no constraints for them.
    if(!assocCsn._target.$isParamEntity && assocCsn.keys) {
      const remainingPrincipalRefs = [];
      for(let fk of assocCsn.keys) {
        let realFk = assocCsn._parent.items ? assocCsn._parent.items.elements[fk.$generatedFieldName] : assocCsn._parent.elements[fk.$generatedFieldName];
        let pk = assocCsn._target.elements[fk.ref[0]];
        if(pk && pk.key && isConstraintCandidate(pk) && isConstraintCandidate(realFk))
        {
          remainingPrincipalRefs.push(fk.ref[0]);
          const c = [ [ fk.$generatedFieldName ], [ fk.ref[0] ] ];
          const key = c.join(',');
          assocCsn._constraints.constraints[key] = c;
        }
      }

      // V2 check that ALL primary keys are constraints
      const renderedKeys = Object.values(assocCsn._target.$keys).filter(isConstraintCandidate).map(v=>v.name);
      if(options.isV2() && intersect(renderedKeys, remainingPrincipalRefs).length !== renderedKeys.length) {
        if(options.odataV2PartialConstr) {
          info('odata-spec-violation-constraints',
                  ['definitions', assocCsn._parent.name, 'elements', assocCsn.name], { api: 'OData V2' } );
        }
        else {
          assocCsn._constraints.constraints = {};
        }
      }
    }
  }

  // If this association points to a redirected Parameter EntityType, do not calculate any constraints,
  // continue with multiplicity
  if(assocCsn._target.$isParamEntity)
  {
    assocCsn._constraints.constraints = Object.create(null);
  }
  return assocCsn._constraints;

  /*
   * In Flat Mode an element is a constraint candidate if it is of scalar type.
   * In Structured mode, it eventually can be of a named type (which is
   * by the construction standards for OData either a complex type or a
   * type definition (alias to a scalar type).
   * The element must never be an association or composition and be renderable.
   */
  function isConstraintCandidate(elt) {
    let rc= (elt &&
            elt.type &&
            (!options.isFlatFormat || options.isFlatFormat && isBuiltinType(elt.type)) &&
            !['cds.Association', 'cds.Composition'].includes(elt.type) &&
            isEdmPropertyRendered(elt, options));
    return rc;
  }
}

function determineMultiplicity(csn)
{
  /*
    =>  SRC Cardinality
    CDS   => EDM
    ------------
    undef => '*'  // CDS default mapping for associations
    undef => 1    // CDS default mapping for compositions
    1     => 0..1 // Association
    1     => 1    // Composition
    n     => '*'
    *     => *

    => TGT Cardinality
    CDS   => EDM
    ------------
    undef      => 0..1 // CDS default mapping for associations
    0..1       => 0..1
    1          => 0..1
    1 not null => 1  (targetMin=1 is set by transform/toOdata.js)
    1..1       => 1   // especially for unmanaged assocs :)
    0..m       => '*' // CDS default mapping for compositions
    m          => '*'
    1..n       => '*'
    n..m       => '*'
    *          => '*'
  */

  /* new csn:
  src, min, max
  */

  const isAssoc = csn.type === 'cds.Association';
  if(!csn.cardinality)
    csn.cardinality = Object.create(null);

  if(!csn.cardinality.src)
    csn.cardinality.src = isAssoc ? '*' : '1';
  if(!csn.cardinality.min)
    csn.cardinality.min = 0;
  if(!csn.cardinality.max)
    csn.cardinality.max = 1;

  let  srcCardinality = (csn.cardinality.src == 1) ? (isAssoc ? '0..1' : '1') : '*';
  let  tgtCardinality = (csn.cardinality.max > 1 || csn.cardinality.max === '*') ? '*' :
                          (csn.cardinality.min == 1) ? '1' : '0..1';

  return [srcCardinality, tgtCardinality];
}

function mapCdsToEdmType(csn, messageFunctions, isV2=false, isMediaType=false)
{
  const { error } = messageFunctions || { error: ()=>true };
  let cdsType = csn.type;
  if(cdsType === undefined) {
    error(null, csn.$location, `no type found`);
    return '<NOTYPE>';
  }
  if(!isBuiltinType(cdsType))
    return cdsType;

  let edmType = {
    // Edm.String, Edm.Binary
    'cds.String': 'Edm.String',
    'cds.hana.NCHAR': 'Edm.String',
    'cds.LargeString': 'Edm.String',
    'cds.hana.VARCHAR': 'Edm.String',
    'cds.hana.CHAR': 'Edm.String',
    'cds.hana.CLOB': 'Edm.String',
    'cds.Binary': 'Edm.Binary',
    'cds.hana.BINARY': 'Edm.Binary',
    'cds.LargeBinary': 'Edm.Binary',
    // numbers: exact and approximate
    'cds.Decimal': 'Edm.Decimal',
    'cds.DecimalFloat': 'Edm.Decimal',
    'cds.hana.SMALLDECIMAL': 'Edm.Decimal', // V4: Scale="floating" Precision="16"
    'cds.Integer64': 'Edm.Int64',
    'cds.Integer': 'Edm.Int32',
    'cds.hana.SMALLINT': 'Edm.Int16',
    'cds.hana.TINYINT': 'Edm.Byte',
    'cds.Double': 'Edm.Double',
    'cds.hana.REAL': 'Edm.Single',
    // other: date/time, boolean
    'cds.Date': 'Edm.Date',
    'cds.Time': 'Edm.TimeOfDay',
    // For a very long time it was unclear wether or not to map the Date types to a different Edm Type in V2,
    // no one has ever asked about it in the meantime. The falsy if is just there to remember the eventual mapping.
    'cds.DateTime': 'Edm.DateTimeOffset', // (isV2 && false) ? 'Edm.DateTime'
    'cds.Timestamp': 'Edm.DateTimeOffset', // (isV2 && false) ? 'Edm.DateTime'
    'cds.Boolean': 'Edm.Boolean',
    'cds.UUID': 'Edm.Guid',
    'cds.hana.ST_POINT': 'Edm.GeometryPoint',
    'cds.hana.ST_GEOMETRY': 'Edm.Geometry',
    /* unused but EDM defined
    Edm.Geography
    Edm.GeographyPoint
    Edm.GeographyLineString
    Edm.GeographyPolygon
    Edm.GeographyMultiPoint
    Edm.GeographyMultiLineString
    Edm.GeographyMultiPolygon
    Edm.GeographyCollection    Edm.GeometryLineString
    Edm.GeometryPolygon
    Edm.GeometryMultiPoint
    Edm.GeometryMultiLineString
    Edm.GeometryMultiPolygon
    Edm.GeometryCollection
    */
  }[cdsType];
  if (edmType == undefined) {
    error(null, csn.$path, { type: cdsType }, `No EDM type available for $(TYPE)`);
  }
  if(isV2)
  {
    if (edmType === 'Edm.Date')
      edmType = 'Edm.DateTime';
    if (edmType === 'Edm.TimeOfDay')
      edmType = 'Edm.Time';
    if(['cds.hana.ST_POINT', 'cds.hana.ST_GEOMETRY'].includes(cdsType)) {
      error(null, csn.$path, { type: cdsType }, `OData V2 does not support Geometry data types, $(TYPE) can't be mapped`);
    }
  }
  else // isV4
  {
    // CDXCORE-CDXCORE-173
    if(isMediaType)
      edmType = 'Edm.Stream';
  }
  return edmType;
}

function addTypeFacets(node, csn)
{
  const isV2 = node.v2;
  if (csn.length != null)
    node.MaxLength = csn.length;
  if (csn.scale !== undefined)
    node.Scale = csn.scale;
  // else if (csn.type === 'cds.hana.SMALLDECIMAL' && !isV2)
  //   node.Scale = 'floating';

  if (csn.precision != null)
    node.Precision = csn.precision;
  // else if (csn.type === 'cds.hana.SMALLDECIMAL' && !isV2)
  //   node.Precision = 16;
  else if (csn.type === 'cds.Timestamp' && node.Type === 'Edm.DateTimeOffset')
    node.Precision = 7;
  if([ 'cds.Decimal', 'cds.DecimalFloat', 'cds.hana.SMALLDECIMAL' ].includes(csn.type)) {
    if(isV2) {
      // no prec/scale or scale is 'floating'/'variable'
      if(!(csn.precision || csn.scale) || ['floating', 'variable'].includes(csn.scale)) {
        node.setXml( { 'sap:variable-scale': true } );
        delete node.Scale;
      }
    }
    else {
      // map both floating and variable to => variable
      if(node.Scale === 'floating')
        node.Scale = 'variable';
      if(!csn.precision && !csn.scale)
        // if Decimal has no p, s set scale 'variable'
        node.setXml( { Scale: 'variable' } ); // floating is V4.01
    }
  }
  // Unicode unused today
  if(csn.unicode)
    node.Unicode = csn.unicode;
  if(csn.srid)
    node.SRID = csn.srid;
}


  /**
   * A simple identifier is a Unicode character sequence with the following restrictions:
   * - The first character MUST be the underscore character (U+005F) or any character in the Unicode category “Letter (L)” or “Letter number (Nl)”
   * - The remaining characters MUST be the underscore character (U+005F) or any character in the Unicode category:
   *   “Letter (L)”,
   *   “Letter number (Nl)”,
   *   “Decimal number (Nd)”,
   *   “Non-spacing mark (Mn)”,
   *   “Combining spacing mark (Mc)”,
   *   “Connector punctuation (Pc)”,
   *   “Other, format (Cf)”
   * source: https://docs.oasis-open.org/odata/odata-csdl-xml/v4.01/os/odata-csdl-xml-v4.01-os.pdf#page=75
   *
   * @param {string} identifier
   */
function isODataSimpleIdentifier(identifier){
  // this regular expression reflects the specifiation from above
  const regex = /^[\p{Letter}\p{Nl}_]{1}[_\p{Letter}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Cf}]{0,127}$/gu
  return identifier && identifier.match(regex);
}

function escapeString(str) {
  // first regex: replace & if not followed by apos; or quot; or gt; or lt; or amp; or #
  // Do not always escape > as it is a marker for {i18n>...} translated string values
  let result = str;
  if (typeof str === 'string') {
    result = str.replace(/&(?!(?:apos|quot|[gl]t|amp);|#)/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;')
      .replace(/\r\n|\n/g, '&#xa;');
    if (!result.startsWith('{i18n>') && !result.startsWith('{bi18n'))
      result = result.replace(/>/g, '&gt;')
  }
  return result;
}

// return the path prefix of a given name or if no prefix available 'root'
function getSchemaPrefix(name) {
  const lastDotIdx = name.lastIndexOf('.');
  return (lastDotIdx > 0 ) ? name.substring(0, lastDotIdx) : 'root';
}

// get artifacts base name
function getBaseName(name) {
  const lastDotIdx = name.lastIndexOf('.');
  return (lastDotIdx > 0 ) ? name.substring(lastDotIdx+1, name.length) : name;
}

// This is a poor mans path resolver for $self partner paths only
function resolveOriginAssoc(csn, env, path) {
  for(let i = 0; i < path.length; i++) {
    let elements = (env.items && env.items.elements || env.elements);
    if(elements)
      env = env.elements[path[i]];
    let type = (env.items && env.items.type || env.type);
    if(type && !isBuiltinType(type) && !(env.items && env.items.elements || env.elements))
      env = csn.definitions[env.type];
  }
  return env;
}

module.exports = {
  validateOptions,
  intersect,
  foreach,
  forAll,
  isContainee,
  isAssociation,
  isManagedAssociation,
  isComposition,
  isAssociationOrComposition,
  isToMany,
  isSingleton,
  isEntity,
  isStructuredType,
  isStructuredArtifact,
  isParameterizedEntity,
  isDerivedType,
  isActionOrFunction,
  resolveOnConditionAndPrepareConstraints,
  finalizeReferentialConstraints,
  determineMultiplicity,
  mapCdsToEdmType,
  addTypeFacets,
  isODataSimpleIdentifier,
  escapeString,
  getSchemaPrefix,
  getBaseName
}
