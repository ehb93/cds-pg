#!/usr/bin/env node
const cds = require('../lib') //> ensure we are the first to load @sap/cds locally
const cli = { //NOSONAR

  Shortcuts: {
    s: 'serve',
    v: 'version', '-v':'version', '--version':'version'
  },

  exec (cmd = process.argv[2], ...argv) {
    if (process[Symbol.for('ts-node.register.instance')]) {
      process.env.CDS_TYPESCRIPT = process.env.CDS_TYPESCRIPT || 'true'
    }
    require('util').inspect.defaultOptions = { colors: !!process.stderr.isTTY, depth:11 }
    if (!argv.length) argv = process.argv.slice(3)
    if (cmd in this.Shortcuts) cmd = process.argv[2] = this.Shortcuts[cmd]
    if (process.env.NODE_ENV !== 'test')  this.errorHandlers()
    const task = _require ('./'+cmd)
      || _require ('@sap/cds-dk/bin/'+cmd) // if dk is in installed modules
      || _require (_npmGlobalModules()+'/@sap/cds-dk/bin/'+cmd)  // needed for running cds in npm scripts
    if (!task)  return _requires_cdsdk (cmd)
    return task.apply (this, this.args(task,argv))
  },

  args (task, argv) {

    const { options:o=[], flags:f=[], shortcuts:s=[] } = task
    const _global = /^--(profile|production|sql|odata|build-.*|cdsc-.*|odata-.*|folders-.*)$/
    const _flags = { '--production':true }
    const options = {}, args = []
    let k,a, env = null

    if (argv.length) for (let i=0; i < argv.length; ++i) {
      if ((a = argv[i])[0] !== '-') args.push(a)
      else if ((k = s.indexOf(a)) >= 0) k < o.length ? add(o[k],argv[++i]) : add(f[k-o.length])
      else if ((k = o.indexOf(a)) >= 0) add(o[k],argv[++i])
      else if ((k = f.indexOf(a)) >= 0) add(f[k])
      else if (_global.test(a)) add_global(a, _flags[a] || argv[++i])
      else throw cds.error ('invalid option: '+ a)
    }

    function add (k,v) { options[k.slice(2)] = v || true }
    function add_global (k,v='') {
      if (k === '--production') return process.env.NODE_ENV = 'production'
      if (k === '--profile') return process.env.CDS_ENV = v.split(',')
      if (k === '--odata') v = { flavor:v }
      let e=env || (env={}), path = k.slice(2).split('-')
      while (path.length > 1) { let p = path.shift(); e = e[p]||(e[p]={}) }
      add (k, e[path[0]] = v)
    }

    if (env) cds.env.add (env)
    return [ args, options ]
  },

  errorHandlers () {
    const _error = (e) => { cli.log(e.errors || e, { 'log-level': cds.env.log.levels.cli }); _exit(1) }
    const _exit = (c) => { console.log(); process.exit(c) }
    cds.repl || process.on ('unhandledRejection', _error)
    cds.repl || process.on ('uncaughtException', _error)
    process.on ('SIGTERM',_exit)
    process.on ('SIGHUP',_exit)
    process.on ('SIGINT',_exit)
    process.on ('SIGUSR2',_exit) // by nodemon
  },

  get log() { return this.log = require('./utils/log') }
}

const _require = (id,o) => {
  try { var resolved = require.resolve(id,o) } catch(e){ return }
  return require (resolved)
}

const _requires_cdsdk = (cmd) => {
  const dk = {add:1,build:1,compile:1,deploy:1,env:1,eval:1,help:1,import:1,init:1,repl:1,watch:1}
  let message
  if (!cmd) { message = `
    Install '@sap/cds-dk' to use cds:\n
      npm i -g @sap/cds-dk\n`
  }
  else if (cmd in dk) { message = `
    'cds ${cmd}' needs '@sap/cds-dk' to be installed. Get it with:\n
      npm i -g @sap/cds-dk\n`
  }
  else { message = `
    Unknown command '${cmd}'. Install '@sap/cds-dk', then try again:\n
      npm i -g @sap/cds-dk\n`
  }
  process.exitCode = 1
  return console.error (message)
}

const _npmGlobalModules = () => {
  try {
    return require ('child_process').execSync('npm root -g').toString().trim()
  } catch (err) { return }
}

module.exports = Object.assign ((..._) => cli.exec(..._), cli)
if (!module.parent)  cli.exec()
/* eslint no-console:off */
