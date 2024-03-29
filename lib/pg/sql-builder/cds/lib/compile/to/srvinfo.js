
const cds = require('../..')
const { isfile, path: { join, posix: { normalize } } } = cds.utils

// Produces information on provided services in the model:
//   name, expected URL path at runtime,...
module.exports = (model, options={}) => {

  const result = []
  const isNodeProject = _isNodeProject(options.root || cds.root)
  const javaPrefix = _javaPrefix()
  const isJavaProject = !!javaPrefix

  cds.linked(model) .all ('service') .forEach (service => {
    if (isJavaProject) {
      result.push(_makeJava(service))
      if (isNodeProject) {  // could be a node project as well (hybrid)
        result.push(_makeNode(service))
      }
    }
    else { // assume this is node
      result.push(_makeNode(service))
    }
  })

  return result

  function _makeJava(service) {
    return {
      name: service.name,
      urlPath: _url4 (_javaPath(service)),
      destination: 'srv-api', // the name to register in xs-app.json
      runtime: 'Java',
      location: service.$location
    }
  }
  function _makeNode(service) {
    return {
      name: service.name,
      urlPath: _url4 (cds.serve.path4(service)),
      destination: 'srv-api', // the name to register in xs-app.json
      runtime: 'Node.js',
      location: service.$location
    }
  }

   // the URL path that is *likely* effective at runtime
  function _url4 (p) {
    return normalize (p.replace(/^\/+/, '') + '/') //> /foo/bar  ->  foo/bar/
  }

  function _javaPath (service) {
    const d = model.definitions[service.name]
    const path = d && d['@path'] ? d['@path'].replace(/^[^/]/, c => '/'+c) : service.name
    return join(javaPrefix, path).replace(/\\/g, '/')
  }

  function _isNodeProject(root) {
    for (let dir of [root, join(root, cds.env.folders.srv)]) {
      const file = isfile (join (dir,'package.json'))
      if (file) {
        const pjson = require(file)
        if (pjson.dependencies && pjson.dependencies['@sap/cds']) {
          return true
        }
      }
    }
  }

  function _javaPrefix() {
    let is_java
    for (let s of model.$sources) {
      const file = isfile (join (s,'../src/main/resources/application.yaml'))
      if (file) {
        const yaml = cds.load.yaml(file)
        for (let {cds} of Array.isArray(yaml) ? yaml : [yaml]) {
          if (cds && cds['odata-v4.endpoint.path'])  return cds['odata-v4.endpoint.path']
          if (cds && cds['odata-v2.endpoint.path'])  return cds['odata-v2.endpoint.path']
        }
        return 'odata/v4/'
      }
      else if (isfile (join(s,'../pom.xml'))) is_java = true
    }
    return is_java && 'odata/v4/'
  }

}
