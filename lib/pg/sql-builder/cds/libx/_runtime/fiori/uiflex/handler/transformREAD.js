const { EXT_BACK_PACK, getExtendedFields, hasExtendedEntity, isExtendedEntity, getTargetRead } = require('../utils')

const _addBackPack = (columns, extFields, alias) => {
  if (!columns) return

  const hasBackPack = columns.some(
    col => col.ref && col.ref[col.ref.length - 1] === EXT_BACK_PACK && _hasAlias(col.ref, alias)
  )
  if (hasBackPack) return // get out early, avoiding overhead of second check

  const hasExtFields = columns.some(
    col => col.ref && extFields.includes(col.ref[col.ref.length - 1]) && _hasAlias(col.ref, alias)
  )

  if (hasExtFields) {
    const col = { ref: [EXT_BACK_PACK] }
    if (alias) col.ref.unshift(alias)
    columns.push(col)
  }

  /*
    Removing backpack if not needed doesn't work. Probably ref copy problem.
    if (hasBackPack && !hasExtFields) remove backpack.
  */
}

const _hasAlias = (ref, alias) => {
  return (ref.length === 1 && !alias) || (ref.length > 1 && ref[0] === alias)
}

const _removeExtendedFields = (columns, extFields, alias) => {
  if (!columns) return

  let i = columns.length
  while (i--) {
    const col = columns[i]
    if (col.ref && extFields.includes(col.ref[col.ref.length - 1]) && _hasAlias(col.ref, alias)) {
      columns.splice(i, 1)
    }
  }
}

const _transformUnion = (req, model) => {
  // second element is active entity
  const name = req.target.name.SET ? req.target.name.SET.args[1]._target.name : req.target.name
  const extFields = getExtendedFields(name, model)
  _addBackPack(req.query.SELECT.columns, extFields)
  _removeExtendedFields(req.query.SELECT.columns, extFields)

  _addBackPack(
    req.query.SELECT.from.SET.args[0].SELECT.columns,
    extFields,
    req.query.SELECT.from.SET.args[0].SELECT.from.args[0].as
  )
  _addBackPack(req.query.SELECT.from.SET.args[1].SELECT.columns, extFields)
  _removeExtendedFields(
    req.query.SELECT.from.SET.args[0].SELECT.columns,
    extFields,
    req.query.SELECT.from.SET.args[0].SELECT.from.args[0].as
  )
  _removeExtendedFields(req.query.SELECT.from.SET.args[1].SELECT.columns, extFields)
}

const _getAliasedEntitiesForJoin = (args, model) => {
  const extEntities = []

  args.forEach(arg => {
    if (arg.ref && arg.ref[0] !== 'DRAFT.DraftAdministativeData' && isExtendedEntity(arg.ref[0], model)) {
      const extFields = getExtendedFields(arg.ref[0], model)
      extEntities.push({ name: arg.ref[0], as: arg.as, extFields })
    }

    if (arg.join) {
      extEntities.push(..._getAliasedEntitiesForJoin(arg.args, model))
    }
  })

  return extEntities
}

const _transformJoin = (req, model) => {
  const extEntities = _getAliasedEntitiesForJoin(req.query.SELECT.from.args, model)

  extEntities.forEach(ext => {
    _addBackPack(req.query.SELECT.columns, ext.extFields, ext.as)
    _removeExtendedFields(req.query.SELECT.columns, ext.extFields, ext.as)
  })
}

const _transformColumns = (columns, targetName, model) => {
  if (!columns) return

  const extFields = getExtendedFields(targetName, model)
  if (extFields.length !== 0) {
    _addBackPack(columns, extFields)
    _removeExtendedFields(columns, extFields)
  }

  columns.forEach(col => {
    if (col.ref && col.expand) {
      const expTargetName = model.definitions[targetName].elements[col.ref[0]].target
      _transformColumns(col.expand, expTargetName, model)
    }
  })
}

function transformExtendedFieldsREAD(req) {
  if (!hasExtendedEntity(req, this.model)) return

  const target = getTargetRead(req)
  _transformColumns(req.query.SELECT.columns, target.name, this.model)

  if (req.query.SELECT.from.SET) return _transformUnion(req, this.model) // union
  if (req.query.SELECT.from.join) return _transformJoin(req, this.model) // join
}

module.exports = {
  transformExtendedFieldsREAD
}
