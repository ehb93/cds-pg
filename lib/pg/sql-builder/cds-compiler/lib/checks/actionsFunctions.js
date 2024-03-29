'use strict';

const { isBuiltinType } = require('../model/csnUtils');

// Only to be used with validator.js - a correct this value needs to be provided!

/**
 * Check bound/unbound actions and functions. These checks are only meaningful for the OData backend.
 *
 * @param {CSN.Artifact} art Definition to be checked: Either the action artifact or an entity with actions.
 * @param {string} artName name of the definition
 * @param {string} prop Ignored property, always "definitions"
 * @param {CSN.Path} path path to the definition
 */
function checkActionOrFunction(art, artName, prop, path) {
  if (!(art.kind === 'action' || art.kind === 'function') && !art.actions)
    return;

  // const isMultiSchema = this.options.toOdata.odataFormat === 'structured' &&
  //   (this.options.toOdata.odataProxies || this.options.toOdata.odataXServiceRefs);

  const serviceName = this.csnUtils.getServiceName(artName);
  if (!serviceName)
    this.warning(null, path, `Functions and actions must be declared in a service`);

  if (art.kind === 'entity') {
    for (const [ actName, act ] of Object.entries(art.actions)) {
      if (act.params) {
        for (const [ paramName, param ] of Object.entries(act.params))
          checkActionOrFunctionParameter.bind(this)(param, path.concat([ 'actions', actName, 'params', paramName ]), act.kind);
      }
      if (act.returns)
        checkReturns.bind(this)(act.returns, path.concat([ 'actions', actName, 'returns' ]), act.kind);
    }
  }
  else {
    if (art.params) {
      for (const [ paramName, param ] of Object.entries(art.params))
        checkActionOrFunctionParameter.bind(this)(param, path.concat([ 'params', paramName ]), art.kind);
    }
    if (art.returns)
      checkReturns.bind(this)(art.returns, path.concat('returns'), art.kind);
  }

  /**
   * Check the parameters of an action
   *
   * @param {object} param parameter object
   * @param {CSN.Path} currPath path to the parameter
   * @param {string} actKind 'action' or 'function'
   */
  function checkActionOrFunctionParameter(param, currPath, actKind) {
    const paramType = param.type ? this.csnUtils.getFinalTypeDef(param.type) : param;

    if (param.default || paramType.default) {
      this.error('param-default', currPath, { '#': actKind },
                 {
                   std: 'Artifact parameters can\'t have a default value', // Not used
                   action: 'Action parameters can\'t have a default value',
                   function: 'Function parameters can\'t have a default value',
                 });
    }

    if (paramType.type && this.csnUtils.isAssocOrComposition(param.type)) {
      this.error(null, currPath, { '#': actKind },
                 {
                   std: 'An association is not allowed as this artifact\'s parameter type', // Not used
                   action: 'An association is not allowed as action\'s parameter type',
                   function: 'An association is not allowed as function\'s parameter type',
                 });
    }

    if (paramType.items && paramType.items.type)
      checkActionOrFunctionParameter.bind(this)(paramType.items, currPath.concat('items'), actKind);

    // check if the structured & user-defined is from the current service
    checkUserDefinedType.bind(this)(paramType, param.type, currPath);
  }

  /**
   * Check the return statement of an action
   *
   * @param {object} returns returns object
   * @param {CSN.Path} currPath path to the returns object
   * @param {string} actKind 'action' or 'function'
   */
  function checkReturns(returns, currPath, actKind) {
    const finalReturnType = returns.type ? this.csnUtils.getFinalBaseType(returns.type) : returns;

    if (this.csnUtils.isAssocOrComposition(finalReturnType)) {
      this.error(null, currPath, { '#': actKind },
                 {
                   std: 'An association is not allowed as this artifact\'s return type', // Not used
                   action: 'An association is not allowed as action\'s return type',
                   function: 'An association is not allowed as function\'s return type',
                 });
    }

    if (finalReturnType.items) // check array return type
      checkReturns.bind(this)(finalReturnType.items, currPath.concat('items'), actKind);
    else // check if return type is user definited from the current service
      checkUserDefinedType.bind(this)(finalReturnType, returns.type, currPath);
  }

  /**
   * Check non-builtin used types in actions
   *
   * @param {CSN.Artifact} type The final type definition
   * @param {string} typeName Name of the type definition
   * @param {CSN.Path} currPath The current path
   */
  function checkUserDefinedType(type, typeName, currPath) {
    if (!isBuiltinType(type) && type.kind && type.kind !== 'type') {
      const serviceOfType = this.csnUtils.getServiceName(typeName);
      if (serviceName && serviceName !== serviceOfType) {
        // if (!(isMultiSchema && serviceOfType)) {
        this.error(null, currPath,
                   { type: typeName, kind: type.kind, service: serviceName },
                   '$(TYPE) of kind $(KIND) is defined outside a service and can\'t be used in $(SERVICE)');
        // }
      }
    }
  }
}

module.exports = { checkActionOrFunction };
