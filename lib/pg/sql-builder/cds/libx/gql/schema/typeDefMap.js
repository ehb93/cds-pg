const { CDS_TO_GRAPHQL_TYPES } = require('../constants/adapter')
const { gqlName } = require('../utils')

const servicesToTypeDefMap = services => {
  const typeDefs = {}

  // Create nested map of services, their entities, and their respective elements
  for (const service of services) {
    const serviceDefs = (typeDefs[gqlName(service.name)] = {})

    const serviceNamePrefix = `${service.name}.`
    const entitiesKV = Object.entries(service.model.definitions).filter(
      // eslint-disable-next-line no-unused-vars
      ([k, _]) => k.startsWith(serviceNamePrefix) && service.model.definitions[k].kind === 'entity'
    )

    // eslint-disable-next-line no-unused-vars
    for (const [_, entity] of entitiesKV) {
      const def = (serviceDefs[gqlName(entity.name)] = {})
      for (const ele of Object.values(entity.elements)) {
        if (ele.name.startsWith('up_') || ele.name === 'localized' || ele.name === 'texts') {
          continue
        } else if (ele.isAssociation || ele.isComposition) {
          if (!ele.target.startsWith(serviceNamePrefix)) {
            // TODO entities in other namespaces
            continue
          }
          def[ele.name] = ele.is2one ? gqlName(ele.target) : `[${gqlName(ele.target)}]`
        } else if (ele.elements) {
          // TODO structured types
          continue
        } else {
          if (CDS_TO_GRAPHQL_TYPES[ele.type]) {
            def[ele.name] = CDS_TO_GRAPHQL_TYPES[ele.type]
          }
          // TODO aspects
        }
      }
    }
  }

  return typeDefs
}

module.exports = { servicesToTypeDefMap }
