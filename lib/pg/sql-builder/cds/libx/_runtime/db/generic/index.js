// before
const rewrite = require('./rewrite')
const input = require('./input')
const integrity = require('./integrity')
const { convertVirtuals: virtual } = require('./virtual')
// on
const CREATE = require('./create')
const READ = require('./read')
const UPDATE = require('./update')
const DELETE = require('./delete')
// after
const structured = require('./structured')
const arrayed = require('./arrayed')

module.exports = {
  rewrite,
  virtual,
  input,
  integrity,
  CREATE,
  READ,
  UPDATE,
  DELETE,
  structured,
  arrayed
}
