const { fs } = require('@sap/cds-foss')
const path = require('path')
const { hasJavaNature, getProperty } = require('../util')
const { FILE_EXT_CDS, BUILD_TASK_HANA, BUILD_TASK_FIORI, BUILD_TASK_JAVA, BUILD_TASK_NODE, BUILD_TASK_MTX,
    CDS_CONFIG_PATH_SEP, BUILD_MODE_INPLACE, BUILD_TASK_PREFIX, BUILD_TASKS } = require("../constants")
const BuildTaskProvider = require('../buildTaskProvider')

class BuildTaskProviderInternal extends BuildTaskProvider {
    constructor(cds, logger) {
        super()
        this._cds = cds
        this._logger = logger
    }

    get cds() {
        return this._cds
    }
    get env() {
        return this.cds.env
    }
    get logger() {
        return this._logger
    }

    canHandleTask(task) {
        return BUILD_TASKS.includes(task.for)
            || task.use && task.use.startsWith(BUILD_TASK_PREFIX)
    }

    loadHandler(task) {
        return require(`./${BuildTaskProviderInternal._getForValueFromTask(task)}`)
    }

    async lookupTasks(buildOptions) {
        return await this._createTasks(buildOptions)
    }

    async applyTaskDefaults(task) {
        const taskFor = BuildTaskProviderInternal._getForValueFromTask(task)
        task.for = task.for || taskFor
        task.use = task.use || `${BUILD_TASK_PREFIX}/${taskFor}`

        if (!task.src) {
            switch (taskFor) {
                case BUILD_TASK_HANA:
                    task.src = BuildTaskProviderInternal._normalizePath(this.env.folders.db)
                    break
                case BUILD_TASK_JAVA:
                case BUILD_TASK_NODE:
                    task.src = BuildTaskProviderInternal._normalizePath(this.env.folders.srv)
                    break
                case BUILD_TASK_FIORI:
                    task.src = BuildTaskProviderInternal._normalizePath(this.env.folders.app)
                    break
                case BUILD_TASK_MTX:
                    task.src = "."
                    break
                default:
                    throw new Error(`Unknown build task '${task.use || task.for}'`)
            }
        }
    }

    async _createTasks(buildOptions) { // NOSONAR
        this.logger.debug("[cds] - Determining CDS build tasks from CDS configuration - applying defaults")
        const { root: projectPath } = buildOptions
        let tasks = []
        let db = typeof this.env.folders.db === "string" ? [BuildTaskProviderInternal._normalizePath(this.env.folders.db)] : this.env.folders.db
        let srv = typeof this.env.folders.srv === "string" ? [BuildTaskProviderInternal._normalizePath(this.env.folders.srv)] : this.env.folders.srv

        const dbOptions = {
            model: []
        }
        const srvOptions = {
            model: []
        }
        if (Array.isArray(db) && db.length > 0) {
            db = BuildTaskProviderInternal._getModuleFolder(projectPath, db) || null
        }
        if (Array.isArray(srv) && srv.length > 0) {
            srv = BuildTaskProviderInternal._getModuleFolder(projectPath, srv) || null
        }
        if (db) {
            // create hana build task
            const dbTask = this._createDbTask(projectPath, db, dbOptions, buildOptions)
            if (dbTask) {
                tasks.push(dbTask)
            }
        } else {
            this.logger.log(`[cds] - project doesn't have a database module [${this.env.folders.db}]`)
        }

        if (srv) {
            // create java or node build task
            const srvTask = this._createSrvTask(projectPath, srv, srvOptions)
            if (srvTask) {
                tasks.push(srvTask)
            }

            // auto-create fiori build tasks only in Webide Fullstack compatibility mode
            if (this.env.build.mode === BUILD_MODE_INPLACE) {
                // create fiori build tasks
                const defaultModels = this._getDefaultModelOptions(projectPath)
                const fioriSrvOptions = {
                    model: [...defaultModels]
                }
                const fioriTasks = this._createFioriTasks(projectPath, fioriSrvOptions)
                if (fioriTasks.length > 0) {
                    tasks = tasks.concat(fioriTasks)
                    const appDirs = this._getFioriAppModelPaths(fioriTasks, projectPath)
                    if (!BuildTaskProviderInternal._appDirsIncluded(defaultModels, appDirs)) {
                        // adding additional appDirs, otherwise use default
                        // tasks.forEach(task => task.options.model = BuildTaskProviderInternal._pushModelPaths(projectPath, defaultModels, appDirs))
                        srvOptions.model = BuildTaskProviderInternal._pushModelPaths(projectPath, defaultModels, appDirs)
                        dbOptions.model = BuildTaskProviderInternal._pushModelPaths(projectPath, defaultModels, appDirs)
                    }
                }
            }
        } else {
            this.logger.log(`[cds] - project doesn't have a service module '${this.env.folders.srv}'`)
        }

        // create mtx build task for node applications
        if (db && tasks.find(task => task.for === BUILD_TASK_NODE)) {
            const mtxTask = this._createMtxTask(srv)
            if (mtxTask) {
                tasks.push(mtxTask)
            }
        }
        return tasks
    }

    static _appDirsIncluded(defaultDirs, appDirs) {
        return !appDirs.some(appDir => !defaultDirs.includes(appDir))
    }

    _createDbTask(projectPath, src, taskOptions, buildOptions) {
        this.logger.debug("[cds] - Determining database kind.")
        let task = null

        if (this._useHana(projectPath, buildOptions)) {
            this.logger.debug("[cds] - Found HANA database.")
            // legacy build supports dest property
            const compileDest = this.env.get("data.dest")
            if (compileDest) {
                //../db/src/gen
                // compileDest is relative to src folder in modular build - resolve correctly
                taskOptions.compileDest = path.relative(path.resolve(projectPath, src), path.resolve(projectPath, compileDest))
            }

            task = {
                src: src,
                for: BUILD_TASK_HANA,
                options: taskOptions
            }
        } else {
            this.logger.debug("[cds] - Found sqlite database - skipping HANA build task")
        }
        return task
    }

    _useHana(projectPath, buildOptions) {
        if (this.env.get("build.mode") === BUILD_MODE_INPLACE
            || getProperty(buildOptions, "for.hana.skipManifestGeneration") // deprecated fallback for webide fullstack and mtx
            || getProperty(buildOptions, "for.hana.contentManifest") === false // fallback for webide fullstack and mtx
            || this.env.get("requires.db.kind") === "hana"
            || this.env.get("requires.db.dialect") === "hana") {

            return true
        }
        // false if other db has been defined
        if (this.env.get("requires.db.kind")) {
            return false
        }
        // check whether cds config represents a legacy build system config for which requires.db was not configured
        // Note: compat layer sets requires.db: {}
        const userEnv = this.cds.env.for("cds", projectPath, false)
        return userEnv && (userEnv.get("data.model") || userEnv.get("service.model"))
    }

    _createMtxTask(srv) {
        this.logger.debug("[cds] - Determining single or multi-tenant strategy.")
        let task = null

        if (this.env.get("requires.multitenancy") && (this.env.get("requires.db.kind") === "hana" || this.env.get("requires.db.dialect") === "hana")) {
            this.logger.debug("[cds] - Found multi-tenant app.")
            task = {
                src: ".",
                for: BUILD_TASK_MTX,
                dest: srv
            }
        } else {
            this.logger.debug("[cds] - Found single-tenant app - skipping mtx build task")
        }
        return task
    }

    _createSrvTask(projectPath, src, taskOptions) {
        this.logger.debug("[cds] - Determining implementation technology")
        let task = this._createJavaTask(projectPath, src, taskOptions)

        if (!task) {
            this.logger.debug("[cds] - Found implementation technology node")
            task = {
                src: src,
                for: BUILD_TASK_NODE,
                options: taskOptions
            }
        }
        return task
    }

    _createJavaTask(projectPath, src, taskOptions) {
        if (this._hasJavaNature(projectPath, src)) {
            this.logger.debug("[cds] - Found implementation technology java")
            // legacy build supports dest property
            const compileDest = this.env.get("service.dest")
            if (compileDest) {
                // compileDest is relative to src folder in modular build - resolve correctly
                taskOptions.compileDest = path.relative(path.resolve(projectPath, src), path.resolve(projectPath, compileDest))
            }
            return {
                src: src,
                for: BUILD_TASK_JAVA,
                options: taskOptions
            }
        }
        return null
    }

    /**
     * Only used in WebIDE Fullstack szenario
     * @deprecated
     * @param {*} projectPath
     * @param {*} fioriSrvOptions
     * @returns
     */
    _createFioriTasks(projectPath, fioriSrvOptions) {
        let tasks = []
        this.logger.debug("[cds] - Determining fiori modules - matching modules */webapp/manifest.json")
        // fiori-app build-tasks
        let appDirs = this.env.ui && this.env.ui.apps ? this.env.ui.apps : undefined
        if (!appDirs) {
            const DEFAULT_UI_MANIFEST_PATTERNS = [
                "*/webapp/manifest.json" // top-level UI apps  (typical Web IDE layout)
            ]
            let app = BuildTaskProviderInternal._normalizePath(this.env.folders.app)
            if (typeof app === "string") {
                DEFAULT_UI_MANIFEST_PATTERNS.push(path.join(app, "*/webapp/manifest.json"))
            } else if (Array.isArray(app)) {
                app.forEach(entry => DEFAULT_UI_MANIFEST_PATTERNS.push(path.join(entry, "*/webapp/manifest.json")))
            }

            const manifestPaths = BuildTaskProviderInternal._findFiles(projectPath, DEFAULT_UI_MANIFEST_PATTERNS)

            // use '/' for any cds-config path entries
            appDirs = manifestPaths.map(manifestPath => path.relative(projectPath, manifestPath.split("webapp")[0]).replace(/\\/g, CDS_CONFIG_PATH_SEP))
        } else {
            appDirs = appDirs.map(appDir => {
                if (path.basename(appDir) === "webapp") {
                    return path.dirname(appDir)
                }
                return appDir
            })
        }
        this.logger._debug && this.logger.debug(`[cds] - Found fiori app paths [${appDirs}]`)
        appDirs.forEach(appDir => {
            appDir = BuildTaskProviderInternal._normalizePath(appDir)
            let modelPaths = this._resolveModel(path.resolve(projectPath, appDir))
            const newTask = {
                src: appDir,
                for: "fiori",
                options: {
                    model: BuildTaskProviderInternal._pushModelPaths(projectPath, fioriSrvOptions.model, modelPaths.length > 0 ? [appDir] : [])
                }
            }
            if (!tasks.find((task) => {
                return task.src === newTask.src && task.for === newTask.for
            })) {
                tasks.push(newTask)
            }
        })
        return tasks
    }

    _getDefaultModelOptions(projectPath) {
        const rm = Object.values(this.env.requires).map(r => r.model).filter(m => m)
        return BuildTaskProviderInternal._pushModelPaths(projectPath, [], this.env.roots, rm)
    }

    _getFioriAppModelPaths(tasks, projectPath) {
        const appDirs = []

        tasks.forEach((task) => {
            // the build task is only relevant if it contains an annotations model
            // only in that case options.model is containing an entry <task.src>
            if (task.for === BUILD_TASK_FIORI && task.options.model.find(cur => cur === task.src)) {
                const appRoot = task.src.split(CDS_CONFIG_PATH_SEP)[0]
                let appDir = task.src
                let model = this._resolveModel(path.resolve(projectPath, appRoot))
                if (model.length > 0) {
                    // appRoot may contain index.cds file
                    appDir = appRoot
                }

                if (appDir && !appDirs.find(cur => cur === appDir)) {
                    appDirs.push(appDir)
                }
            }
        })
        return appDirs
    }

    _resolveModel(modelPath) {
        let model
        try {
            model = this.cds.resolve(modelPath)
        } catch (e) {
            // silently ignore -> assume no model exists
        }
        return model ? model : []
    }

    /**
     * Returns whether this project is a java project or not.
     * @param {string} projectPath - the absolute project path
     * @param {string} src - the folder name of the service module
     */
    _hasJavaNature(projectPath, src) {
        return hasJavaNature([path.join(projectPath, src), projectPath])
    }

    static _getForValueFromTask(task) {
        return task.for ? task.for : task.use && task.use.substring(BUILD_TASK_PREFIX.length + 1)
    }

    static _pushModelPaths(projectPath, model, ...modelPaths) {
        model = new Set(model)
        // may contain nested arrays
        modelPaths = BuildTaskProviderInternal._flatten(modelPaths)

        modelPaths.forEach(m => {
            if (m && !model.has(m) && !model.has(m + "/")) {
                const dir = path.resolve(projectPath, m)
                if (fs.existsSync(dir)) {
                    model.add(BuildTaskProviderInternal._normalizePath(m))
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
                acc = acc.concat(BuildTaskProviderInternal._flatten(m))
            } else if (m) {
                acc.push(m)
            }
            return acc
        }, [])
    }

    static _strippedPath(p) {
        return p.replace(/^(\/|\\)/, '').replace(/(\/|\\)$/, '') // strip leading and trailing slash or backslash
    }

    static _readDirs(dir) {
        if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) return []
        return fs.readdirSync(dir)
            .map(f => path.resolve(dir, f))
            .filter(f => fs.lstatSync(f).isDirectory())
    }

    static _findFiles(projectPath, patterns) {
        const files = []
        patterns.forEach(pattern => {
            const starIndex = pattern.indexOf('*')
            if (starIndex >= 0) {
                const dir = path.resolve(projectPath, pattern.substring(0, starIndex))
                const subPattern = BuildTaskProviderInternal._strippedPath(pattern.substring(starIndex + 1, pattern.length)) // '*/foo/bar/' -> 'foo/bar'
                files.push(...BuildTaskProviderInternal._readDirs(dir).map(subDir => BuildTaskProviderInternal._findFiles(subDir, [subPattern])))
            } else {
                const file = path.resolve(projectPath, pattern)
                if (fs.existsSync(file)) files.push(file)
            }
        })

        function _flatten(o, arr = []) {
            if (o) {
                Array.isArray(o) ? o.forEach(e => _flatten(e, arr)) : arr.push(o)
            }
            return arr
        }
        return _flatten(files)
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
module.exports = BuildTaskProviderInternal
