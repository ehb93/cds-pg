const cds = require('../../../cds')
const { ensureDraftsSuffix } = require('../../../common/utils/draft')

const { EXT_BACK_PACK } = require('../utils')

const _getDraftTable = (view, cds) => {
  return cds.model.definitions[view]._isDraftEnabled ? ensureDraftsSuffix(view) : undefined
}

const _addAnnotation = extension => {
  Object.values(extension.elements).forEach(el => {
    el['@cds.extension'] = true
  })
}

const _isProjection = target => target && target.query && target.query._target

const _resolveViews = (target, views_ = []) => {
  if (_isProjection(target)) {
    views_.push(target)
    return _resolveViews(target.query._target, views_)
  }

  return target
}

const _getCsn = req => {
  const csn = {
    extensions: req.data.extensions.map(ext => JSON.parse(ext))
  }

  return csn
}

const _addViews = csn => {
  csn.extensions.forEach(extension => {
    const target = cds.model.definitions[extension.extend]
    const views_ = []
    const view = _resolveViews(target, views_)
    extension.extend = view && view.name
    _addAnnotation(extension)

    // All projection views leading to the db entity are extended with back pack in case view columns are explicitly listed.
    // The views using projections with '*' obtain the back pack automatically.
    views_.forEach(view => {
      if (!view.projection || (view.projection.columns && !view.projection.columns.some(col => col === '*'))) {
        csn.extensions.push({
          extend: view.name,
          columns: Object.keys(extension.elements).map(key => {
            return { ref: [key] }
          })
        })
      }
    })
  })
}

const _handleDefaults = async (extension, dbEntity, req, cds, draftEntity) => {
  const ext = Object.keys(extension.elements)
    .filter(key => extension.elements[key].default)
    .map(key => {
      const element = extension.elements[key]
      const t = cds.model.definitions[element.type] || cds.builtin.types[element.type]
      const value = t && t instanceof cds.builtin.classes.string ? `"${element.default.val}"` : element.default.val
      return `"${key}":${value}`
    })

  if (ext.length !== 0) {
    const extStr = ext.join(',')
    const changed = `'{${extStr},' || substr(${EXT_BACK_PACK}, 2, length(${EXT_BACK_PACK})-1)`
    const assign = `${EXT_BACK_PACK} = CASE WHEN ${EXT_BACK_PACK} IS NULL THEN '{${extStr}}' ELSE ${changed} END`
    await UPDATE(dbEntity).with(assign)
    if (draftEntity) await UPDATE(draftEntity).with(assign)
  }
}

const _validateCsn = (csn, req) => {
  csn.extensions.forEach(extension => {
    if (!extension.extend || !cds.model.definitions[extension.extend]) {
      req.reject(400, 'Invalid extension. Parameter "extend" missing or malformed')
    }

    if (!extension.elements) {
      req.reject(400, 'Invalid extension. Missing parameter "elements"')
    }
  })
}

const _validateExtensionFields = async (csn, req) => {
  csn.extensions.forEach(extension => {
    if (extension.elements) {
      Object.keys(extension.elements).forEach(name => {
        if (!/^[A-Za-z]\w*$/.test(name)) {
          req.reject(400, `Invalid extension. Bad element name "${name}"`)
        }

        if (Object.keys(cds.model.definitions[extension.extend].elements).includes(name)) {
          req.reject(400, `Invalid extension. Element "${name}" already exists`)
        }
      })
    }
  })
}

const _getCompilerError = messages => {
  const defaultMsg = 'Error while compiling extension'
  if (!messages) return defaultMsg

  for (const msg of messages) {
    if (msg.severity === 'Error') return msg.message
  }

  return defaultMsg
}

const _validateExtension = async (csn, req) => {
  try {
    const base = await cds.load('*', cds.options)
    const baseCsn = await cds.compile.to.json(base)
    const extCsn = await cds.compile.to.json(csn)
    await cds.compile.to.csn({ 'base.csn': baseCsn, 'ext.csn': extCsn })
  } catch (err) {
    req.reject(400, _getCompilerError(err.messages))
  }
}

module.exports = function () {
  this.on('addExtension', async req => {
    const csn = _getCsn(req, cds)
    _validateCsn(csn, req)
    await _validateExtensionFields(csn, req)
    _addViews(csn, cds)
    await _validateExtension(csn, req)

    const ID = cds.utils.uuid()
    await INSERT.into('cds_r.Extensions').entries([{ ID, csn: JSON.stringify(csn) }])

    for (const ext of req.data.extensions) {
      const extension = JSON.parse(ext)
      const draft = _getDraftTable(extension.extend, cds)
      const target = cds.model.definitions[extension.extend]
      const dbEntity = _resolveViews(target).name
      await _handleDefaults(extension, dbEntity, req, cds, draft)
    }

    setTimeout(() => process.send('restart'), 1111)
  })
}
