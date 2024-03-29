const cds = require('../../cds')

const { getAllKeys } = require('../../cds-services/adapter/odata-v4/odata-to-cqn/utils')

const { getNavigationIfStruct } = require('../../common/utils/structured')
const { ensureNoDraftsSuffix, ensureDraftsSuffix, ensureUnlocalized } = require('../../common/utils/draft')
const { filterKeys } = require('../../fiori/utils/handler')
const { isAsteriskColumn } = require('../../common/utils/rewriteAsterisks')

// Symbols are used to add extra information in response structure
const GET_KEY_VALUE = Symbol.for('sap.cds.getKeyValue')
const TO_MANY = Symbol.for('sap.cds.toMany')
const TO_ACTIVE = Symbol.for('sap.cds.toActive')
const SKIP_MAPPING = Symbol.for('sap.cds.skipMapping')
const IDENTIFIER = Symbol.for('sap.cds.identifier')
const IS_ACTIVE = Symbol.for('sap.cds.isActive')
const IS_UNION_DRAFT = Symbol.for('sap.cds.isUnionDraft')

const { DRAFT_COLUMNS } = require('../../common/constants/draft')

const { getCQNUnionFrom } = require('../../common/utils/union')

function getCqnCopy(readToOneCQN) {
  const readToOneCQNCopy = JSON.parse(JSON.stringify(readToOneCQN))
  if (readToOneCQN[GET_KEY_VALUE] !== undefined) readToOneCQNCopy[GET_KEY_VALUE] = readToOneCQN[GET_KEY_VALUE]
  if (readToOneCQN[TO_MANY] !== undefined) readToOneCQNCopy[TO_MANY] = readToOneCQN[TO_MANY]
  if (readToOneCQN[TO_ACTIVE] !== undefined) readToOneCQNCopy[TO_ACTIVE] = readToOneCQN[TO_ACTIVE]
  if (readToOneCQN[SKIP_MAPPING] !== undefined) readToOneCQNCopy[SKIP_MAPPING] = readToOneCQN[SKIP_MAPPING]
  if (readToOneCQN[IDENTIFIER] !== undefined) readToOneCQNCopy[IDENTIFIER] = readToOneCQN[IDENTIFIER]
  if (readToOneCQN[IS_ACTIVE] !== undefined) readToOneCQNCopy[IS_ACTIVE] = readToOneCQN[IS_ACTIVE]
  if (readToOneCQN[IS_UNION_DRAFT] !== undefined) readToOneCQNCopy[IS_UNION_DRAFT] = readToOneCQN[IS_UNION_DRAFT]
  return readToOneCQNCopy
}

class JoinCQNFromExpanded {
  constructor(cqn, csn, locale) {
    this._SELECT = Object.assign({}, cqn.SELECT)
    this._csn = csn
    // REVISIT: locale is only passed in case of sqlite -> bad coding
    if (cds.env.i18n.for_sqlite.includes(locale)) {
      this._locale = locale
    }
    this.queries = []
    this.mappings = {}
  }

  /**
   * Build one to N queries and construct the post processing configs.
   * Each expand with a to many target will result in an extra query and config.
   *
   * @returns {this}
   */
  buildJoinQueries() {
    const unionTableRef = this._getUnionTable(this._SELECT)
    // side effect: this_aliases is set
    const aliases = this._getTableAlias(this._SELECT, [], unionTableRef && unionTableRef.table)

    // Add table aliases to all refs in where part obtained from annotations
    this._adaptAliasForWhere(this._SELECT.where)

    // Update elements at WHERE, so there are no issues with ambiguity
    this._adaptWhereOrderBy(this._SELECT, aliases)

    // Get first level of expanding regarding to many and all to one if not part of a nested to many expand.
    this._createJoinCQNFromExpanded(this._SELECT, [])

    return this
  }

  _getUnionTable(SELECT) {
    if (!SELECT.from.SET) return
    // Ensure the draft table is picked, no matter, which position
    for (const arg of SELECT.from.SET.args) {
      const ref = this._getRef(arg.SELECT)
      // Do not handle non draft cases, as it will be unclear, which entity to pick from
      if (ref.table.endsWith('_drafts')) {
        return ref
      }
    }
  }

  _isDraftTargetActive(table) {
    return Boolean(this._csn.definitions[table])
  }

  _isDraftTree(table) {
    // TODO: this is a workaround until the service is flagged as draft enabled by cds-services
    if (!this._isDraft) {
      const entity =
        this._csn.definitions[ensureUnlocalized(table)] || this._csn.definitions[table.replace(/_drafts$/i, '')]
      this._isDraft = entity._isDraftEnabled
    }

    return this._isDraft
  }

  /**
   * Build first level of expanding regarding to many and all to one if not part of a nested to many expand.
   *
   * @param {object} SELECT - SELECT part of a CQN.
   * @param {Array} toManyTree - Holds information how deeply nested the expand is and where the result is added in the tree.
   * @param {boolean} defaultLanguage - Use default language for localized fields
   * @private
   */
  _createJoinCQNFromExpanded(SELECT, toManyTree, defaultLanguage) {
    const joinArgs = SELECT.from.args
    const isJoinOfTwoSelects = joinArgs && joinArgs.every(a => a.SELECT)

    const unionTableRef = this._getUnionTable(SELECT)
    const unionTable = unionTableRef && unionTableRef.table
    const tableAlias = this._getTableAlias(SELECT, toManyTree, unionTable)

    const readToOneCQN = this._getReadToOneCQN(SELECT, isJoinOfTwoSelects ? 'filterExpand' : tableAlias)

    if (isJoinOfTwoSelects) {
      // mappings
      const mappings = this._getMappingObject(toManyTree)
      const prefix = `${tableAlias}_`
      SELECT.columns
        .filter(c => c.as && c.as.startsWith(prefix) && c[SKIP_MAPPING] !== true)
        .forEach(c => {
          mappings[c.as.replace(prefix, '')] = c.as
        })
      // expand to one
      const entity = this._csn.definitions[joinArgs[0].SELECT.from.SET.args[1].SELECT.from.ref[0]]
      const givenColumns = readToOneCQN.columns
      readToOneCQN.columns = []
      this._expandedToFlat({ entity, givenColumns, readToOneCQN, tableAlias, toManyTree, defaultLanguage })
    } else {
      const table = unionTable || this._getRef(SELECT).table
      const isDraftTree = this._isDraftTree(table)
      const entity = this._getEntityForTable(table)

      if (unionTable) readToOneCQN[IS_UNION_DRAFT] = true

      readToOneCQN[IS_ACTIVE] = isDraftTree ? this._isDraftTargetActive(table) : true

      const givenColumns = readToOneCQN.columns
      readToOneCQN.columns = []
      this._expandedToFlat({ entity, givenColumns, readToOneCQN, tableAlias, toManyTree, defaultLanguage })
    }

    // brute force hack
    readToOneCQN.columns = readToOneCQN.columns.filter(c => c.as !== 'filterExpand_IsActiveEntity')

    // Add at start, so that the deepest level is post processed first
    this.queries.push({
      SELECT: readToOneCQN,
      _toManyTree: toManyTree
    })
  }

  /**
   * Self referencing associations, two expanded entities based on same table, ...
   * Requires an abstract name to prevent ambiguity issues.
   * Use hash to prevent names longer than support by DB.
   *
   * @param SELECT
   * @param toManyTree
   * @param unionTable
   * @returns {string}
   * @private
   */
  _getTableAlias(SELECT, toManyTree, unionTable) {
    return this._createAlias(toManyTree.length === 0 ? unionTable || this._getRef(SELECT).table : toManyTree.join(':'))
  }

  _getRef(SELECT) {
    const table = Object.prototype.hasOwnProperty.call(SELECT.from, 'join')
      ? this._getRefFromJoin(SELECT.from.args)
      : SELECT.from

    return {
      table: table.SELECT ? this._getRef(table.SELECT).table : table.ref[0],
      as: table.as
    }
  }

  _getRefFromJoin(args) {
    if (args[0].join) {
      return this._getRefFromJoin(args[0].args)
    }

    if (args[0].ref) {
      return args[0]
    }

    // Order is reversed
    return args[args.length - 1]
  }

  /**
   * Create an alias from value.
   *
   * @param {string} value
   * @returns {string}
   * @private
   */
  _createAlias(value) {
    if (!this._aliases) {
      this._aliases = {}
    }

    if (!this._aliases[value]) {
      const aliasNum = Object.keys(this._aliases).length

      if (aliasNum < 26) {
        this._aliases[value] = String.fromCharCode(aliasNum + 97)
      } else {
        this._aliases[value] = `alias${aliasNum + 1}`
      }
    }

    return this._aliases[value]
  }

  _getEntityForTable(table) {
    if (table === 'DraftAdministrativeData') {
      table = `DRAFT.${table}`
    }

    if (this._isDraft) {
      return this._csn.definitions[table] || this._csn.definitions[table.replace(/_drafts/i, '')]
    }

    return this._csn.definitions[table]
  }

  /**
   * Get base CQN, with the same filters as origin.
   *
   * @param {object} SELECT
   * @param {string} tableAlias
   * @returns {object}
   * @private
   */
  _getReadToOneCQN(SELECT, tableAlias) {
    const cqn = Object.assign({}, SELECT, { from: Object.assign({}, SELECT.from) })

    if (Object.prototype.hasOwnProperty.call(cqn.from, 'join')) {
      this._adaptJoin(tableAlias, cqn, cqn.from)
    } else {
      if (cqn.from.SET) {
        cqn.from.SET = Object.assign({}, cqn.from.SET, { args: this._adaptUnionArgs(cqn.from.SET.args) })
      }

      cqn.from.as = tableAlias
    }

    return cqn
  }

  _adaptTableNameInColumn(column, originalIdentifier, tableAlias) {
    return column.ref && column.ref[0] === originalIdentifier
      ? Object.assign({}, column, { ref: [tableAlias, column.ref[1]] })
      : column
  }

  _adaptJoin(tableAlias, cqn, from) {
    from.args = from.args.slice(0)
    if (Object.prototype.hasOwnProperty.call(from.args[0], 'join')) {
      this._adaptJoin(tableAlias, cqn, from.args[0])
    } else {
      const index = from.args[0].ref ? 0 : from.args.length - 1
      const target = Object.assign({}, from.args[index], { as: tableAlias })
      const originalIdentifier = from.args[index].as || from.args[index].ref[0]

      from.args[index] = target
      from.on = from.on.map(column => this._adaptTableNameInColumn(column, originalIdentifier, tableAlias))
      cqn.columns = cqn.columns.map(column => this._adaptTableNameInColumn(column, originalIdentifier, tableAlias))
    }
  }

  _adaptUnionArgs(args) {
    return args.map(arg => {
      if (arg.SELECT.columns) {
        // remove the expands from the sub selects, as they are joined against the unioned result
        arg = Object.assign({}, arg, { SELECT: Object.assign({}, arg.SELECT) })
        arg.SELECT.columns = arg.SELECT.columns.filter(element => {
          return !element.expand || typeof element.expand === 'function'
        })
      }

      return arg
    })
  }

  _adaptWhereElement(element, cqn, tableAlias) {
    if (element.list) {
      return Object.assign(element, {
        list: element.list.map(element => this._checkOrderByWhereElementRecursive(cqn, element, tableAlias))
      })
    }
    return this._checkOrderByWhereElementRecursive(cqn, element, tableAlias)
  }

  /**
   * Ensure that columns are accessed in combination with table alias.
   * Prevents ambiguity issues.
   *
   * @param {object} cqn
   * @param {string} tableAlias
   * @returns {object}
   * @private
   */
  _adaptWhereOrderBy(cqn, tableAlias) {
    if (cqn.where) {
      cqn.where = cqn.where.map(element => this._adaptWhereElement(element, cqn, tableAlias))
    }

    if (cqn.having) {
      cqn.having = cqn.having.map(element => this._adaptWhereElement(element, cqn, tableAlias))
    }

    if (cqn.orderBy) {
      cqn.orderBy = cqn.orderBy.map(element => {
        return this._checkOrderByWhereElementRecursive(cqn, element, tableAlias)
      })
    }

    if (cqn.groupBy) {
      cqn.groupBy = cqn.groupBy.map(element => {
        return this._checkOrderByWhereElementRecursive(cqn, element, tableAlias)
      })
    }

    return cqn
  }

  _addAlias(whereElement) {
    whereElement.ref && whereElement.ref.splice(0, 1, Object.values(this._aliases)[0])
  }

  _adaptAliasForFrom(from) {
    if (from.args) {
      from.args.forEach(arg => {
        this._adaptAliasForFrom(arg)
      })
    } else if (from.SELECT) {
      this._adaptAliasForFrom(from.SELECT.from)
      if (from.SELECT.where) {
        this._adaptAliasForWhere(from.SELECT.where)
      }
    }
  }

  _adaptAliasForWhere(where) {
    if (where) {
      for (const whereElement of where) {
        if (whereElement.SELECT) {
          if (whereElement.SELECT.where) {
            this._adaptAliasForWhere(whereElement.SELECT.where)
          }
          this._adaptAliasForFrom(whereElement.SELECT.from)
        }
      }
    }
  }

  _navigationNeedsAlias(element, { table } = {}) {
    const entity = this._csn.definitions[table]
    if (entity) {
      const e = this._csn.definitions[table].elements[element.ref[0]]
      return e && e.isAssociation
    }

    return false
  }

  _checkOrderByWhereElementRecursive(cqn, element, tableAlias) {
    if (element.func) {
      element = Object.assign({}, element)
      this._functionNeedsReplacement(cqn, tableAlias, element)
    } else if (element.ref) {
      element = Object.assign({}, element)
      element.ref = element.ref.slice(0)

      if (element.ref.length === 1) {
        element.ref.unshift(tableAlias)
      } else if (this._elementAliasNeedsReplacement(element, this._getUnionTable(cqn) || this._getRef(cqn))) {
        element.ref[0] = tableAlias
      } else if (this._navigationNeedsAlias(element, this._getUnionTable(cqn) || this._getRef(cqn))) {
        element.ref.unshift(tableAlias)
      }

      this._functionNeedsReplacement(cqn, tableAlias, element)
    } else if (element.xpr) {
      element = Object.assign({}, element)
      element.xpr = element.xpr.map(nestedElement => {
        return this._checkOrderByWhereElementRecursive(cqn, nestedElement, tableAlias)
      })
    } else if (element.SELECT && element.SELECT.where) {
      element = {
        SELECT: Object.assign({}, element.SELECT, {
          where: this._adaptWhereSELECT(this._getUnionTable(cqn) || this._getRef(cqn), element.SELECT.where, tableAlias)
        })
      }
    }

    return element
  }

  /**
   * @param aliasedTable
   * @param {Array} where
   * @param tableAlias
   * @private
   * @returns {Array}
   */
  _adaptWhereSELECT(aliasedTable, where, tableAlias) {
    return where.map(element => {
      return this._elementAliasNeedsReplacement(element, aliasedTable)
        ? Object.assign({}, element, { ref: [tableAlias, element.ref[1]] })
        : element
    })
  }

  _elementAliasNeedsReplacement(element, { table, as }) {
    // ref contains a single column, no replacement needed
    if (!element.ref || element.ref.length < 2) {
      return false
    }

    switch (element.ref[0]) {
      case table:
      case as:
        return true
      default:
        return false
    }
  }

  _isValidFunc(element) {
    if (typeof element.func === 'string' && Array.isArray(element.args)) {
      return true
    }

    if (
      typeof element.ref[0] === 'string' &&
      typeof element.ref[1] === 'object' &&
      Array.isArray(element.ref[1].args)
    ) {
      return true
    }
  }

  _mapArg(arg, cqn, tableAlias) {
    if (Array.isArray(arg.list)) {
      arg = Object.assign({}, arg)
      arg.list = arg.list.map(item => {
        return this._checkOrderByWhereElementRecursive(cqn, item, tableAlias)
      })

      return arg
    }

    return this._checkOrderByWhereElementRecursive(cqn, arg, tableAlias)
  }

  _functionNeedsReplacement(cqn, tableAlias, element) {
    if (!this._isValidFunc(element)) {
      return
    }

    if (element.ref) {
      element.ref[1] = Object.assign({}, element.ref[1])
      element.ref[1].args = element.ref[1].args.map(arg => {
        return this._mapArg(arg, cqn, tableAlias)
      })
    } else {
      element.args = element.args.slice(0)
      element.args = element.args.map(arg => {
        return this._mapArg(arg, cqn, tableAlias)
      })
    }
  }

  _skip(targetEntity) {
    return targetEntity && targetEntity._hasPersistenceSkip
  }

  /**
   * Build CQN(s) with JOINs for expanding. In case of expanding with to many an additional CQN will be pushed to toManyCQN.
   *
   * @param {object} arg - Avoiding many arguments and issues that come with it by using an object.
   * @param {object} arg.entity - Entity that is taken from CSN.
   * @param {Array} arg.givenColumns - List of read columns taken from CQN.
   * @param {object} arg.readToOneCQN - Build CQN the JOIN(s) should be added to or it will be used to filter an expanded to many entity.
   * @param {string} arg.tableAlias - Table alias
   * @param {Array} arg.toManyTree - Information, where the expand array is located in the result array.
   * @param {boolean} arg.defaultLanguage - Use default language for localized fields
   * @private
   */
  _expandedToFlat({ entity, givenColumns, readToOneCQN, tableAlias, toManyTree, defaultLanguage }) {
    const toManyColumns = []
    const mappings = this._getMappingObject(toManyTree)

    const readToOneCQNCopy = getCqnCopy(readToOneCQN)

    for (const column of givenColumns) {
      let navigation
      if (column.expand) {
        navigation = getNavigationIfStruct(entity, tableAlias === column.ref[0] ? column.ref.slice(1) : column.ref)
        if (this._skip(navigation && navigation._target)) continue
      }

      if (this._isExpandToMany(column, entity, navigation)) {
        // To many can only be build, once all other columns have been processed.
        const trgt = column.ref[column.ref.length - 1]
        mappings[trgt] = { [TO_MANY]: true }
        if (entity._isDraftEnabled && entity.elements[trgt]._isAssociationStrict) mappings[trgt][TO_ACTIVE] = true
        toManyColumns.push({ parentAlias: tableAlias, column: column })
      } else if (typeof column.expand === 'object') {
        // Expands with to one target can be processed directly
        const navProp = column.ref[column.ref.length - 1]
        const navTarget = entity.elements[navProp]
        if (
          entity._isDraftEnabled &&
          navTarget._isAssociationStrict &&
          !navTarget['@odata.draft.enclosed'] &&
          navTarget.name !== 'DraftAdministrativeData'
        ) {
          mappings[navProp] = { [TO_ACTIVE]: true }
        }
        this._addJoinAndElements({
          column,
          entity,
          readToOneCQN,
          toManyTree,
          parentAlias: tableAlias,
          defaultLanguage
        })
      } else {
        // No expand, directly add the column and its mapping.
        readToOneCQN.columns.push(this._addAliasToColumn(column, entity, tableAlias, mappings))

        // REVISIT required for other cqn properties as well?
        this.adjustOrderBy(readToOneCQN.orderBy, mappings, column, tableAlias)
      }
    }

    // only as second step handle expand to many, or else keys might still be unknown
    this._toMany({
      entity,
      readToOneCQN,
      tableAlias,
      toManyColumns,
      toManyTree,
      mappings,
      defaultLanguage,
      readToOneCQNCopy
    })
  }

  adjustOrderBy(orderBy, mappings, column, tableAlias) {
    const colName = column.as || (column.ref && column.ref[column.ref.length - 1])
    if (orderBy && mappings[colName]) {
      orderBy.forEach(order => {
        if (order.args) {
          this.adjustOrderBy(order.args, mappings, column, tableAlias)
        } else {
          if (order.ref[0] === tableAlias && order.ref[1] === colName) {
            order.as = mappings[colName]
          }
        }
      })
    }
  }

  /**
   * Follow the tree to get to the relevant config object.
   *
   * @param {Array} toManyTree
   * @returns {object}
   * @private
   */
  _getMappingObject(toManyTree) {
    let mappings = this.mappings
    for (const element of toManyTree) {
      if (!mappings[element]) mappings[element] = {}
      mappings = mappings[element]
    }
    return mappings
  }

  _addJoinCompToOne(cqn, entity, tableAlias) {
    const draftTable = ensureDraftsSuffix(entity.target)
    const on = []
    for (const key in entity._target.keys) {
      if (key !== 'IsActiveEntity') {
        on.push({ ref: [`${tableAlias}_drafts`, key] }, '=', { ref: [tableAlias, key] })
      }
    }
    return {
      args: [cqn, { ref: [draftTable], as: `${tableAlias}_drafts` }],
      join: 'left',
      on: on
    }
  }

  _isExpandToMany(column, entity, navigation) {
    return typeof column.expand === 'function' ||
      (column.expand && column.ref[column.ref.length - 1] === 'DraftAdministrativeData')
      ? false
      : navigation && navigation.is2many
  }

  _isNavigationToOne(activeTable, target) {
    return (
      target &&
      ((activeTable && target.type === 'cds.Composition') || target.type === 'cds.Association') &&
      target.is2one
    )
  }

  _getTarget(entity, column) {
    const navigation = getNavigationIfStruct(entity, column.ref)
    return (navigation && navigation.target) || column.ref[0]
  }

  /**
   * Adds JOIN instructions to CQN for expands with 1:1 target and returns config how to map it back.
   *
   * @param {object} args
   * @param args.column
   * @param args.entity
   * @param args.readToOneCQN
   * @param args.toManyTree
   * @param args.parentAlias
   * @param args.defaultLanguage
   * @private
   */
  // eslint-disable-next-line complexity
  _addJoinAndElements({ column, entity, readToOneCQN, toManyTree, parentAlias, defaultLanguage }) {
    const extendedToManyTree = toManyTree.concat(column.ref)
    const tableAlias = this._createAlias(extendedToManyTree.join(':'))
    const target = this._getTarget(entity, column)

    // if union always only expand with active, otherwise evaluate flag
    // if flag shows false, we check entity for associations to non draft
    const activeTableRequired =
      readToOneCQN[IS_UNION_DRAFT] ||
      readToOneCQN[IS_ACTIVE] ||
      (entity.elements[column.ref[0]].type === 'cds.Association' &&
        !entity.elements[column.ref[0]]['@odata.draft.enclosed']) ||
      !this._csn.definitions[target]._isDraftEnabled

    const colTarget = target && ensureUnlocalized(target)
    const defaultLanguageThis =
      defaultLanguage ||
      entity['@cds.localized'] === false ||
      (colTarget && this._csn.definitions[colTarget] && this._csn.definitions[colTarget]['@cds.localized'] === false)

    const join =
      column.ref[0] === 'DraftAdministrativeData' || !entity.elements[column.ref[0]].notNull || this._isDraft
        ? 'left'
        : 'inner'

    const args = [
      readToOneCQN.from.SET ? this._unionToSubQuery(readToOneCQN) : readToOneCQN.from,
      {
        ref: [this._refFromRefByExpand(column.ref[0], colTarget, defaultLanguageThis, activeTableRequired)],
        as: tableAlias
      }
    ]

    readToOneCQN.from = {
      join,
      args,
      on: null
    }

    const expandedEntity = this._getEntityForTable(target)
    if (readToOneCQN[IS_UNION_DRAFT] && expandedEntity.drafts) {
      const cols = column.expand.filter(c => !c.expand && !DRAFT_COLUMNS.includes(c.ref[0])).map(c => c.ref[0])
      const ks = Object.keys(expandedEntity.keys).filter(
        c => !expandedEntity.keys[c].isAssociation && !DRAFT_COLUMNS.includes(c)
      )
      const user = (cds.context && cds.context.user && cds.context.user.id) || 'anonymous'
      const unionFrom = getCQNUnionFrom(cols, expandedEntity.name, expandedEntity.name + '.drafts', ks, user)
      readToOneCQN.from.args[1] = {
        SELECT: {
          columns: cols,
          from: unionFrom,
          as: tableAlias
        }
      }
    }

    // note: set the on condition after the join kind and args are set
    readToOneCQN.from.on = this._getOnCond(entity, column.ref, tableAlias, parentAlias, readToOneCQN)

    if (column.ref[0] !== 'DraftAdministrativeData') {
      this._addJoinKeyColumnsToUnion(readToOneCQN.from.args, readToOneCQN.from.on, parentAlias)
    }

    // special case of navigation to one requires additional LEFT JOIN and CASE for HasDraftEntity
    const compToOne = this._isNavigationToOne(readToOneCQN[IS_ACTIVE], entity.elements[column.ref[0]])
    const index = column.expand.findIndex(col => col.ref && col.ref[col.ref.length - 1] === 'HasDraftEntity')

    if (compToOne && index !== -1) {
      readToOneCQN.from = this._addJoinCompToOne(readToOneCQN.from, entity.elements[column.ref[0]], tableAlias)
      if (activeTableRequired) {
        column.expand[index] = {
          xpr: [
            'case',
            'when',
            `${tableAlias}_drafts.DraftAdministrativeData_DraftUUID`,
            'IS NOT NULL',
            'then',
            'true',
            'else',
            'false',
            'end'
          ],
          as: 'HasDraftEntity',
          cast: { type: 'cds.Boolean' }
        }
      } else {
        column.expand[index] = {
          val: false,
          as: 'HasDraftEntity',
          cast: { type: 'cds.Boolean' }
        }
      }
    }

    const givenColumns = column.expand.map(col => {
      if (
        activeTableRequired &&
        col.ref &&
        col.ref.length &&
        (col.ref[0] === 'IsActiveEntity' || col.ref[0] === 'HasActiveEntity')
      ) {
        return {
          val: col.ref[0] === 'IsActiveEntity',
          as: col.ref[0],
          cast: { type: 'cds.Boolean' }
        }
      }
      return col
    })

    this._expandedToFlat({
      entity: this._getEntityForTable(target),
      givenColumns,
      readToOneCQN,
      tableAlias,
      toManyTree: extendedToManyTree,
      defaultLanguage: defaultLanguageThis
    })
  }

  _refFromRefByExpand(column, target, defaultLanguage, isActiveRequired = true) {
    if (column === 'DraftAdministrativeData') {
      return 'DRAFT.DraftAdministrativeData'
    }

    if (isActiveRequired && !defaultLanguage) {
      const locale = this._locale ? `${this._locale}.` : ''
      const localized = `localized.${locale}${target}`
      if (this._csn.definitions[localized]) {
        target = localized
      }
    }

    return `${target}${isActiveRequired ? '' : '_drafts'}`
  }

  _unionToSubQuery(readToOneCQN) {
    return {
      SELECT: {
        columns: Array.from(readToOneCQN.columns),
        from: readToOneCQN.from,
        as: readToOneCQN.from.as
      }
    }
  }

  _getAliases(columns) {
    return columns.reduce((aliases, entry) => {
      if (!entry.ref) {
        return aliases
      }

      if (!aliases[entry.ref[0]]) {
        aliases[entry.ref[0]] = {}
      }

      aliases[entry.ref[0]][entry[IDENTIFIER]] = entry.as
      return aliases
    }, {})
  }

  _getSubSelectColumns(cqn) {
    const args = cqn.args || cqn.from.args

    if (args) {
      for (const arg of args) {
        if (arg.ref) {
          continue
        }

        if (arg.SELECT && arg.SELECT.columns.some(column => column[IDENTIFIER])) {
          return arg.SELECT.columns
        }

        return this._getSubSelectColumns(arg.SELECT || arg)
      }
    }

    if (!cqn.from) return []

    const columns = cqn.from.SELECT ? cqn.from.SELECT.columns : cqn.columns
    return columns.some(column => column[IDENTIFIER]) ? columns : []
  }

  _getOnCond(entity, columns, tableAlias, parentAlias, readToOneCQN) {
    if (columns[0] === 'DraftAdministrativeData') {
      if (readToOneCQN[IS_ACTIVE]) {
        const subWhere = []

        for (const key in entity.keys) {
          if (key === 'IsActiveEntity') continue
          if (subWhere.length) {
            subWhere.push('and')
          }

          subWhere.push({ ref: [key] }, '=', { ref: [parentAlias, key] })
        }

        return [
          { ref: [tableAlias, 'DraftUUID'] },
          'in',
          {
            SELECT: {
              from: { ref: [ensureDraftsSuffix(entity.name)] },
              columns: [{ ref: ['DraftAdministrativeData_DraftUUID'] }],
              where: subWhere
            }
          }
        ]
      }

      return [{ ref: [tableAlias, 'DraftUUID'] }, '=', { ref: [parentAlias, 'DraftAdministrativeData_DraftUUID'] }]
    }

    // No sub select
    const subSelectColumns = this._getSubSelectColumns(readToOneCQN)

    if (subSelectColumns.length === 0) {
      return entity._relations[tableAlias === columns[0] ? columns.slice(1) : columns].join(tableAlias, parentAlias)
    }

    const aliases = this._getAliases(subSelectColumns)
    const on = entity._relations[tableAlias === columns[0] ? columns.slice(1) : columns].join(tableAlias, parentAlias)

    for (const element of on) {
      if (element.ref && aliases[element.ref[0]] && aliases[element.ref[0]][element.ref[1]]) {
        element.ref[1] = aliases[element.ref[0]][element.ref[1]]
      }
    }

    return on
  }

  _addJoinKeyColumnsToUnion(args, on, parentAlias) {
    for (const arg of args) {
      if (arg.ref) {
        continue
      }

      if (arg.args) {
        this._addJoinKeyColumnsToUnion(arg.args, on, parentAlias)
      } else if (arg.SELECT.from.SET && arg.SELECT.as === parentAlias) {
        this._addColumns(arg.SELECT.from.SET.args, on, parentAlias)
      }
    }
  }

  _addColumns(args, on, parentAlias) {
    const [
      {
        SELECT: { columns }
      }
    ] = args
    const keyColumns = on
      .filter(entry => {
        return (
          entry.ref &&
          entry.ref[0] === parentAlias &&
          !columns.some(column => column.ref && column.ref[column.ref.length - 1] === entry.ref[1])
        )
      })
      .map(entry => ({ ref: [entry.ref[1]] }))

    if (keyColumns.length === 0) return

    for (const {
      SELECT: { columns }
    } of args) {
      columns.push(...keyColumns)
    }
  }

  /**
   * Add an unique alias to each column, to avoid ambiguity.
   * Add this information to the post process config.
   *
   * @param {object} column
   * @param entity
   * @param tableAlias
   * @param mappings
   * @returns {object}
   * @private
   */
  _addAliasToColumn(column, entity, tableAlias, mappings) {
    // No identifier for this row entry or technical column
    if (this._isAliasNotNeeded(column)) {
      return column
    }

    return this._buildNewAliasColumn(column, entity, tableAlias, mappings)
  }

  /**
   * Technical or a value without a casted ensureNoDraftsSuffixname, or some other not yet supported combinations should not be refactored.
   *
   * @param {object} column
   * @returns {boolean}
   * @private
   */
  _isAliasNotNeeded(column) {
    // functions, direct values, ...
    if (!column.ref && !column.as) {
      return true
    }

    // No column name specified means false
    return column.ref && typeof column.ref[column.ref.length - 1] !== 'string'
  }

  _buildNewAliasColumn(column, entity, tableAlias, mappings) {
    // Casted name, vs column name
    const identifier = this._getIdentifier(column, tableAlias)
    const as = column[SKIP_MAPPING] ? column.as : `${tableAlias}_${identifier}`
    const aliasedElement = Object.assign({}, column)

    aliasedElement.as = as

    // Add table alias or name to handle cases, where joined tables have same column names
    if (this._isElement(column.ref, entity)) {
      const alias = tableAlias || ensureNoDraftsSuffix(entity.name)
      aliasedElement.ref = alias ? [alias, column.ref[0]] : [column.ref[0]]
    }

    if (!column[SKIP_MAPPING]) {
      mappings[column[IDENTIFIER] || identifier] = as
    }

    return aliasedElement
  }

  _getIdentifier(column, tableAlias) {
    if (column.as) {
      return column.as.startsWith(`${tableAlias}_`) && column.ref ? column.ref[column.ref.length - 1] : column.as
    }

    return column.ref[column.ref.length - 1]
  }

  _isElement(ref, entity) {
    if (!ref || ref.length !== 1) return false

    // Normal element
    if (entity.elements[ref[0]]) return true

    // structured element
    const splitted = ref[0].split('_')
    if (splitted.length > 1 && entity.elements[splitted[0]]) return true

    // Draft column
    return DRAFT_COLUMNS.includes(ref[0])
  }

  _toMany({
    entity,
    readToOneCQN,
    tableAlias,
    toManyColumns,
    toManyTree,
    mappings,
    defaultLanguage,
    readToOneCQNCopy
  }) {
    if (toManyColumns.length === 0) {
      return
    }

    this._addKeysIfNeeded({ entity, readToOneCQN, tableAlias })

    for (const { column, parentAlias } of toManyColumns) {
      const select = this._buildExpandedCQN({
        column,
        entity,
        readToOneCQN: readToOneCQNCopy,
        toManyTree,
        mappings,
        parentAlias,
        defaultLanguage
      })
      this._createJoinCQNFromExpanded(select, toManyTree.concat([column.ref[column.ref.length - 1]]), defaultLanguage)
    }
  }

  /**
   * In case of to many relations, a key is needed for post processing.
   *
   * @param {object} args
   * @param args.entity
   * @param args.readToOneCQN
   * @param args.tableAlias
   * @private
   */
  _addKeysIfNeeded({ entity, readToOneCQN, tableAlias }) {
    for (const name of this._getMissingKeys({ entity, readToOneCQN, tableAlias })) {
      if (name === 'IsActiveEntity') {
        readToOneCQN.columns.push({
          val: readToOneCQN[IS_ACTIVE],
          as: 'IsActiveEntity',
          cast: { type: 'cds.Boolean' }
        })
      } else {
        readToOneCQN.columns.push({
          as: `${tableAlias}_${name}`,
          ref: [tableAlias, name]
        })
      }
    }
  }

  /**
   * Compare the list of available keys with keys listed already listed at CQN and return missing.
   *
   * @param {object} args
   * @param args.entity
   * @param args.readToOneCQN
   * @param args.tableAlias
   * @returns {Array}
   * @private
   */
  _getMissingKeys({ entity, readToOneCQN, tableAlias }) {
    const keyNames = getAllKeys(entity)

    if (!keyNames) {
      return []
    }

    return keyNames.filter(name => {
      return !readToOneCQN.columns.some(column => column.as === `${tableAlias}_${name}` || column.as === name)
    })
  }

  /**
   * Construct the base CQN for a to many expands.
   *
   * @param {object} args
   * @param args.column
   * @param args.entity
   * @param args.readToOneCQN
   * @param args.toManyTree
   * @param args.mappings
   * @param args.parentAlias
   * @param args.defaultLanguage
   * @returns {object}
   * @private
   */
  // eslint-disable-next-line complexity
  _buildExpandedCQN({ column, entity, readToOneCQN, toManyTree, mappings, parentAlias, defaultLanguage }) {
    const isUnion = !!readToOneCQN.from.SET

    const colRef = parentAlias === column.ref[0] ? column.ref.slice(1) : column.ref.slice(0)
    const element = entity.elements[colRef[0]]
    const colTarget = ensureUnlocalized(element.target)
    const defaultLanguageThis =
      defaultLanguage ||
      entity['@cds.localized'] === false ||
      this._csn.definitions[colTarget]['@cds.localized'] === false

    const expandActive =
      readToOneCQN[IS_ACTIVE] ||
      (element.type === 'cds.Association' && !element['@odata.draft.enclosed']) ||
      !this._csn.definitions[colTarget]._isDraftEnabled
    const ref = this._getJoinRef(entity.elements, colRef[0], expandActive, defaultLanguageThis)
    const tableAlias = this._createAlias(toManyTree.concat(colRef).join(':'))
    const on = entity._relations[colRef[0]].join(tableAlias, 'filterExpand')
    const filterExpand = this._getFilterExpandCQN(readToOneCQN, on, parentAlias, entity.keys)
    const expandedEntity = this._csn.definitions[colTarget]
    const joinColumns = this._getJoinColumnsFromOnAddToMapping(mappings[colRef[0]], parentAlias, on, entity)

    let cqn = {
      from: {
        join: 'inner',
        args: [{ ref: [ref], as: tableAlias }, filterExpand],
        on: on
      }
    }

    if (typeof readToOneCQN[IS_ACTIVE] === 'boolean') {
      cqn[IS_ACTIVE] = !ref.endsWith('_drafts')
    }

    cqn.columns = this._getColumnsForExpand({
      tableAlias,
      columnList: column,
      entity: expandedEntity,
      joinColumns,
      isActive: cqn[IS_ACTIVE],
      parentEntity: entity
    })

    if (column.where) {
      cqn.where = this._copyWhere(column.where).map(element => this._adaptWhereElement(element, cqn, tableAlias))
    }

    if (column.orderBy) {
      cqn.orderBy = this._copyOrderBy(column.orderBy, tableAlias, expandedEntity)
    }

    if (column.limit) cqn.limit = column.limit

    cqn = this._adaptWhereOrderBy(cqn, tableAlias)

    if (isUnion) {
      const cols = column.expand.filter(c => !c.expand && !DRAFT_COLUMNS.includes(c.ref[0])).map(c => c.ref[0])
      // ensure the join columns are selected
      for (const each of joinColumns) {
        const col = each.ref[each.ref.length - 1]
        if (!cols.includes(col)) cols.push(col)
      }
      // ensure the foreign keys are selected in case of expand to one
      for (const each of cqn.columns) {
        if (each.expand) {
          const assoc = expandedEntity.associations[each.ref[0]]
          if (assoc.is2one) {
            const fks = Object.values(expandedEntity.elements).filter(ele => ele['@odata.foreignKey4'] === assoc.name)
            cols.push(...fks.map(fk => fk.name))
          }
        }
      }
      const ks = Object.keys(expandedEntity.keys).filter(
        c => !expandedEntity.keys[c].isAssociation && !DRAFT_COLUMNS.includes(c)
      )
      const user = (cds.context && cds.context.user && cds.context.user.id) || 'anonymous'
      const unionFrom = getCQNUnionFrom(cols, ref.replace(/_drafts$/, ''), ref, ks, user)
      for (const each of cqn.columns) {
        if (!each.as) continue
        // replace val with ref
        if (each.as === 'IsActiveEntity' || each.as === 'HasActiveEntity') {
          delete each.val
          each.ref = [tableAlias, each.as]
          each.as = tableAlias + '_' + each.as
        }
        // ensure the cast
        if (each.as.match(/IsActiveEntity$/) || each.as.match(/HasActiveEntity$/) || each.as.match(/HasDraftEntity$/)) {
          each.cast = { type: 'cds.Boolean' }
        }
      }
      const cs = cqn.columns.filter(c => !c.expand && c.ref && c.ref[0] === tableAlias).map(c => ({ ref: [c.ref[1]] }))
      const unionArgs = cqn.from.args
      unionArgs[0].SELECT = { columns: cs, from: unionFrom, distinct: true }
      delete unionArgs[0].ref
    }

    return cqn
  }

  _getJoinRef(elements, column, isActive, defaultLanguage) {
    const assoc = elements[column]
    if (typeof isActive !== 'boolean' || isActive || assoc.type !== 'cds.Composition') {
      return defaultLanguage ? ensureUnlocalized(assoc.target) : assoc.target
    }
    return assoc.target + '_drafts'
  }

  /**
   * Get the list of key columns in ref format.
   * Add the table alias to avoid ambiguity issues.
   *
   * @param tableAlias
   * @param isActive
   * @param expandedEntity
   * @returns {Array}
   * @private
   */
  _getKeyColumnForTarget(tableAlias, isActive, expandedEntity) {
    return getAllKeys(expandedEntity)
      .filter(column => typeof isActive !== 'boolean' || column !== 'IsActiveEntity')
      .map(column => {
        return { ref: [tableAlias, column] }
      })
  }

  _getLimitInSelect(cqn, columns, limit, orderBy, expandedEntity) {
    const select = {
      SELECT: {
        columns: this._copyColumns(columns, 'limitFilter'),
        from: { ref: [cqn.from.args[0].ref[0]], as: 'limitFilter' },
        where: this._convertOnToWhere(cqn.from.on, cqn.from.args[0].as, 'limitFilter'),
        limit: limit
      }
    }

    if (orderBy) {
      select.SELECT.orderBy = this._copyOrderBy(orderBy, 'limitFilter', expandedEntity)
    }

    return select
  }

  _isPathExpressionToOne(ref, entity) {
    const ref0 = ref[0]
    const el = entity.elements[ref0]
    return el && el.is2one
  }

  _copyOrderBy(orderBy, alias, expandedEntity) {
    return orderBy.map(element => {
      const sort = element.sort
      if (element.args)
        return { func: element.func, args: this._copyOrderBy(element.args, alias, expandedEntity), sort }
      const ref =
        element.ref[0] === alias
          ? [...element.ref]
          : element.ref.length === 1
          ? [alias, element.ref[0]]
          : this._isPathExpressionToOne(element.ref, expandedEntity)
          ? [alias, ...element.ref]
          : [alias, element.ref[1]]
      return (sort && { ref, sort }) || { ref }
    })
  }

  _getHasDraftEntityXpr(expandedEntity, tableAlias) {
    const draftTable = ensureDraftsSuffix(expandedEntity.name)
    const where = filterKeys(expandedEntity.keys).reduce((res, keyName) => {
      if (res.length !== 0) res.push('and')
      res.push({ ref: [draftTable, keyName] }, '=', { ref: [tableAlias, keyName] })
      return res
    }, [])
    const hasDraftQuery = {
      SELECT: {
        from: { ref: [draftTable] },
        columns: [{ val: 1 }],
        where: where
      }
    }
    return {
      xpr: ['case', 'when', hasDraftQuery, 'IS NOT NULL', 'then', 'true', 'else', 'false', 'end'],
      as: 'HasDraftEntity',
      cast: { type: 'cds.Boolean' }
    }
  }

  _copyColumns(columns, alias) {
    return columns.map(element => {
      const column = {
        ref: [alias, element.ref[element.ref.length - 1]]
      }

      if (element.as) {
        column.as = element.as
      }

      return column
    })
  }

  _convertOnToWhere(on, currentAlias, newAlias) {
    return on.map(element => {
      if (typeof element === 'object' && element.ref) {
        return {
          ref: [element.ref[0] === currentAlias ? newAlias : element.ref[0], element.ref[1]]
        }
      }

      return element
    })
  }

  _copyWhere(list) {
    return list.map(entry => {
      return typeof entry === 'object' ? this._copyObject(entry) : entry
    })
  }

  _copyObject(obj) {
    const newObj = {}

    for (const key in obj) {
      if (Array.isArray(obj[key])) {
        newObj[key] = Array.from(obj[key])
      } else {
        newObj[key] = obj[key]
      }
    }

    return newObj
  }

  /**
   * Reduce column list to column(s) needed to merge the result into one.
   *
   * @param readToOneCQN
   * @param on
   * @param parentAlias
   * @param keyObject
   * @returns {object}
   * @private
   */
  _getFilterExpandCQN(readToOneCQN, on, parentAlias, keyObject) {
    const columns = []

    const outerColumns = []

    for (const entry of on) {
      if (typeof entry === 'object' && entry.ref && entry.ref[0] === 'filterExpand') {
        columns.push(this._getColumnObjectForFilterExpand(readToOneCQN, parentAlias, entry.ref[1]))
        outerColumns.push({ ref: [entry.ref[1]] })
      }
    }

    const keys = Object.keys(keyObject).filter(
      key =>
        key !== 'IsActiveEntity' && !keyObject[key].is2one && !keyObject[key].is2many && !keyObject[key]._isStructured
    )

    for (const key of keys) {
      if (!columns.map(entry => entry.as).includes(key)) {
        columns.push(this._getColumnObjectForFilterExpand(readToOneCQN, parentAlias, key))
        outerColumns.push({ ref: [key] })
      }
    }

    const subSelect = Object.assign({}, readToOneCQN, { columns })

    const SELECT = { from: { SELECT: subSelect }, columns: outerColumns, distinct: true }

    return {
      SELECT: SELECT,
      as: 'filterExpand'
    }
  }

  _getColumnObjectForFilterExpand(readToOneCQN, parentAlias, key) {
    const relevantColumn = readToOneCQN.columns.find(
      column => column[IDENTIFIER] === key && column.ref[0] === parentAlias
    )
    return {
      ref: [parentAlias, (relevantColumn && relevantColumn.as) || key],
      as: key
    }
  }

  _getValueFromEntry(entry, parentAlias, key, struct) {
    let value = entry[key] || entry[key.toUpperCase()]
    if (value === undefined) {
      value = entry[`${parentAlias}_${key}`] || entry[`${parentAlias}_${key}`.toUpperCase()]
    }

    if (value === undefined && cds.env.effective.odata && cds.env.effective.odata.structs) {
      // here, it should be a structured key
      const keys = Object.keys(entry).filter(k => k.startsWith(key + '_'))
      if (keys.length) {
        // find struct
        if (!struct) {
          let current = this._csn.definitions[this._SELECT.from.ref[0]]
          let navs
          for (const k in this._aliases) {
            if (this._aliases[k] === parentAlias) {
              navs = k
            }
          }
          navs = navs.split(':')
          while (navs.length) {
            const element = current.elements[navs.shift()]
            if (element) {
              current = this._csn.definitions[element.target]
            }
          }
          struct = current.elements[key.replace(parentAlias + '_', '')]
        }
        // build value for spreading (cf. mapping[GET_KEY_VALUE])
        value = []
        for (const k in struct.elements) {
          const ele = struct.elements[k]
          const l = key + '_' + k
          if (ele._isStructured) value.push(...this._getValueFromEntry(entry, parentAlias, l, ele))
          else value.push(this._getValueFromEntry(entry, parentAlias, l))
        }
      }
    }

    return value
  }

  _addColumNames(entity, parentAlias, columnNames) {
    for (const keyName in entity.keys) {
      if (entity.keys[keyName].is2one || entity.keys[keyName].is2many) continue
      const columnNameAlt = keyName === 'IsActiveEntity' ? 'IsActiveEntity' : `${parentAlias}_${keyName}`
      if (!columnNames.includes(columnNameAlt)) {
        columnNames.push(columnNameAlt)
      }
    }
  }

  /**
   * In case a column is used at a JOIN, it needs to be added to the list of selected columns.
   *
   * @param mapping
   * @param parentAlias
   * @param on
   * @param entity
   * @returns {Array}
   * @private
   */
  _getJoinColumnsFromOnAddToMapping(mapping, parentAlias, on, entity) {
    const columns = []
    const columnNames = []

    this._addColumNames(entity, parentAlias, columnNames)

    for (const entry of on) {
      if (typeof entry === 'object' && entry.ref && entry.ref[0] !== 'filterExpand') {
        const as = entry.ref.join('_')
        columns.push({
          ref: entry.ref,
          as: as,
          [SKIP_MAPPING]: true
        })
      }
    }

    // Function will be used a post processing to create unique keys for cache and lookup the same
    mapping[GET_KEY_VALUE] = (atExpanded, entry) => {
      const keyValue = []
      const keyList = atExpanded
        ? Object.keys(entry).filter(keyName => keyName.toLowerCase().startsWith('filterexpand_'))
        : columnNames

      for (const key of keyList) {
        const parts = key.split('_')
        // For draft-enabled entities, associations may not take over 'IsActiveEntity', e.g.
        // when a draft points to an active entity
        if (parts[parts.length - 1] !== 'IsActiveEntity') {
          let val = this._getValueFromEntry(entry, parentAlias, key)
          if (val instanceof Buffer) {
            val = Buffer.from(val).toString('base64')
          }
          if (!Array.isArray(val)) val = [val]
          keyValue.push(...val)
        }
      }

      return keyValue.join(':')
    }

    return columns
  }

  /**
   * Get the explicitly named columns for expand and add ID columns, so the result can be added to the correct part at merged result.
   *
   * @param {object} args
   * @param args.tableAlias
   * @param args.columnList
   * @param args.entity
   * @param args.joinColumns
   * @param args.isActive
   * @param args.parentEntity
   * @returns {object}
   * @private
   */
  _getColumnsForExpand({ tableAlias, columnList, entity, joinColumns, isActive, parentEntity = {} }) {
    const columns = []
    const keys = getAllKeys(entity)
    const parentKeys = getAllKeys(parentEntity)

    for (const column of columnList.expand) {
      if (column.expand || !column.ref) {
        columns.push(column)
      } else {
        this._addToColumnList(columns, entity, tableAlias, column, isActive)
      }
    }

    this._addMissingJoinElements(columns, joinColumns)
    this._addMissingKeyColumns(columns, tableAlias, keys, isActive, entity)
    this._addMissingParentKeyColumns(columns, 'filterExpand', parentKeys, isActive)

    return columns
  }

  _createCalculatedBooleanColumn(alias, isActive) {
    return {
      val: isActive,
      as: alias,
      cast: { type: 'cds.Boolean' }
    }
  }

  _createIsActiveEntityOfParent(isActive, tableAlias) {
    return {
      val: isActive,
      as: `${tableAlias}_IsActiveEntity`,
      cast: { type: 'cds.Boolean' },
      [SKIP_MAPPING]: true
    }
  }

  _addToColumnList(columns, entity, tableAlias, column, isActive) {
    const columnName = column.ref[column.ref.length - 1]

    if (typeof isActive === 'boolean') {
      if (columnName === 'IsActiveEntity') {
        columns.push(this._createCalculatedBooleanColumn('IsActiveEntity', isActive))
        return
      }
      if (isActive) {
        if (columnName === 'HasActiveEntity') {
          columns.push(this._createCalculatedBooleanColumn('HasActiveEntity', false))
          return
        }
        if (columnName === 'HasDraftEntity') {
          columns.push(this._getHasDraftEntityXpr(entity, tableAlias))
          return
        }
      }
    }

    columns.push({
      ref: [tableAlias, columnName],
      as: column.as || `${tableAlias}_${columnName}`
    })
  }

  _isNotIncludedIn(columns) {
    if (columns.some(column => isAsteriskColumn(column))) return _ => false
    return entry =>
      !columns.some(
        column =>
          (typeof column === 'object' && column.ref && column.ref[1] === entry) ||
          ('val' in column && column.as === entry)
      )
  }

  /**
   * Add join columns if they are not already existing in the list.
   *
   * @private
   */

  _addMissingJoinElements(columns, joinColumns, keys) {
    const isNotIncludedInColumns = this._isNotIncludedIn(columns)
    for (const joinColumn of joinColumns) {
      if (isNotIncludedInColumns(joinColumn.ref[1])) {
        columns.push(joinColumn)
      }
    }
  }

  /**
   * Add key columns if they are not already existing in the list.
   *
   * @param columns
   * @param tableAlias
   * @param keys
   * @param isActive
   * @param entity
   * @private
   */
  _addMissingKeyColumns(columns, tableAlias, keys, isActive, entity) {
    for (const key of keys.filter(this._isNotIncludedIn(columns))) {
      if (key === 'IsActiveEntity' && typeof isActive === 'boolean') {
        columns.push(this._createCalculatedBooleanColumn(key, isActive))
      } else if (!entity.elements[key].elements) {
        // > don't add if complex key
        columns.push({
          ref: [tableAlias, key],
          as: `${tableAlias}_${key}`
        })
      }
    }
  }

  _addMissingParentKeyColumns(columns, tableAlias, keys, parentIsActive) {
    for (const key of keys) {
      if (key === 'IsActiveEntity' && typeof parentIsActive === 'boolean') {
        columns.push(this._createIsActiveEntityOfParent(parentIsActive, tableAlias))
      } else {
        columns.push({
          ref: [tableAlias, key],
          as: `${tableAlias}_${key}`,
          [SKIP_MAPPING]: true
        })
      }
    }
  }
}

/**
 * Creates CQN(s) by using JOIN for all expanded entries, as expanding is not supported by SQL.
 *
 * @param {object} cqn - CQN with expanded columns
 * @param {object} csn - Services CSN
 * @param {string} locale
 * @returns {object}
 * @private
 */
const createJoinCQNFromExpanded = (cqn, csn, locale) => {
  return new JoinCQNFromExpanded(cqn, csn, locale).buildJoinQueries()
}

/**
 * Check if the given CQN is of type select and contains expand.
 *
 * @param {object} cqn
 * @returns {boolean}
 * @private
 */
const hasExpand = cqn => {
  if (!cqn) return false
  const { SELECT } = cqn
  if (!SELECT) return false
  const { columns } = SELECT
  if (!columns) return false
  return columns.some(col => col.expand)
}

module.exports = {
  createJoinCQNFromExpanded,
  hasExpand
}
