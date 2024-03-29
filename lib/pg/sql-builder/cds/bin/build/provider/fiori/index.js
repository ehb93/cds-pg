const path = require('path')
const BuildTaskHandlerEdmx = require('../buildTaskHandlerEdmx')
const URL = require('url')
const { getProperty, isOldJavaStack, relativePaths } = require('../../util')

const { ODATA_VERSION, ODATA_VERSION_V2, BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_RESULT_ONLY, BUILD_TASK_FIORI, BUILD_TASK_JAVA, CDS_CONFIG_PATH_SEP } = require('../../constants')

/**
 * With cds 4 service metadata for the UI service binding is no longer created by default.
 * For SAP Web IDE Full-Stack compatibility a corresponding metadata.xml is still generated.
 * Though, 'fiori' build tasks can still be configured for UI5 mockserver usage - see https://github.wdf.sap.corp/cap/issues/issues/8673
 */
class FioriAppModuleBuilder extends BuildTaskHandlerEdmx {
    async prepare() {
        this.buildOptions.for[BUILD_TASK_FIORI] = this.buildOptions.for[BUILD_TASK_FIORI] || {}

        // cache for later use across multiple FioriAppModuleBuilder instances
        const fioriBuildOptions = getProperty(this.buildOptions.for, BUILD_TASK_FIORI)
        fioriBuildOptions.appModel = new Map()
        fioriBuildOptions.appEdmx = new Map()

        // group tasks that have a common application root folder
        const appTaskGroups = new Map()
        this.buildOptions.tasks.forEach(task => {
            if (task.for === BUILD_TASK_FIORI) {
                const appFolder = path.relative(this.buildOptions.root, task.src).split(CDS_CONFIG_PATH_SEP)[0]
                appTaskGroups.has(appFolder) ? appTaskGroups.get(appFolder).push(task) : appTaskGroups.set(appFolder, [task])
            }
        })

        // merge all model references to resolve the model later on
        const appModelGroups = new Map()
        for (let [appFolder, appTaskGroup] of appTaskGroups.entries()) {
            const appModels = new Set()
            appTaskGroup.forEach(task => {
                if (Array.isArray(task.options.model)) {
                    task.options.model.forEach(model => appModels.add(model))
                }
            })
            appModelGroups.set(appFolder, appModels)
        }

        const originFioriBuildOption = fioriBuildOptions[BUILD_OPTION_OUTPUT_MODE]
        fioriBuildOptions[BUILD_OPTION_OUTPUT_MODE] = OUTPUT_MODE_RESULT_ONLY

        try {
            const edmxOptions = { version: this.env.get(ODATA_VERSION) }

            if (edmxOptions.version !== ODATA_VERSION_V2) {
                const javaTask = this.buildOptions.tasks.find(task => task.for === BUILD_TASK_JAVA)

                if (javaTask
                    && await isOldJavaStack([javaTask.src, this.buildOptions.root])
                    && !this.env.for("cds", this.buildOptions.root, false).get(ODATA_VERSION)) {

                    // old java stack
                    // default is now v4 and not v2 anymore, so overwrite with v2 if using default
                    this.logger.debug("Fiori task is forcing OData v2 for building though the default is v4.")
                    edmxOptions.version = ODATA_VERSION_V2
                }
            }

            for (let [appFolder, appModelGroup] of appModelGroups.entries()) {
                this.logger.log(`building module [${appFolder}] using [${this.constructor.name}]`)
                const modelPaths = this.cds.resolve(Array.from(appModelGroup.values()), this.buildOptions)
                if (!modelPaths || modelPaths.length === 0) {
                    this.logger.log(`no model found`)
                    continue
                }
                this.logger._debug && this.logger.debug(`model: ${relativePaths(this.buildOptions.root, modelPaths).join(", ")}`)

                //cache model per fiori app root folder
                const options = this.options()
                const model = await this.cds.load(modelPaths, options)
                fioriBuildOptions.appModel.set(appFolder, model)

                await this.compileToEdmx(model, null, edmxOptions)

                // cache edmx per fiori app root folder
                fioriBuildOptions.appEdmx.set(appFolder, this._result.edmx)
            }
        } finally {
            fioriBuildOptions[BUILD_OPTION_OUTPUT_MODE] = originFioriBuildOption
        }
        return false
    }

    /**
     * This version only creates a odata representation for the 'mainService' data source
     * as defined by the fiori wizard - everything else is currently not supported.
     * Therefore errors are only logged, the build does not fail in case a the service
     * cannot be resolved based on the defined service URI
     */
    async build() {
        const { src, dest } = this.task
        const modelPaths = this.resolveModel()
        if (!modelPaths || modelPaths.length === 0) {
            this.logger.log(`no model found`)
            return
        }
        this.logger._debug && this.logger.debug(`model: ${relativePaths(this.buildOptions.root, modelPaths).join(", ")}`)

        await this._writeEdmxToWebapp(src, dest)
    }

    async _writeEdmxToWebapp(src, dest) {
        const manifestPath = path.join(src, 'webapp', 'manifest.json')
        let manifest

        try {
            manifest = require(manifestPath)
        } catch (error) {
            this.logger.log(`UI module does not contain a manifest.json [${relativePaths(this.buildOptions.root, manifestPath)}], skipping build`)
            return
        }

        const mainService = getProperty(manifest, ['sap.app', 'dataSources', 'mainService'])
        if (!mainService) {
            // no mainService defined - not supported
            this.logger._debug && this.logger.debug(`UI module does not have a datasource [mainService], [${relativePaths(this.buildOptions.root, manifestPath)}], skipping build`)
            return
        }

        const localUri = getProperty(mainService, ['settings', 'localUri'])
        const uri = mainService.uri

        if (!localUri || !uri) {
            this.logger._debug && this.logger.warn(`local uri setting missing for data source [mainService], [${relativePaths(this.buildOptions.root, manifestPath)}]`)
            return
        }

        const appFolder = path.relative(this.buildOptions.root, src).split(CDS_CONFIG_PATH_SEP)[0]
        const model = this.getBuildOption("appModel").get(appFolder)
        if (!model) {
            this.logger.error(`failed to load model for service uri ${uri}, data source [mainService]`)
            return
        }

        const edmx = this._getEdmxForUri(model, appFolder, uri)
        if (!edmx) {
            this.logger.error(`failed to resolve service definition for service uri ${uri}, data source [mainService]`)
            return
        }

        if (!this.hasBuildOption(BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_RESULT_ONLY)) {
            const edmxPath = path.resolve(path.join(dest, 'webapp'), this._strippedUrlPath(localUri))
            return this.write(edmx).to(edmxPath)
        }
    }

    _getEdmxForUri(model, appFolder, uri) {
        const uriSegments = this._strippedUrlPath(uri).split('/')

        // one segment of the URI has to match a service name
        // NOTE: assumption is that the service definition can be resolved - either by
        // - defining corresponding using statement in annotations model or
        // - adding the service module folder to the model option
        let service = this.cds.reflect(model).find(service => uriSegments.find(segment => service.name === segment))

        if (service) {
            const allServices = this.getBuildOption("appEdmx").get(appFolder)
            if (allServices) {
                return allServices.get(service.name + ".xml")
            }
        }
        return null
    }

    _strippedUrlPath(urlString) {
        const url = URL.parse(urlString)
        return url.pathname.replace(/^(\/|\\)/, '').replace(/(\/|\\)$/, '') // strip leading and trailing slash or backslash)
    }
}

module.exports = FioriAppModuleBuilder
