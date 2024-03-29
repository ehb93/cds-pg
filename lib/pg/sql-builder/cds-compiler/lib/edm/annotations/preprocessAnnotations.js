'use strict';

const edmUtils = require('../edmUtils.js');
const { makeMessageFunction } = require('../../base/messages.js');


/**************************************************************************************************
 * preprocessAnnotations
 *
 * options:
 *   v
 *
 * This module never produces errors. In case of "unexpected" situations we issue a warning and
 * try to proceed with the processing as good as possible.
 *
 */
function preprocessAnnotations(csn, serviceName, options) {
  const { warning } = makeMessageFunction(csn, options);
  let fkSeparator = '_';

  resolveShortcuts();


  // ----------------------------------------------------------------------------------------------
  // helper functions
  // ----------------------------------------------------------------------------------------------

  // helper to determine the OData version
  // TODO: improve option handling
  function isV2() {
    return options.v && options.v[0];
  }

  // return value can be null is target has no key
  function getKeyOfTargetOfManagedAssoc(assoc) {
    // assoc.target can be the name of the target or the object itself
    let targetName = (typeof assoc.target === 'object') ? assoc.target.name : assoc.target;
    let target     = (typeof assoc.target === 'object') ? assoc.target      : csn.definitions[assoc.target];

    let keyNames = Object.keys(target.elements).filter(x => target.elements[x].key);
    if (keyNames.length === 0) {
      keyNames.push('MISSING');
      warning(null, null, `in annotation preprocessing: target ${targetName} has no key`);
    }
    else if (keyNames.length > 1)
      warning(null, null, `in annotation preprocessing: target ${targetName} has multiple key elements`);

    // TODO: what happens if key of target is itself a managed association?
    return keyNames[0];
  }

  // ----------------------------------------------------------------------------------------------
  // main annotation processors
  // ----------------------------------------------------------------------------------------------


  // resolve shortcuts
  function resolveShortcuts() {
    let art = null;

    edmUtils.forAll(csn.definitions, (artifact, artifactName) => {
      if(artifactName == serviceName || artifactName.startsWith(serviceName + '.')) {
        art = artifactName;
        handleAnnotations(artifactName, artifact);
        edmUtils.forAll(artifact.elements, (element, elementName) => {
          handleAnnotations(elementName, element);
        });
        edmUtils.forAll(artifact.actions, (action) => {
          edmUtils.forAll(action.params, (param, paramName) => {
            handleAnnotations(paramName, param);
          });
        });
      }
    });

    function handleAnnotations(carrierName, carrier) {

      // collect the names of the carrier's annotation properties
      let annoNames = Object.keys(carrier).filter( x => x.substr(0,1) === '@')

      for (let aName of annoNames) {
        let aNameWithoutQualifier = aName.split('#')[0];

        //for warning messages
        let ctx = 'target: ' + art + '/' + carrierName;


        // Always - draft annotations, value is action name
        //   - v2: prefix with entity name
        //   - prefix with service name
        draftAnnotations(carrier, aName, aNameWithoutQualifier);

        // Always - FixedValueListShortcut
        //   expand shortcut form of ValueList annotation
        fixedValueListShortCut(carrier, aNameWithoutQualifier, ctx);

        // Always - TextArrangementReordering
        //   convert @Common.TextArrangement annotation that is on same level as Text annotation into a nested annotation
        textArrangementReordering(carrier, aName, aNameWithoutQualifier, ctx);
      }

      // inner functions
      function draftAnnotations(carrier, aName, aNameWithoutQualifier) {
        if ((carrier.kind === 'entity' || carrier.kind === 'view') &&
            (aNameWithoutQualifier === '@Common.DraftRoot.PreparationAction' ||
              aNameWithoutQualifier === '@Common.DraftRoot.ActivationAction' ||
              aNameWithoutQualifier === '@Common.DraftRoot.EditAction' ||
              aNameWithoutQualifier === '@Common.DraftNode.PreparationAction')
            ) {
          let value = carrier[aName];
          // prefix with service name, if not already done
          if (value === 'draftPrepare'  || value === 'draftActivate' || value === 'draftEdit') {
            let serviceName = carrierName.replace(/.[^.]+$/, '');
            value = carrier[aName] = serviceName + '.' + value;
          }
          // for v2: function imports live inside EntityContainer -> path needs to contain "EntityContainer/"
          //         we decided to prefix names of bound action/functions with entity name -> needs to be reflected in path, too
          if (isV2()) {
            let entityNameShort = carrierName.split('.').pop();
            carrier[aName] = value.replace(/(draft(Prepare|Activate|Edit))$/, (match, p1) => 'EntityContainer/' + entityNameShort + '_' + p1)
          }
        }
      }

      function fixedValueListShortCut(carrier, aNameWithoutQualifier, ctx) {
        if (aNameWithoutQualifier === '@Common.ValueList.entity' ||
            aNameWithoutQualifier === '@Common.ValueList.viaAssociation') {

          const _fixedValueListShortCut = () => {
            // note: we loop over all annotations that were originally present, even if they are
            //       removed from the carrier via this handler
            //       we don't remove anything from the array "annoNames"

            // if CollectionPath is explicitly given, no shortcut expansion is made
            if (carrier['@Common.ValueList.CollectionPath']) {
              return false;
            }

            if (carrier.kind === 'entity' || carrier.kind === 'view') {
              warning(null, null, `annotation preprocessing/${aNameWithoutQualifier}: annotation must not be used for an entity, ${ctx}`);
              return false;
            }

            // check on "type"? e.g. if present, it must be #fixed ... ?

            // value list entity
            let enameShort = null;  // (string) name of value list entity, short (i.e. name within service)
            let enameFull = null;   // (string) name of value list entity, fully qualified name

            if (aNameWithoutQualifier === '@Common.ValueList.viaAssociation') {
              // value is expected to be an expression, namely the path to an association of the carrier entity
              let assocName = carrier['@Common.ValueList.viaAssociation']['='];
              if (!assocName) {
                warning(null, null, `in annotation preprocessing/${aNameWithoutQualifier}: value of 'viaAssociation' must be a path, ${ctx}`);
                return false;
              }
              let assoc = csn.definitions[art].elements[assocName];
              if (!assoc || !(assoc.type === 'cds.Association' || assoc.type === 'cds.Composition')) {
                warning(null, null, `in annotation preprocessing/${aNameWithoutQualifier}: there is no association "${assocName}", ${ctx}`);
                return false;
              }

              enameFull = assoc.target.name || assoc.target; // full name
              enameShort = enameFull.split('.').pop();
            }
            else if (aNameWithoutQualifier === '@Common.ValueList.entity') {
              // if both annotations are present, ignore 'entity' and raise a message
              if (annoNames.map(x=>x.split('#')[0]).find(x=>(x=='@Common.ValueList.viaAssociation'))) {
                warning(null, null, `in annotation preprocessing/@Common.ValueList: 'entity' is ignored, as 'viaAssociation' is present, ${ctx}`);
                return false;
              }

              let annoVal = carrier['@Common.ValueList.entity']; // name of value list entity
              if (annoVal['=']) {
                warning(null, null, `in annotation preprocessing/${aNameWithoutQualifier}: annotation value must be a string, ${ctx}`);
              }

              let nameprefix = art.replace(/.[^.]+$/, ''); // better way of getting the service name?

              enameShort = annoVal['='] || annoVal;
              enameFull = nameprefix + '.' + enameShort;
            }

            let vlEntity = csn.definitions[enameFull]; // (object) value list entity
            if (!vlEntity) {
              warning(null, null, `in annotation preprocessing/${aNameWithoutQualifier}: entity "${enameFull}" does not exist, ${ctx}`);
              return false;
            }

            // label
            //   explicitly provided label wins
            let label = carrier['@Common.ValueList.Label'] ||
                        carrier['@Common.Label'] || vlEntity['@Common.Label'] || enameShort;

            // localDataProp
            //   name of the element carrying the value help annotation
            //   if this is a managed assoc, use fk field instead (if there is a single one)
            let localDataProp = carrierName.split('/').pop();
            if (edmUtils.isManagedAssociation(carrier)) {
              localDataProp = localDataProp + fkSeparator + getKeyOfTargetOfManagedAssoc(carrier);
            }

            // if this carrier is a generated foreign key field and the association is marked @cds.api.ignore
            // rename the localDataProp to be 'assocName/key'
            if(carrier['@cds.api.ignore']) {
              let assocName = carrier['@odata.foreignKey4'];
              if(assocName && options.isV4()) {
                localDataProp = localDataProp.replace(assocName+fkSeparator, assocName+'/');
              }
            }

            // valueListProp: the (single) key field of the value list entity
            //   if no key or multiple keys -> warning
            let valueListProp = null;
            let keys = Object.keys(vlEntity.elements).filter( x => vlEntity.elements[x].key );
            if (keys.length === 0) {
              warning(null, null, `in annotation preprocessing/value help shortcut: entity "${enameFull}" has no key, ${ctx}`);
              return false;
            }
            else if (keys.length > 1)
              warning(null, null, `in annotation preprocessing/value help shortcut: entity "${enameFull}" has more than one key, ${ctx}`);
            valueListProp = keys[0];

            // textField:
            //   first entry of @UI.Identification
            //     a record with property 'Value' and expression as its value
            //     or shortcut expansion array of paths
            // OR
            //   the (single) non-key string field, if there is one
            let textField = null;
            let Identification = vlEntity['@UI.Identification'];
            if (Identification && Identification[0] && Identification[0]['=']) {
              textField = Identification[0]['='];
            } else if (Identification && Identification[0] && Identification[0]['Value'] && Identification[0]['Value']['=']) {
              textField = Identification[0]['Value']['='];
            } else {
              let stringFields = Object.keys(vlEntity.elements).filter(
                x => !vlEntity.elements[x].key && vlEntity.elements[x].type === 'cds.String')
              if (stringFields.length == 1)
                textField = stringFields[0];
            }

            // explicitly provided parameters win
            let parameters = carrier['@Common.ValueList.Parameters'];
            if (!parameters) {
              parameters = [{
                '$Type': 'Common.ValueListParameterInOut',
                'LocalDataProperty' : { '=' : localDataProp },
                'ValueListProperty' : valueListProp
              }];
              if (textField) {
                parameters[1] = {
                  '$Type': 'Common.ValueListParameterDisplayOnly',
                  'ValueListProperty' : textField
                };
              }
            }

            let newObj = Object.create( Object.getPrototypeOf(carrier) );
            Object.keys(carrier).forEach( e => {
              if (e === '@Common.ValueList.entity' || e === '@Common.ValueList.viaAssociation') {
                newObj['@Common.ValueList.Label'] = label;
                newObj['@Common.ValueList.CollectionPath'] = enameShort;
                newObj['@Common.ValueList.Parameters'] = parameters;
              }
              else if (e === '@Common.ValueList.type' ||
                      e === '@Common.ValueList.Label' ||
                      e === '@Common.ValueList.Parameters') {
                // nop
              }
              else {
                newObj[e] = carrier[e];
              }
              delete carrier[e];
            });
            Object.assign(carrier, newObj);
            return true;
          }

          const success = _fixedValueListShortCut();
          if (!success) {
            // In case of failure, avoid subsequent warnings
            delete carrier[aNameWithoutQualifier];
            delete carrier['@Common.ValueList.type'];
          }
        }
      }

      function textArrangementReordering(carrier, aName, aNameWithoutQualifier, ctx) {
        if (aNameWithoutQualifier === '@Common.TextArrangement') {
          let value = carrier[aName];
          let textAnno = carrier['@Common.Text'];
          // can only occur if there is a @Common.Text annotation at the same target
          if (!textAnno) {
            warning(null, null, `in annotation preprocessing: TextArrangement shortcut without Text annotation, ${ctx}`);
          }

          //change the scalar anno into a "pseudo-structured" one
          // TODO should be flattened, but then alphabetical order is destroyed
          let newTextAnno = { '$value': textAnno, '@UI.TextArrangement': value };
          carrier['@Common.Text'] = newTextAnno;
          delete carrier[aName];
        }
      }
    }
  }
}

module.exports = {
  preprocessAnnotations,
};
