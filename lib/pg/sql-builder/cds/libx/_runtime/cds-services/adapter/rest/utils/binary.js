const _isKeyTypeBinary = (entity, key) => {
  return (
    entity.elements &&
    entity.elements[key] &&
    (entity.elements[key].type === 'cds.Binary' || entity.elements[key].type === 'cds.LargeBinary')
  )
}

const base64toBuffer = (json, entity) => {
  if (typeof json !== 'object') {
    return
  }

  for (const key in json) {
    if (_isKeyTypeBinary(entity, key) && json[key]) {
      json[key] = Buffer.from(json[key], 'base64')
    }
  }
}

const _arrayToBase64 = (json, entity) => {
  json.forEach(element => {
    if (typeof element === 'object') {
      bufferToBase64(element, entity)
    }
  })
}

const _objectToBase64 = (json, entity) => {
  for (const key in json) {
    if (_isKeyTypeBinary(entity, key) && json[key]) {
      json[key] = json[key].toString('base64')
    }
  }
}

const bufferToBase64 = (json, entity) => {
  if (typeof json !== 'object') return

  if (Array.isArray(json)) {
    _arrayToBase64(json, entity)
  } else {
    _objectToBase64(json, entity)
  }
}

module.exports = {
  base64toBuffer,
  bufferToBase64
}
