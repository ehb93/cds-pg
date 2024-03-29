const { fs } = require('@sap/cds-foss')
const path = require('path')
const _cds = require('./cds')
const { OUTPUT_MODE_DEFAULT, LOG_MODULE_NAMES } = require("./constants")
const BuildTaskProviderInternal = require('./provider/buildTaskProviderInternal')
const BuildTaskProvider = require('./buildTaskProvider')

class BuildTaskProviderFactory {
    constructor(logger, cds, buildOptions) {
        this._cds = cds ? cds : _cds
        this._logger = logger || this._cds.log(LOG_MODULE_NAMES)
        buildOptions.for = buildOptions.for || {}
        buildOptions.outputMode = buildOptions.outputMode || OUTPUT_MODE_DEFAULT
        this._buildOptions = buildOptions
    }
    get cds() {
        return this._cds
    }
    get env() {
        return this._cds.env
    }
    get logger() {
        return this._logger
    }
    get buildOptions() {
        return this._buildOptions
    }
    get providers() {
        if (!this._providers) {
            this._providers = this._loadProviders()
        }
        return this._providers
    }

    async applyTaskDefaults(tasks) {
        await Promise.all(tasks.map(async task => {
            if (!task.for && !task.use) {
                throw new Error("Invalid build task definition - property 'for' and property 'use' missing")
            }
            const provider = this.providers.find(provider => {
                try {
                    return provider.canHandleTask(task)
                } catch (e) {
                    this.logger.error(`Build task provider ${provider.constructor.name} returned error:\n` + e)
                    throw e
                }
            })
            if (!provider) {
                throw new Error(`No provider found for build task '${task.for || task.use}'`)
            }
            if (provider instanceof DefaultBuildTaskProvider) {
                this.logger._debug && this.logger.debug(`No provider found for build task '${task.use}', using default provider`)
            }
            await this._applyTaskDefaults(provider, [task])
        }))
    }

    async lookupTasks() {
        this.logger.debug("[cds] - Determining CDS build tasks from CDS configuration - applying defaults")
        let tasks = []
        await Promise.all(this.providers.map(async (provider) => {
            let pluginTasks = await this._lookupTasks(provider)
            if (!Array.isArray(pluginTasks)) {
                this.logger.error(`Build task provider ${provider.constructor.name} returned invalid type, array required.\nReceived ${JSON.stringify(pluginTasks)}`)
            }
            // apply defaults
            await this._applyTaskDefaults(provider, pluginTasks)

            tasks = tasks.concat(pluginTasks)
            this.logger._debug && this.logger.debug(`Build task provider ${provider.constructor.name} returned build tasks ${JSON.stringify(pluginTasks)}`)
        }))
        return tasks
    }

    /**
     * Create a BuildTaskHandler instance for the given build task.
     * The implementation is loaded based on the build task's 'for' or 'use' option.
     * @param {*} task
     * @param {*} buildOptions
     */
    createHandler(task) {
        const BuildTaskHandlerClass = this.loadHandler(task)
        const resolvedTask = this.resolveTask(task)
        this.logger._debug && this.logger.debug(`[cds] - loaded build task handler [${resolvedTask.use}]`)

        const handler = new BuildTaskHandlerClass()
        handler._task = resolvedTask
        handler._cds = this.cds
        handler._logger = this.logger
        handler._buildOptions = this.buildOptions
        this.logger._debug && this.logger.debug(`[cds] - created BuildTaskHandler [${resolvedTask.use}]`)
        return handler
    }

    /**
     * Loads the build task handler implementation for the given build task.
     * 'for' defines an alias for built-in handlers like 'hana', 'java-cf', 'node-cf', 'fiori' or 'mtx'.
     * 'use' defines the fully qualified module name of external build task handler implemenations.
     * @param {object} task
     */
    loadHandler(task) {
        let provider = this.providers.find(provider => provider.canHandleTask(task))
        if (!provider) {
            throw new Error(`No provider found for build task '${task.for || task.use}'`)
        }
        try {
            return provider.loadHandler(task)
        }
        catch (e) {
            this.logger.error(`Provider failed to load handler class - provider: ${provider.constructor.name}, task: ${task.for || task.use} :\n` + e)
            throw e
        }
    }

    resolveTasks(tasks) {
        return tasks.map(task => this.resolveTask(task))
    }

    /**
     * Resolves the given build task based on the project root folder.<br>
     * The task is validated in order to ensure that 'src' refers to a valid folder and 'for' or 'use' reference can be required.
     * @param {*} task
     * @param {*} buildOptions
     */
    resolveTask(task) {
        // first validate handler implementation
        this.loadHandler(task)

        // second valdiate src path
        const resolvedTask = JSON.parse(JSON.stringify(task))

        // Do not store resolved symlinks as this is causing issues on Windows, e.g. if git projects are
        // located under 'C:\SAPDevelop\git\...' using a sym-link from '%USERHOME%\git' to 'C:\SAPDevelop\git'.
        // see cap/issues/#8694
        resolvedTask.src = path.resolve(this.buildOptions.root, task.src)
        try {
            //validate source path
            fs.realpathSync(resolvedTask.src)
        } catch (e) {
            throw new Error(`Build task [${resolvedTask.for || resolvedTask.use}] could not be resolved - folder src [${path.resolve(this.buildOptions.root, task.src)}] does not exist`)
        }
        resolvedTask.dest = path.resolve(this.buildOptions.target, task.dest || task.src)
        resolvedTask.options = task.options || {}
        return resolvedTask
    }

    async _lookupTasks(provider) {
        try {
            return provider.lookupTasks(this.buildOptions)
        } catch (e) {
            this.logger.error(`Build task provider ${provider.constructor.name} returned error:\n` + e)
            throw e
        }
    }

    async _applyTaskDefaults(provider, tasks) {
        try {
            return Promise.all(tasks.map(task => provider.applyTaskDefaults(task)))
        } catch (e) {
            this.logger.error(`Build task provider ${provider.constructor.name} returned error:\n` + e)
            throw e
        }
    }

    _loadProviders() {
        // order is important - the DefaultBuildTaskProvider has to be the last provider in the list
        return [this._createProvider(BuildTaskProviderInternal), this._createProvider(DefaultBuildTaskProvider)]
    }

    _createProvider(clazz, plugin) {
        const provider = new clazz()
        provider._cds = this.cds
        provider._logger = this.logger
        provider._plugin = plugin
        return provider
    }
}

/**
 * Default provider implementation handling fully qualified custom build task declarations.
 * Has to be the last entry in the providers list.
 */
class DefaultBuildTaskProvider extends BuildTaskProvider {
    canHandleTask(task) {
        return !!task.use
    }
    loadHandler(task) {
        if (!task.use) {
            throw new Error(`Invalid build task definition [${task.for}] - property 'use' missing`)
        }
        try {
            return module.parent.require(task.use)
        }
        catch (e) {
            throw new Error(`Build task could not be resolved - module [${task.use}] cannot be loaded:\n` + e)
        }
    }
}
module.exports = BuildTaskProviderFactory
