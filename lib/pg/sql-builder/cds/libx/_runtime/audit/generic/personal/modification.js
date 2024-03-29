const cds = require('../../../cds')

const getTemplate = require('../../../common/utils/template')
const templateProcessor = require('../../../common/utils/templateProcessor')

const {
  getMapKeyForCurrentRequest,
  getRootEntity,
  getPick,
  createLogEntry,
  addObjectID,
  addDataSubject,
  addDataSubjectForDetailsEntity,
  resolveDataSubjectPromises
} = require('./utils')

let als

const attachDiffToContextHandler = async function (req) {
  // REVISIT: what does this do?
  Object.defineProperty(req.query, '_selectAll', {
    enumerable: false,
    writable: false,
    configurable: true,
    value: true
  })

  // store diff in audit data structure at context
  if (!req.context._audit.diffs) req.context._audit.diffs = new Map()
  req.context._audit.diffs.set(req._.query, await req.diff())
}

const _getOldAndNew = (action, row, key) => {
  let oldValue = action === 'Create' ? null : row._old && row._old[key]
  if (oldValue === undefined) oldValue = null
  let newValue = action === 'Delete' ? null : row[key]
  if (newValue === undefined) newValue = null
  return { oldValue, newValue }
}

const _addAttribute = (log, action, row, key) => {
  if (!log.attributes.find(ele => ele.name === key)) {
    const { oldValue, newValue } = _getOldAndNew(action, row, key)
    if (oldValue !== newValue)
      log.attributes.push({ name: key, oldValue: String(oldValue), newValue: String(newValue) })
  }
}

const _processorFnModification = (modificationLogs, model, req, beforeWrite) => processArgs => {
  if (!processArgs.row._op) return

  const { row, key, element, plain } = processArgs

  // delete in before phase, create and update in after phase
  if ((row._op === 'delete') !== !!beforeWrite) return

  const entity = getRootEntity(element)
  const action = row._op[0].toUpperCase() + row._op.slice(1)

  // create or augment log entry
  const modificationLog = createLogEntry(modificationLogs, entity, row)

  // process categories
  for (const category of plain.categories) {
    if (category === 'ObjectID') {
      addObjectID(modificationLog, row, key)
    } else if (category === 'DataSubjectID') {
      addDataSubject(modificationLog, row, key, entity)
    } else if (category === 'IsPotentiallyPersonal' || category === 'IsPotentiallySensitive') {
      _addAttribute(modificationLog, action, row, key)
    }
  }

  // add promise to determine data subject if a DataSubjectDetails entity
  if (
    element.parent['@PersonalData.EntitySemantics'] === 'DataSubjectDetails' &&
    modificationLog.dataSubject.id.length === 0 // > id still an array -> promise not yet set
  ) {
    addDataSubjectForDetailsEntity(row, modificationLog, req, entity, model, element)
  }
}

const _getDataModificationLogs = (req, tx, diff, beforeWrite) => {
  const template = getTemplate(
    `personal_${req.event}`.toLowerCase(),
    Object.assign({ name: req.target._service.name, model: tx.model }),
    req.target,
    { pick: getPick(req.event) }
  )

  const modificationLogs = {}
  const processFn = _processorFnModification(modificationLogs, tx.model, req, beforeWrite)
  templateProcessor({ processFn, row: diff, template })

  return modificationLogs
}

const _calcModificationLogsHandler = async function (req, beforeWrite, that) {
  const mapKey = getMapKeyForCurrentRequest(req)

  const modificationLogs = _getDataModificationLogs(req, that, req.context._audit.diffs.get(mapKey), beforeWrite)

  // store modificationLogs in audit data structure at context
  if (!req.context._audit.modificationLogs) req.context._audit.modificationLogs = new Map()
  const existingLogs = req.context._audit.modificationLogs.get(mapKey) || {}
  req.context._audit.modificationLogs.set(mapKey, Object.assign(existingLogs, modificationLogs))

  // execute the data subject promises before going along to on phase
  // guarantees that the reads are executed before the data is modified
  await Promise.all(Object.keys(modificationLogs).map(k => modificationLogs[k].dataSubject.id))
}

const calcModificationLogsHandler4Before = function (req) {
  return _calcModificationLogsHandler(req, true, this)
}

const calcModificationLogsHandler4After = function (_, req) {
  return _calcModificationLogsHandler(req, false, this)
}

const emitModificationHandler = async function (_, req) {
  als = als || (await cds.connect.to('audit-log'))
  if (!als.ready) return

  const modificationLogs = req.context._audit.modificationLogs.get(req.query)
  const modifications = Object.keys(modificationLogs)
    .map(k => modificationLogs[k])
    .filter(ele => ele.attributes.length)

  await resolveDataSubjectPromises(modifications)
  await als.emit('dataModificationLog', { modifications })
}

module.exports = {
  attachDiffToContextHandler,
  calcModificationLogsHandler4Before,
  calcModificationLogsHandler4After,
  emitModificationHandler
}
