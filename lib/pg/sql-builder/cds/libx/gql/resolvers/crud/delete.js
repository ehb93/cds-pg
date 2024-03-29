const { ARGUMENT } = require('../../constants/adapter')
const { getArgumentByName, astToWhere } = require('../parse/ast2cqn')

module.exports = async (service, entityFQN, selection) => {
  let query = service.delete(entityFQN)

  const filter = getArgumentByName(selection.arguments, ARGUMENT.FILTER)
  if (filter) {
    query.where(astToWhere(filter))
  }

  let result
  try {
    result = await service.tx(tx => tx.run(query))
  } catch (e) {
    if (e.code === 404) {
      result = 0
    } else {
      throw e
    }
  }

  return result
}
