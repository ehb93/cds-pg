'use strict';

/* eslint max-lines:off */
/* eslint max-statements-per-line:off */

const NAVPROP_TRENNER = '_';
const VALUELIST_NAVPROP_PREFIX = '';

const edmUtils = require('./edmUtils.js')
const { initializeModel } = require('./edmPreprocessor.js');
const translate = require('./annotations/genericTranslation.js');
const { setProp } = require('../base/model');
const { cloneCsn, isEdmPropertyRendered, isBuiltinType } = require('../model/csnUtils');
const { checkCSNVersion } = require('../json/csnVersion');
const { makeMessageFunction } = require('../base/messages');

/*
OData V2 spec 06/01/2017 PDF version is available from here:
https://msdn.microsoft.com/en-us/library/dd541474.aspx
*/

function csn2edm(_csn, serviceName, _options) {
  return csn2edmAll(_csn, _options, [ serviceName ])[ serviceName ];
}

function csn2edmAll(_csn, _options, serviceNames=undefined) {
  // get us a fresh model copy that we can work with
  const csn = cloneCsn(_csn, _options);

  // use original options for messages; cloned CSN for semantic location
  const messageFunctions = makeMessageFunction(csn, _options, 'to.edmx');
  const { info, warning, error, message, throwWithError } = messageFunctions;
  checkCSNVersion(csn, _options);

  let rc = Object.create(null);

  // Currently, the cloneCsn keeps only the creator from the csn.meta.
  // There is the need to assign the odata options because we would like to determine
  // whether to execute toFinalBaseType in the edmPreprocessor or not
  if (_csn.meta && _csn.meta.transformation === 'odata' && _csn.meta.options) {
    if (!csn.meta) setProp(csn, 'meta', Object.create(null));
    setProp(csn.meta, 'options', _csn.meta.options);
  }

  let [ allServices,
    allSchemas,
    whatsMyServiceRootName,
    options ] = initializeModel(csn, _options, messageFunctions);

  const Edm = require('./edm.js')(options, error);

  const v = options.v;
  if(Object.keys(allServices).length === 0) {
    info(null, null, `No Services in model`);
    return rc;
  }

  if(serviceNames === undefined)
    serviceNames = options.serviceNames;
  if(serviceNames) {
    serviceNames.forEach(name => {
      let serviceCsn = allServices[name];
      if(serviceCsn == undefined) {
        warning(null, null, { name }, 'No service definition with name $(NAME) found in the model');
      }
      else {
        rc[name] = createEdm(serviceCsn);
      }
    });
  }
  else {
    rc = Object.values(allServices).reduce((services, serviceCsn) => {
      services[serviceCsn.name] = createEdm(serviceCsn);
      return services; }, rc);
  }
  throwWithError();
  return rc;

  //--------------------------------------------------------------------------------
  // embedded functions
  //--------------------------------------------------------------------------------
  function createEdm(serviceCsn) {

    function baseName(str, del) { let l = str.lastIndexOf(del);   // eslint-disable-line no-unused-vars
      return (l >= 0) ? str.slice(l+del.length, str.length) : str; }

    // if we have a real alias take it, otherwise use basename of service
    // let alias = serviceCsn.alias || baseName(baseName(serviceCsn.name, '::'), '.');
    // FIXME: UI5 cannot deal with spec conforming simpleid alias names

    const service = new Edm.DataServices(v);
    /** @type {object} */
    const edm = new Edm.Edm(v, service);

    /* -------------------------------------------------
      Multi Schema generation in V4:

      If a service contains nested contexts (exactly one level)!
      then these contexts are interpreted as additional schemas:

      service MainSchema {
        entity A { toD: association to SideSchema1.D; };
        context SideSchema1 {
          entity D {};
        }
        context SideSchema2 {
          ...
        }
      };

      Only the main schema has an entity container
      Nested definitions are identified by their name in
      definitions:

      MainSchema.A: {},
      MainSchema.SideSchema1.D: {},
      MainSchema.SideSchema2....

      This requires that the names of all members
      of the side elements must be stripped to reflect the
      schema local name (with single schema prefix).
      Also all schema members need to be grouped into
      their respective schemas.

      All type references inside the EDM sub nodes must
      also be rewritten to address the individual schema
      entries.
      -----------------------------------------------*/
    let LeadSchema;
    const fqSchemaXRef = [serviceCsn.name];
    const whatsMySchemaName = function(n) {
      return fqSchemaXRef.reduce((rc, sn) => !rc && n && n.startsWith(sn + '.') ? sn : rc, undefined);
    }

    // create schema containers
    const subSchemaDictionary = {
      [serviceCsn.name]: {
        name: serviceCsn.name,
        fqName: serviceCsn.name,
        _csn: serviceCsn,
        container: true,
        definitions: Object.create(null)
      }
    };
    
    if(options.isV4()) {
      // tunnel schema xref and servicename in options to edm.Typebase to rectify
      // type references that are eventually also prefixed with the service schema name.
      options.serviceName = serviceCsn.name;
      // List of all schema names in this service, including the service itself
      options.whatsMySchemaName = whatsMySchemaName;

      // Add additional schema containers as sub contexts to the service
      Object.entries(allSchemas).forEach(([fqName, art]) => {
        if(serviceCsn.name === whatsMyServiceRootName(fqName) &&
          fqName.startsWith(serviceCsn.name + '.') && art.kind === 'schema') {
          fqSchemaXRef.push(fqName);
          // Strip the toplevel service schema name (see comment above)
          const name = fqName.replace(serviceCsn.name + '.', '');
          subSchemaDictionary[name] = {
            name,
            fqName,
            _csn: art,
            container: false,
            definitions: Object.create(null)
          };
        }
      }, subSchemaDictionary);

      // Sort schema names in reverse order to allow longest match
      fqSchemaXRef.sort((a,b) => b.length-a.length);

      // Fill the schemas and references, fqSchemaXRef must be complete
      populateSchemas(subSchemaDictionary);
      const xServiceRefs = populateXserviceRefs();
      /* TODO:
      const references = Object.entries(allSchemas).reduce((references, [fqName, art]) => {
        // add references
        if(fqName.startsWith(serviceCsn.name + '.') && art.kind === 'reference') {
          fqSchemaXRef.push(fqName);
          references.push(art);
        }
        return references;
      }, []);
      */
      // Add xrefs to full schema cross ref list for further usage
      fqSchemaXRef.push(...xServiceRefs);
      fqSchemaXRef.sort((a,b) => b.length-a.length);

      // Bring the schemas in alphabetical order, service first, root last
      const sortedSchemaNames = Object.keys(subSchemaDictionary).filter(n => n !== 'root' && n !== serviceCsn.name).sort();
      if(subSchemaDictionary.root)
        sortedSchemaNames.push('root');

      // Finally create the schemas and register them in the service.
      LeadSchema = createSchema(subSchemaDictionary[serviceCsn.name]);
      service.registerSchema(serviceCsn.name, LeadSchema);

      sortedSchemaNames.forEach(name => {
        const schema = subSchemaDictionary[name];
        service.registerSchema(schema.fqName, createSchema(schema));
      });

      // Add cross service references to the EDM
      xServiceRefs.forEach(ref => {
        let r = new Edm.Reference(v, ref.ref);
        r.append(new Edm.Include(v, ref.inc))
        edm._defaultRefs.push(r);
      });
    }
    else {
      populateSchemas(subSchemaDictionary);
      LeadSchema = createSchema(subSchemaDictionary[serviceCsn.name]);
      service.registerSchema(serviceCsn.name, LeadSchema);
    }

    /*
      EntityContainer duplicate check
    */
    service._children.forEach(c => {
      c._ec && Object.entries(c._ec._registry).forEach((([setName, arr]) => {
        if(arr.length > 1) {
          error(null, null, { name: c.Namespace, id: setName },
          `Namespace $(NAME): Duplicate entries in EntityContainer with Name=$(ID) for ${arr.map(a =>a.getDuplicateMessage()).join(', ')} `);
        }
      }));
    });
    // Create annotations and distribute into Schemas
    addAnnotations();
    return edm

    // Sort definitions into their schema container
    function populateSchemas(schemas) {
      Object.entries(csn.definitions).forEach(([fqName, art]) => {
        // Identify service members by their definition name only, this allows
        // to let the internal object.name have the sub-schema name.
        // With nested services we must do a longest path match and check wether
        // the current definition belongs to the current toplevel service definition.

        // Definition is to be considered if
        // its name has a schema prefix and it's not a schema defining context
        // and its service root is the current service being generated
        let mySchemaName = whatsMySchemaName(fqName);
        // Add this definition to a (sub) schema, if it is not
        // a container (context, service) and
        // not marked to be ignored as schema member
        if(mySchemaName &&
           serviceCsn.name === whatsMyServiceRootName(fqName, false) &&
           ![ 'context', 'service' ].includes(art.kind)) {

          // Strip the toplevel serviceName from object.name
          // except if the schema name is the service name itself.
          // Proxy names are not prefixed, as they need to be reused.
          if(mySchemaName !== serviceCsn.name) {
            fqName = art.name = fqName.replace(serviceCsn.name + '.', '');
            mySchemaName = mySchemaName.replace(serviceCsn.name + '.', '');
          }
          schemas[mySchemaName].definitions[fqName] = art;
        }
      }, schemas);
    }

    // Fill xServiceRefs for Edm.Reference
    function populateXserviceRefs() {
      /*
        References into other Schemas

        References are top level elements in an EDM. However,
        they are valid per service only, so a special link
        object needs to be created that link into the target
        schema.

        Technically these are also contexts but with kind='reference'

        As they are not part of the official CSN spec, they are created
        transiently in the type/proxy exposure.

        ref = { kind: 'reference',
          name: targetSchemaName,
          ref: { Uri },
          inc: { Namespace: targetSchemaName, optionalAlias },
          $mySchemaName: targetSchemaName,
          $proxy: true
        };
      */

      return Object.entries(allSchemas).reduce((references, [fqName, art]) => {
        // add references
        if(art.kind === 'reference' && whatsMySchemaName(fqName) && serviceCsn.name === whatsMyServiceRootName(fqName, false)) {
          fqSchemaXRef.push(fqName);
          references.push(art);
        }
        return references;
      }, []);
    }

    // Main schema creator function
    function createSchema(schema) {
      /** @type {object} */

      // Same check for alias (if supported by us)
      const reservedNames = ['Edm', 'odata', 'System', 'Transient'];
      if(reservedNames.includes(schema.name)) {
        warning('odata-spec-violation-namespace',
                [ 'definitions', schema.name ], { names: reservedNames });
      }
      const Schema = new Edm.Schema(v, schema.name, undefined /* unset alias */, schema._csn, /* annotations */ [], schema.container);
      const EntityContainer = Schema._ec || (LeadSchema && LeadSchema._ec);
      // now namespace and alias are used to create the fullQualified(name)
      const schemaNamePrefix = schema.name + '.'
      const schemaAliasPrefix = schemaNamePrefix;
      const schemaCsn = schema;
      const navigationProperties = [];

      /* create the entitytypes and sets
        Do not create an entity set if:
            V4 containment: _containerEntity is set and not equal with the artifact name
            Entity starts with 'localserviceNameized.' or ends with '_localized'
      */
      edmUtils.foreach(schemaCsn.definitions,
        a => edmUtils.isEntity(a) && !a.abstract && a.name.startsWith(schemaNamePrefix),
        createEntityTypeAndSet
      );
      // create unbound actions/functions
      edmUtils.foreach(schemaCsn.definitions, a => edmUtils.isActionOrFunction(a) && a.name.startsWith(schemaNamePrefix),
        (options.isV4()) ? createActionV4 : createActionV2);

    // create the complex types
      edmUtils.foreach(schemaCsn.definitions,
      a => edmUtils.isStructuredType(a) && a.name.startsWith(schemaNamePrefix),
      createComplexType);

      if(options.isV4())
      {
        edmUtils.foreach(schemaCsn.definitions,
        artifact => edmUtils.isDerivedType(artifact) &&
        !edmUtils.isAssociationOrComposition(artifact) &&
        artifact.name.startsWith(schemaNamePrefix),
          createTypeDefinition);
      }

      // fetch all exising children names in a map
      const NamesInSchemaXRef = Schema._children.reduce((acc, cur) => {
        if(acc[cur.Name] === undefined) {
          acc[cur.Name] = [ cur ];
        } else {
          acc[cur.Name].push(cur);
        }
        return acc;
      }, Object.create(null) );

      navigationProperties.forEach(np => {
        if(options.isV4()) {
        // V4: No referential constraints for Containment Relationships
          if((!np.isContainment() || (options.renderForeignKeys)) && !np.isToMany())
            np.addReferentialConstraintNodes();
        }
        else {
          addAssociation(np);
        }
      });

      // remove EntityContainer if empty
      if(Schema._ec && Schema._ec._children.length === 0) {
        Schema._children.splice(Schema._children.indexOf(Schema._ec), 1);
      }
      if(Schema._children.length === 0) {
        // FIXME: Location for sub schemas?
        warning(null, ['definitions', Schema.Namespace], { name: Schema.Namespace }, 'Schema $(NAME) is empty');
      }

      Object.entries(NamesInSchemaXRef).forEach(([name, refs]) => {
        if(refs.length > 1) {
          error(null, ['definitions', `${Schema.Namespace}.${name}`], { name: Schema.Namespace },
          'Duplicate name in Schema $(NAME)');
        }
      });

      return Schema;

      function createEntityTypeAndSet(entityCsn)
      {
        const EntityTypeName = entityCsn.name.replace(schemaNamePrefix, '');
        const EntitySetName = edmUtils.getBaseName(entityCsn.$entitySetName || entityCsn.name);

        const [ properties, hasStream ] = createProperties(entityCsn);

        const loc = ['definitions', entityCsn.name];
        const type = `${schema.name}.${EntityTypeName}`;
        if(properties.length === 0) {
          warning(null, loc, { type }, 'EDM EntityType $(TYPE) has no properties');
        } else if(entityCsn.$edmKeyPaths.length === 0) {
          warning(null, loc, { type }, 'EDM EntityType $(TYPE) has no primary key');
        }
        properties.forEach(p => {
          const pLoc = [...loc, 'elements', p.Name];
          if(!p[p._typeName]) {
            message('odata-spec-violation-type', pLoc);
          }
          if(p.Name === EntityTypeName) {
            warning('odata-spec-violation-property-name', pLoc, { kind: entityCsn.kind });
          }
          if(options.isV2() && p._isCollection && !edmUtils.isAssociationOrComposition(p._csn)) {
            warning('odata-spec-violation-array', pLoc, { api: 'OData V2' });
          }
        });

        // construct EntityType attributes
        const attributes = { Name : EntityTypeName };

        // CDXCORE-CDXCORE-173
        if(options.isV2() && hasStream)
          attributes['m:HasStream'] = hasStream;

        Schema.append(new Edm.EntityType(v, attributes, properties, entityCsn));

        if (EntityContainer && entityCsn.$hasEntitySet)
        {
          /** @type {object} */
          let containerEntry;

          if(edmUtils.isSingleton(entityCsn, options.isV4())) {
            containerEntry = new Edm.Singleton(v, { Name: EntitySetName, Type: fullQualified(EntityTypeName) }, entityCsn);
            if(entityCsn['@odata.singleton.nullable'])
              containerEntry.Nullable= true;
          }
          else {
            containerEntry = new Edm.EntitySet(v, { Name: EntitySetName, EntityType: fullQualified(EntityTypeName) }, entityCsn);
          }

          // V4: Create NavigationPropertyBinding in EntitySet
          if(options.isV4()) {
            entityCsn.$edmNPBs.forEach(npb => {
              containerEntry.append(new Edm.NavigationPropertyBinding(v, npb))
            });
          }
          EntityContainer.register(containerEntry);
        }

        // put actions behind entity types in Schema/EntityContainer
        edmUtils.forAll(entityCsn.actions, (a, n) => {
          (options.isV4()) ? createActionV4(a, n, entityCsn)
                          : createActionV2(a, n, entityCsn)
        });
      }

      // add bound/unbound actions/functions for V4
      function createActionV4(actionCsn, name, entityCsn=undefined)
      {
        const iAmAnAction = actionCsn.kind === 'action';

        const actionName = edmUtils.getBaseName(actionCsn.name);

        const attributes = { Name: actionName, IsBound : false };

        if(!iAmAnAction)
          attributes.IsComposable = false;

        /** @type {object} */
        const actionNode = (iAmAnAction) ? new Edm.Action(v, attributes)
                                      : new Edm.FunctionDefinition(v, attributes);

        // bpName is eventually used later for EntitySetPath
        const bpNameAnno = actionCsn['@cds.odata.bindingparameter.name'];
        const bpName = bpNameAnno !== undefined ? (bpNameAnno['='] || bpNameAnno) : 'in';

        if(entityCsn != undefined)
        {
          actionNode.IsBound = true;
          const bpType = fullQualified(entityCsn.name);
          // Binding Parameter: 'in' at first position in sequence, this is decisive!
          if(actionCsn['@cds.odata.bindingparameter.collection'])
            actionNode.append(new Edm.Parameter(v, { Name: bpName, Type: bpType, Collection:true } ));
          else
            actionNode.append(new Edm.Parameter(v, { Name: bpName, Type: bpType } ));
        }
        else if(EntityContainer)// unbound => produce Action/FunctionImport
        {
          /** @type {object} */
          const actionImport = iAmAnAction
            ? new Edm.ActionImport(v, { Name: actionName, Action : fullQualified(actionName) })
            : new Edm.FunctionImport(v, { Name: actionName, Function : fullQualified(actionName) });

          const rt = actionCsn.returns && ((actionCsn.returns.items && actionCsn.returns.items.type) || actionCsn.returns.type);
          if(rt) // add EntitySet attribute only if return type is a non abstract entity
          {
            const definition = schemaCsn.definitions[rt];
            if(definition && definition.kind === 'entity' && !definition.abstract)
            {
              actionImport.EntitySet = edmUtils.getBaseName(rt);
            }
          }
          EntityContainer.register(actionImport);
        }

        // Parameter Nodes
        edmUtils.forAll(actionCsn.params, (parameterCsn, parameterName) => {
          actionNode.append(new Edm.Parameter(v, { Name: parameterName }, parameterCsn ));
        });

        // return type if any
        if(actionCsn.returns) {
          actionNode._returnType = new Edm.ReturnType(v, actionCsn.returns);
          // if binding type matches return type add attribute EntitySetPath
          if(entityCsn != undefined && fullQualified(entityCsn.name) === actionNode._returnType._type) {
            actionNode.EntitySetPath = bpName;
          }
        }
        Schema.addAction(actionNode);
      }

      // add bound/unbound actions/functions for V2
      function createActionV2(actionCsn, name, entityCsn=undefined)
      {
        /** @type {object} */
        const functionImport = new Edm.FunctionImport(v, { Name: name.replace(schemaNamePrefix, '') } );

        // inserted now to maintain attribute order with old odata generator...
        /*
          V2 says (p33):
          * If the return type of FunctionImport is a collection of entities, the EntitySet
            attribute is defined.
          * If the return type of FunctionImport is of ComplexType or scalar type,
            the EntitySet attribute cannot be defined.
          The spec doesn't mention single ET: Ralf Handls confirmed that there is a gap
          in the spec and advised mention it as in V4
        */

        const actLoc = ['definitions', ...(entityCsn ? [entityCsn.name, 'actions', actionCsn.name] : [actionCsn.name])];
        const rt = actionCsn.returns && ((actionCsn.returns.items && actionCsn.returns.items.type) || actionCsn.returns.type);
        if(rt) // add EntitySet attribute only if return type is an entity
        {
          const defintion = schemaCsn.definitions[rt];
          if(defintion && edmUtils.isEntity(defintion))
          {
            functionImport.EntitySet = rt.replace(schemaNamePrefix, '');
          }
        }

        if(actionCsn.returns)
          functionImport.ReturnType = getReturnType(actionCsn);

        if(actionCsn.kind === 'function')
          functionImport.setXml( {'m:HttpMethod': 'GET' });
        else if(actionCsn.kind === 'action')
          functionImport.setXml( {'m:HttpMethod': 'POST'});

        if(entityCsn != undefined)
        {
          // Make bound function names always unique as per Ralf's recommendation
          functionImport.setXml( {'sap:action-for':  fullQualified(entityCsn.name) } );
          functionImport.Name = entityCsn.name.replace(schemaNamePrefix, '') + '_' + functionImport.Name;

          // Binding Parameter: Primary Keys at first position in sequence, this is decisive!
          // V2 XML: Nullable=false is set because we reuse the primary key property for the parameter
          edmUtils.foreach(entityCsn.elements,
            elementCsn => elementCsn.key && !edmUtils.isAssociationOrComposition(elementCsn),
            (elementCsn, elementName) => {
              functionImport.append(new Edm.Parameter(v, { Name: elementName }, elementCsn, 'In' ));
            }
          );
        }

        // is this still required?
        edmUtils.forAll(actionCsn, (v, p) => {
          if (p.match(/^@sap\./))
            functionImport.setXml( { ['sap:' + p.slice(5).replace(/\./g, '-')] : v });
        });
        // then append all other parameters
        // V2 XML: Parameters that are not explicitly marked as Nullable or NotNullable in the CSN must become Nullable=true
        // V2 XML spec does only mention default Nullable=true for Properties not for Parameters so omitting Nullable=true let
        // the client assume that Nullable is false.... Correct Nullable Handling is done inside Parameter constructor
        edmUtils.forAll(actionCsn.params, (parameterCsn, parameterName) => {
          const paramLoc = [...actLoc, 'params', parameterName];
          const param = new Edm.Parameter(v, { Name: parameterName }, parameterCsn, 'In' );
          if(!param._type.startsWith('Edm.') && !edmUtils.isStructuredType(csn.definitions[param._type])) {
            warning('odata-spec-violation-param', paramLoc, { api: 'OData V2' });
          }
          if(param._isCollection) {
            warning('odata-spec-violation-array', paramLoc, { api: 'OData V2' });
          }
          functionImport.append(param);
        });

        if(EntityContainer)
          EntityContainer.register(functionImport);

        function getReturnType(action)
        {
          // it is safe to assume that either type or items.type are set
          const returns = action.returns.items || action.returns;
          let type = returns.type;
          if(type){
            if(!isBuiltinType(type) && !['entity', 'view', 'type'].includes(csn.definitions[type].kind)){
              const returnsLoc = [ ...actLoc, 'returns'];
              warning('odata-spec-violation-returns', returnsLoc, { kind: action.kind, api: 'OData V2' });
            }
            type = edmUtils.mapCdsToEdmType(returns, messageFunctions, options.isV2());
          }

          if(action.returns._isCollection)
            type = `Collection(${type})`

          return type;
        }
      }

      /**
       * @param {object} elementsCsn
       * @param {object} edmParentCsn
       * @returns {[object[], boolean]} Returns a [ [ Edm Properties ], boolean hasStream ]:
       *                              array of Edm Properties
       *                              boolean hasStream : true if at least one element has @Core.MediaType assignment
       */
      function createProperties(elementsCsn, edmParentCsn=elementsCsn)
      {
        const props = [];
        let hasStream = false;
        edmUtils.forAll(elementsCsn.elements, (elementCsn, elementName) =>
        {
          if(elementCsn._edmParentCsn == undefined)
            setProp(elementCsn, '_edmParentCsn', edmParentCsn);

          if(!elementCsn._ignore) {
            if(edmUtils.isAssociationOrComposition(elementCsn))
            {
              // Foreign keys are part of the generic elementCsn.elements property creation

              // This is the V4 edmx:NavigationProperty
              // gets rewritten for V2 in addAssociations()

              // suppress navprop creation only if @odata.navigable:false is not annotated.
              // (undefined !== false) still evaluates to true
              if (!elementCsn._target.abstract && elementCsn['@odata.navigable'] !== false)
              {
                const navProp = new Edm.NavigationProperty(v, {
                  Name: elementName,
                  Type: elementCsn._target.name
                }, elementCsn);
                props.push(navProp);
                // save the navProp in the global array for late constraint building
                navigationProperties.push(navProp);
              }
            }
            // render ordinary property if element is NOT ...
            // 1) ... annotated @cds.api.ignore
            // 2) ... annotated @odata.foreignKey4 and odataFormat: structured

            else if(isEdmPropertyRendered(elementCsn, options))
            {
              // CDXCORE-CDXCORE-173
              // V2: filter  @Core.MediaType
              if ( options.isV2() && elementCsn['@Core.MediaType']) {
                // CDXCORE-CDXCORE-177:
                // V2: don't render element but add attribute 'm:HasStream="true' to EntityType
                // V4: render property type 'Edm.Stream'
                hasStream = true;
                info(null, ['definitions', elementsCsn.name], { name: elementsCsn.name, id: elementName, anno: '@Core.MediaType' },
                  '$(NAME): Property $(ID) annotated with $(ANNO) is removed from EDM in OData V2');

              } else {
                props.push(new Edm.Property(v, { Name: elementName }, elementCsn));
              }
            }
          }

        });
        return [ props, hasStream ];
      }

      function createComplexType(structuredTypeCsn)
      {
        // V4 attributes: Name, BaseType, Abstract, OpenType
        const attributes = { Name: structuredTypeCsn.name.replace(schemaNamePrefix, '') };

        const complexType = new Edm.ComplexType(v, attributes, structuredTypeCsn);
        const elementsCsn = structuredTypeCsn.items || structuredTypeCsn;
        const properties = createProperties(elementsCsn, structuredTypeCsn)[0];
        const loc = ['definitions', structuredTypeCsn.name];

        if(properties.length === 0) {
          warning(null, ['definitions', structuredTypeCsn.name], { name: structuredTypeCsn.name },
          'EDM ComplexType $(NAME) has no properties');
        }
        properties.forEach(p => {
          const pLoc = [ ...loc, ...(structuredTypeCsn.items ? ['items', 'elements'] : [ 'elements' ]), p.Name ];
          if(!p[p._typeName]) {
            message('odata-spec-violation-type', pLoc);
          }
          if(p.Name === complexType.Name) {
            warning('odata-spec-violation-property-name', pLoc, { kind: structuredTypeCsn.kind });
          }
          if(options.isV2()) {
            if(p._isCollection && !edmUtils.isAssociationOrComposition(p._csn)) {
              warning('odata-spec-violation-array', pLoc, { api: 'OData V2' });
            }
            if(edmUtils.isAssociationOrComposition(p._csn)) {
              warning('odata-spec-violation-assoc', pLoc, { api: 'OData V2' });
            }
          }
        });


        complexType.append(...(properties));

        Schema.append(complexType);
      }

      // V4 <TypeDefintion>
      function createTypeDefinition(typeCsn)
      {
        // derived types are already resolved to base types
        const props = { Name: typeCsn.name.replace(schemaNamePrefix, '') };
        const typeDef = new Edm.TypeDefinition(v, props, typeCsn );
        Schema.append(typeDef);
      }

      /*
      * addAssociation() constructs a V2 association.
      * In V4 all this has been simplified very much, the only thing actually left over is
      * <ReferentialConstriant> that is then a sub element to <NavigationProperty>.
      * However, referential constraints are substantially different to its V2 counterpart,
      * so it is better to reimplement proper V4 construction of<NavigationProperty> in a separate
      * function.
      *
      * This method does:
      * rewrite <NavigationProperty> attributes to be V2 compliant
      * add <Association> elements to the schema
      * add <End>, <ReferentialConstraint>, <Dependent> and <Principal> sub elements to <Association>
      * add <AssociationSet> to the EntityContainer for each <Association>
      */
      function addAssociation(navigationProperty)
      {
        let constraints = navigationProperty._csn._constraints;
        let parentName = navigationProperty._csn._edmParentCsn.name.replace(schemaNamePrefix, '');
        let plainAssocName = parentName + NAVPROP_TRENNER + navigationProperty.Name.replace(VALUELIST_NAVPROP_PREFIX, '');
        let assocName = plainAssocName;
        let i = 1;
        while(NamesInSchemaXRef[assocName] !== undefined) {
          assocName = plainAssocName + '_' + i++;
        }

        let fromRole = parentName;
        let toRole = navigationProperty.Type.replace(schemaAliasPrefix, ''); // <= navprops type should be prefixed with alias

        let fromEntityType = fromRole;
        let toEntityType = toRole;

        // The entity set name may not be the same as the type name (parameterized entities have
        // differing set names (<T>Parameters => <T>, <T>Type => <T>Set)
        let fromEntitySet = ( navigationProperty._csn._edmParentCsn.$entitySetName || fromEntityType).replace(schemaNamePrefix, '');
        let toEntitySet = (navigationProperty._targetCsn.$entitySetName || toEntityType).replace(schemaNamePrefix, '');

        // from and to roles must be distinguishable (in case of self association entity E { toE: association to E; ... })

        if(fromRole === toRole) {
          if(constraints._partnerCsn)
            fromRole += '1';
          else
            toRole += '1';
        }

        // add V2 attributes to navigationProperty
        navigationProperty.Relationship = fullQualified(assocName);
        navigationProperty.FromRole = fromRole;
        navigationProperty.ToRole = toRole;

        // remove V4 attributes
        if(navigationProperty.Type != undefined)
          delete navigationProperty.Type;
        if(navigationProperty.Partner != undefined)
          delete navigationProperty.Partner;
        if(navigationProperty.ContainsTarget != undefined)
          delete navigationProperty.ContainsTarget;

        /*
          If NavigationProperty is a backlink association (constraints._originAssocCsn is set), then there are two options:
          1) Counterpart NavigationProperty exists and is responsible to create the edm:Association element which needs to
            be reused by this backlink association. This is save because at this point of the processing all NavProps are created.
          2) Counterpart NavigationProperty does not exist (@odata.navigable:false), then the missing edm:Association element
            of the origin association needs to be created as if it would have been already available in case (1).
        */

        let reuseAssoc = false;
        let forwardAssocCsn = constraints._partnerCsn;
        if(forwardAssocCsn)
        {
          // This is a backlink, swap the roles and types, rewrite assocName
          [ fromRole, toRole ] = [ toRole, fromRole ];
          [ fromEntityType, toEntityType ] = [ toEntityType, fromEntityType ];
          [ fromEntitySet, toEntitySet ] = [ toEntitySet, fromEntitySet ];

          parentName = forwardAssocCsn._edmParentCsn.name.replace(schemaNamePrefix, '');
          assocName = plainAssocName = parentName + NAVPROP_TRENNER + forwardAssocCsn.name.replace(VALUELIST_NAVPROP_PREFIX, '');
          i = 1;
          while(NamesInSchemaXRef[assocName] !== undefined && !(NamesInSchemaXRef[assocName][0] instanceof Edm.Association)) {
            assocName = plainAssocName + '_' + i++;
          }

          navigationProperty.Relationship = fullQualified(assocName)

          reuseAssoc = !!forwardAssocCsn._NavigationProperty;
          constraints = forwardAssocCsn._constraints;
          constraints._multiplicity = edmUtils.determineMultiplicity(forwardAssocCsn);
        }

        if(reuseAssoc)
          return;

        // Create Association and AssociationSet if this is not a backlink association.
        // Store association at navigation property because in case the Ends must be modified
        // later by the partner (backlink) association
        const edmAssociation = new Edm.Association(v, { Name: assocName }, navigationProperty,
                                        [ fromRole, fullQualified(fromEntityType) ],
                                        [ toRole, fullQualified(toEntityType) ],
                                        constraints._multiplicity );
        if(NamesInSchemaXRef[assocName] === undefined) {
          NamesInSchemaXRef[assocName] = [ edmAssociation ];
        }
        else {
          NamesInSchemaXRef[assocName].push(edmAssociation);
        }
        // Add ReferentialConstraints if any
        if(!navigationProperty._isCollection && Object.keys(constraints.constraints).length > 0) {
          // A managed composition is treated as association
          if(navigationProperty._csn.type === 'cds.Composition' && navigationProperty._csn.on) {
            edmAssociation.append(Edm.ReferentialConstraint.createV2(v,
              toRole, fromRole, constraints.constraints));
          }
          else {
            edmAssociation.append(Edm.ReferentialConstraint.createV2(v,
              fromRole, toRole, constraints.constraints));
          }
        }

        Schema.append(edmAssociation);
        if(EntityContainer && !navigationProperty._targetCsn.$proxy) {
          const assocSet =  new Edm.AssociationSet(v, { Name: assocName, Association: fullQualified(assocName) },
            fromRole, toRole, fromEntitySet, toEntitySet);
          if(navigationProperty._csn._SetAttributes)
            assocSet.setSapVocabularyAsAttributes(navigationProperty._csn._SetAttributes);
          EntityContainer.register(assocSet);
        }
      }

      // produce a full qualified name replacing the namespace with the alias (if provided)
      function fullQualified(name)
      {
        return schemaAliasPrefix + name.replace(schemaNamePrefix, '')
      }
    }

    // generate the Edm.Annotations tree and append it to the corresponding schema
    function addAnnotations() {
      let { annos, usedVocabularies } = translate.csn2annotationEdm(csn, serviceCsn.name, Edm, options, messageFunctions);
      // distribute edm:Annotations into the schemas
      // Distribute each anno into Schema
      annos.forEach(anno => {
        let targetSchema = whatsMySchemaName(anno.Target);
        // if no target schema has been found, it's a service annotation that applies to the service schema
        if(targetSchema === undefined)
          targetSchema = serviceCsn.name;
        if(targetSchema) {
          if(targetSchema !== serviceCsn.name) {
            anno.Target = anno.Target.replace(serviceCsn.name + '.', '');
          }
          edm._service._schemas[targetSchema]._annotations.push(anno);
        }
      });
      annos = [];
      // add references for the used vocabularies
      usedVocabularies.forEach(voc => {
        let r = new Edm.Reference(v, voc.ref);
        r.append(new Edm.Include(v, voc.inc))
        edm._defaultRefs.push(r);
      })
    }
  }
}
module.exports = { csn2edm, csn2edmAll };
