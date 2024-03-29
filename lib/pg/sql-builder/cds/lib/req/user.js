const req_locale = require('./locale')

class User {

  constructor (_) {
    if (new.target === Anonymous) return; else if (_ === undefined) return new User.default
    if (typeof _ === 'string') { this.id = _; return }
    for (let each in _) super[each] = _[each] // overrides getters
    if (Array.isArray(_._roles)) this._roles = _._roles.reduce((p,n)=>{p[n]=1; return p},{})
  }

  get locale() { return super.locale = req_locale (this._req) }
  set locale(l) { if (l) super.locale = l }

  get attr() { return super.attr = {} }

  get _roles(){ return super._roles = {
    'identified-user': !!this.id,
    'authenticated-user': !!this.id && this.authLevel !== 'weak' // REVISIT: _.authLevel
  }}

  is (role) { return role === 'any' || !!this._roles[role] }
  valueOf() { return this.id }

}

class Anonymous extends User {
  is (role) { return role === 'any' }
  get _roles() { return {} }
}
Anonymous.prototype._is_anonymous = true
Anonymous.prototype.id = 'anonymous'

class Privileged extends User {
  constructor(_) { super(_||{}) }
  is() { return true }
}
Privileged.prototype._is_privileged = true
Privileged.prototype.id = 'privileged'

module.exports = exports = Object.assign (User, { Anonymous, Privileged, default:Anonymous })
