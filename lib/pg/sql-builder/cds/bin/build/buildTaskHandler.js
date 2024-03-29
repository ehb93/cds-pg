const path = require('path')
const { fs } = require('@sap/cds-foss')

const { BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_DEFAULT, OUTPUT_MODE_RESULT_ONLY, SEVERITY_INFO, SEVERITY_WARNING, SEVERITY_ERROR, OVERRIDE_METHOD_MSG } = require('./constants')
const { hasOptionValue, getProperty, relativePaths, isAbsolutePath, BuildMessage } = require('./util')

/**
 * The build task handler creates the build output for a dedicated build task. It is uniquely identified
 * by the build task's <code>use</code> property. It represents the fully qualified node module path
 * of the build task handler implementation.
 * <p>
 * The build task engine defines the following protocol. The methods are invoked in descending order:
 * <ul>
 *  <li>init() - optional</li>
 *  <li>get priority() - optional</li>
 *  <li>async clean()</li>
 *  <li>async build()</li>
 * </ul>
 * The reflected CSN can be accessed using the async method <code>model()</code>.
 */
class BuildTaskHandler {
    /**
     * @class
     */
    constructor() {
        if (new.target === BuildTaskHandler) {
            throw new TypeError("Cannot construct BuildTaskHandler instances directly");
        }
        this._written = new Set()
        this._messages = []
        //injected by framework
        this._task
        this._buildOptions
    }
    static get INFO() {
        return SEVERITY_INFO
    }
    static get WARNING() {
        return SEVERITY_WARNING
    }
    static get ERROR() {
        return SEVERITY_ERROR
    }
    /**
     * Returns the build task executed by this build task handler.
     * @return {object}
     */
    get task() {
        //injected by framework
        return this._task
    }

    /**
     * Returns the message object to add build task specific messages. Severity 'Info', 'Warning', and 'Error' are supported.
     * @return {Array}
     */
    get messages() {
        return this._messages
    }

    /**
     * Returns the list of files written by this build task handler of current CDS build execution.
     * @return {Array}
     */
    get files() {
        return [...this._written]
    }

    /**
     * Returns the priority of this handler as number, where 0 represents the minimum value and
     * Number.MAX_SAFE_INTEGER the maximum value.
     * Positive numbers mean higher and negative numbers lower priority. Build task handlers
     * with higher priority value are executed before handlers with lower priority.
     * <br>
     * Note: Currently not supported for custom build task handlers as they are always executed
     * before the built-in handlers.
     * @return {number} the priority for this handler as integer.
     */
    get priority() {
        return 1
    }
    /**
     * Called by the framework immediately after this instance has been created.
     * The instance has already been fully initialized.
     */
    init() { }

    /**
     * Called by the framework to create the artefacts of this build task handler.
     */
    async build() {
        throw new TypeError(OVERRIDE_METHOD_MSG)
    }

    /**
     * Called by the framework immediately before 'build' to delete any output created by this build task handler.
     * <p>
     * Note: The <code>BuildTaskEngine</code> is cleaning the common generation target folder if the build is
     * executed in staging mode, e.g. build.target: "gen".
     */
    async clean() {
        throw new TypeError(OVERRIDE_METHOD_MSG)
    }

    /**
     * Asynchronously write the given content to a given file path.
     * If the file exists the content is replaced. If the file does not exist, a new file will be created.
     * The file name is stored in the list of files written by this build task handler.
     * @param {string} dest - absolute or relative file path. Relative paths will be resolved to this task's destination path.
     * @param {any} data - If data is of type object the JSON-stringified version is written.
     */
    write(data) {
        return {
            to: async (dest) => {
                if (!this._hasBuildOption(BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_RESULT_ONLY)) {
                    if (!isAbsolutePath(dest)) {
                        // relative to build task's destination path
                        dest = path.resolve(this.task.dest, dest)
                    }
                    this._pushFile(dest)
                    if (this._hasBuildOption(BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_DEFAULT)) {
                        await fs.outputFile(dest, typeof data === "object" ? JSON.stringify(data, null, 2) : data)
                    }
                }
            }
        }
    }

    /**
     * Copy a file or directory if the build task option 'outputMode' does not have the value 'resultOnly'.
     * The directory can have contents.
     * <p>
     * Note: The file name is stored in the list of files written by this build task handler.
     * </p>
     * @param {string} source The absolute or relative source path of the file or directory to copy.
     * Relative paths will be resolved to this task's source path.
     * @param {string} dest The absolute or relative target path. Relative paths will be resolved to this task's destination path.
     *
     */
    copy(source) {
        return {
            to: async (dest) => {
                if (!this._hasBuildOption(BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_RESULT_ONLY)) {
                    if (!isAbsolutePath(source)) {
                        // relative to build task's source path
                        source = path.resolve(this.task.src, source)
                    }
                    if (!isAbsolutePath(dest)) {
                        // relative to build task's destination path
                        dest = path.resolve(this.task.dest, dest)
                    }
                    this._pushFile(dest)
                    if (this._hasBuildOption(BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_DEFAULT)) {
                        // symlinks are not dereferenced
                        await fs.copy(source, dest)
                    }
                    return dest
                }
            }
        }
    }

    /**
     * Adds the given user message and severity to the list of messages issued by this build task.
     * <p>
     * User messages will be logged after CDS build has been finished based on the log-level that has been set.
     * By default messages with severity <em>warning</em> and <em>error</em> will be logged.
     * @param {string} message the message text
     * @param {string} severity the severity of the message
     */
    pushMessage(message, severity) {
        this.messages.push(new BuildMessage(message, severity))
    }

    /**
     * Returns the reflected CSN model using this build task's model settings.
     * @return {object} the reflected CSN
     */
    async model() {
        const files = this._resolveModel()
        if (!files || files.length === 0) {
            this._logger.log("no model found, skip build")
            return null
        }
        this._logger._debug && this._logger.debug(`model: ${relativePaths(this._buildOptions.root, files).join(", ")}`)
        const options = { messages: this._messages }
        // $location paths are relative to current working dir by default - make sure a given project root folder is taken
        options.cwd = this._buildOptions.root

        const model = await this._cds.load(files, options)
        if (!model) {
            return null
        }
        return model
    }

    /**
     * Adds the given fully qualified file path to the list of files that are written by this build task.
     * @param {string} filePath
     */
    _pushFile(filePath) {
        this._written.add(filePath)
    }
    /**
     * Returns a list of CDS model files defining the transitive closure of the CDS model based on the model options
     * defined for this build task.
     */
    _resolveModel() {
        const modelPaths = Array.isArray(this.task.options.model) && this.task.options.model.length > 0 ? this.task.options.model : !Array.isArray(this.task.options.model) && this.task.options.model || this.task.src
        return this._cds.resolve(modelPaths, this._buildOptions)
    }
    /** Determines whether the given build option value has been set for this build task.
      * If the value is omitted, the existence of the given property name is checked.
      */
    _hasBuildOption(qualifiedName, value) {
        return hasOptionValue(this._getBuildOption(qualifiedName), value)
    }
    // Returns the value of the given build option defined for this build task.
    _getBuildOption(qualifiedName) {
        // build task options overwriting other settings
        let value = getProperty(this.task.options, qualifiedName)
        if (value !== undefined) {
            return value
        }
        value = getProperty(this._buildOptions.for[this.task.for], qualifiedName)
        if (value !== undefined) {
            return value
        }
        return getProperty(this._buildOptions, qualifiedName)
    }
}
module.exports = BuildTaskHandler
