
const {fse} = require('@sap/cds-foss');
const os = require('os');
const path = require('path');

const { BuildTaskEngine, BuildTaskFactory } = require('../../build');
const buildConstants = require('../../build/constants');
const cds = require('../../../lib');
const cfUtil = require('./cfUtil');
const { defaultLogger, nullLogger } = require('./logger');
const hdiDeployUtil = require('./hdiDeployUtil');
const mtaUtil = require('../../build/mtaUtil');
const runCommand = require('./runCommand');
const { bold, info } = require('../../utils/term');


const IS_WIN = (os.platform() === 'win32');
const UTF_8 = 'utf-8';


const DEBUG = process.env.DEBUG;

class HanaDeployer {

  async deploy(model, serviceName, noSave, tunnelAddress, buildTaskOptions, vcapFile, undeployWhitelist, hdiOptions = {}, logger = defaultLogger) { // NOSONAR

    logger.log(`[cds.deploy] - ${bold('Starting deploy to SAP HANA ...')}`);
    logger.log();

    const projectPath = path.resolve(process.env._TEST_CWD || process.cwd());

    const { buildResults } = await this._build(buildTaskOptions, model, logger);

    let vcapServices;
    if (vcapFile) {
      logger.log();
      logger.log(`[cds.deploy] - Using vcap file ${vcapFile} (beta feature).`);
      vcapServices = await this._loadVCAPServices(vcapFile);
    }

    for (const buildResult of buildResults) {
      const currentModelFolder = buildResult.result.dest;

      if (undeployWhitelist) {
        logger.log('[cds.deploy] - Writing undeploy.json');
        await fse.writeJSON(path.join(currentModelFolder, 'undeploy.json'), undeployWhitelist);
      }

      if (vcapFile) {
        await fse.mkdirp(currentModelFolder);
      } else {
        const { cfServiceInstanceName, serviceKey } =
          await this._getOrCreateCFService(projectPath, currentModelFolder, serviceName, tunnelAddress, logger);

        vcapServices = this._getVCAPServicesEntry(cfServiceInstanceName, serviceKey);

        if (!noSave) {
          await this._addInstanceToDefaultEnvJson([currentModelFolder, projectPath], cfServiceInstanceName, serviceKey, logger);
        }
      }

      // Check if deployer is already installed, otherwise only install this one, not the rest of dependencies.
      if (!await hdiDeployUtil.findHdiDeployLib(currentModelFolder, logger)) {
        const { deployerName, deployerVersionSpec } = hdiDeployUtil
        logger.log(`[cds.deploy] - installing ${deployerName}`);
        await runCommand('npm', ['install', `${deployerName}@${deployerVersionSpec}`,
          (noSave ? '--no-save' : '--save-dev')], logger, {
          cwd: currentModelFolder,
          shell: IS_WIN,
          stdio: 'inherit',
          env: { NODE_ENV: 'development' }  // for 'install --save-dev' to work, there must be no 'production' set
        });
      }

      await hdiDeployUtil.deploy(currentModelFolder, vcapServices, hdiOptions, logger);
    }

    await this._addToGitignore(projectPath, 'default-env.json', logger);

    logger.log(`[cds.deploy] - If not already done, use ${info('cds add hana')} to configure the project for SAP HANA.\n`);
    logger.log(`[cds.deploy] - Done.`);

    return { buildResults };
  }


  async _getOrCreateCFService(projectPath, currentModelFolder, serviceName, tunnelAddress, logger) {
    const modelName = path.basename(currentModelFolder);

    // get from param
    let cfServiceInstanceMta;
    let cfServiceInstanceName;
    if (serviceName) {
      cfServiceInstanceName = serviceName;
    } else {
      const cfServiceDescriptor = await mtaUtil.getHanaDbModuleDescriptor(projectPath, modelName, logger);
      cfServiceInstanceName = cfServiceDescriptor.hdiServiceName;
      cfServiceInstanceMta = cfServiceDescriptor.hdiService
    }

    logger.log();
    this._validateServiceInstanceName(cfServiceInstanceName);
    logger.log(`[cds.deploy] - Using container ${bold(cfServiceInstanceName)}`);

    let cfConfig = cfServiceInstanceMta && cfServiceInstanceMta.parameters && cfServiceInstanceMta.parameters.config;
    await this.createHanaService(cfServiceInstanceName, cfConfig, logger);

    const cfServiceInstanceKeyName = `${cfServiceInstanceName}-key`;
    let serviceKey = await cfUtil.getServiceKey(cfServiceInstanceName, cfServiceInstanceKeyName);
    if (!serviceKey) {
      serviceKey = await cfUtil.createServiceKey(cfServiceInstanceName, cfServiceInstanceKeyName, logger);
    }
    this._validateServiceKey(serviceKey, cfServiceInstanceKeyName);

    if (tunnelAddress) {
      logger.log(`[cds.deploy] - Using tunnel address ${bold(tunnelAddress)} (beta feature)`);
      serviceKey = this._injectTunnelAddress(serviceKey, tunnelAddress)
    }

    return { cfServiceInstanceName, serviceKey }
  }

  async createHanaService(instanceName, cfConfig, logger) {
    // hana or hanatrial, error if neither found
    try {
      return await cfUtil.createService('hana', 'hdi-shared', instanceName, cfConfig, logger);
    } catch (error) {
      if (error.command && /offering .* not found/i.test(error.command.stderr)) {
        logger.log(`[cds.deploy] - Falling back to 'hanatrial'`);
        return await cfUtil.createService('hanatrial', 'hdi-shared', instanceName, cfConfig, logger);
      }
      else if (error.command && /no database/i.test(error.command.stderr)) {
        logger.log(`[cds.deploy] - No database connected to 'hana' service. Falling back to 'hanatrial'`);
        return await cfUtil.createService('hanatrial', 'hdi-shared', instanceName, cfConfig, logger);
      }
      throw error;
    }
  }



  _validateServiceKey(serviceKey, cfServiceInstanceKey) {
    if (!serviceKey) {
      throw new Error(`[cds.deploy] - Could not create service key ${bold(cfServiceInstanceKey)}.`);
    }

    const fields = ['schema', 'user', 'password', 'url'];
    for (const field of fields) {
      if (!serviceKey[field]) {
        throw new Error(`[cds.deploy] - Service key is missing mandatory field '${field}'. Make sure you are ${bold('not')} using a managed service.`);
      }
    }
  }


  async _build(buildTaskOptions, model, logger) {
    buildTaskOptions = buildTaskOptions || {
      root: process.env._TEST_CWD || process.cwd()
    };

    if (typeof model === 'string') {
      model = [model];
    }

    logger.log(`[cds.deploy] - Creating build tasks`);
    const buildTaskFactory = new BuildTaskFactory((DEBUG ? logger : nullLogger), cds);
    const allTasks = await buildTaskFactory.getTasks(buildTaskOptions);

    const hanaTasks = allTasks.filter((task => {
      return task.for === buildConstants.BUILD_TASK_HANA && (!model || model.includes(task.src));
    }));

    let srcFolder = cds.env.folders.db || 'db';
    if (Array.isArray(srcFolder)) {
      srcFolder = srcFolder[0] || 'db';
    }

    if (hanaTasks.length === 0) {
      hanaTasks.push({
        for: buildConstants.BUILD_TASK_HANA,
        src: srcFolder,
        options: {
          model: cds.env.requires.db && cds.env.requires.db.model || cds.resolve('*', false)
        }
      });
    }

    logger.log(`[cds.deploy] - Running build`);

    const buildResults = await new BuildTaskEngine((DEBUG ? logger : nullLogger)).processTasks(hanaTasks, buildTaskOptions);
    return { buildResults, allTasks }
  }


  async _loadVCAPServices(vcapFile) {
    try {
      const content = await fse.readJSON(vcapFile);
      if (!content.VCAP_SERVICES) {
        throw new Error(`The vcap file ${vcapFile} does not contain a VCAP_SERVICES entry.`);
      }

      return content.VCAP_SERVICES;
    } catch (err) {
      throw new Error(`Error reading vcap file: ${err.message}`);
    }
  }


  async _addInstanceToDefaultEnvJson(currentFolders, serviceInstanceName, serviceKey, logger) {
    for (const currentFolder of currentFolders) {
      let defaultEnvJson = {};
      const defaultEnvJsonPath = path.join(currentFolder, 'default-env.json');

      try {
        defaultEnvJson = await fse.readJSON(defaultEnvJsonPath, UTF_8);
      } catch (err) {
        // ignore any errors
      }

      defaultEnvJson.VCAP_SERVICES = defaultEnvJson.VCAP_SERVICES || {};
      for (const serviceKey of Object.keys(defaultEnvJson.VCAP_SERVICES)) {
        defaultEnvJson.VCAP_SERVICES[serviceKey] = defaultEnvJson.VCAP_SERVICES[serviceKey].filter((service) => {
          return (service.name !== serviceInstanceName);
        });
      }

      const hanaEntry = this._getVCAPServicesEntry(serviceInstanceName, serviceKey)
      defaultEnvJson.VCAP_SERVICES = {
        ...defaultEnvJson.VCAP_SERVICES,
        ...hanaEntry
      }

      logger.log(`[cds.deploy] - Writing ${defaultEnvJsonPath}`);
      await fse.outputJSON(defaultEnvJsonPath, defaultEnvJson, {
        spaces: 2
      });
    }
  }


  async _addToGitignore(currentFolder, entry, logger) {
    const gitIgnorePath = path.join(currentFolder, '.gitignore');
    let entryMustBeAdded = true;
    try {
      const gitCheckCmd = await runCommand('git', ['check-ignore', entry], nullLogger);
      if (gitCheckCmd.code === 0) {
        // git verifies the chain of gitignore files, code === 0 file is ignored
        entryMustBeAdded = false;
      }
    } catch (err) {
      // git command not available or some problem occurred
      logger.warn(`[cds.deploy] - Error while calling git: ${err}`);
    }

    if (entryMustBeAdded) {
      let gitIgnore = '';
      try {
        gitIgnore = await fse.readFile(gitIgnorePath, UTF_8);
        if (gitIgnore.indexOf(entry) >= 0) {
          // entry exists in file
          return;
        }
      } catch (err) {
        // ignore file not found
      }

      logger.log(`[cds.deploy] - Adding ${entry} to ${gitIgnorePath}`);
      gitIgnore = `${gitIgnore.trim()}

# added by cds deploy
${entry}
`;
      await fse.outputFile(gitIgnorePath, gitIgnore);
    }
  }

  _getVCAPServicesEntry(serviceInstanceName, serviceKey) {
    return {
      hana: [
        {
          name: serviceInstanceName,
          tags: ['hana'],
          credentials: serviceKey
        }
      ]
    };
  }


  _validateServiceInstanceName(serviceInstanceName) {
    // valid service name chars: alpha-numeric, hyphens, and underscores
    if (/[^\w-_]+/g.exec(serviceInstanceName)) {
      throw new Error(`[cds.deploy] - Service name ${serviceInstanceName} must only contain alpha-numeric, hyphens, and underscores.`);
    }
  }

  _injectTunnelAddress(serviceKey, tunnelAddress) {
    if (!/\w+:\d+/.test(tunnelAddress)) {
      throw new Error(`Invalid tunnel address '${tunnelAddress}' - must be in form 'host:port'`)
    }
    const [tunnelHost, tunnelPort] = tunnelAddress.split(':')
    const { host, port } = serviceKey
    serviceKey.host = tunnelHost
    serviceKey.port = tunnelPort
    serviceKey.url = serviceKey.url.replace(`${host}:${port}`, tunnelAddress)
    serviceKey.hostname_in_certificate = host  // make cert. verification happy, see xs2/hdideploy.js#527
    serviceKey.url = serviceKey.url + (serviceKey.url.includes('?') ? '&' : '?') + 'hostNameInCertificate=' + host
    return serviceKey
  }

}

module.exports = new HanaDeployer();
