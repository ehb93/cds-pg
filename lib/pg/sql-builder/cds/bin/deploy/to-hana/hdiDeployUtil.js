const cp = require('child_process');
const path = require('path');
const util = require('util');

const execAsync = util.promisify(cp.exec);

const { nullLogger } = require('./logger');

class HdiDeployUtil {

    constructor() {
        this.hdiDeployLibs = new Map();
        this.deployerName = '@sap/hdi-deploy'
        this.deployerVersionSpec = '^4'
    }

    async deploy(dbDir, vcapServices, options = {}, logger = nullLogger) {
        logger.log();
        logger.log(`[cds.deploy] - Deploying to HANA from ${dbDir}`);

        let deployerEnv = JSON.parse(JSON.stringify(process.env)); // deep copy
        const hdiDeployLib = await this._getHdiDeployLib(dbDir, logger);
        if (hdiDeployLib.clean_env) {
            deployerEnv = hdiDeployLib.clean_env(deployerEnv);
        }

        deployerEnv.VCAP_SERVICES = JSON.stringify(vcapServices);

        if (options.autoUndeploy) {
            logger.log(`[cds.deploy] - Hdi deployer automatically undeploys deleted resources using --auto-undeploy.`);
            deployerEnv.HDI_DEPLOY_OPTIONS = JSON.stringify({
                'auto_undeploy': true
            });
        }

        await this._executeDeploy(dbDir, deployerEnv, logger);
    }

    async findHdiDeployLib(cwd) {
        const searchPaths = await this._npmSearchPaths(cwd)
        try {
            return require.resolve(path.join(this.deployerName, 'library'), {paths: searchPaths});
        } catch (err) {
            // no luck
        }
    }

    async _getHdiDeployLib(dbDir, logger) {
        let hdiDeployLib = this.hdiDeployLibs.get(dbDir)
        if (!hdiDeployLib) {
            hdiDeployLib = await this._loadHdiDeployLib(dbDir, logger);
            this.hdiDeployLibs.set(dbDir, hdiDeployLib);
        }

        return hdiDeployLib;
    }


    async _loadHdiDeployLib(cwd, logger = nullLogger) {
        const libPath = await this.findHdiDeployLib(cwd)
        if (!libPath) {
            const searchPaths = await this._npmSearchPaths(cwd)
            throw new Error(`[cds.deploy] - Required library '${this.deployerName}' not found in
    ${searchPaths.join('\n    ')}
Add it either as a devDependency using 'npm install -D ${this.deployerName}' or install it globally using 'npm install -g ${this.deployerName}'.`);
        }

        logger.log(`[cds.deploy] - Using HDI deployer from ${libPath}`)

        // let any error go through and abort deploy
        return require(libPath);
    }


    async _npmSearchPaths (cwd) {
        const npmRootCall = await execAsync('npm root -g');
        const globalNodeModules = npmRootCall.stdout.toString().trim();
        return [cwd, globalNodeModules]
    }


    async _executeDeploy(dbDir, env, logger = nullLogger) {
        const hdiDeployLib = await this._getHdiDeployLib(dbDir, logger);
        return new Promise((resolve, reject) => {
            hdiDeployLib.deploy(dbDir, env, (error, response) => {
                if (error) {
                    return reject(error);
                }
                if (response && response.exitCode && response.exitCode !== 0) {
                    let message = `[cds.deploy] - HDI deployment failed with exit code ${response.exitCode}`
                    if (response.signal)  message += `. ${response.signal}`
                    return reject(new Error(message));
                }
                return resolve();
            }, {
                    stdoutCB: data => logger.debug(data.toString()),
                    stderrCB: error => logger.error(error.toString())
                });
        });
    }
}


module.exports = new HdiDeployUtil();

/* eslint no-console: off */
