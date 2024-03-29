const { fs } = require('@sap/cds-foss')
const path = require('path')
const _cds = require('./cds'), { log } = _cds.exec
const BuildTaskProviderFactory = require('./buildTaskProviderFactory')
const { hasJavaNature, getProperty, redactCredentials } = require('./util')
const { FILE_EXT_CDS, BUILD_TASK_JAVA, LOG_MODULE_NAMES } = require("./constants")

class BuildTaskFactory {
    constructor(logger, cds) {
        this._cds = cds ? cds : _cds
        this._logger = logger || this._cds.log(LOG_MODULE_NAMES)
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

    // the following order for determining build tasks is used
    // 1. create from commandline input, e.g. cds build/all --for hana --src db --model srv --dest db
    // 2. read using cds.env.build.tasks
    // 3. create from cds.env.folders config data
    async getTasks(buildOptions = { root: process.env._TEST_CWD || process.cwd() }) {
        try {
            const providerFactory = new BuildTaskProviderFactory(this._logger, this._cds, buildOptions)
            const tasks = await this._createTasks(providerFactory)
            buildOptions.target = path.resolve(buildOptions.root, this.env.build.target)

            // log build tasks
            this.logger.log(`[cds] - the following build tasks will be executed`)
            let tasksOutput = "   {\n     \"build\": {\n       \"target\": \"" + this.env.build.target + "\",\n       \"tasks\": ["
            for (let i = 0; i < tasks.length; i++) {
                tasksOutput += "\n         " + BuildTaskFactory._stringifyTask(tasks[i]) + (i + 1 < tasks.length ? "," : "")
            }
            tasksOutput += "\n       ]\n     }\n   }\n"
            this.logger.log(tasksOutput)

            // for testing purposes
            this.logger.debug("cds.env used for build:")
            this.logger._debug && this.logger.debug(redactCredentials(this.env))

            // always resolve tasks for input validation
            if (buildOptions.resolve || buildOptions.cli) {
                const resolvedTasks = providerFactory.resolveTasks(tasks)
                if (buildOptions.resolve) {
                    return resolvedTasks
                }
            }
            return tasks
        } catch (e) {
            this.logger.log('')
            // cds CLI layer is doing the logging if invoked using CLI
            if (!buildOptions.cli) {
                log(e, { withStack: true, log: (message) => this.logger.log(message) })
            }
            throw e
        }
    }

    async _createTasks(providerFactory) {
        const buildOptions = providerFactory.buildOptions
        this.logger.log(`[cds] - determining build tasks for project [${buildOptions.root}].`)

        let tasks = this._getExistingTasks()
        if (tasks.length === 0) {
            tasks = await providerFactory.lookupTasks()
        } else {
            // 1. apply default values including task.for and task.use and ensure that for all tasks a provider exists - throwing error otherwise
            await providerFactory.applyTaskDefaults(tasks)
        }

        const existingTasks = tasks
        // 2. filters the list of build tasks and adapts according to given CLI options
        tasks = await this._applyCliTaskOptions(buildOptions, tasks)
        if (tasks !== existingTasks && tasks.some(task => !existingTasks.find(existingTask => existingTask === task))) {
            // a different task shall be executed
            await providerFactory.applyTaskDefaults(tasks)
        }

        // obligatory task defaults shared by all tasks
        this._applyCommontTaskDefaults(tasks, buildOptions)

        // ensure correct values for optional build task properties, error for missing mandatory properties
        this._validateBuildTasks(tasks)

        this._setDefaultBuildTargetFolder(tasks, buildOptions)
        return tasks
    }

    _getExistingTasks() {
        return Array.isArray(getProperty(this.env, 'build.tasks')) ? JSON.parse(JSON.stringify(this.env.build.tasks)) : []
    }

    _applyCommontTaskDefaults(tasks, buildOptions) {
        tasks.forEach(task => {
            this._setTaskOptions(task, buildOptions.root)
            if (!task.src) {
                throw new Error(`Invalid build task definition - value of property 'src' is missing in [${task.for || task.use}].`)
            }
        })
    }

    _validateBuildTasks(tasks) {
        tasks.forEach(task => {
            if (!task.src) {
                throw new Error(`Invalid build task definition - value of property 'src' is missing in [${task.for || task.use}].`)
            }
        })
    }

    _setDefaultBuildTargetFolder(tasks, buildOptions) {
        const task = tasks.find(task => task.for === BUILD_TASK_JAVA ? true : false)
        const srv = task ? task.src : BuildTaskFactory._getModuleFolder(buildOptions.root, BuildTaskFactory._flatten([this.env.folders.srv])) || "srv"

        // Java projects use "." as the default build target folder
        if (this._hasJavaNature(buildOptions.root, srv) && this._adaptBuildTargetSettingForJava(buildOptions.root)) {
            this.logger.debug("[cds] - using inplace build for java project instead of default staging build")
        }
        buildOptions.target = path.resolve(buildOptions.root, this.env.build.target)
    }

    _getDefaultModelOptions(projectPath) {
        // clear model cache - see https://github.tools.sap/cap/cds/pull/181
        // Required as cds.serve is invoking cds.resolve('*') which caused cds to cache the current model state
        // which in turn screwed-up all subsequent tests - see ./lib/compile/resolve.js#L67 and ./lib/compile/resolve.js#L58
        this.cds.resolve.cache = {}

        const modelPaths = this.cds.resolve("*", false)
        return BuildTaskFactory._pushModelPaths(projectPath, [], modelPaths)
    }

    /**
     * Returns whether this project is a java project or not.
     * @param {string} projectPath - the absolute project path
     * @param {string} src - the folder name of the service module
     */
    _hasJavaNature(projectPath, src) {
        return hasJavaNature([path.join(projectPath, src), projectPath])
    }

    /**
    * Use inplace build for java projects if build.target has not been configured.
    * @param {string} projectPath
    * @returns {boolean} true if changed, false otherwise
    */
    _adaptBuildTargetSettingForJava(projectPath) {
        if (this.env.build.target !== ".") {
            // filter user settings of cds.env
            const userEnv = this.env.for("cds", projectPath, false)

            // use helper as env.build might be undefined
            if (!getProperty(userEnv, "build.target")) {
                this.env.build.target = "."
                return true
            }
        }
        return false
    }

    _applyCliTaskOptions(buildOptions, tasks, ignoreSrcOption) {
        if (buildOptions.cmdOptions) {
            const options = buildOptions.cmdOptions

            // filter tasks using either option for, use, src
            tasks = tasks.filter(task => {
                return (!options.use || options.use === task.use) && (!options.for || options.for === task.for) && (ignoreSrcOption || !options.src || options.src === task.src)
            })

            if (tasks.length === 0 && (options.for || options.use)) {
                tasks = [{}]
                if ((options.for)) {
                    tasks[0].for = options.for
                }
                if ((options.use)) {
                    tasks[0].use = options.use
                }
                if (options.src) {
                    tasks[0].src = options.src
                }
            }
            // apply remaining cli options to filtered tasks
            tasks.forEach(task => {
                if (options.dest) {
                    task.dest = options.dest
                }
                if (options.opts) {
                    const opts = BuildTaskFactory._scanTaskOptionParams(options.opts)
                    task.options = task.options ? Object.assign(task.options, opts) : opts
                }
            })
        }
        return tasks
    }

    _setTaskOptions(task, projectPath) {
        task.options = task.options || {}
        if (!task.options.model || Array.isArray(task.options.model) && task.options.model.length === 0) {
            const models = new Set(this._getDefaultModelOptions(projectPath))
            if (task.src) {
                models.add(task.src)
            }
            task.options.model = [...models]
        }
        else if (!Array.isArray(task.options.model)) {
            task.options.model = [task.options.model]
        }
    }

    static _stringifyTask(task) {
        // ensures identical order of properties
        const order = ["for", "use", "src", "dest", "options"]
        const keys = Object.keys(task).sort((a, b) => order.indexOf(a) - order.indexOf(b))

        return keys.reduce((acc, key, idx) => {
            // render either "for" OR "use" value
            return acc + (key !== "use" || keys[idx - 1] !== "for" ? (acc !== "{" ? ", " : "") + JSON.stringify(key) + ":" + JSON.stringify(task[key]) : "")
        }, "{") + "}"
    }

    static _scanTaskOptionParams(optsParams) {
        // need to create new regex every call since a constant would keep the match state
        const quoteRegex = /([\w-]+)=([\w/.]+|\[([\w/,.]+)\])/g

        // captures a=1             => a:1
        //          a=[x,y,z]       => a:[x,y,z]
        //          a=1,b=[x,y,z]   => a:1 b=[x,y,z]
        let match = quoteRegex.exec(optsParams)
        const taskOptions = {}

        while (match != null) {
            const key = match[1]
            const value = match[3] || match[2]
            const valueArray = value.split(",")
            taskOptions[key] = valueArray.length > 1 ? valueArray.map((entry) => entry.trim()) : value
            match = quoteRegex.exec(optsParams)
        }
        return taskOptions
    }

    static _pushModelPaths(projectPath, model, ...modelPaths) {
        model = new Set(model)
        // may contain nested arrays
        modelPaths = BuildTaskFactory._flatten(modelPaths)

        modelPaths.forEach(m => {
            if (m && !model.has(m) && !model.has(m + "/")) {
                const dir = path.resolve(projectPath, m)
                if (fs.existsSync(dir)) {
                    model.add(BuildTaskFactory._normalizePath(m))
                } else if (fs.existsSync(dir + FILE_EXT_CDS)) { //might be cds file name, compability to old build configs
                    model.add(m)
                }
            }
        })
        return [...model]
    }

    static _flatten(modelPaths) {
        return modelPaths.reduce((acc, m) => {
            if (Array.isArray(m)) {
                acc = acc.concat(BuildTaskFactory._flatten(m))
            } else if (m) {
                acc.push(m)
            }
            return acc
        }, [])
    }

    /**
     * For valid paths remove trailing '/'. Otherwise return as is - important!!
     * @param {*} dir
     */
    static _normalizePath(dir) {
        return typeof dir === "string" ? dir.replace(/\/$/, '') : dir
    }

    /**
     * Determines the module folder from the past list that may represent files or folders w or w/o .cds file extension.
     * @param {string} projectPath
     * @param {Array} filesOrFolders
     */
    static _getModuleFolder(projectPath, filesOrFolders) {
        const resources = [...filesOrFolders]
        filesOrFolders.forEach(fileOrFolder => {
            if (path.extname(fileOrFolder) !== FILE_EXT_CDS) {
                resources.push(fileOrFolder + FILE_EXT_CDS)
            }
        })
        return resources.reduce((acc, resource) => {
            if (!acc) {
                let resourcePath = path.resolve(projectPath, resource)
                if (fs.existsSync(resourcePath)) {
                    if (fs.lstatSync(resourcePath).isDirectory()) {
                        acc = resource
                    } else {
                        // represents file
                        acc = path.dirname(resource)
                    }
                }
            }
            return acc
        }, null)
    }
}
module.exports = BuildTaskFactory
