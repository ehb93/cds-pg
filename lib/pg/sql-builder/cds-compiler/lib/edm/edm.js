// @ts-nocheck

'use strict'

const edmUtils = require('./edmUtils.js');
const { isBuiltinType } = require('../model/csnUtils.js');

module.exports = function (options, error) {
  class Node
  {
    constructor(v, attributes=Object.create(null), csn=undefined)
    {
      if(!attributes || typeof attributes !== 'object')
        error(null, 'Please debug me: attributes must be a dictionary');
      if(!Array.isArray(v))
        error(null, 'Please debug me: v is either undefined or not an array: ' + v);
      if(v.filter(v=>v).length != 1)
        error(null, 'Please debug me: exactly one version must be set');
      Object.assign(this, attributes);
      this.set({ _children: [], _xmlOnlyAttributes: Object.create(null), _jsonOnlyAttributes: Object.create(null), _v: v, _ignoreChildren: false });

      if(this.v2)
        this.setSapVocabularyAsAttributes(csn);
    }

    get v2() { return this._v[0] }
    get v4() { return this._v[1] }

    get kind() {
      return this.constructor.name
    }

    // set's additional properties that are invisible for the iterators
    set(attributes)
    {
      if(!attributes || typeof attributes !== 'object')
        error(null, 'Please debug me: attributes must be a dictionary');
      let newAttributes = Object.create(null);
      edmUtils.forAll(attributes, (value, p) => {
        newAttributes[p] = {
          value,
          configurable: true,
          enumerable: false,
          writable: true
        }
      });
      return Object.defineProperties(this, newAttributes)
    }

    // set properties that should only appear in the XML representation
    setXml(attributes)
    {
      if(!attributes || typeof attributes !== 'object')
        error(null, 'Please debug me: attributes must be a dictionary');
      return Object.assign(this._xmlOnlyAttributes, attributes);
    }

    // set properties that should only appear in the JSON representation
    // today JSON attributes are not rendered in toJSONattributes()
    setJSON(attributes)
    {
      if(!attributes || typeof attributes !== 'object')
        error(null, 'Please debug me: attributes must be a dictionary');
      return Object.assign(this._jsonOnlyAttributes, attributes);
    }

    prepend(...children)
    {
      this._children.splice(0, 0, ...children.filter(c => c));
    }
    append(...children)
    {
      // remove undefined entries
      this._children.push(...children.filter(c => c));
      return this
    }

    // virtual
    toJSON()
    {
      let json = Object.create(null);
      // $kind Property MAY be omitted in JSON for performance reasons
      if(![ 'Property', 'EntitySet', 'ActionImport', 'FunctionImport', 'Singleton', 'Schema' ].includes(this.kind))
        json['$Kind'] = this.kind;

      this.toJSONattributes(json);
      this.toJSONchildren(json);
      return json
    }

    // virtual
    toJSONattributes(json)
    {
      edmUtils.forAll(this, (v,p) => {
        if (p !== 'Name')
          json[p[0] === '@' ? p : '$' + p] = v;
      });
      return json;
    }

    // virtual
    toJSONchildren(json)
    {
      // any child with a Name should be added by it's name into the JSON object
      // all others must overload toJSONchildren()
      this._children.filter(c => c.Name).forEach(c => json[c.Name] = c.toJSON());
    }

    // virtual
    toXML(indent = '', what='all')
    {
      let kind = this.kind;
      let head = indent + '<' + kind;

      if(kind=='Parameter' && this.Collection) {
        delete this.Collection;
        this.Type=`Collection(${this.Type})`;
      }

      head += this.toXMLattributes();

      let inner = this.innerXML(indent + '  ', what)
      if (inner.length < 1) {
        head += '/>'
      }
      else if (inner.length < 77 && inner.indexOf('<') < 0) {
        head += '>' + inner.slice(indent.length + 1, -1) + '</' + kind + '>'
      } else {
        head += '>\n' + inner + indent + '</' + kind + '>'
      }
      return head;
    }

    // virtual
    toXMLattributes()
    {
      let tmpStr = '';
      edmUtils.forAll(this, (v, p) => {
        if (typeof this[p] !== 'object')
          tmpStr += ' ' + p + '="' + edmUtils.escapeString(v) + '"'
      });
      edmUtils.forAll(this._xmlOnlyAttributes, (v,p) => {
        if (typeof v !== 'object')
          tmpStr += ' ' + p + '="' + edmUtils.escapeString(v) + '"'
      });
      return tmpStr;
    }

    // virtual
    innerXML(indent, what='all')
    {
      let xml = '';

      this._children.forEach(e =>
        xml += e.toXML(indent, what) + '\n');
      return xml;
    }

    // virtual
    setSapVocabularyAsAttributes(csn, useSetAttributes=false)
    {
      if(csn)
      {
        const attr = (useSetAttributes ? csn._SetAttributes : csn);
        edmUtils.forAll(attr, (v, p) => {
          if (p.match(/^@sap./))
            this.setXml( { ['sap:' + p.slice(5).replace(/\./g, '-')] : v } );
        });
      }
    }
  }

  class Reference extends Node
  {
    constructor(v, details)
    {
      super(v, details);
      if(this.v2)
        this['xmlns:edmx'] = 'http://docs.oasis-open.org/odata/ns/edmx';
    }

    get kind() { return 'edmx:Reference' }

    toJSON()
    {
      let json = Object.create(null);
      let includes = [];

      this._children.forEach(c => includes.push(c.toJSON()));
      if(includes.length > 0)
        json['$Include'] = includes;
      return json;
    }
  }

  class Include extends Node
  {
    get kind() { return 'edmx:Include' }
    toJSON()
    {
      let json = Object.create(null);
      return this.toJSONattributes(json);
    }
  }

  class Schema extends Node
  {
    constructor(v, ns, alias=undefined, serviceCsn=null, annotations=[], withEntityContainer=true)
    {
      let props = Object.create(null);
      props.Namespace = ns;
      if(alias != undefined)
        props.Alias = alias;
      super(v, props);
      this.set( { _annotations: annotations, _actions: Object.create(null) } );
      this.setXml( { xmlns: (this.v2) ? 'http://schemas.microsoft.com/ado/2008/09/edm' : 'http://docs.oasis-open.org/odata/ns/edm' } );

      if(this.v2 && serviceCsn)
        this.setSapVocabularyAsAttributes(serviceCsn);

      if(withEntityContainer)
      {
        let ecprops = { Name: 'EntityContainer' };
        let ec = new EntityContainer(v, ecprops, serviceCsn );
        if(this.v2)
          ec.setXml( { 'm:IsDefaultEntityContainer':  true } );
        // append for rendering, ok ec has Name
        this.append(ec);
        // set as attribute for later access...
        this.set({ _ec : ec })
      }
    }

    // hold actions and functions in V4
    addAction(action)
    {
      if(this._actions[action.Name])
        this._actions[action.Name].push(action);
      else
        this._actions[action.Name] = [action];
    }

    setAnnotations(annotations)
    {
      if(Array.isArray(annotations) && annotations.length > 0)
        this._annotations.push(...annotations);
    }

    innerXML(indent, what)
    {
      let xml = '';
      if(what=='metadata' || what=='all')
      {
        xml += super.innerXML(indent);
        edmUtils.forAll(this._actions, actionArray => {
          actionArray.forEach(action => {
            xml += action.toXML(indent, what) + '\n'; });
        });
      }
      if(what=='annotations' || what=='all')
      {
        if(this._annotations.length > 0) {
          this._annotations.filter(a => a.Term).forEach(a => xml += a.toXML(indent) + '\n');
          this._annotations.filter(a => a.Target).forEach(a => xml += a.toXML(indent) + '\n');
        }
      }
      return xml;
    }

    // no $Namespace
    toJSONattributes(json)
    {
      edmUtils.forAll(this, (v,p) => {
        if (p !== 'Name' && p !== 'Namespace')
          json[p[0] === '@' ? p : '$' + p] = v;
      });
    }

    toJSONchildren(json)
    {
      // 'edmx:DataServices' should not appear in JSON
      super.toJSONchildren(json);
      if(this._annotations.length > 0) {
        this._annotations.filter(a => a.Term).forEach(a => {
          Object.entries(a.toJSON()).forEach(([n, v]) => {
            json[n] = v;
          });
        });
        let json_Annotations = Object.create(null);
        this._annotations.filter(a => a.Target).forEach(a => json_Annotations[a.Target] = a.toJSON());
        if(Object.keys(json_Annotations).length)
          json['$Annotations'] = json_Annotations;
      }
      edmUtils.forAll(this._actions, (actionArray, actionName) => {
        json[actionName] = [];
        actionArray.forEach(action => {
          json[actionName].push(action.toJSON());
        });
      });

      return json;
    }

  }

  class DataServices extends Node
  {
    constructor(v)
    {
      super(v);
      this.set( { _schemas: Object.create(null) } );

      if(this.v2)
        this.setXml( { 'm:DataServiceVersion': '2.0' } )
    }

    get kind() { return 'edmx:DataServices'; }

    registerSchema(fqName, schema)
    {
      if(!this._schemas[fqName]) {
        this._schemas[fqName] = schema;
        super.append(schema);
      }
    }

    toJSONchildren(json)
    {
      // 'edmx:DataServices' should not appear in JSON
      this._children.forEach(s => json[s.Namespace] = s.toJSON());
      return json;
    }
  }

    /* <edmx:Edmx> must contain exactly one <edmx:DataServices> with 1..n <edm:Schema> elements
                  may contain 0..n <edmx:Reference> elements

      For Odata 1.0..3.0 EDMX is an independent container with its own version 1.0.
      The OData version can be found at the DataServices Version attribute.
      From OData 4.0 onwards, EDMX is no longer a separate 'container' object but
      is used for OData exclusively. Therefore the version attribute reflects the
      OData version
    */

  class Edm extends Node
  {
    constructor(v, service)
    {
      super(v, { Version : (v[1]) ? '4.0' : '1.0' });
      this.set( { _service: service, _defaultRefs: [] } );

      let xmlProps = Object.create(null);
      if(this.v4)
      {
        xmlProps['xmlns:edmx']   = 'http://docs.oasis-open.org/odata/ns/edmx';
      }
      else
      {
        xmlProps['xmlns:edmx'] = 'http://schemas.microsoft.com/ado/2007/06/edmx';
        xmlProps['xmlns:m']    = 'http://schemas.microsoft.com/ado/2007/08/dataservices/metadata';
        xmlProps['xmlns:sap']  = 'http://www.sap.com/Protocols/SAPData';
      }
      this.setXml(xmlProps);
    }

    get kind() { return 'edmx:Edmx' }

    hasAnnotations()
    {
      let rc = false;
      this._service._children.forEach(c =>
        { if(c._annotations.length > 0) rc = true; } )
      return rc;
    }

    getSchemaCount()
    {
      return this._service._children.length;
    }

    getAnnotations(schemaIndex=0)
    {
      if(this._service && this._service._children[schemaIndex])
        return this._service._children[schemaIndex]._annotations;
      else
        return undefined;
    }

    setAnnotations(annotations, schemaIndex=0)
    {
      if(this._service && this._service._children[schemaIndex])
        this._service._children[schemaIndex]._annotations = annotations;
    }

    toJSON()
    {
      let schema = this._service._children[0];

      let json = Object.create(null);
      json['$Version'] = this.Version;
      json['$EntityContainer'] = schema.Namespace + '.' + schema._ec.Name;

      let reference_json = Object.create(null);
      this._defaultRefs.forEach(r => reference_json[r.Uri] = r.toJSON());
      this._children.forEach(r => reference_json[r.Uri] = r.toJSON());

      if(Object.keys(reference_json).length)
        json['$Reference'] = reference_json;

      this._service.toJSONattributes(json);
      this._service.toJSONchildren(json);
      return json;
    }

    // all(default), metadata, annotations
    toXML(what='all')
    {
      let rc = '<?xml version="1.0" encoding="utf-8"?>\n';
      rc += `${super.toXML('', what)}`;
      return rc;
    }

    innerXML(indent, what)
    {
      let xml = '';

      if(this.v4 || (this.v2 && (what === 'all' || what === 'annotations')))
        this._defaultRefs.forEach(r => xml += r.toXML(indent) + '\n');
      this._children.forEach(e => xml += e.toXML(indent) + '\n');
      xml += this._service.toXML(indent, what) + '\n';
      return xml;
    }
  }

  class EntityContainer extends Node
  {
    constructor() {
      super(...arguments);
      this.set( { _registry: Object.create(null) } );
    }
    // use the _SetAttributes
    setSapVocabularyAsAttributes(csn)
    {
      super.setSapVocabularyAsAttributes(csn, true);
    }
    register(entry) {
      if(!this._registry[entry.Name])
        this._registry[entry.Name] = [entry];
      else
        this._registry[entry.Name].push(entry);
      super.append(entry);
    }
  }



  class Singleton extends Node
  {
    toJSONattributes(json)
    {
      edmUtils.forAll(this, (v,p) => {
        if (p !== 'Name')
        {
          if(p === 'EntityType') // it's $Type in json
            json['$Type'] = v;
          else
            json[p[0] === '@' ? p : '$' + p] = v;
        }
      });
      return json;
    }

    toJSONchildren(json)
    {
      let json_navPropBinding = Object.create(null);
      this._children.forEach(npb => json_navPropBinding[npb.Path] = npb.Target);
      if(Object.keys(json_navPropBinding).length > 0)
        json['$NavigationPropertyBinding'] = json_navPropBinding;

      return json;
    }

    getDuplicateMessage() {
      return `EntityType "${this.EntityType}"`
    }
  }

  class EntitySet extends Singleton
  {
    // use the _SetAttributes
    setSapVocabularyAsAttributes(csn)
    {
      super.setSapVocabularyAsAttributes(csn, true);
    }

    toJSONattributes(json)
    {
      //  OASIS ODATA-1231 $Collection=true
      json['$Collection']=true;
      return super.toJSONattributes(json);
    }
  }

  class Key extends Node
  {
    // keys is an array of [name] or [name, alias]
    constructor(v, keys)
    {
      super(v);
      if (keys && keys.length > 0)
      {
        keys.forEach(k => this.append(new PropertyRef(v, ...k)));
      }
    }

    toJSON()
    {
      let json = [];
      this._children.forEach(c => json.push(c.toJSON()));
      return json;
    }
  }

  /* Base class to Action/Function that provides
  overloaded XML and JSON rendering of parameters and
  return type. Parameters are _children.
  _returnType holds the eventually existing ReturnType in V4.
  In V2 the return type is a direct attribute called ReturnType
  to the FunctionImport. See comment in class FunctionImport.
  */

  class ActionFunctionBase extends Node
  {
    constructor(v, details)
    {
      super(v, details);
      this.set( { _returnType: undefined });
    }

    innerXML(indent)
    {
      let xml = super.innerXML(indent);
      if(this._returnType != undefined)
        xml += this._returnType.toXML(indent) + '\n';
      return xml
    }

    toJSONchildren(json)
    {
      let json_parameters = [];
      this._children.forEach(p => json_parameters.push(p.toJSON()));
      if(json_parameters.length > 0)
        json['$Parameter'] = json_parameters;
      if(this._returnType)
      {
        json['$ReturnType'] = this._returnType.toJSON();
      }
      return json;
    }
  }
  // FunctionDefinition should be named 'Function', but this would
  // collide with a method 'Function' of the Istanbul/NYC tool
  class FunctionDefinition extends ActionFunctionBase
  {
    get kind()  { return 'Function'; }
  }
  class Action extends ActionFunctionBase {}

  /* FunctionImport is derived from ActionFunctionBase
  because in V2 Parameters need to be rendered as sub elements
  to Function Import. The ReturnType property is set in the
  assembly code above (the invisible returnType is left undefined)
  */
  class FunctionImport extends Node {
    getDuplicateMessage() {
      return `Function "${this.Name}"`
    }
  } //ActionFunctionBase {}
  class ActionImport extends Node {
    getDuplicateMessage() {
      return `Action "${this.Name}"`
    }
  }

  class TypeBase extends Node
  {
    constructor(v, attributes, csn, typeName='Type')
    {
      if(!(csn instanceof Object || (typeof csn === 'object' && csn !== null)))
        error(null, 'Please debug me: csn must be an object');

      // ??? Is CSN still required? NavProp?
      super(v, attributes, csn);
      this.set({ _typeName: typeName });

      if(this[typeName] == undefined)
      {
        let typecsn = csn.type ? csn : (csn.items && csn.items.type ? csn.items : csn);
        // Complex/EntityType are derived from TypeBase
        // but have no type attribute in their CSN
        if(typecsn.type) { // this thing has a type
          // check wether this is a scalar type (or array of scalar type) or a named type
          let scalarType = undefined;
          if(typecsn.items && typecsn.items.type &&
            isBuiltinType(typecsn.items.type)) {
            scalarType = typecsn.items;
          }
          else if(isBuiltinType(typecsn.type)) {
            scalarType = typecsn;
          }
          if(scalarType) {
            this[typeName] = csn._edmType;
            // CDXCORE-CDXCORE-173 ignore type facets for Edm.Stream
            // cds-compiler/issues/7835: Only set length for Binary as long as it is
            // unclear how many bytes a string character represents.
            // We can't calculate an unambiguous byte stream length for DB dependent
            // multi-byte characters.
            if(!(this[typeName] === 'Edm.Stream' &&
               ![ /*'cds.String',*/ 'cds.Binary'].includes(scalarType.type)))
              edmUtils.addTypeFacets(this, scalarType);
          }
          else {
            this[typeName] = typecsn.type;
          }
          // CDXCORE-245:
          // map type to @odata.Type
          // optionally add @odata.MaxLength but only in combination with @odata.Type
          // In absence of checks restrict @odata.Type to 'Edm.String' and 'Edm.Int[16,32,64]'
          let odataType = csn['@odata.Type'];
          if(odataType === 'Edm.String')
          {
            this[typeName] = odataType;
            if(csn['@odata.MaxLength']) {
              this['MaxLength'] = csn['@odata.MaxLength'];
            }
          } else if(['Edm.Int16', 'Edm.Int32', 'Edm.Int64'].includes(odataType)) {
            this[typeName] = odataType;
          }
        }
      }
      // Set the collection property if this is either an element or a parameter
      if(csn.kind === undefined) {
        this.set({ _isCollection: csn._isCollection });
      }

      if(options.whatsMySchemaName && this[typeName]) {
        let schemaName = options.whatsMySchemaName(this[typeName]);
        if(schemaName && schemaName !== options.serviceName) {
          this[typeName] = this[typeName].replace(options.serviceName + '.', '');
        }
      }

      // store undecorated type for JSON
      this.set( { _type : this[typeName] });
      // decorate for XML (not for Complex/EntityType)
      if(this._isCollection)
        this[typeName] = `Collection(${this[typeName]})`
    }

    toJSONattributes(json)
    {
      // $Type Edm.String, $Nullable=false MAY be omitted
      // @ property and parameter for performance reasons
      if(this._type !== 'Edm.String' && this._type)   // Edm.String is default)
        json['$'+this._typeName] = this._type;

      edmUtils.forAll(this, (v,p) => {
        if (p !== 'Name' && p != this._typeName
          // remove this line if Nullable=true becomes default
          && !(p === 'Nullable' && v == false))
        {
          json[p[0] === '@' ? p : '$' + p] = v;
        }
      });

      if(this._isCollection)
        json['$Collection'] = this._isCollection;

      return json;

    }
  }

  class ComplexType extends TypeBase { }
  class EntityType extends ComplexType
  {
    constructor(v, details, properties, csn)
    {
      super(v, details, csn);
      this.append(...properties);
      const aliasXref = Object.create(null);

      csn.$edmKeyPaths.forEach(p => {
        const [alias, ...tail] = p[0].split('/').reverse();

        if(aliasXref[alias] === undefined)
          aliasXref[alias] = 0;
        else
          aliasXref[alias]++;
        // if it's a path, push the alias
        if(tail.length > 0)
          p.push(alias);
      });
      csn.$edmKeyPaths.slice().reverse().forEach(p => {
        let alias = p[1];
        if(alias)
        {
          const c = aliasXref[alias]--;
          // Limit Key length to 32 characters
          if(c > 0) {
            if(alias.length > 28) {
              alias = alias.substr(0, 13)+ '__' +alias.substr(alias.length-13, alias.length);
            }
            alias = alias+'_'+c.toString().padStart(3,0);
          }
          else if(alias.length > 32) {
            alias = alias.substr(0, 15)+ '__' +alias.substr(alias.length-15, alias.length);
          }
          p[1] = alias;
        }
      });

      if(csn.$edmKeyPaths && csn.$edmKeyPaths.length)
        this.set( { _keys: new Key(v, csn.$edmKeyPaths) } );
    }

    innerXML(indent)
    {
      let xml = '';
      if(this._keys)
        xml += this._keys.toXML(indent) + '\n';
      return xml + super.innerXML(indent);
    }

    toJSONattributes(json)
    {
      super.toJSONattributes(json);
      if(this._keys)
      {
        json['$Key'] = this._keys.toJSON();
      }
      return json;
    }
  }

  class TypeDefinition extends TypeBase
  {
    constructor(v, attributes, csn)
    {
      super(v, attributes, csn, 'UnderlyingType');
    }

    toJSONattributes(json)
    {
      super.toJSONattributes(json);
      json['$UnderlyingType'] = this._type;
      return json;
    }
  }

  class EnumType extends TypeDefinition
  {
    constructor(v, attributes, csn)
    {
      super(v, attributes, csn);

      // array of enum not yet allowed
      let enumValues = /*(csn.items && csn.items.enum) ||*/ csn.enum;
      edmUtils.forAll(enumValues, (e, en) =>  {
        this.append(new Member(v, { Name: en, Value: e.val } ));
      });
    }

    toJSONattributes(json)
    {
      super.toJSONattributes(json);
      return json;
    }

    toJSONchildren(json)
    {
      this._children.forEach(c => c.toJSONattributes(json));
      return json;
    }
  }

  class Member extends Node
  {
    toJSONattributes(json)
    {
      json[this.Name] = this.Value;
      return json;
    }
  }

  class PropertyBase extends TypeBase
  {
    constructor(v, attributes, csn)
    {
      super(v, attributes, csn);
      this.set({ _csn: csn });
      if(this.v2)
      {
        let typecsn = csn.items || csn;

        // see edmUtils.mapsCdsToEdmType => add sap:display-format annotation
        // only if Edm.DateTime is the result of a cast from Edm.Date
        // but not if Edm.DateTime is the result of a regular cds type mapping
        if(this.Type === 'Edm.DateTime'
        && (typecsn.type !== 'cds.DateTime' && typecsn.type !== 'cds.Timestamp'))
          this.setXml( { 'sap:display-format' : 'Date' } );

      }
      this.setNullable();
    }

    setNullable()
    {
      // From the Spec: In OData 4.01 responses a collection-valued property MUST specify a value for the Nullable attribute.
      if(this._isCollection) {
        this.Nullable = !this.isNotNullable();
      }
      // Nullable=true is default, mention Nullable=false only in XML
      // Nullable=false is default for EDM JSON representation 4.01
      // When a key explicitly (!) has 'notNull = false', it stays nullable
      else if(this.isNotNullable())
      {
        this.Nullable = false;
      }
    }

    isNotNullable(csn=undefined) {
      let nodeCsn = csn || this._csn;
      // Nullable=true is default, mention Nullable=false only in XML
      // Nullable=false is default for EDM JSON representation 4.01
      // When a key explicitly (!) has 'notNull = false', it stays nullable
      return (nodeCsn._NotNullCollection !== undefined ? nodeCsn._NotNullCollection :
        (nodeCsn.key && !(nodeCsn.notNull === false)) || nodeCsn.notNull === true);
    }

    toJSONattributes(json)
    {
      super.toJSONattributes(json);
      // mention all nullable elements explicitly, remove if Nullable=true becomes default
      if(this.Nullable === undefined || this.Nullable === true)
      {
        json['$Nullable'] = true;
      }
      return json;
    }
  }

  /* ReturnType is only used in v4, mapCdsToEdmType can be safely
  called with V2=false */
  class ReturnType extends PropertyBase
  {
    constructor(v, csn)
    {
      super(v, {}, csn);
    }

    // we need Name but NO $kind, can't use standard to JSON()
    toJSON()
    {
      let json = Object.create(null);
      this.toJSONattributes(json);
      // !this._nullable if Nullable=true become default
      if(this._nullable)
        json['$Nullable'] = this._nullable;
      return json;
    }
  }

  class Property extends PropertyBase
  {
    constructor(v, attributes, csn)
    {
      // the annotations in this array shall become exposed as Property attributes in
      // the V2 metadata.xml
      // @ts-ignore
      Property.SAP_Annotation_Attribute_WhiteList = [
        '@sap.hierarchy.node.for',                  //-> 	sap:hierarchy-node-for
        '@sap.hierarchy.parent.node.for',           // -> 	sap:hierarchy-parent-node-for
        '@sap.hierarchy.level.for',               	// -> 	sap:hierarchy-level-for
        '@sap.hierarchy.drill.state.for',           // -> 	sap:hierarchy-drill-state-for
        '@sap.hierarchy.node.descendant.count.for'	// -> 	sap:hierarchy-node-descendant-count-for
      ];

      super(v, attributes, csn);
      // TIPHANACDS-4180
      if(this.v2)
      {
        if(csn['@odata.etag'] == true || csn['@cds.etag'] == true)
          this.ConcurrencyMode='Fixed'

        // translate the following @sap annos as xml attributes to the Property
        edmUtils.forAll(csn, (v, p) => {
          // @ts-ignore
          if (Property.SAP_Annotation_Attribute_WhiteList.includes(p))
            this.setXml( { ['sap:' + p.slice(5).replace(/\./g, '-')] : v });
        });
      }

      // OData only allows simple values, no complex expressions or function calls
      // This is a poor man's expr renderer, assuming that edmPreprocessor has
      // added a @Core.ComputedDefaultValue for complex defaults
      if (csn.default && !csn['@Core.ComputedDefaultValue']) {

        let def = csn.default;
        // if def has a value, it's a simple value
        let defVal = def.val;
        // if it's a simple value with signs, produce a string representation
        if(csn.default.xpr) {
          defVal = csn.default.xpr.map(i => {
            if(i.val !== undefined) {
              if(csn.type === 'cds.Boolean')
                return i.val ? 'true' : 'false';
              return i.val;
            }
            return i;
          }).join('');
        }
        // complex values should be marked with @Core.ComputedDefaultValue already in the edmPreprocessor
        if(defVal !== undefined) {
          /* No Default Value rendering in V2 (or only with future flag).
            Reason: Fiori UI5 expects 'Default' under extension namespace 'sap:'
            Additionally: The attribute is named 'Default' in V2 and 'DefaultValue' in V4
          */
          if(this.v4)
            this[`Default${this.v4 ? 'Value' : ''}`] = ['cds.Boolean', 'cds.Binary', 'cds.LargeBinary', 'cds.Integer64', 'cds.Integer'].includes(csn.type)
          ? defVal
          : edmUtils.escapeString(defVal);
        }
      }
    }

    // required for walker to identify property handling....
    // static get isProperty() { return true }
  }

  class PropertyRef extends Node
  {
    constructor(v, Name, Alias) {
      super(v, (Alias) ? { Name, Alias } : { Name });
    }

    toJSON() {
      return this.Alias ? { [this.Alias]:this.Name } : this.Name;
    }
  }

  class Parameter extends PropertyBase
  {
    constructor(v, attributes, csn={}, mode=null)
    {
      super(v, attributes, csn);

      if(mode != null)
        this.Mode = mode;

      // V2 XML: Parameters that are not explicitly marked as Nullable or NotNullable in the CSN must become Nullable=true
      // V2 XML Spec does only mention default Nullable=true for Properties not for Parameters so omitting Nullable=true let
      // the client assume that Nullable is false.... Correct Nullable Handling is done inside Parameter constructor
      if(this.v2 && this.Nullable === undefined)
        this.setXml({Nullable: true});
    }

    toJSON()
    {
      // we need Name but NO $kind, can't use standard to JSON()
      let json = Object.create(null);
      json['$Name'] = this.Name;
      return this.toJSONattributes(json);
    }
  }

  class NavigationPropertyBinding extends Node {}

  class NavigationProperty extends Property
  {
    constructor(v, attributes, csn)
    {
      super(v, attributes, csn);

      let [src, tgt] = edmUtils.determineMultiplicity(csn._constraints._partnerCsn || csn);
      csn._constraints._multiplicity = csn._constraints._partnerCsn ? [tgt, src] : [src, tgt];

      this.set( {
        _type: attributes.Type,
        _isCollection: this.isToMany(),
        _targetCsn: csn._target
      } );

      if (this.v4)
      {
        // either csn has multiplicity or we have to use the multiplicity of the backlink
        if(this._isCollection) {
          this.Type = `Collection(${attributes.Type})`
          // attribute Nullable is not allowed in combination with Collection (see Spec)
          // Even if min cardinality is > 0, remove Nullable, because the implicit OData contract
          // is that a navigation property must either return an empty collection or all collection
          // values are !null (with other words: a collection must never return [1,2,null,3])
          delete this.Nullable;
        }
        // we have exactly one selfReference or the default partner
        let partner = (!csn.$noPartner && csn._selfReferences.length === 1) ? csn._selfReferences[0] : csn._constraints._partnerCsn;
        if(partner && partner['@odata.navigable'] !== false) {
          // $abspath[0] is main entity
          this.Partner = partner.$abspath.slice(1).join(options.pathDelimiter);
        }

        /*
          1) If this navigation property belongs to an EntityType for a parameterized entity
          ```entity implemented in calcview (P1: T1, ..., Pn: Tn) { ... }```
          and if the csn.containsTarget for this NavigationProperty is true,
          then this is the generated 'Results' association to the underlying entityType.
          Only this special association may have an explicit ContainsTarget attribute.
          See csn2edm.createParmeterizedEntityTypeAndSet() for details
          2) ContainsTarget stems from the @odata.contained annotation
        */
        if(csn['@odata.contained'] == true || csn.containsTarget) {
          this.ContainsTarget = true;
        }
        if(this.ContainsTarget === undefined && csn.type === 'cds.Composition') {
          // Delete is redundant in containment
          // TODO: to be specified via @sap.on.delete
          this.append(new OnDelete(v, { Action: 'Cascade' } ) );
        }

      }

      if (this.v2 && this.isNotNullable()) {
          // in V2 not null must be expressed with target cardinality of 1 or more,
          // store Nullable=false and evaluate in determineMultiplicity()
        delete this.Nullable;
      }

      // store NavProp reference in the model for bidirectional $Partner tagging (done in getReferentialConstraints())
      csn._NavigationProperty = this;
    }

    // if the backlink association is annotated with @odata.contained or the underlying association
    // is marked with _isToContainer, then the association is a Containment relationship
    isContainment() {
      return this._csn._isToContainer || this._csn['@odata.contained'];
    }

    isNotNullable(csn=undefined) {
      let nodeCsn = csn || this._csn;
      // Set Nullable=false only if 'NOT NULL' was specified in the model
      // Do not derive Nullable=false from key attribute.
      // If an unmanaged association has a cardinality min === max === 1 => Nullable=false
      // If unmanaged assoc has min > 0 and max > 1 => target is 'Collection()' => Nullable is not applicable
      return (nodeCsn.notNull === true || (nodeCsn.on && nodeCsn.cardinality && nodeCsn.cardinality.min === 1 && nodeCsn.cardinality.max === 1));
    }
    isToMany() {
      return (this._isCollection || this._csn._constraints._multiplicity[1] === '*');
    }

    toJSONattributes(json)
    {
      // use the original type, not the decorated one
      super.toJSONattributes(json);
      json['$Type'] = this._type;

      // attribute Nullable is not allowed in combination with Collection (see Spec)
      if(json['$Collection'])
        delete json['$Nullable'];
      return json;
    }

    toJSONchildren(json)
    {
      let json_constraints = Object.create(null);
      this._children.forEach(c => {
        switch(c.kind) {
          case 'ReferentialConstraint':
            // collect ref constraints in dictionary
            json_constraints[c.Property] = c.ReferencedProperty;
            break;
          case 'OnDelete':
            json['$OnDelete'] = c.Action;
            break;
          default:
            error(null, 'Please debug me: Unhandled NavProp child: ' + c.kind);

        }
      });
      // TODO Annotations
      if(Object.keys(json_constraints).length > 0)
        json['$ReferentialConstraint'] = json_constraints;
      return json;
    }

    // V4 referential constraints!
    addReferentialConstraintNodes()
    {
      // flip the constrains if this is a $self partner
      let _constraints = this._csn._constraints;
      let [i,j] = [0,1];
      if(this._csn._constraints._partnerCsn) {
        _constraints = this._csn._constraints._partnerCsn._constraints;
        [i,j] = [1,0];
      }
      edmUtils.forAll(_constraints.constraints,
        c => this.append(new ReferentialConstraint(this._v,
        { Property: c[i].join(options.pathDelimiter), ReferencedProperty: c[j].join(options.pathDelimiter) } ) ) );
    }
  }

  class ReferentialConstraint extends Node
  {
    innerXML(indent)
    {
      if(this._d && this._p)
      {
        return this._p.toXML(indent) + '\n' + this._d.toXML(indent) + '\n';
      }
      else
        return super.innerXML(indent);
    }
  }

  class OnDelete extends Node {}

  // Annotations below
  class AnnotationBase extends Node
  {
    // No Kind: AnnotationBase is base class for Thing and ValueThing with dynamic kinds,
    // this requires an explicit constructor as the kinds cannot be blacklisted in
    // Node.toJSON()
    toJSON()
    {
      let json = Object.create(null);
      this.toJSONattributes(json);
      this.toJSONchildren(json);
      return json
    }

    getConstantExpressionValue()
    {
      // short form: key: value
      const inlineConstExpr =
        [ 'Edm.Binary', 'Edm.Boolean', 'Edm.Byte', 'Edm.Date', 'Edm.DateTimeOffset',  'Edm.Decimal', 'Edm.Double', 'Edm.Duration', 'Edm.Guid',
          'Edm.Int16', 'Edm.Int32', 'Edm.Int64', 'Edm.SByte','Edm.Single', /*'Edm.Stream',*/ 'Edm.String', 'Edm.TimeOfDay',
          /* UI.xml: defines Annotations with generic type 'Edm.PrimitiveType' */
          'Edm.PrimitiveType', 'Bool'
          // Official JSON V4.01 Spec defines these paths as constant inline expression (OKRA requires them as explicit exprs):
          // 'AnnotationPath', 'ModelElementPath', 'NavigationPropertyPath', 'PropertyPath',
        ];

      const dict = this._jsonOnlyAttributes;
      const inline = edmUtils.intersect(Object.keys(dict), inlineConstExpr);
      if(inline.length === 1)
      {
        let v = dict[inline[0]];
        switch(inline[0])
        {
          /* short notation for Edm.Boolean, Edm.String and Edm.Float, see internal project:
              edmx2csn-npm/edm-converters/blob/835d92a1aa6b0be25c56cef85e260c9188187429/lib/edmxV40ToJsonV40/README.md
            */
          case 'Edm.Boolean': 
            v = (v=='true'?true:(v=='false'?false:v));
            // eslint-no-fallthrough
          case 'Edm.String':
            // eslint-no-fallthrough
          case 'Edm.Float':
            // eslint-no-fallthrough
            return v;
          default:
            // OKRA requires this for JSON->XML mapping
            // because they didn't want to lookup the type in the vocabulary
            return { '$Cast': v, '$Type': inline[0] };
        }
      }
      else
      {
        // if this is not a constant expression shortcut, render key/value pair verbatim
        // without filtering non-spec-compliant constExpr
        let json = Object.create(null);
        Object.entries(dict).forEach(([k,v]) => {
          json['$'+k] = v;
        });
        return json;
      }
    }

    mergeJSONAnnotations(prefix='') {
      return this._children.filter(c => c.kind === 'Annotation').reduce((o, a) => {
        Object.entries(a.toJSON()).forEach(([n, v]) => {
          o[prefix+n] = v;
        });
        return o; },
        Object.create(null));
    }
  }

  class Annotations extends AnnotationBase
  {
    constructor(v, target)
    {
      super(v, { Target: target });
      if (this.v2)
        this.setXml( { xmlns : 'http://docs.oasis-open.org/odata/ns/edm' } );
    }

    toJSONattributes(json)
    {
      edmUtils.forAll(this, (v,p) => {
        if (p !== 'Target')
          json[p[0] === '@' ? p : '$' + p] = v;
      });
      return json;
    }

    toJSONchildren(json)
    {
      this._children.forEach(a => {
        Object.entries(a.toJSON()).forEach(([n, v]) => {
          json[n] = v;
        });
      })
    }
  }

  // An Annotation must contain either children or a constant value
  // The value attribute is rendered by getConstantExpressionValue().
  // However, in case the constant expression value differs for XML an JSON
  // (EnumMember & EnumMember@odata.type) then the value properties must
  // be separated by using setJSON(attribute) and setXML(attribute).
  // See genericTranslation::handleValue() for details (especially the code
  // that sets the EnumMember code). All this has been done because the
  // Annotation object is passed around in genericTranslation and the
  // properties are set all over the place. The initial assumption was that
  // the constant expression value is the same for both XML and JSON. But
  // since it was discovered, that in JSON the EnumMember type must be
  // transported this is no longer the case....
  class Annotation extends AnnotationBase
  {
    constructor(v, termName)
    {
      super(v, { Term: termName } );
    }

    toJSON()
    {
      const json = super.mergeJSONAnnotations(this.getJsonFQTermName());
      const e = this._children.filter(c => c.kind !== 'Annotation');
      if(e.length === 0 || this._ignoreChildren) // must be a constant expression
        json[this.getJsonFQTermName()] = this.getConstantExpressionValue();
      else
        // annotation must have exactly one child (=record or collection)
        json[this.getJsonFQTermName()] = e[0].toJSON();
      return json;
    }

    getJsonFQTermName() {
      return '@' + this.Term + (this.Qualifier ? '#' + this.Qualifier : '');
    }
  }

  class Collection extends AnnotationBase
  {
    toJSON()
    {
      // EDM JSON doesn't mention annotations on collections
      return this._children.map(a => a.toJSON());
    }
  }

  class Record extends AnnotationBase
  {
    toJSONattributes(json)
    {
      if(this.Type)
        json['@type'] = this.Type;
      let keys = Object.keys(this).filter(k => k !== 'Type');
      for(let i = 0; i < keys.length; i++)
        json['$'+keys[i]] = this[keys[i]];
    }

    toJSONchildren(json)
    {
      this._children.forEach(c => {
        switch(c.kind)
        {
          case 'Annotation': {
            Object.entries(c.toJSON()).forEach(([n, v]) => {
              json[n] = v;
            });
            break;
          }
          case 'PropertyValue': {
            // plus property annotations as [a.Property]@anno: val
            Object.entries(c.mergeJSONannotations()).forEach(([n, a]) => {
              json[n] = a;
            });
            // render property as const expr (or subnode)
            json[c.Property] = c.toJSON();
            break;
          }
          default:
            error(null, 'Pease debug me: Unhandled Record child: ' + c.kind);
        }
      });
    }
  }

  class PropertyValue extends AnnotationBase
  {
    constructor(v, property)
    {
      super(v);
      this.Property = property;
    }

    toJSON()
    {
      const c = this._children.filter(c => c.kind !== 'Annotation')
      if(c.length === 0 || this._ignoreChildren)
        return this.getConstantExpressionValue();
      else
      {
        return c[0].toJSON();
      }
    }
    mergeJSONannotations() {
      return super.mergeJSONAnnotations(this.Property);
    }
  }

  class Thing extends AnnotationBase
  {
    constructor(v, kind, details)
    {
      super(v, details);
      this.setKind(kind);
    }

    setKind(kind)
    {
      Object.defineProperty(this, 'kind',
      { get: function() { return kind; }});
    }
  }

  class ValueThing extends Thing
  {
    constructor(v, kind, value)
    {
      super(v, kind, undefined);
      this.set( { _value : value });
    }

    toXML(indent='')
    {
      let kind = this.kind;
      let xml = indent + '<' + kind + this.toXMLattributes();
      xml +=  (this._value !== undefined ? '>' + edmUtils.escapeString(this._value) + '</' + kind + '>' : '/>');
      return xml;
    }

    toJSON()
    {
      if(this._children.length === 0 || this._ignoreChildren) // must be a constant expression
        return this.getConstantExpressionValue();
      else
        // annotation must have exactly one child (=record or collection)
        return this._children[0].toJSON();
    }
  }

  // Binary/Unary dynamic expression
  class Expr extends Thing {
    constructor(v, kind, details) {
      super(v, kind, details);
    }

    toJSON()
    { 
      // toJSON: depending on number of children unary or n-ary expr
      const json = this.mergeJSONAnnotations();
      const e = this._children.filter(c=>c.kind !== 'Annotation');
      if(e.length === 1) {
        json['$'+this.kind] = e[0].toJSON();
      }
      else {
        json['$'+this.kind] = e.map(c => c.toJSON());
      }
      return json;
    }
  }

  class Null extends AnnotationBase {
    toXMLattributes() {
      return '';
    }
    toJSON() {
      const json = this.mergeJSONAnnotations();
      json['$'+this.kind] = null;
      return json;
    }
  }
  class Apply extends AnnotationBase {
    toJSON() {
      const json = this.mergeJSONAnnotations();
      json['$'+this.kind] = this._children.filter(c=>c.kind !== 'Annotation').map(c => c.toJSON());
      this.toJSONattributes(json);
      return json;
    }
  }
  class Cast extends AnnotationBase {
    toXMLattributes() {
      if(this._jsonOnlyAttributes['Collection'])
        return ` Type="Collection(${this.Type})"`
      else
        return ` Type="${this.Type}"`
    }
    toJSON() {
      const json = this.mergeJSONAnnotations();
      // first expression only, if any
      const c = this._children.filter(c=>c.kind !== 'Annotation');
      json['$'+this.kind] = c.length ? c[0].toJSON() : {};
      this.toJSONattributes(json);
      return json;
    }
    toJSONattributes(json) {
      super.toJSONattributes(json);
      edmUtils.forAll(this._jsonOnlyAttributes, (v,p) => {
        json[p[0] === '@' ? p : '$' + p] = v;
      });
      return json;
    }
  }
  class IsOf extends Cast {}

  class If extends AnnotationBase {
    toJSON() {
      const json = this.mergeJSONAnnotations();
      json['$'+this.kind] = this._children.filter(c=>c.kind !== 'Annotation').map(c => c.toJSON());
      return json;
    }
  }
  class LabeledElement extends AnnotationBase {
    toJSON() {
      const json = this.mergeJSONAnnotations();
      // first expression only, if any
      const c = this._children.filter(c=>c.kind !== 'Annotation');
      json['$'+this.kind] = c.length ? c[0].toJSON() : '';
      this.toJSONattributes(json);
      return json;
    }

    toJSONattributes(json) // including Name
    {
      edmUtils.forAll(this, (v,p) => {
        json[p[0] === '@' ? p : '$' + p] = v;
      });
      return json;
    }
  }
  // LabeledElementReference is a 
  class LabeledElementReference extends ValueThing {
    constructor(v, val) {
      super(v, 'LabeledElementReference', val);
    }
  }
  class UrlRef extends AnnotationBase {
    toJSON() {
      const json = this.mergeJSONAnnotations();
      // first expression only, if any
      const c = this._children.filter(c=>c.kind !== 'Annotation');
      json['$'+this.kind] = c.length ? c[0].toJSON() : {};
      return json;
    }
  }

  // V2 specials
  class End extends Node {}
  class Association extends Node
  {
    constructor(v, details, navProp, fromRole, toRole, multiplicity)
    {
      super(v, details);
      this.set( { _end: [] });
      this._end.push(
        new End(v, { Role: fromRole[0], Type: fromRole[1], Multiplicity: multiplicity[0] } ),
        new End(v, { Role: toRole[0], Type: toRole[1], Multiplicity: multiplicity[1] } ) );

      // set Delete:Cascade on composition end
      if(navProp._csn.type === 'cds.Composition')
        this._end[0].append(new OnDelete(v, { Action: 'Cascade' }));

      if(navProp._csn._selfReferences && navProp._csn._selfReferences.length &&
         navProp._csn._selfReferences[0].type === 'cds.Composition')
        this._end[1].append(new OnDelete(v, { Action: 'Cascade' }));
    }

    innerXML(indent)
    {
      let xml = '';
      this._end.forEach(e => xml += e.toXML(indent) + '\n');
      xml += super.innerXML(indent);
      return xml;
    }
  }

  class AssociationSet extends Node
  {
    constructor(v, details, fromRole, toRole, fromEntitySet, toEntitySet)
    {
      super(v, details);
      this.append(
          new End(v, { Role: fromRole, EntitySet: fromEntitySet } ),
          new End(v, { Role: toRole,   EntitySet: toEntitySet } )
        );
    }
    getDuplicateMessage() {
      return `Association "${this.Association}"`
    }
}

  class Dependent extends Node {}
  class Principal extends Node {}

  ReferentialConstraint.createV2 =
    function(v, from, to, c)
    {
      let node = new ReferentialConstraint(v, {});
      node.set({ _d: new Dependent(v, { Role: from } ) });
      node.set({ _p: new Principal(v, { Role: to } ) });

      edmUtils.forAll(c, cv => {
        node._d.append(new PropertyRef(v, cv[0].join(options.pathDelimiter)));
        node._p.append(new PropertyRef(v, cv[1].join(options.pathDelimiter)));
      });
      return node;
    }

  return {
    Edm,
    Reference,
    Include,
    Schema,
    DataServices,
    EntityContainer,
    EntitySet,
    Singleton,
    TypeDefinition,
    EnumType,
    ComplexType,
    EntityType,
    Key,
    //ActionFunctionBase,
    FunctionDefinition,
    Action,
    FunctionImport,
    ActionImport,
    ReturnType,
    // PropertyBase,
    Property,
    PropertyRef,
    Parameter,
    NavigationPropertyBinding,
    NavigationProperty,
    ReferentialConstraint,
    OnDelete,
    // Annotations
    Annotations,
    Annotation,
    Collection,
    Record,
    Thing,
    ValueThing,
    PropertyValue,
    // Expressions
    Expr,
    Null,
    Apply,
    Cast,
    If,
    IsOf,
    LabeledElement,
    LabeledElementReference,
    UrlRef,
    // V2 specials
    End,
    Association,
    AssociationSet,
    Dependent,
    Principal
  }

} // instance function
