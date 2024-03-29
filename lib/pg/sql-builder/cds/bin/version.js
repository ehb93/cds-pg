/* eslint-disable no-console */
const { dirname, join, resolve } = require ('path')
module.exports = Object.assign(list_versions, {
  flags: [ '--info', '--markdown', '--all', '--npm-list', '--npm-tree' ],
  shortcuts: [ '-i', '-m','-a', '-ls', '-ll' ],
  info,
  help: `
# SYNOPSIS

    *cds version* <options>
    *cds -v* <option>

    Prints the versions of all @sap/cds packages in your package dependencies.

# OPTIONS

    *-i  | --info*

      Prints version information in a tabular markdown format, which you
      can embed into your bug reports.

    *-a  | --all*

      Also lists sub-packages and optional dependencies.

    *-ls | --npm-list* <pattern>
    *-ll | --npm-tree* <pattern>

      Prints an npm ls tree filtered to the specified pattern.
      (default: '@sap/cds')

`})

function list_versions(args, options) { //NOSONAR
  if (options['npm-list'] || options['npm-tree']) {
    let [pattern] = args, re = pattern ? RegExp(pattern) : /@sap\/cd[rs]|@sap\/eslint-plugin-cds/
    let cmd = 'npm ls --depth ' + (options['npm-tree'] ? 11 : 0)
    console.log (cmd,'| grep', pattern)
    return require('child_process').exec(cmd, (e,stdout)=>{
      // if (e) console.error(e)
      for (let line of stdout.split(/\n/)) if (line.match(re)) console.log(
        line.replace(/(@sap[^@]*)@([\S]+)( -> [\S]+)?(deduped)?/,'\x1b[91m$1 \x1b[32m$2\x1b[0m\x1b[2m$3\x1b[32m$4\x1b[0m')
      )
    })
  }
  const versions = info (options)
  if (options.markdown)  return _markdown (versions)
  if (options.info)  return _markdown (versions)
  const mark = options.noColors ? s => s : require('./utils/term').info
  for (let each of Object.keys(versions).sort())  console.log(`${mark(each)}: ${versions[each]}`)
}

function info(o) {
  const main = _findPackage (require.main.filename)
  return {
    ..._versions4(main, {}, true),  // usually sap/cds-dk or sap/cds
    ..._versions4('@sap/eslint-plugin-cds', {}, null, o),
    ..._versions4(process.cwd(), {}, null, o),
    ..._versions4('..', {}, null, o),
    'Node.js': process.version,
    'home': __dirname.slice(0,-4)
  }
}

function _versions4 (pkg_name, info, parent, o={}) {
  if (!pkg_name)  return info
  try {
    const pkg = require(join(pkg_name, 'package.json'))
    info[pkg.name] = pkg.version
    if (!parent || o.all) for (let d in pkg.dependencies) { // recurse sap packages in dependencies...
      if (!(d in info) && d.startsWith('@sap/')) _versions4(d, info, pkg.name, o)
    }
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') info[pkg_name] = '-- missing --'  // unknown error
    // require fails for indirect packages if node_modules layout is nested, e.g. on Windows.
    // Try one more time with nested node_modules dir.
    else if (parent) _versions4(parent + '/node_modules/' + pkg_name, info)
  }
  return info
}


function _markdown (versions) {
  console.log()
  const pkg = { name:'', repository:'', version:'' }; try {
    Object.assign (pkg, require (resolve('package.json')))
  } catch (e) {/* ignored */}
  console.log ('|', pkg.name, '|', pkg.repository.url || pkg.repository, '|')
  console.log ('|:------------------ | ----------- |')
  if (require('../lib').env['project-nature'] === 'nodejs') {
    console.log ('|', v('Node.js'), '|')
    console.log ('|', v('@sap/cds'), '|')
  } else {
    console.log ('|', v('CAP Java Runtime'), '|')
    console.log ('|', v('OData Version'), '|')
  }
  console.log ('|', v('@sap/cds-compiler'), '|')
  console.log ('|', v('@sap/cds-dk'), '|')
  console.log ('|', v('@sap/eslint-plugin-cds'), '|')
  function v (component) {
    const version = versions [component] || '_version_'
    return (component + '           ').slice(0,18)
    +' | '+ (version  + '           ').slice(0,11)
  }
  console.log()
}

function _findPackage (dir) {
  try {
    if (dir) {
      require.resolve(join (dir, 'package.json'))
      return dir
    }
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND')  throw e
    return _findPackage (dirname (dir))
  }
}
