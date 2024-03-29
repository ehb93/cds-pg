exports.BUILD_OPTION_OUTPUT_MODE = "outputMode"

exports.OUTPUT_MODE_DEFAULT = "default"
exports.OUTPUT_MODE_PREVIEW = "preview"
exports.OUTPUT_MODE_RESULT_ONLY = "resultOnly"

exports.BUILD_TASK_NPM_SCOPE = "@sap"
exports.BUILD_TASK_PREFIX = exports.BUILD_TASK_NPM_SCOPE + "/cds/lib/build"
exports.BUILD_TASK_JAVA = "java-cf"
exports.BUILD_TASK_NODE = "node-cf"
exports.BUILD_TASK_HANA = "hana"
exports.BUILD_TASK_FIORI = "fiori"
exports.BUILD_TASK_MTX = "mtx"
exports.BUILD_TASKS = [this.BUILD_TASK_JAVA, this.BUILD_TASK_NODE, this.BUILD_TASK_HANA, this.BUILD_TASK_FIORI, this.BUILD_TASK_MTX]

exports.ODATA_VERSION = "odata.version"
exports.ODATA_VERSION_V2 = "v2"
exports.ODATA_VERSION_V4 = "v4"

exports.BUILD_MODE_INPLACE = "inplace"
exports.BUILD_NODEJS_EDMX_GENERAION = "build.nodejs.edmxgeneration" // WebIDE Fullstack

exports.EDMX_GENERATION = "edmxGeneration"

exports.SKIP_MANIFEST_GENERATION = "skipManifestGeneration"
exports.SKIP_PACKAGE_JSON_GENERATION = "skipPackageJsonGeneration"
exports.SKIP_HDBTABLEDATA_GENERATION = "skipHdbtabledataGeneration"

exports.CONTENT_LANGUAGE_BUNDLES = "contentLanguageBundles" // create i18n.json language bundles
exports.CONTENT_DEFAULT_CSN = "contentDefaultCsn"           // create default CSN format flavor: "inferred"
exports.CONTENT_EDMX = "contentEdmx"                        // create EDMX for required languages
exports.CONTENT_MANIFEST = "contentManifest"                // create manifest.yml and .cfignore files
exports.CONTENT_PACKAGE_JSON = "contentPackageJson"         // create package.json file if not existing, or modify existing package.json
exports.CONTENT_HDBTABLEDATA = "contentHdbtabledata"        // create .hdbtabledata files for .csv files if not existing 

exports.FOLDER_GEN = "gen"
exports.FILE_EXT_CDS = ".cds"

exports.CDS_CONFIG_PATH_SEP = "/"
exports.SKIP_ASSERT_COMPILER_V2 = "skip-assert-compiler-v2"
exports.SEVERITY_ERROR = "Error"
exports.SEVERITY_WARNING = "Warning"
exports.SEVERITY_INFO = "Info"
exports.SEVERITY_DEBUG = "Debug"
exports.SEVERITIES = [exports.SEVERITY_ERROR, exports.SEVERITY_WARNING, exports.SEVERITY_INFO, exports.SEVERITY_DEBUG]
exports.LOG_LEVEL_ERROR = "error"
exports.LOG_LEVEL_WARN = "warn"
exports.LOG_LEVEL_INFO = "info"
exports.LOG_LEVEL_DEBUG = "debug"
exports.LOG_LEVELS = [exports.LOG_LEVEL_ERROR, exports.LOG_LEVEL_WARN, exports.LOG_LEVEL_INFO, exports.LOG_LEVEL_DEBUG]
exports.LOG_MODULE_NAMES = "cds|build"
exports.OVERRIDE_METHOD_MSG = "Must override method"
