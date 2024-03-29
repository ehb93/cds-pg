const cds = require('./cds')
const { fs } = require('@sap/cds-foss')
const path = require('path')
const { getProperty } = require('./util')

const HDI_CONTAINER_TYPES = ['com.sap.xs.hdi-container']
const UTF_8 = 'utf-8'
const MTA_YAML = 'mta.yaml'

async function getHanaDbModuleDescriptor(projectPath, moduleName, logger) {
    // mta might be null if mta.yaml does not exist
    const mta = await _getMta(projectPath, logger)
    const projectInfo = await _getProjectInfo(projectPath, mta, logger)
    const hdiService = _findHdiResource(mta, moduleName, logger)
    const appName = _getApplicationName(mta, moduleName, 'hdb')

    return {
        project: projectInfo,
        appName: appName ? appName : `${projectInfo.name}-${moduleName}-deployer`,
        hdiServiceName: hdiService ? hdiService.name : `${projectInfo.name}-${moduleName}`,
        hdiService: hdiService
    }
}

async function getServiceModuleDescriptor(projectPath, moduleName, moduleType, logger) {
    // mta might be null if mta.yaml does not exist
    const mta = await _getMta(projectPath, logger)
    const projectInfo = await _getProjectInfo(projectPath, mta, logger)
    const appName = _getApplicationName(mta, moduleName, moduleType)

    return {
        project: projectInfo,
        appName: appName ? appName : `${projectInfo.name}-${moduleName}`
    }
}

async function _getProjectInfo(projectPath, mta, logger) {
    const details = {
    }
    // 1. use mta data
    if (mta) {
        details.id = mta.ID
        details.description = mta.description
        details.version = mta.version
        if (mta.ID) {
            details.name = mta.ID.replace(/\./g, '-')
        }
    }
    // 2. use package.json data
    const packageJsonPath = path.join(projectPath, 'package.json')
    if (await fs.pathExists(packageJsonPath)) {
        try {
            const packageJson = await fs.readJSON(packageJsonPath, 'utf-8')
            if (!details.description && packageJson.description) {
                details.description = packageJson.description
            }
            if (!details.version && packageJson.version) {
                details.version = packageJson.version
            }
            if (packageJson.name) {
                let segments = packageJson.name.trim().split('/')
                // scope as namespace
                if (segments[0].startsWith('@')) {
                    segments[0] = segments[0].replace('@', '')
                }
                segments = segments.map(segment => segment.startsWith('@') ? encodeURIComponent(segment.replace('@', '')) : encodeURIComponent(segment))
                if (!details.name) {
                    details.name = segments[segments.length - 1]
                }
                if (!details.id) {
                    details.id = segments.join('.')
                }
                if (!details.description) {
                    details.description = segments[segments.length - 1]
                }
            }
        } catch (e) {
            logger.error(`Failed to load ${packageJsonPath} - skip application data`)
            logger.error(e)
        }
    }
    // 3. use project name and static default values
    const projectName = path.basename(projectPath)
    if (!details.name) {
        details.name = projectName
    }
    if (!details.description) {
        details.description = projectName
    }
    if (!details.id) {
        details.id = projectName
    }
    if (!details.version) {
        details.version = '1.0.0'
    }
    return details
}

async function _getMta(projectPath, logger) {
    // yaml.parse  oesn't like null
    const mtaFilePath = path.join(projectPath, MTA_YAML)

    const existsMtaYaml = await fs.pathExists(mtaFilePath)
    if (!existsMtaYaml) {
        logger.debug('mta.yaml not existing')
        return null
    }

    const yamlStr = await fs.readFile(mtaFilePath, UTF_8)

    // yaml returns null if string couldn't be parsed, e.g. empty string
    return cds.parse.yaml(yamlStr)
}

function _getApplicationName(mta, moduleName, moduleType) {
    const module = _findModule(mta, moduleName, moduleType)
    if (module) {
        const appName = getProperty(module, 'parameters.app-name')
        return appName ? appName : module.name
    }
    return null
}

function _findModules(mta, moduleType) {
    let modules = []
    if (mta && Array.isArray(mta.modules)) {
        modules = mta.modules.filter(module => module.type === moduleType)
    }
    return modules
}

function _findModule(mta, moduleName, moduleType) {
    const modules = _findModules(mta, moduleType)
    if (modules.length === 1) {
        return modules[0]
    } else if (modules.length > 1) {
        return modules.find(module => typeof module.path === 'string' && module.path.includes(moduleName))
    }
    return null
}

function _findHdiResource(mta, moduleName, logger) {
    if (mta && Array.isArray(mta.resources)) {
        const hdiResources = mta.resources.filter(resource => HDI_CONTAINER_TYPES.includes(resource.type))

        if (hdiResources.length > 0) {
            if (Array.isArray(mta.modules)) {
                const module = _findModule(mta, moduleName, 'hdb')
                if (module && Array.isArray(module.requires)) {
                    return hdiResources.find(hdiResource =>
                        module.requires.find(req =>
                            hdiResource.name === req.name
                        )
                    )
                }
            }

            logger.warn(`No matching hdi resource found for ${moduleName}. Using ${hdiResources[0].name}.`)
            return hdiResources[0]
        }
    }

    return null
}

module.exports = {
    getHanaDbModuleDescriptor,
    getServiceModuleDescriptor,
    MTA_YAML
}
