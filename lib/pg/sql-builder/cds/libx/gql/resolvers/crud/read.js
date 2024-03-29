const { ARGUMENT } = require('../../constants/adapter')
const { getArgumentByName, astToColumns, astToWhere, astToOrderBy, astToLimit } = require('../parse/ast2cqn')

module.exports = async (service, entityFQN, selection) => {
  let query = service.read(entityFQN)
  query.columns(astToColumns(selection.selectionSet.selections))

  const filter = getArgumentByName(selection.arguments, ARGUMENT.FILTER)
  if (filter) {
    query.where(astToWhere(filter))
  }

  const orderBy = getArgumentByName(selection.arguments, ARGUMENT.ORDER_BY)
  if (orderBy) {
    query.orderBy(astToOrderBy(orderBy))
  }

  const top = getArgumentByName(selection.arguments, ARGUMENT.TOP)
  const skip = getArgumentByName(selection.arguments, ARGUMENT.SKIP)
  if (top) {
    query.limit(astToLimit(top, skip))
  }

  return await service.tx(tx => tx.run(query))
}
