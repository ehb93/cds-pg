const DeleteBuilder = require('./DeleteBuilder')
const InsertBuilder = require('./InsertBuilder')
const SelectBuilder = require('./SelectBuilder')
const UpdateBuilder = require('./UpdateBuilder')
const CreateBuilder = require('./CreateBuilder')
const DropBuilder = require('./DropBuilder')

const _getCustomBuilderIfExists = (options, type) => {
  if (options && options.customBuilder) {
    switch (type) {
      case 'SELECT': {
        return options.customBuilder.SelectBuilder
      }

      case 'UPDATE': {
        return options.customBuilder.UpdateBuilder
      }

      case 'DELETE': {
        return options.customBuilder.DeleteBuilder
      }

      case 'CREATE': {
        return options.customBuilder.CreateBuilder
      }

      case 'DROP': {
        return options.customBuilder.DropBuilder
      }
    }
  }
}

/**
 * Factory method to build a SQL string from a CQN object.
 *
 * @param {object} cqn The CQN object used to build the SQL string
 * @param {object} [options] The configuration object for delimiters and placeholders.
 * @param {string} [options.delimiter] - The delimiter string.
 * @param {string} [options.placeholder] - The placeholder for prepared statement.
 * @param {string} [options.locale] - The locale of the user interface.
 * @param {object} [options.customBuilder] - Custom SQL Builders.
 * @param {object} [options.customBuilder.SelectBuilder] - Custom SelectBuilder
 * @param {object} [options.customBuilder.UpdateBuilder] - Custom UpdateBuilder
 * @param {object} [options.customBuilder.DeleteBuilder] - Custom DeleteBuilder
 * @param {object} [options.customBuilder.CreateBuilder] - Custom CreateBuilder
 * @param {object} [options.customBuilder.DropBuilder] - Custom DropBuilder
 * @param [options.definitions]
 * @param {Map} [options.typeConversion] - Map for database specific type conversion. Only relevant for CREATE.
 * @param {object} [csn] CSN
 * @returns {import("./BaseBuilder")} A builder instance
 * @throws Error if no valid CQN object provided
 */
const build = (cqn, options, csn) => {
  if (!cqn) {
    throw new Error('Cannot build SQL. No CQN object provided.')
  }

  const build = Builder => {
    return new Builder(cqn, options, csn).build()
  }

  if (options && options.definitions) {
    csn = options
    options = {}
  }

  if (cqn.SELECT) {
    return build(_getCustomBuilderIfExists(options, 'SELECT') || SelectBuilder)
  }

  if (cqn.INSERT) {
    return build(InsertBuilder)
  }

  if (cqn.UPDATE) {
    return build(_getCustomBuilderIfExists(options, 'UPDATE') || UpdateBuilder)
  }

  if (cqn.DELETE) {
    return build(_getCustomBuilderIfExists(options, 'DELETE') || DeleteBuilder)
  }

  if (cqn.CREATE) {
    return build(_getCustomBuilderIfExists(options, 'CREATE') || CreateBuilder)
  }

  if (cqn.DROP) {
    return build(_getCustomBuilderIfExists(options, 'DROP') || DropBuilder)
  }

  throw new Error(`Cannot build SQL. Invalid CQN object provided: ${JSON.stringify(cqn)}`)
}

module.exports = build
