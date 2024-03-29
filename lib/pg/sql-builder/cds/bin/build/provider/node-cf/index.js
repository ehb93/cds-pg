const { fs } = require('@sap/cds-foss')
const path = require('path')
const BuildTaskHandlerEdmx = require('../buildTaskHandlerEdmx')
const { getHanaDbModuleDescriptor, getServiceModuleDescriptor } = require('../../mtaUtil')
const { BuildError } = require('../../util')
const { BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_RESULT_ONLY, ODATA_VERSION, ODATA_VERSION_V2,
    BUILD_TASK_HANA, FOLDER_GEN, BUILD_NODEJS_EDMX_GENERAION, EDMX_GENERATION, SKIP_PACKAGE_JSON_GENERATION, SKIP_MANIFEST_GENERATION, CONTENT_EDMX, CONTENT_MANIFEST, CONTENT_PACKAGE_JSON } = require('../../constants')
const { WARNING } = require('../../buildTaskHandler')

const FILE_NAME_MANIFEST_YML = "manifest.yml"

class NodeCfModuleBuilder extends BuildTaskHandlerEdmx {
    init() {
        super.init()
        // set unified option values in order to easy access later on
        this.task.options[CONTENT_EDMX] = this.hasBuildOption(CONTENT_EDMX, true) || this.hasCdsEnvOption(BUILD_NODEJS_EDMX_GENERAION, true) || this.hasBuildOption(EDMX_GENERATION, true) ? true : false
        this.task.options[CONTENT_MANIFEST] = !this.hasBuildOption(CONTENT_MANIFEST, false) && !this.hasBuildOption(SKIP_MANIFEST_GENERATION, true) ? true : false
        this.task.options[CONTENT_PACKAGE_JSON] = !this.hasBuildOption(CONTENT_PACKAGE_JSON, false) && !this.hasBuildOption(SKIP_PACKAGE_JSON_GENERATION, true) ? true : false

        if (this.task.options.compileDest) {
            throw new BuildError("Option not supported - compileDest")
        }
        // fallback if src has been defined as '.'
        this.destGen = this.isStagingBuild() ? path.resolve(this.task.dest, path.relative(this.buildOptions.root, this.task.src) || this.env.folders.srv) : path.join(this.task.dest, FOLDER_GEN)
    }

    async build() {
        if (this.env.get(ODATA_VERSION) === ODATA_VERSION_V2) {
            // log warning as nodejs is only supporting odata version V4
            this.pushMessage("OData v2 is not supported by node runtime. Make sure to define OData v2 in cds configuration.", WARNING)
        }

        const model = await this.model()
        if (!model) {
            return this._result
        }

        // adding csn to build result containing @source and _where persisted properties
        await this.compileToJson(model, this.destGen)

        // collect and write language bundles into single i18n.json file
        await this.collectLanguageBundles(model, this.destGen)

        if (this.hasBuildOption(CONTENT_EDMX, true)) {
            await this.compileToEdmx(model, this.destGen)
        }

        if (!this.hasBuildOption(BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_RESULT_ONLY)) {
            await this._copyNativeContent(this.task.src, this.isStagingBuild() ? this.destGen : path.dirname(this.destGen))

            if (this.hasBuildOption(CONTENT_MANIFEST, true)) {
                await Promise.all([this._writeManifestYml(), this._writeCfIgnore()])
            }
        }
        return this._result
    }

    async clean() {
        // staging build content is deleted by BuildTaskEngine
        if (this.buildOptions.target === this.buildOptions.root) {
            // delete the entire 'task.dest' folder otherwise, for details see #constructor
            // - the value of the folder 'src' has been appended to the origin 'task.dest' dir
            this.logger._debug && this.logger.debug(`Deleting build target folder ${this.destGen}`)
            await fs.remove(this.isStagingBuild() ? this.task.dest : this.destGen)
        }
    }

    async _copyNativeContent(src, dest) {
        const regex = RegExp('\\.cds$|package\\.json|manifest\\.y.?ml')

        await super.copyNativeContent(src, dest, (entry) => {
            if (fs.statSync(entry).isDirectory()) {
                return true // using common filter for folders
            }
            return !regex.test(path.basename(entry))
        })

        // copy relevant content located at project root, e.g. *.js, i18n/*, package.json -> gen/srv
        let packageJsonCopy = false
        let { folders = ['i18n'] } = this.env.i18n
        folders.push('handlers')
        folders = folders.map(folder => path.join(this.buildOptions.root, folder))

        await super.copyNativeContent(this.buildOptions.root, this.task.dest, (entry) => {
            if (fs.statSync(entry).isDirectory()) {
                return folders.some(folder => entry.startsWith(folder))
            }
            if (/\.js$|\.properties$/.test(entry)) {
                return true
            }
            if (/package\.json$/.test(entry) && this.hasBuildOption(CONTENT_PACKAGE_JSON, true)) {
                packageJsonCopy = true
                return true
            }
            return false
        })

        if (packageJsonCopy) {
            await this._modifyPackageJson(path.join(this.task.dest, 'package.json'))
        }
    }

    /**
     * Filter file dependencies for CF deployment.<p>
     *
     * On CF, any ../file or file:... dependency is not resolvable anyways, so we can safely filter it out.
     * In CAP samples, we use these to refer to other CDS modules at build time.
     * @param {string} file
     */
    async _modifyPackageJson(file) {
        function _deleteFileDependencies(deps = {}) {
            let changed = false
            Object.keys(deps).forEach(key => {
                if (typeof deps[key] === 'string' && deps[key].startsWith('.') || deps[key].startsWith('file:')) {
                    this.logger.log(`${this.task.for}: removing file dependency '${deps[key]}' from ${path.relative(this.buildOptions.root, file)}`)
                    delete deps[key]
                    changed = true
                }
            })
            return changed
        }
        function _addEnginesField(content) {
            if (!content.engines || !content.engines.node) {
                const { engines } = require('../../../../package.json')
                if (engines && engines.node) {
                    this.logger.log(`${this.task.for}: adding node engines version to package.json ${engines.node}`)
                    content.engines = content.engines || {}
                    content.engines.node = engines.node
                    return true
                }
            }
            return false
        }

        let content = await fs.readFile(file)
        let changed = false
        if (content) {
            content = JSON.parse(content)
            changed |= _deleteFileDependencies.call(this, content.dependencies)
            changed |= _deleteFileDependencies.call(this, content.devDependencies)
            changed |= _addEnginesField.call(this, content)
        }
        if (changed) {
            await this.write(content).to(file)
        }
    }

    // this is to have a dev fast-turnaround
    async _writeCfIgnore() {
        if (this.isStagingBuild()) {
            const content = `node_modules/\n`
            await this.write(content).to('.cfignore')
        }
    }

    async _writeManifestYml() {
        if (!this.isStagingBuild()) {
            return
        }

        let manifest = path.join(this.task.src, FILE_NAME_MANIFEST_YML)
        if (await fs.pathExists(manifest)) {
            // copy existing manifest to service root folder in staging area
            await this.copy(manifest).to(FILE_NAME_MANIFEST_YML)
            return
        }
        manifest = path.join(this.task.src, 'manifest.yml')
        if (await fs.pathExists(manifest)) {
            // copy existing manifest to service root folder in staging area
            await this.copy(manifest).to('manifest.yml')
            return
        }

        // generate one...
        // check whether a hdi service binding is required
        const hanaBuildTask = this.buildOptions.tasks.find(task => task.for === BUILD_TASK_HANA)
        let hanaServiceBinding = ""

        if (hanaBuildTask) {
            const dbModuleDescriptor = await getHanaDbModuleDescriptor(this.buildOptions.root, path.basename(hanaBuildTask.src), this.logger)
            hanaServiceBinding = `      - ${dbModuleDescriptor.hdiServiceName}`
        } else {
            this.logger.debug("generating manifest.yml without HANA service binding, using sqlite database")
        }

        try {
            const srvModuleDescriptor = await getServiceModuleDescriptor(this.buildOptions.root, path.basename(this.task.src), "nodejs", this.logger)
            const MANIFEST_YML_CONTENT = `---
applications:
  - name: ${srvModuleDescriptor.appName}
    path: .
    memory: 256M
    buildpacks:
      - nodejs_buildpack
    services:
${hanaServiceBinding}`

            await this.write(MANIFEST_YML_CONTENT).to(FILE_NAME_MANIFEST_YML)
        } catch (e) {
            if (e.name === 'YAMLSyntaxError') {
                this.logger.error("Failed to parse [mta.yaml]")
            }
            this.logger.error(e)
        }
    }
}

module.exports = NodeCfModuleBuilder
