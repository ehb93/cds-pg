const { fs } = require('@sap/cds-foss')
const path = require('path')
const BuildTaskHandlerInternal = require('../buildTaskHandlerInternal')
const { getHanaDbModuleDescriptor } = require('../../mtaUtil')
const { OUTPUT_MODE_RESULT_ONLY, BUILD_OPTION_OUTPUT_MODE, SKIP_HDBTABLEDATA_GENERATION, SKIP_PACKAGE_JSON_GENERATION,
    SKIP_MANIFEST_GENERATION, CONTENT_MANIFEST, CONTENT_PACKAGE_JSON, CONTENT_HDBTABLEDATA } = require('../../constants')
const { BuildError, setProperty, relativePaths } = require('../../util')
const CSV = require('../../csv-reader')
const to_hdbmigration = require('./2migration')
const to_hdbtabledata = require('./2tabledata')
const { ERROR } = require('../../buildTaskHandler')

const DEFAULT_COMPILE_DEST_FOLDER = path.normalize("src/gen")

const FILE_EXT_CSV = ".csv"
const FILE_EXT_HDBTABLEDATA = ".hdbtabledata"
const FILE_EXT_HDBTABLE = ".hdbtable"
const FILE_EXT_HDBMIGRATIONTABLE = ".hdbmigrationtable"

const FILE_NAME_HDICONFIG = ".hdiconfig"
const FILE_NAME_HDINAMESPACE = ".hdinamespace"
const FILE_NAME_PACKAGE_JSON = "package.json"
const FILE_NAME_MANIFEST_YML = "manifest.yml"
const PATH_LAST_DEV_CSN = "last-dev/csn.json"

// add well-known types supported by HANA Cloud Edition - see also https://github.wdf.sap.corp/cap/issues/issues/8056
const REQUIRED_PLUGIN_TYPES = [FILE_EXT_CSV, FILE_EXT_HDBTABLEDATA, FILE_EXT_HDBTABLE, ".hdbview", ".hdbindex", ".hdbconstraint"]
class HanaModuleBuilder extends BuildTaskHandlerInternal {
    init() {
        this._result = {
            dest: this.task.dest,
            hana: []
        }
        // set unified option values in order to easy access later on
        this.task.options[CONTENT_MANIFEST] = !this.hasBuildOption(CONTENT_MANIFEST, false) && !this.hasBuildOption(SKIP_MANIFEST_GENERATION, true) ? true : false
        this.task.options[CONTENT_PACKAGE_JSON] = !this.hasBuildOption(CONTENT_PACKAGE_JSON, false) && !this.hasBuildOption(SKIP_PACKAGE_JSON_GENERATION, true) ? true : false
        this.task.options[CONTENT_HDBTABLEDATA] = !this.hasBuildOption(CONTENT_HDBTABLEDATA, false) && !this.hasBuildOption(SKIP_HDBTABLEDATA_GENERATION, true) ? true : false

        this.task.options.compileDest = path.resolve(this.task.dest, this.task.options.compileDest || DEFAULT_COMPILE_DEST_FOLDER)
    }

    async build() {
        const { src, dest } = this.task
        const model = await this.model()
        if (!model) {
            return this._result
        }
        const plugins = await this._compileToHana(model)

        if (!this.hasBuildOption(BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_RESULT_ONLY)) {
            // TODO: option 'mtxOriginalSrc' is only a workaround as native hana content part of reuse modules is still an open issue!
            // The option is set by mtx build_helper - the path refers to the base model: 'node_modules/_base/<dbDir>'
            // All files except *.cds files will be copied from base model folder to '#this.task.dest/src/**'.
            // Note:
            // Native hana artifacts are currently not supported by extensions - thus content copied from the base model cannot overwrite
            // content defined by the extension.
            if (this.task.options.build && this.task.options.build.mtxOriginalSrc) {
                const baseModelDbSrcPath = path.join(this.buildOptions.root, this.task.options.build.mtxOriginalSrc)
                if (await fs.pathExists(baseModelDbSrcPath)) {
                    await this._copyNativeContent(baseModelDbSrcPath, dest)
                }
            }

            await this._copyNativeContent(src, dest)
            await this._writeHdiConfig(plugins)
            await this._writeHdiNamespace()

            if (this.hasBuildOption(CONTENT_HDBTABLEDATA, true)) {
                await this._compileToHdbtabledata(model, dest)
            }
            if (this.hasBuildOption(CONTENT_PACKAGE_JSON, true)) {
                await this._writePackageJson()
            }
            if (this.hasBuildOption(CONTENT_MANIFEST, true)) {
                await this._writeManifestYml()
                await this._writeCfIgnore()
            }
        }
        return this._result
    }

    /**
     * Deletes any content that has been created in folder '#this.task.dest/src/gen' by some inplace mode.
     * <br>
     * Note: Content created in staging build will be deleted by the #BuildTaskEngine itself.
     */
    async clean() {
        if (this.isStagingBuild()) {
            return super.clean()
        }
        return fs.remove(this.task.options.compileDest)
    }

    /**
     * Copies the entire content of the db module located in the given <src> folder to the folder <dest>.
     * '*.csv' and '*.hdbtabledata' files located in a subfolder 'data' or 'csv' will be copied to '<dest>/src/gen/data>'||'<dest>/src/gen/csv>'
     *
     * @param {string} src
     * @param {string} dest
     */
    async _copyNativeContent(src, dest) {
        const dbCsvDir = path.join(src, "csv")
        const dbDataDir = path.join(src, "data")
        const csvDirs = [dbCsvDir, dbDataDir]
        const regex = RegExp('\\.cds$|\\.csv$|\\.hdbtabledata$')
        const regexData = RegExp('\\.csv$|\\.hdbtabledata$')

        await super.copyNativeContent(src, dest, (entry) => {
            if (fs.statSync(entry).isDirectory()) {
                return true // using common filter for folders
            }
            return (!regex.test(entry) && entry !== this.env.build.outputfile) ||
                (regexData.test(entry) && !entry.startsWith(dbCsvDir) && !entry.startsWith(dbCsvDir))
        }) || []

        // handle *.csv and *.hdbtabledata located in '<dbSrc>/data' and '<dbSrc>/csv' folder
        const allFiles = csvDirs.reduce((acc, csvDir) => {
            return acc.concat(BuildTaskHandlerInternal._find(csvDir, (entry) => {
                if (fs.statSync(entry).isDirectory()) {
                    return false
                }
                return regexData.test(entry)
            }))
        }, [])

        return Promise.all(allFiles.map((file) => {
            return this.copy(file).to(path.join(this.task.options.compileDest, path.relative(src, file)))
        }))
    }

    /**
     * Generates *.hdbtabledata files in folder '#this.task.dest/src/gen' from *.csv files located in '#this.task.dest/src/**' folder.
     * The generated *.hdbtabledata files will link to their *.csv counterparts using relative links. The *.csv files have either
     * already been defined in the 'src' folder or they have been copied to '#this.task.dest/src/gen/**' folder if they have been
     * created outside 'src' folder. If custom *.hdbtabledata files are found nothing is generated for this particular folder.
     * <br>
     * Note: *.csv and *.hdbtabledata need to be copied to '#this.task.dest/src/gen**' if required before this method is called.
     * In inplace mode dest folder is refering to src folder.
     *
     * @param {object} model compiled csn
     */
    async _compileToHdbtabledata(model, dest) { //NOSONAR
        const tabledataDirs = new Set()
        const destSrcDir = path.join(dest, "src")
        const csvFiles = BuildTaskHandlerInternal._find(destSrcDir, (entry) => {
            if (fs.statSync(entry).isDirectory()) {
                return true
            }
            const extName = path.extname(entry)
            if (extName === FILE_EXT_HDBTABLEDATA) {
                tabledataDirs.add(path.dirname(entry))
            }
            return extName === FILE_EXT_CSV
        })
        if (csvFiles.length > 0) {
            const csvDirs = csvFiles.map(path.dirname).reduce((dirs, dir) => {
                if (!tabledataDirs.has(dir) && !dirs.includes(dir)) { // exclude any dir where a tabledata is present
                    dirs.push(dir)
                }
                return dirs
            }, [])

            // ODM csv data comes with license comments, so strip these
            if (!this.hasBuildOption("stripCsvComments", false)) {
                await this._stripCsvComments(csvFiles)
            }

            const promises = []
            const relDest = path.relative(this.task.dest, this.task.options.compileDest)
            const options = { ...this.options(), dirs: csvDirs, baseDir: this.task.options.compileDest }

            const tableDatas = await to_hdbtabledata(model, options)
            for (let [tableData, { file, csvFolder }] of tableDatas) {
                // create .hdbtabledata side-by-side if .csv is contained in 'src/gen/**' subfolder
                // otherwise create in 'src/gen'
                let tableDataPath = csvFolder.startsWith(this.task.options.compileDest) ? csvFolder : this.task.options.compileDest
                tableDataPath = path.join(tableDataPath, file)
                this._result.hana.push(path.join(relDest, file))
                promises.push(this.write(tableData).to(tableDataPath))
            }
            await Promise.all(promises)
        }
    }

    async _stripCsvComments(csvFiles) {
        // Note: modification of csv files is only allowed for files located in the compile destination folder,
        // meaning having their origin location at db/data/* or db/csv/*
        for (const file of csvFiles) {
            if (this.isStagingBuild() || file.startsWith(this.task.options.compileDest)) {
                await CSV.stripComments(file)
            }
        }
    }

    /**
     * Creates the hana artifacts from the given csn model and writes the files to the folder '<dest>/src/gen'.
     *
     * @param {object} model The compiled csn model
     */
    async _compileToHana(model) {
        // see CAP issue #6222
        const undeployTypes = await this._readTypesFromUndeployJson()
        const pluginTypes = new Set([...REQUIRED_PLUGIN_TYPES, ...undeployTypes])

        // enforces sqlNames option for compiler in tests
        const options = this.options()
        options.sql_mapping = this.env.sql.names

        // compile to old format (.hdbcds) or new format (.hdbtable / .hdbview)
        const format = this.env.hana['deploy-format']
        if (!this.cds.compile.to[format]) {
            return Promise.reject(new Error(`Invalid deploy-format defined: ${format}`))
        }

        if (this.hasCdsEnvOption('features.journal', false) || format === 'hdbcds') {
            await this._compileToHdb(model, pluginTypes, format, options)
        } else {
            await this._compileToHdbmigration(model, pluginTypes, options)
        }
        return pluginTypes
    }

    async _compileToHdb(model, pluginTypes, format, options) {
        const relDest = path.relative(this.task.dest, this.task.options.compileDest)
        const result = this.cds.compile.to[format](model, options)
        const promises = []

        for (const [content, key] of result) {
            pluginTypes.add(key.suffix || path.extname(key.file))
            const file = key.file ? key.file : key.name + key.suffix
            this._result.hana.push(path.join(relDest, file))
            if (!this.hasBuildOption(BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_RESULT_ONLY)) {
                promises.push(this.write(content).to(path.join(this.task.options.compileDest, file)))
            }
        }
        await Promise.all(promises)
    }

    async _compileToHdbmigration(model, pluginTypes, options) {
        const relDestDir = path.relative(this.task.dest, this.task.options.compileDest)
        const relDbDestDir = path.relative(this.buildOptions.root, this.task.options.compileDest)
        const dbSrcDir = path.join(this.task.src, "src")
        const relDbSrcDir = path.relative(this.buildOptions.root, dbSrcDir)
        const lastDevCsnFolder = PATH_LAST_DEV_CSN
        const lastDevCsnDir = path.join(this.task.src, lastDevCsnFolder)
        let lastDev = null
        const promises = []
        const migrationTableFiles = []

        if (await fs.pathExists(lastDevCsnDir)) {
            lastDev = await fs.readJSON(lastDevCsnDir, 'utf-8')
        }
        // pass options from cds env
        setProperty(options, 'hana.journal', this.env.get('hana.journal'))

        const compilationResult = await to_hdbmigration(model, lastDev, dbSrcDir, options)
        const definitions = compilationResult.definitions
        const afterImage = compilationResult.afterImage

        for (const { name, suffix, content, changed } of definitions) {
            pluginTypes.add(suffix)
            const file = name + suffix
            if (suffix === FILE_EXT_HDBMIGRATIONTABLE) {
                migrationTableFiles.push(path.join(relDbSrcDir, file))
                if (changed) {
                    this._result.hana.push(path.join("src", file))
                    if (!this.hasBuildOption(BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_RESULT_ONLY)) {
                        promises.push(this.write(content).to(path.join(dbSrcDir, file)))
                    }
                } else {
                    this.logger._debug && this.logger.debug(`no change, keep existing ${file}`)
                }
            } else {
                this._result.hana.push(path.join(relDestDir, file))
                if (!this.hasBuildOption(BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_RESULT_ONLY)) {
                    promises.push(this.write(content).to(path.join(this.task.options.compileDest, file)))
                }
                if (suffix === FILE_EXT_HDBTABLE) {
                    // issue an error in case a .hdbmigrationtable file already exists
                    if (await fs.pathExists(path.join(dbSrcDir, name + FILE_EXT_HDBMIGRATIONTABLE))) {
                        this.pushMessage(`Multiple files exist defining the same HANA artifact - [${path.join(relDbSrcDir, name + FILE_EXT_HDBMIGRATIONTABLE)}, ${path.join(relDbDestDir, file)}].\nEither annotate the model entity using @cds.persistence.journal or undeploy the file [${path.join('src', name + FILE_EXT_HDBMIGRATIONTABLE)}] using an undeploy.json file.`, ERROR)
                    }
                }
            }
        }
        await Promise.all(promises)
        await this._validateHdbmigrationtables()

        // update last development version
        if (afterImage) {
            if (migrationTableFiles.length > 0) {
                await this.write(afterImage).to(lastDevCsnDir)
            }
        } else {
            throw new BuildError(`Inconsistent CDS compilation results - file ${lastDevCsnFolder} missing`)
        }
    }

    async _writePackageJson() {
        const packageJson = path.join(this.task.src, "package.json")
        const exists = await fs.pathExists(packageJson)

        if (exists) {
            this.logger._debug && this.logger.debug(`skip create [${relativePaths(this.buildOptions.root, packageJson)}], already existing`)
        }
        if (this.isStagingBuild() && !exists) {
            const content = await this._readTemplateAsJson(FILE_NAME_PACKAGE_JSON)
            await this.write(content).to(path.join(this.task.dest, FILE_NAME_PACKAGE_JSON))
        }
    }

    /**
     * Create .hdiconfig file in <dest>src/gen folder of db module.
     */
    async _writeHdiConfig(plugins) {
        const hdiConfig = path.join(this.task.options.compileDest, FILE_NAME_HDICONFIG)
        const template = await this._readTemplateAsJson(FILE_NAME_HDICONFIG)
        let content = {
            'file_suffixes': {}
        }
        for (const key in template['file_suffixes']) {
            if (plugins.has('.' + key)) {
                content['file_suffixes'][key] = template['file_suffixes'][key]
            }
        }
        if (Object.keys(content['file_suffixes']).length !== plugins.size) {
            this.logger.error(`'HANA plugin not found for file suffix [${Array.from(plugins).join(',')}]`)
        }
        // TODO - Be on the save side for now - go for the content use case later on if this works as expected.
        if (this.env.hana['deploy-format'] === 'hdbtable') {
            await this.write(content).to(hdiConfig)
        } else {
            await this.write(template).to(hdiConfig)
        }
    }

    /**
     * Create .hdinamespace file in <dest>src/gen folder of db module.
     */
    async _writeHdiNamespace() {
        // see issue #64 - add .hdinamespace file to prevent HDI from adding gen/ folder to the namespace.
        const hdiNamespace = path.join(this.task.options.compileDest, FILE_NAME_HDINAMESPACE)
        const content = await this._readTemplateAsJson(FILE_NAME_HDINAMESPACE)
        return await this.write(content).to(hdiNamespace)
    }

    /**
     * Create .cfignore file only for staging build.
     * This is to have a fast-turnaround at development
     */
    async _writeCfIgnore() {
        if (this.isStagingBuild()) {
            const content = `node_modules/\n`
            await this.write(content).to(path.join(this.task.dest, '.cfignore'))
        }
    }

    async _writeManifestYml() {
        if (!this.isStagingBuild()) {
            return
        }
        if (await fs.pathExists(path.join(this.task.src, FILE_NAME_MANIFEST_YML)) || await fs.pathExists(path.join(this.task.src, 'manifest.yml'))) {
            this.logger.debug('skip cf manifest generation, already existing')
            return
        }
        try {
            const descriptor = await getHanaDbModuleDescriptor(this.buildOptions.root, path.basename(this.task.src), this.logger)
            const MANIFEST_YML_CONTENT = `---
applications:
  - name: ${descriptor.appName}
    path: .
    no-route: true
    health-check-type: process
    memory: 256M
    buildpacks:
      - nodejs_buildpack
    services:
      - ${descriptor.hdiServiceName}`

            this.logger.debug("Cloud Foundry service binding required for HDI container. To create a service use CF command")
            this.logger._debug && this.logger.debug(`  cf cs hana hdi-shared ${descriptor.hdiServiceName}`)

            await this.write(MANIFEST_YML_CONTENT).to(path.join(this.task.dest, FILE_NAME_MANIFEST_YML))
        } catch (e) {
            if (e.name === 'YAMLSyntaxError') {
                this.logger.error("Failed to parse [mta.yaml] - skip manifest.yml generation")
            }
            this.logger.error(e)
        }
    }

    async _readTemplateAsJson(template) {
        const templatePath = path.join(__dirname, 'template', template)
        return fs.readJSON(templatePath, 'utf-8').catch((error) => {
            this.logger.error(`Failed to read template [${templatePath}]`)
            return Promise.reject(error)
        })
    }

    async _readTypesFromUndeployJson() {
        const result = new Set()
        const file = path.join(this.task.src, "undeploy.json")
        if (await fs.pathExists(file)) {
            const undeployList = await fs.readJSON(file)
            if (Array.isArray(undeployList)) {
                undeployList.forEach(entry => result.add(path.extname(entry)))
            }
        }
        return result
    }

    async _validateHdbmigrationtables() {
        const dbSrcDir = path.join(this.task.src, "src")
        const migrationTableFiles = BuildTaskHandlerInternal._find(dbSrcDir, (res) => {
            return fs.statSync(res).isFile() && path.extname(res) === FILE_EXT_HDBMIGRATIONTABLE
        })
        if (migrationTableFiles.length > 0) {
            const parser = require('./migrationtable')

            await Promise.all(migrationTableFiles.map(async file => {
                try {
                    const tableModel = await parser.read(file)
                    if (tableModel && /^>>>>>/m.test(tableModel.migrations.toString())) {
                        this.pushMessage(`Current model changes require manual resolution. See migration file ${path.relative(this.buildOptions.root, file)} for further details.`, ERROR)
                    }
                } catch (e) {
                    // do not abort build in post validation step
                    this.pushMessage(`${path.relative(this.buildOptions.root, file)}: ${e.toString()}`, ERROR)
                }
            }))
        }
    }
}
module.exports = HanaModuleBuilder
