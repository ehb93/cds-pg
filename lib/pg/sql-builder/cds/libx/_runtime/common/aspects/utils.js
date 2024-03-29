const Relation = require('./relation')

const CommonFieldControl = e => {
  const cfr = e['@Common.FieldControl']
  return cfr && cfr['#']
}

const isMandatory = e => {
  return (
    e['@assert.mandatory'] !== false &&
    (e['@mandatory'] ||
      e['@Common.FieldControl.Mandatory'] ||
      e['@FieldControl.Mandatory'] ||
      CommonFieldControl(e) === 'Mandatory')
  )
}

const isReadOnly = e => {
  return (
    e['@readonly'] ||
    e['@cds.on.update'] ||
    e['@cds.on.insert'] ||
    e['@Core.Computed'] ||
    e['@Common.FieldControl.ReadOnly'] ||
    e['@FieldControl.ReadOnly'] ||
    CommonFieldControl(e) === 'ReadOnly'
  )
}

const getETag = entity => {
  let val
  for (const ele in entity.elements) {
    if (entity.elements[ele]['@odata.etag']) {
      val = ele
      break
    }
  }
  return val
}

const hasPersonalData = entity => {
  let val
  if (entity['@PersonalData.DataSubjectRole'] && entity['@PersonalData.EntitySemantics']) {
    for (const ele in entity.elements) {
      if (
        entity.elements[ele]['@PersonalData.IsPotentiallyPersonal'] ||
        entity.elements[ele]['@PersonalData.IsPotentiallySensitive']
      ) {
        val = true
        break
      }
    }
  }
  return val
}

const hasSensitiveData = entity => {
  let val
  if (entity['@PersonalData.DataSubjectRole'] && entity['@PersonalData.EntitySemantics']) {
    for (const ele in entity.elements) {
      if (entity.elements[ele]['@PersonalData.IsPotentiallySensitive']) {
        val = true
        break
      }
    }
  }
  return val
}

const _exposeRelation = relation => Object.defineProperty({}, '_', { get: () => relation })

const _relationHandler = relation => ({
  get: (target, name) => {
    const path = name.split(',')
    const prop = path.join('_')
    if (!target[prop]) {
      if (path.length === 1) {
        // REVISIT: property 'join' must not be used in CSN to make this working
        if (relation._has(prop)) return relation[prop]
        const newRelation = Relation.to(relation, prop)
        if (newRelation) {
          target[prop] = new Proxy(_exposeRelation(newRelation), _relationHandler(newRelation))
        }
        return target[prop]
      }
      target[prop] = path.reduce((r, p) => r[p] || r.csn._relations[p], relation)
      target[prop].path = path
    }
    return target[prop]
  }
})

const getRelations = e => {
  const newRelation = Relation.to(e)
  return new Proxy(_exposeRelation(newRelation), _relationHandler(newRelation))
}

const _hasJoinCondition = e => e.isAssociation && e.on && e.on.length > 2

const _isSelfRef = e => e.ref && e.ref[0] === '$self'

const _getBacklinkName = on => {
  const i = on.findIndex(_isSelfRef)
  if (i === -1) return
  let ref
  if (on[i + 1] && on[i + 1] === '=') ref = on[i + 2].ref
  if (on[i - 1] && on[i - 1] === '=') ref = on[i - 2].ref
  return ref && ref[ref.length - 1]
}

const isSelfManaged = e => {
  if (!_hasJoinCondition(e)) return
  return !!e.on.find(_isSelfRef)
}

const isBacklink = (e, checkComposition) => getAnchor(e, checkComposition) && true

const _isUnManagedAssociation = (e, checkComposition) =>
  e.isAssociation && (!checkComposition || e._isCompositionEffective) && _hasJoinCondition(e)

const getAnchor = (e, checkComposition) => {
  if (!(e._isAssociationStrict && (e.keys || e.on))) return
  for (const anchor of Object.values(e._target.associations || {})) {
    if (!_isUnManagedAssociation(anchor, checkComposition)) continue
    if (_getBacklinkName(anchor.on) === e.name && anchor.target === e.parent.name) return anchor
  }
}

const getBacklink = (e, checkComposition) => {
  if (!_isUnManagedAssociation(e, checkComposition)) return
  const backlinkName = _getBacklinkName(e.on)
  if (backlinkName) return e._target && e._target.elements && e._target.elements[backlinkName]
}

module.exports = {
  isMandatory,
  isReadOnly,
  getETag,
  hasPersonalData,
  hasSensitiveData,
  getRelations,
  isSelfManaged,
  isBacklink,
  getAnchor,
  getBacklink
}
