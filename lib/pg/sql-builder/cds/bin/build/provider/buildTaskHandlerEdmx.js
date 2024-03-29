const path = require('path')
const BuildTaskHandlerInternal = require('./buildTaskHandlerInternal')
const { BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_RESULT_ONLY } = require('../constants')

class BuildTaskHandlerEdmx extends BuildTaskHandlerInternal {
    init() {
        this._result = {
            dest: this.task.dest,
            csn: {},
            edmx: new Map(),
            languages: new Set(),
            services: new Set(),
            languageBundles: {}
        }
    }
    async compileToEdmx(model, edmxDest, compileOptions = {}) { // NOSONAR
        const promises = []
        const services = this.cds.reflect(model).services

        // TODO mtx build_helper tests currently expects this, strange...
        this._result.languages.add('')

        // new compile impl is throwing error in case no services exist!
        if (services.length > 0) {
            const options = {
                ...this._options4edmx(),
                ...compileOptions
            }
            this.logger._debug && this.logger.debug(`compiling edmx files using OData version ${options.version}`)

            const result = this.cds.compile.to.edmx(model, options)

            if (result) {
                let langs = this.task.options.lang || this.cds.env.i18n.languages
                if (langs.split) { // string to array
                    langs = langs.split(',')
                }
                if (langs.length > 0 && langs[0] !== 'all' && langs.indexOf('') < 0) {
                    langs.push('')  // make sure fallback language is in, runtimes expect it
                }
                for (let [content, key] of result) {
                    const serviceName = key.file ? key.file : key.name
                    this._result.services.add(serviceName)
                    const locResult = this.cds.localize(model, langs, content)
                    if (locResult[Symbol.iterator]) { // multi result
                        for (let [localizedContent, { lang }] of locResult) {
                            promises.push(this._writeEdmxForLang(localizedContent, serviceName, lang, edmxDest))
                        }
                    } else { // single result
                        promises.push(this._writeEdmxForLang(locResult, serviceName, langs[0], edmxDest))
                    }
                }
            }
        }
        return Promise.all(promises)
    }

    async compileToJson(model, csnDest) {
        // This will als add a @source prop containing the relative path to the origin .cds source file
        // and a parsed _where clause for @restrict.{grant,where} annotations.
        // The @source annotation is required for correct custom handler resolution if no @impl annotation has been defined as
        // custom service handler implementations are relative to the origin .cds source files.
        // For staging builds (task.src !== task.dest) the csn.json file that is served at runtime is copied into a corresponding srv subfolder.
        // As a consequence the src folder name has to be included in the @source file name while for inplace builds (task.src === task.dest) this is not the case.
        // This ensures that the paths are relative to the cwd when executing cds run.
        const jsonOptions = {
            cwd: this.buildOptions.root,
            src: this.task.src === this.task.dest ? this.task.src : this.buildOptions.root
        }
        const csnStr = this.cds.compile.to.json(model, jsonOptions)
        this._result.csn = JSON.parse(csnStr)
        this._result.csn.meta = model.meta

        // csnDest might be null
        if (csnDest && !this.hasBuildOption(BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_RESULT_ONLY)) {
            await this.write(csnStr).to(path.join(csnDest, 'csn.json'))
        }
        return this._result.csn
    }

    /**
     * Collect and write language bundles into a single i18n.json file.
     * @param {Object} model
     * @param {string} bundleDest
     */
    async collectLanguageBundles(model, bundleDest) {
        // collect effective i18n properties...
        let bundles = {}
        const bundleGenerator = this.cds.localize.bundles4(model)
        if (bundleGenerator && bundleGenerator[Symbol.iterator]) {
            for (let [locale, bundle] of bundleGenerator) {
                // fallback bundle has the name ""
                if (typeof locale === 'string') {
                    bundles[locale] = bundle
                }
            }
        }

        // omit bundles in case the fallback bundle is the only existing entry
        const keys = Object.keys(bundles)
        if (keys.length === 1 && keys[0] === "" && Object.keys(bundles[keys[0]]).length === 0) {
            bundles = {}
        }
        // copied from ../compile/i18n.js
        const { folders = ['i18n'], file = 'i18n' } = this.env.i18n
        
        // bundleDest might be null
        if (bundleDest && Object.keys(bundles).length > 0) {
            if (!this.hasBuildOption(BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_RESULT_ONLY)) {
                await this.write(bundles).to(path.join(bundleDest, folders[0], file + '.json'))
            }
        }
        this._result.languageBundles = bundles
        return bundles
    }

    _options4odata() {
        const o = this.options()
        o.version = this.env.odata.version
        return o
    }

    _options4edmx() {
        const o = this._options4odata()
        o.service = 'all'
        return o
    }

    _writeEdmxForLang(content, serviceName, lang, edmxDest) {
        this._result.languages.add(lang)
        const fileName = serviceName + (lang ? '_' + lang + '.xml' : '.xml')
        this._result.edmx.set(fileName, content)

        //edmxDest might be null
        if (edmxDest && !this.hasBuildOption(BUILD_OPTION_OUTPUT_MODE, OUTPUT_MODE_RESULT_ONLY)) {
            return this.write(content).to(path.join(edmxDest, fileName))
        }
        return Promise.resolve()
    }
}
module.exports = BuildTaskHandlerEdmx
