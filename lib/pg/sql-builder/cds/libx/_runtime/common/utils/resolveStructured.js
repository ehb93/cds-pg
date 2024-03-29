const _flattenProps = (subElement, structName, structProperties, structElement, asRef) => {
  if (subElement.elements) {
    return _resolveStructured(
      {
        structName: `${structName}_${subElement.name}`,
        structProperties: structProperties.slice(1)
      },
      subElement.elements,
      asRef
    )
  } else if (subElement.isAssociation) {
    if (structProperties.length && subElement.is2one && !subElement.on) {
      return asRef
        ? [{ ref: [`${structName}_${structProperties.join('_')}`] }]
        : [`${structName}_${structProperties.join('_')}`]
    }

    return []
  }
  return asRef ? [{ ref: [`${structName}_${structElement}`] }] : [`${structName}_${structElement}`]
}

const _resolveStructured = ({ structName, structProperties }, subElements, asRef = true) => {
  if (!subElements) {
    return []
  }

  // only add from structProperties
  if (structProperties.length) {
    return _flattenProps(subElements[structProperties[0]], structName, structProperties, structProperties[0], asRef)
  }

  const flattenedElements = []
  for (const structElement in subElements) {
    flattenedElements.push(
      ..._flattenProps(subElements[structElement], structName, structProperties, structElement, asRef)
    )
  }
  return flattenedElements
}

module.exports = _resolveStructured
