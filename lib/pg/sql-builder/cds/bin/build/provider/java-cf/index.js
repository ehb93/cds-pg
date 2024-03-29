const { fs } = require('@sap/cds-foss')
const path = require('path')

const BuildTaskHandlerEdmx = require('../buildTaskHandlerEdmx')
const { isOldJavaStack, BuildError } = require('../../util')

const { BUILD_OPTION_OUTPUT_MODE, ODATA_VERSION, ODATA_VERSION_V2, OUTPUT_MODE_RESULT_ONLY, FILE_EXT_CDS, SKIP_ASSERT_COMPILER_V2, CONTENT_LANGUAGE_BUNDLES, CONTENT_DEFAULT_CSN } = require('../../constants')
const { INFO } = require('../../buildTaskHandler')

const DEFAULT_COMPILE_DEST_FOLDER = path.normalize('src/main/resources/edmx')

class JavaCfModuleBuilder extends BuildTaskHandlerEdmx {
    init() {
        super.init()
        this.task.options.compileDest = path.resolve(this.task.dest, this.task.options.compileDest || DEFAULT_COMPILE_DEST_FOLDER)
    }

    async build() {
        const { src, dest } = this.task

        const odataOptions = {
            version: this.env.get(ODATA_VERSION)
        }

        if (await isOldJavaStack([src, this.buildOptions.root])) {
            if (!this._isCompilerV1() && !this.env.get(`build.${SKIP_ASSERT_COMPILER_V2}`)) {
                throw new BuildError('CDS compiler version 2 does no longer support the classic CAP Java runtime. It is recommended to migrate to the current CAP Java runtime SDK. See https://cap.cloud.sap/docs/java/migration for more.')
            }
            // default is now v4 and not v2 anymore, so warn and overwrite with v2 if using default
            if (!this.env.for('cds', this.buildOptions.root, false).get(ODATA_VERSION)) {
                odataOptions.version = ODATA_VERSION_V2
                this.pushMessage('Forcing OData v2 for building though the default is v4. Make sure to define OData v2 in cds configuration.', INFO)
            }

            // 'sql_mapping' and 'cds.persinstence.name' annotations are required by old java stack
            if (this.env.sql.names !== 'plain') {
                odataOptions.sql_mapping = this.env.sql.names
            }
        }

        const model = await this.model()
        if (!model) {
            return this._result
        }

        const odata = await this._compileForOdata(model, this.task.options.compileDest, odataOptions)
        await this.compileToEdmx(odata, this.task.options.compileDest, odataOptions)

        if (this.hasBuildOption(CONTENT_LANGUAGE_BUNDLES, true)) {
            // collect and write language bundles into single i18n.json file
            await this.collectLanguageBundles(model, this.task.dest)
        }
        if (!this.hasBuildOption(BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_RESULT_ONLY)) {
            await this._copyNativeContent(src, dest)
        }
        return this._result
    }

    async clean() {
        if (this.isStagingBuild()) {
            await super.clean()
            return
        }
        this.logger._debug && this.logger.debug(`Deleting build target folder ${this.task.options.compileDest}`)
        await fs.remove(this.task.options.compileDest)
    }

    async _copyNativeContent(src, dest) {
        return super.copyNativeContent(src, dest, (entry) => {
            if (fs.statSync(entry).isDirectory()) {
                return true // using common filter for folders
            } else {
                const extname = path.extname(entry)
                return extname !== FILE_EXT_CDS
            }
        })
    }

    async _compileForOdata(model, csnDest, compileOptions) {
        // csn for service providers
        const odataOptions = {
            ...this._options4odata(),
            ...compileOptions
        }
        const odataModel = this.cds.compile.for.odata(model, odataOptions)

        // adding csn to build result containing @source and _where persisted properties
        if (this.hasBuildOption(CONTENT_DEFAULT_CSN, true)) { //default true or undefined
            await this.compileToJson(model, csnDest)
        } else {
            await this.compileToJson(odataModel, csnDest)
        }
        return odataModel
    }

    _isCompilerV1() {
        const { version } = require('@sap/cds-compiler/package.json')
        const match = version.match(/(\d+)\.?(\d*)\.?(\d*)/)
        return match && match[1] === 1
    }
}
module.exports = JavaCfModuleBuilder
