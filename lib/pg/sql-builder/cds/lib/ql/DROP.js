const Query = require('./Query')

module.exports = class DROP extends Query {
  static _api() {
    return Object.assign ((e)  => (new this).entity(e), {
      entity: (e) => (new this).entity(e),
      table: (e)  => (new this).table(e),
      view: (e)   => (new this).view(e),
    })
  }
  entity(e) {
    this.DROP.entity = this._target_name4 (e)
    return this
  }
  table(e) {
    const {DROP} = this
    DROP.entity = DROP.table = this._target_name4 (e)
    return this
  }
  view(e) {
    const {DROP} = this
    DROP.entity = DROP.view = this._target_name4 (e)
    return this
  }
}
