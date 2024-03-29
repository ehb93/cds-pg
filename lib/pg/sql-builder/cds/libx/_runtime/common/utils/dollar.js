const cds = require('../../cds')

module.exports = (entryOrRow, keyOrIndex, user, timestamp) => {
  if (!entryOrRow[keyOrIndex]) return

  // REVISIT: shouldn't be necessary, but sql builder default for user currently cannot be an object (test issue?)
  // normalize user (object vs. string)
  user = user && user.id ? user : { id: user || 'anonymous' }

  if (entryOrRow[keyOrIndex] === '$user') entryOrRow[keyOrIndex] = user.id
  else if (entryOrRow[keyOrIndex] === '$now') entryOrRow[keyOrIndex] = timestamp
  else if (entryOrRow[keyOrIndex] === '$uuid') entryOrRow[keyOrIndex] = cds.utils.uuid()
  else if (typeof entryOrRow[keyOrIndex] === 'string') {
    const attr = entryOrRow[keyOrIndex].match(/^\$user\.(.*)/)
    if (attr && attr.length > 1) entryOrRow[keyOrIndex] = (user.attr && user.attr[attr[1]]) || null
  }
}
