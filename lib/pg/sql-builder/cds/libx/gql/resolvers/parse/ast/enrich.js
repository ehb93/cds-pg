const { isVariable, isListValue, isObjectValue } = require('../utils')
const fragmentSpreadSelections = require('./fragment')
const substituteVariable = require('./variable')
const removeMetaFieldsFromSelections = require('./meta')

const traverseObjectValue = (info, objectValue) =>
  objectValue.fields.map(field => traverseArgumentOrObjectField(info, field))

const traverseListValue = (info, listValue) => {
  for (let i = 0; i < listValue.values.length; i++) {
    const value = listValue.values[i]
    if (isVariable(value)) {
      listValue.values[i] = substituteVariable(info, value)
    } else if (isObjectValue(value)) {
      traverseObjectValue(info, value)
    }
  }
}

const traverseArgumentOrObjectField = (info, argumentOrObjectField) => {
  const value = argumentOrObjectField.value
  if (isVariable(value)) {
    argumentOrObjectField.value = substituteVariable(info, value)
  } else if (isListValue(value)) {
    traverseListValue(info, value)
  } else if (isObjectValue(value)) {
    traverseObjectValue(info, value)
  }
}

const traverseSelectionSet = (info, selectionSet) => {
  selectionSet.selections = fragmentSpreadSelections(info, selectionSet.selections)
  selectionSet.selections = removeMetaFieldsFromSelections(selectionSet.selections)
  selectionSet.selections.map(field => traverseField(info, field))
}

const traverseField = (info, field) => {
  if (field.selectionSet) {
    traverseSelectionSet(info, field.selectionSet)
  }

  field.arguments.map(arg => traverseArgumentOrObjectField(info, arg))
}

const traverseFieldNodes = (info, fieldNodes) => fieldNodes.map(fieldNode => traverseField(info, fieldNode))

module.exports = info => {
  const deepClonedFieldNodes = JSON.parse(JSON.stringify(info.fieldNodes))
  traverseFieldNodes(info, deepClonedFieldNodes)
  return deepClonedFieldNodes
}
