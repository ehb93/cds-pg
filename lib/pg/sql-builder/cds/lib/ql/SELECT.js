const Whereable = require('./Whereable'), { parse, predicate4 } = Whereable
const defaults = global.cds.env.sql


module.exports = class SELECT extends Whereable {

  static _api() {
    const $ = Object.assign
    return $((..._)       => new this()._select_or_from(..._), {
      one: $((...x)       => new this({one:true})._select_or_from(...x),{
        columns: (..._)   => new this({one:true}).columns(..._),
        from: (..._)      => new this({one:true}).from(..._),
      }),
      distinct: $((...x)  => new this({distinct:true})._select_or_from(...x),{
        columns: (..._)   => new this({distinct:true}).columns(..._),
        from: (..._)      => new this({distinct:true}).from(..._),
      }),
      columns: (..._)     => new this().columns(..._),
      from: (..._)        => new this().from(..._),
    })
  }

  _select_or_from (cols, ...more) { // srv.read`title`.from`Books` or srv.read`Books` ?
    if (!cols) return this
    else if (is_number(cols)) return this.columns(...arguments) //> numbers can't be from
    else if (cols.name) return this.from (...arguments) //> clearly a from
    else if (cols.raw) { // tagged template string
      if (cols[0].startsWith('from ')) { // SELECT`from ...`, with an arbitrary long CQL tail...
        Object.assign (this.SELECT, SELECT_(' ',arguments))
        return this
      } else if (cols[0][0] === '{') {  // SELECT`{a,b}`... -> it's columns
        let {columns:c} = SELECT_('from X', arguments)
        return this._add('columns',c)
      } else {                          // SELECT`Foo` -> ambiguous -> try parsing as columns...
        let {columns:c} = SELECT_('from X {', arguments, '}')
        if (c.length > 1 || !c[0].ref) return this._add('columns',c)
        // else cols = c[0] //> goes on below...
      }
    } else {                          // SELECT('Foo'|'*',[...]|(foo)=>{})
      if (cols === '*') return this.columns(...arguments)
      const c = _columns_or_not (cols)
      if (c) return this._add('columns',c)
    }

    // return a proxy assuming it's a from and switching to
    // columns on a subsequent call of .from, if any.
    const {SELECT:_} = this, {one} = _
    return Object.defineProperties (this.from (cols, ...more), {
      from: { configurable:true, value:(...args) => { delete this.from
        if (!one) delete _.one; delete _.columns; delete _.where
        return this.from (...args) .columns (cols, ...more)
      }}
    })
  }

  columns (...cols) {
    if (cols[0]) this._add ('columns', _columns(cols))
    return this
  }

  from (target, second, third) {
    this.SELECT.from = target === '*' || this._target_ref4 (...arguments)
    if (!target.raw && second) {
      if (third) {
        this.byKey(second)
        this.columns(third)
      } else {
        const cols = _columns_or_not (second)
        cols ? this._add('columns',cols) : this.byKey(second)
      }
    }
    return this
  }

  fullJoin  (other, as) { return this.join (other, as, 'full') }
  leftJoin  (other, as) { return this.join (other, as, 'left') }
  rightJoin (other, as) { return this.join (other, as, 'right') }
  innerJoin (other, as) { return this.join (other, as, 'inner') }
  join (other, as, kind='inner') {
    const [, target, alias = as] = /(\S+)(?:\s+(?:as)?\s+(\S+))?/i.exec(other)
    const ref = { ref: [target] }
    if (alias) ref.as = alias
    this.SELECT.from = { join:kind, args: [this.SELECT.from, ref] }
    return Object.defineProperty(this, '_where_or_having', { value: 'on', configurable: true })
  }
  on (...args) {
    if (!this.SELECT.from || !this.SELECT.from.join)
      throw new Error(`Invalid call of "SELECT.on()" without prior call of "SELECT.join()"`)
    return this._where (args,'and','on')
  }

  having(...x) {
    return this._where (x,'and','having')
  }

  groupBy (...args) {
    if (!args[0]) return this
    const cqn = args[0].raw ? SELECT_('from X group by', args).groupBy : args.map(parse.expr)
    return this._add('groupBy',cqn)
  }

  orderBy (...args) {
    if (!args[0]) return this
    return this._add('orderBy',_order_by(args))
  }

  limit (rows, offset) {
    if (is_number(rows) || rows) this.SELECT.limit = rows.rows ? rows : { rows: {val:rows} }
    if (is_number(offset)) this.SELECT.limit.offset = { val: offset }
    return this
  }

  forUpdate ({ of, wait = defaults.lock_acquire_timeout || -1 } = {}) {
    const sfu = this.SELECT.forUpdate = {}
    if (of) sfu.of = of.map (c => ({ref:c.split('.')}))
    if (wait >= 0) sfu.wait = wait
    return this
  }

  foreach (callback) {
    return this.then(rows => rows.map(callback))
  }

  valueOf() {
    return super.valueOf('SELECT * FROM')
  }
}


const _columns = (args) => {
  const x = args[0]
  if (x.raw) {
    if (x[0] === '{') return SELECT_('from X ',args).columns
    else              return SELECT_('from X {',args,'}').columns
  } else {
    if (typeof x === 'string' && x[0] === '{') return parse.cql('SELECT from X '+ x).SELECT.columns
    else return _columns_or_not(x) || args.map(_column_expr)
  }
}

const _columns_or_not = (x) => {
  if (typeof x === 'function') return _projection4(x)
  if (Array.isArray(x)) return x.map(_column_expr)
}

const _column_expr = (x) => {
  if (is_cqn(x)) return x
  if (typeof x === 'string') return parse.column(x)
  if (typeof x === 'object') for (let one in x) return Object.assign(parse.expr(one),{as:x[one]})
  else return {val:x}
}

const _projection4 = (fn) => {
  const columns=[]; fn (new Proxy (fn,{
    apply: (_, __, args) => { // handle top-level projections such as (foo)=>{ foo('*') }
      if (!args.length) return columns.push('*')
      let [x] = Array.isArray(args[0]) ? args[0] : args
      columns.push (x === '*' || x === '.*' ? '*' : is_cqn(x) ? x : {ref:[x]})
      return { as: (alias) => (x.as = alias) }
    },
    get: (_, p) => { // handle top-level paths like (foo)=>{ foo.bar }
      const col = {ref:[p]}; columns.push(col)
      const nested = new Proxy(fn,{ // handle n-fold paths like (foo)=>{ foo.bar.car }
        get: (_, p) => {
          if (p === 'where') return (x) => ((col.where = predicate4([x])), nested)
          if (p === 'as') return (alias) => ((col.as = alias), nested)
          else return col.ref.push(p), nested
        },
        apply: (_, __, args) => { // handle nested projections e.g. (foo)=>{ foo.bar (b=>{ ... }) }
          const [a, b] = args
          if (!a) col.expand = ['*']
          else if (a.raw) {
            if (a[0] === '*') col.expand = ['*']
            else if (a[0] === '.*') col.inline = ['*']
            else {
              let {columns} = SELECT_(col.ref[col.ref.length-1] +' ', args, ' from X')
              Object.assign (col, columns[0])
            }
          }
          else if (Array.isArray(a)) col.expand = _columns(a)
          else if (a === '*') col.expand = ['*']
          else if (a === '.*') col.inline = ['*']
          else if (typeof a === 'string') col.ref.push(a)
          else if (typeof a === 'function') {
            let x = (col[/^\(?_\b/.test(a) ? 'inline' : 'expand'] = _projection4(a))
            if (b && b.levels) while (--b.levels) x.push({ ...col, expand: (x = [...x]) })
          }
          return nested
        },
      })
      return nested
    },
  }))
  return columns
}

const _order_by = (args) => {
  if (args[0].raw) return SELECT_('from X order by', args).orderBy
  if (Array.isArray(args[0])) args = args[0]
  const cqn=[], _add = (ref,ad) => {
    const obx = parse.expr(ref); cqn.push(obx)
    if (ad) obx.sort = ad == 1 ? 'asc' : ad == -1 ? 'desc' : ad
  }
  for (let each of args) {
    if (each.ref) cqn.push(each)
    else if (typeof each === 'string') _add (...each.split(' '))
    else for (let ref in each) _add (ref, each[ref])
  }
  return cqn
}

const {CQL} = parse, SELECT_ = (prefix, [ strings, ...more ], suffix) => {
  const tts = [...strings]; tts.raw = true
  if (prefix) tts[0] = `SELECT ${prefix} ${tts[0]}`
  if (suffix) tts[tts.length-1] += ` ${suffix}`
  return CQL(tts,...more).SELECT
}

const is_cqn = x => x === undefined || x === '*' || x.val !== undefined || x.xpr || x.ref || x.list || x.func || x.SELECT
const is_number = x => !isNaN(x)
