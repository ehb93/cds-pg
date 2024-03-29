const { fs } = require('@sap/cds-foss')
const path = require('path')
const BuildTaskHandler = require('../buildTaskHandler')
const { hasOptionValue } = require('../util')
const { FOLDER_GEN } = require('../constants')

class BuildTaskHandlerInternal extends BuildTaskHandler {
    /**
     * Returns the logger that has been passed the build task engine.
     * @returns {object}
     */
    get logger() {
        //injected by framework
        return this._logger;
    }
    /**
     * Returns the cds module providing access to the CDS compiler functionality and other framework functionality.
     * @returns {object}
     */
    get cds() {
        //injected by framework
        return this._cds
    }
    /**
     * Returns the build options used for this CDS build execution
     * @returns {object}
     */
    get buildOptions() {
        return this._buildOptions
    }
    /**
     * Returns the effective CDS environment used by this CDS build execution.
     * @returns {object}
     */
    get env() {
        return this.cds.env
    }
    /**
     * Custom build handlers are executed before internal handlers in order
     * ensure and content cannot be overwriten by mistake.
     */
    get priority() {
        return BuildTaskHandlerInternal.PRIORITY_MAX_VALUE
    }

    async clean() {
        // the build results have already been deleted by the BuildTaskEngine if the build.target !== '.'
        // make sure that src is not a subfolder of dest
        if (this._buildOptions.root === this._buildOptions.target && this.task.src !== this.task.dest && !this._isSubDirectory(this.task.dest, this.task.src)) {
            await fs.remove(this.task.dest)
        }
    }

    /**
     * Used by the framework to initialize the logger implementation.
     * @param {object} logger
     */
    set logger(logger) {
        super.logger = logger;
    }
    /**
     * Used by the framework to initialize the correct cds context.
     * @param {object} cds
     */
    set cds(cds) {
        super.cds = cds;
    }
    /**
     * Sets the build options used for this CDS build execution
     * @param {object} options
     */
    set buildOptions(options) {
        super.buildOptions = options
    }
    /**
     * Maximum allowed priority for internal build tasks.
     */
    static get PRIORITY_MAX_VALUE() {
        return 0;
    }
    /**
     * Minimum allowed priority for custom build tasks.
     */
    static get PRIORITY_MIN_VALUE() {
        return Number.MIN_SAFE_INTEGER;
    }

    /**
     * Called by the framework after {@link #init()}. Handlers may want to perform more elaborate preparation.
     * E.g. caching some pre-calculated data that can be used across multiple build tasks. This kind of data
     * has to be stored in the handler type specific buildOptions section.
     * @returns {Promise<boolean>} A value 'false' indicates that {@link #prepare()} will not be called for other instances
     * of this handler type.
     * True indicates that {@link #prepare()} will be called for other instances of this of this handler type.
     * @deprecated
     */
    async prepare() {
        // cancel subsequent prepare calls for other handlers of the same type by default
        return false
    }

    /**
     * Returns whether cds env has a property with the specified value.
     * If the value is omitted the existence of the given property name is checked.
     * @param {string} qualifiedName
     * @param {any=} value
     */
    hasCdsEnvOption(qualifiedName, value) {
        return hasOptionValue(this.env.get(qualifiedName), value)
    }

    /**
     * Determines whether the given build option value has been set for this build task.
     * If the value is omitted, the existence of the given property name is checked.
     * @param {string} qualifiedName
     * @param {any=} value
     */
    hasBuildOption(qualifiedName, value) {
        return hasOptionValue(this._getBuildOption(qualifiedName), value)
    }

    /**
     * Returns the value of the given build option defined for this build task.
     * @param {string} qualifiedName
     */
    getBuildOption(qualifiedName) {
        return super._getBuildOption(qualifiedName)
    }

    /**
    * Returns a list of CDS model files defining the transitive closure of the CDS model based on the model options
    * defined for this build task.
    */
    resolveModel() {
        return this._resolveModel()
    }

    /**
     * Returns whether the build results of this build plugin are created inplace
     * or in a separate staging folder which is not part of the build tasks src folder.
     */
    isStagingBuild() {
        return this.task.src !== this.task.dest
    }

    async copyNativeContent(srcDir, destDir, customFilter) {
        if (!this.isStagingBuild()) {
            return Promise.resolve()
        }
        const files = BuildTaskHandlerInternal._find(srcDir, (src) => {
            // do not copy files that:
            // - are contained in the 'buildOptions.target' folder
            // - are contained in this modules 'dest' folder
            // - are contained in some generation folder
            // - do NOT fullfill additional specific filter criteria
            // NOTE: there is no specific handling for content that is part of the 'node_modules' folder as it might be required later on, e.g. reuse model content
            return this._commonStagingBuildFilter(src, destDir) && (!customFilter || customFilter.call(this, src))
        })
        return Promise.all(
            files.map((srcFile) => {
                let relFile = path.relative(srcDir, srcFile)
                let destFile = path.join(destDir, relFile)
                return this.copy(srcFile).to(destFile)
            })
        )
    }

    options() {
        return { messages: this._messages, logger: this.logger }
    }

    _isSubDirectory(parent, child) {
        return !path.relative(parent, child).startsWith('..')
    }

    _commonStagingBuildFilter(src, destDir) {
        if (typeof src !== "string" || typeof destDir !== "string") {
            return false
        }
        if (!fs.statSync(src).isDirectory()) {
            return true //file
        }
        if (src === destDir) {
            return false
        }
        const regex = new RegExp(FOLDER_GEN + "\\b")
        if (src === this.buildOptions.target) {
            return false
        }
        return !regex.exec(path.basename(src))
    }

    static _find(srcDir, filter) {
        const files = []
        BuildTaskHandlerInternal._traverseFileSystem(srcDir, files, filter)
        return files;
    }

    static _traverseFileSystem(srcDir, files, filter) {
        let entries = []
        try {
            entries = fs.readdirSync(srcDir)
        } catch (e) {
            // ignore if not existing
        }
        entries.map(subDirEntry => path.join(srcDir, subDirEntry)).forEach((entry) => {
            BuildTaskHandlerInternal._handleResource(entry, files, filter)
        })
    }

    static _handleResource(entry, files, filter) {
        if (!filter || filter.call(this, entry)) {
            var stats = BuildTaskHandlerInternal._getResourceStatus(entry)
            if (stats.isDirectory()) {
                BuildTaskHandlerInternal._traverseFileSystem(entry, files, filter)
            } else if (stats.isFile() || stats.isSymbolicLink()) {
                files.push(entry)
            }
        }
    }

    // for testing purposes
    static _getResourceStatus(entry) {
        return fs.lstatSync(entry)
    }
}
module.exports = BuildTaskHandlerInternal
