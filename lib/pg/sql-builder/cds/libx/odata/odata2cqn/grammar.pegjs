/** ------------------------------------------
 * This is a peg.js adaptation of the https://github.com/oasis-tcs/odata-abnf/blob/master/abnf/odata-abnf-construction-rules.txt
 * which directly constructs CQN out of parsed sources.
 *
 * NOTE:
 * In contrast to the OData ABNF source, which uses very detailed semantic rules,
 * this adaptation uses rather generic syntactic rules only, e.g. NOT distinguishing
 * between Collection Navigation or NOT knowing individual function names.
 * This is to be open to future enhancements of the OData standard, as well as
 * to improve error messages. For example a typo in a function name could be
 * reported specifically instead of throwing a generic parser error.
 *
 * See also: https://docs.microsoft.com/en-us/odata/concepts/queryoptions-overview
 * Future test cases http://docs.oasis-open.org/odata/odata/v4.0/errata03/os/complete/abnf/odata-abnf-testcases.xml
 *
 * Limitations: Type, Geo functions are NOT supported,
 * maxdatetime, mindatetime, fractionalseconds,
 * totaloffsetminutes, date, totalseconds,
 * floor, ceiling also are NOT supported by CAP
 *
 * Examples:
 * Books
 * Books/201
 * Books?$select=ID,title&$expand=author($select=name)&$filter=stock gt 1&$orderby=title
 */

//
// ---------- JavaScript Helpers -------------
  {
    const exception = (message, code = 400) => {
      error(JSON.stringify({ code, message }))
    }
    const $ = Object.assign
    const { strict, minimal } = options
    const stack = []
    let SELECT, count
    const TECHNICAL_OPTS = ['$value'] // odata parts to be handled somewhere else

    // we keep that here to allow for usage in https://pegjs.org/online
    const safeNumber = options.safeNumber || function (str) {
      const n = Number(str)
      return Number.isSafeInteger(n) ? n : str
    }

    // NOTe: mutation of the object property, it's NOT a pure function
    const correctAggAwayWhere = (where, colNames) => {
      const changedWhere = [...where];

      for (const item of changedWhere) {
        if (item.xpr) {
          item.xpr = correctAggAwayWhere(item.xpr, colNames)
        }

        if (item.args) {
          item.args = correctAggAwayWhere(item.args, colNames)
        }

        // $filter ohne $apply -> input set = entity -> kein null setzen
        // $apply mit filter transformation -> wie oben
        // $apply mit filter transformation + $filter -> filter in where, $filter in having
        // $apply mit filter transformation + groupby/aggregate/select + $filter -> filter in where, $filter in having

        // TODO fix this for $apply
        if(item.ref && !colNames.includes(item.ref.join(''))) {
          // item.ref = null;
        }
        // REVISIT: { val:null } for should be also implemented
      }

      return changedWhere;
    }

    const correctAggAwayColumns = (SELECT) => {
      const groupBy = SELECT.groupBy;
      const where = SELECT.where;
      const columns = SELECT.columns || [];
      const aggregates = columns.filter((cur) => cur.as);

      let fromAggregate = [];
      let fromGroupBy = [];

      // handle $apply=aggregate(... as someProp)&$select=someProp,?...
      if (aggregates.length !== 0) {
        fromAggregate = columns.filter((cur) =>
          cur.ref ? aggregates.includes(cur.ref.join('')) : true
        );
      }

      // handle $apply=groupby((someProp,?...))&$select=?...
      if (groupBy) {
        const allowedNames = groupBy.map(({ ref }) => ref && ref.join(''));
        const allowedColumns = columns.filter((cur) =>
           cur.ref && allowedNames.includes(cur.ref.join(''))
        );
        fromGroupBy = allowedColumns.length === 0 ? [...groupBy] : allowedColumns;
      }

      const newColumns = fromAggregate.length !== 0 || fromGroupBy.length !== 0
        ? [...fromGroupBy, ...fromAggregate]
        : SELECT.columns;

      let result = { ...SELECT }
      if (newColumns) result.columns = newColumns
      let newWhere = [];

      if (where && (groupBy || aggregates.length !== 0)) {
        // changing { ref: null } for aggregated-away props
        const colNames = columns.map((cur) => cur.ref && cur.ref.join('') || cur.as);
        result = { ...result, where: correctAggAwayWhere(where, colNames) }
      }

      return result;
    }

    const _compareRefs = col => exp => col === exp ||
      (col.as && exp.as && col.as === exp.as) ||
      (col.ref && exp.ref && col.ref.join('') === exp.ref.join(''))
  }

// ---------- Entity Paths ---------------

  ODataRelativeURI // Note: case-sensitive!
    = '/'? (p:path { SELECT = p })
    ( o"?"o QueryOption ( o'&'o QueryOption )* )? o {
      if (count) {
        // columns set because of $count: ignore $select, $expand, $top, $skip, $orderby
        // REVISIT: don't ignore query options but throw bad request (as okra did)?
        SELECT.columns = [{ args: [{ val: 1 }], as: '$count', func: 'count' }]
        delete SELECT.expand
        delete SELECT.limit
        delete SELECT.orderBy
        return { SELECT }
      }
      if (SELECT.expand) {
        // Books?$expand=author w/o $select=author
        if (!SELECT.columns) SELECT.columns = ['*']
        for (const exp of SELECT.expand) {
          const idx = SELECT.columns.findIndex(_compareRefs(exp))
          if (idx > -1) SELECT.columns.splice(idx, 1)
          SELECT.columns.push(exp)
        }
        delete SELECT.expand
      }
      SELECT = correctAggAwayColumns(SELECT)

      return { SELECT }
    }

  path
    = "$count" {count = true}
    / rv:$("$ref"/"$value") {return !TECHNICAL_OPTS.includes(rv) && {from: {ref: [rv]}}}
    / head:(identifier/val) filter:(OPEN CLOSE/OPEN args CLOSE)? tail:( '/' p:path {return p} )? {
      // minimal: val also as path segment
      const ref = [
        filter
          ? filter.length > 2
            ? { id: head, where: filter[1].map(f => f.val && f.val.match && f.val.match(/^"(.*)"$/) ? { val: f.val.match(/^"(.*)"$/)[1] } : f) }
            : { id: head, where: [] }
          : ( minimal ? `${Object.prototype.hasOwnProperty.call(head, 'val') ? head.val : head}` : head )
      ]
      if (tail && tail.from) {
        const more = tail.from.ref
        if (Object.prototype.hasOwnProperty.call(more[0], 'val')) ref[ref.length-1] = { id:ref[ref.length-1], where:[more.shift()] }
        ref.push (...more)
      }
      const res = {from: {ref}}
      if (tail && tail.columns) res.columns = tail.columns
      return res
    }

  args
    = val:val {return [val]}
    / ref:ref o"="o val:(val/w:word{return {val: w}}) more:( COMMA args )? {
      const args = [ ref, '=', val ]
      if (more) args.push ('and', ...more[1])
      return args
    }

//
// ---------- Query Options ------------

  QueryOption = ExpandOption
  ExpandOption =
    "$select="      o select ( COMMA select )* /
    "$expand="      o expand ( COMMA expand )* /
    "$filter="      o filter /
    "$orderby="     o orderby ( COMMA orderby )* /
    "$top="         o top /
    "$skip="        o skip /
    "$search="      o search /
    "$count="       o count /
    "$apply="       o apply /
    custom


  select
    = col:('*'/ref) {
      SELECT.columns = Array.isArray(SELECT.columns) ? SELECT.columns : []
      if (!SELECT.columns.find(_compareRefs(col))) SELECT.columns.push(col)
      return col
    }

  expand =
    (
      c:('*'/ref) {
        const col = c === '*' ? {} : c
        col.expand = '*'
        if (!Array.isArray(SELECT.expand)) SELECT.expand = []
        if (!SELECT.expand.find(_compareRefs(col))) SELECT.expand.push(col)
        return col
      }
    )
    ( // --- nested query options, if any
      (OPEN {
        stack.push (SELECT)
        SELECT = SELECT.expand[SELECT.expand.length-1]
        SELECT.expand = '*' // by default expand everything
      })(
      expandOptions:( o ";"? o ExpandOption)*
      {
        if (SELECT.columns) {
          if (SELECT.expand === '*') SELECT.expand = []
          for (const col of SELECT.columns) {
            if (!SELECT.expand.find(_compareRefs(col))) SELECT.expand.push(col)
          }
          delete SELECT.columns
        } else {
          if (Array.isArray(SELECT.expand) && SELECT.expand.indexOf('*') === -1) SELECT.expand.unshift('*')
        }
      }
      )(CLOSE {
        SELECT = stack.pop()
      })
    )? // --- end of nested query options
    ( COMMA expand )?

  top
    = val:integer {
      (SELECT.limit || (SELECT.limit={})).rows = {val}
    }

  skip
    = val:integer {
      (SELECT.limit || (SELECT.limit={})).offset = {val}
    }

  search
    = p:search_clause {SELECT.search = p}

  search_clause
    = p:( n:NOT? {return n?[n]:[]} )(
      OPEN xpr:search_clause CLOSE {p.push({xpr})}
      / (
          val:doubleQuotedString {p.push({val})} /
          val:string {p.push({val})} /
          val:word {p.push({val})}
        )
    )( ao:(AND/OR/AND_SPACE) more:search_clause {p.push(ao,...more)} )*
    {return p}

  filter
    = p:where_clause {SELECT.where = p}

  where_clause = p:( n:NOT? {return n?[n]:[]} )(
      OPEN xpr:where_clause CLOSE {p.push({xpr})}
      / comp:comparison {p.push(...comp)}
      / lambda:lambda {p.push(...lambda)}
      / func:boolish {p.push(func)}
      / val:bool {p.push({val})}
    )( ao:(AND/OR) more:where_clause {p.push(ao,...more)} )*
    {return p}

  lambda =
    nav:( n:identifier {return[n]} ) '/' ( n:identifier '/' {nav.push(n)} )*
    xpr:(
      any:any {
        let id = nav.pop()
        if (!any) return ['exists', { ref: [...nav, { id }] }]
        let xpr = []
        for (let i=0, k=0; i<any.length; ++i) {
          let each = any[i]
          if (each.ref && each.ref.length === 0 && any[i+1] === '=') {
            xpr[k++] = { func:'contains', args:[{ref:id}, any[i+=2]] }
          } else {
            xpr[k++] = each
          }
        }

        if (xpr.length < any.length) {
          id = nav.pop()
          return ['exists', { ref: [...nav, { id, where: xpr }] }]
        } else {
          return ['exists', { ref: [...nav, { id, where: any }] }]
        }
      }
      / all:all {
        let id = nav.pop()
        return ['not', 'exists', { ref: [...nav, { id, where: ['not', { xpr: [...all] }] }] }]
      }
    )
    { return xpr }

  inner_lambda =
    p:( n:NOT? { return n ? [n] : [] } )(
      OPEN xpr:inner_lambda CLOSE { p.push('(', ...xpr, ')') }
      / comp:comparison { p.push(...comp) }
      / lambda:lambda { p.push(...lambda)}
    )
    ( ao:(AND/OR) more:inner_lambda { p.push(ao, ...more) } )*
    { return p }

  lambda_clause = prefix:identifier ":" inner:inner_lambda {
    for (const e of inner) {
      // remove the prefix identifier
      if (e.ref && e.ref[0] === prefix) e.ref.shift()
    }

    return inner
  }

  any = "any" OPEN p:lambda_clause? CLOSE { return p }

  all = "all" OPEN p:lambda_clause CLOSE { return p }

  orderby
    = ref:(function/ref) sort:( _ s:$("asc"/"desc") {return s})? {
        const appendObj = $(ref, sort && {sort});
        SELECT.orderBy = SELECT.orderBy ?
          [...SELECT.orderBy, appendObj] :
          [appendObj]
    }

  count
    = val:bool { if(val) SELECT.count = true }

  apply
    = applyTrafo ("/" applyTrafo)*

  custom = [a-zA-Z] [a-zA-Z0-9-]* "=" [^&]*

//
// ---------- Expressions ------------


  comparison "a comparison"
    = a:operand _ o:$("eq"/"ne"/"lt"/"gt"/"le"/"ge") _ b:operand {
      const op = { eq:'=', ne:'!=', lt:'<', gt:'>', le:'<=', ge:'>=' }[o]||o
      return [ a, op, b ]
    }

  mathCalc
    = operand (_ ("add" / "sub" / "mul" / "div" / "mod") _ operand)*

  operand "an operand"
    = function / ref / val / jsonObject / jsonArray / list

  ref "a reference"
    = head:identifier tail:( '/' n:identifier {return n})*
    {
      if (head === "null") {
        return { val: null }
      }

      return { ref:[ head, ...tail ] }
    }

  val
    = val:(bool / date) {return {val}}
    / guid
    / val:number {return typeof val === 'number' ? {val} : { val, literal:'number' }}
    / val:string {return {val}}

  jsonObject = val:$("{" (jsonObject / [^}])* "}") {return {val}}

  jsonArray = val:$("[" o "]" / "[" o "{" (jsonArray / [^\]])* "]") {return {val}}

  list
    = "[" any:$([^\]])* "]" // > needs improvment
    { return { list: any.replace(/"/g,'').split(',').map(ele => ({ val: ele })) } }

  function "a function call"
    = func:$[a-z]+ OPEN a:operand more:( COMMA o:operand {return o} )* CLOSE {
      if (strict && !(func in strict.functions)) exception("'"+ func +"' is an unknown function in OData URL spec (strict mode)")
      return { func, args:[a,...more] }
    }

  boolish "a boolean function"
    = func:("contains"/"endswith"/"startswith") OPEN a:operand COMMA b:operand CLOSE
    { return { func, args:[a,b] }}

  NOT = o "NOT"i _ {return 'not'}
  AND = _ "AND"i _ {return 'and'}
  AND_SPACE =   _ {return 'and'}
  OR  = _  "OR"i _ {return 'or'}


//
// ---------- Transformations ------------

  applyTrafo
    = (
      "aggregate" aggregateTrafo /
      "groupby" groupbyTrafo /
      "filter" filterTrafo /
      countTrafo /

      // REVISIT: All transformations below need improvment
      // and should supported by CAP
      "expand" expandTrafo /
      "search" searchTrafo /
      "concat" concatTrafo /
      "compute" computeTrafo /
      "bottompercent" commonFuncTrafo /
      "bottomsum" commonFuncTrafo /
      "toppercent" commonFuncTrafo /
      "topsum" commonFuncTrafo /
      identityTrafo
      // customFunction
    )

  aggregateTrafo
     = OPEN o aggregateItem (o COMMA o aggregateItem)* o CLOSE
  aggregateItem
    = res:("$count" alias:asAlias { return { func: 'count', args: ['*'], as: alias } }
           / aggregateExpr
          ) {
            SELECT.columns = Array.isArray(SELECT.columns) ? SELECT.columns : []
            if (!SELECT.columns.find(_compareRefs(res))) SELECT.columns.push(res)
            return res
          }
  aggregateExpr
    = path:(
        ref
     // / mathCalc - needs CAP support
      )
      func:aggregateWith aggregateFrom? alias:asAlias
        { return { func, args: [ path ], as: alias } }
      / identifier OPEN aggregateExpr CLOSE // needs CAP support
   // / customAggregate // needs CAP support
  aggregateWith
    = _ "with" _ func:$[a-z]+ { return func; }
  aggregateFrom
    = _ "from" _ ref aggregateWith aggregateFrom? // needs CAP support
  asAlias
    = _ "as" _ alias:identifier { return alias; }

  groupbyTrafo
    = OPEN o (OPEN groupByElem (COMMA o groupByElem)* CLOSE) (COMMA o apply)? o CLOSE
  groupByElem
    = val:(rollupSpec / ref)
    { (SELECT.groupBy || (SELECT.groupBy = [])).push(val) }
  rollupSpec // TODO fix this + add CAP support
    = rollup:("rollup" OPEN o ('$all' / ref) (o COMMA ref)+ o CLOSE) {const err = new Error("Rollup in groupby is not supported yet.");err.statusCode=501;throw err;}

  filterTrafo = OPEN o filter o CLOSE

  countTrafo
    = trafo:("topcount" / "bottomcount") OPEN o val:number o COMMA o ref:ref o CLOSE
    {
      const oredrObj = { ...ref, sort: trafo === 'topcount' ? 'desc' : 'asc' };
      SELECT.orderBy = SELECT.orderBy ? [...SELECT.orderBy, oredrObj] : [oredrObj];
      (SELECT.limit || (SELECT.limit={})).rows = {val};
    }


  // All transformations below need improvment
  // and should supported by CAP
  expandTrafo
    = OPEN o ref o COMMA o
      ( expandTrafo (o COMMA expandTrafo)*
      / filterTrafo (o COMMA expandTrafo)*
      ) o CLOSE

  searchTrafo = OPEN o search o CLOSE

  concatTrafo = OPEN o apply (o COMMA o apply)+ o CLOSE

  computeTrafo = OPEN o computeExpr (o COMMA o computeExpr)* o CLOSE
  computeExpr = where_clause asAlias

  commonFuncTrafo = OPEN o operand o COMMA o operand o CLOSE

  identityTrafo = "identity"


//
// ---------- Literals -----------

  bool = b:("true" / "false") { return b === 'true'}

  string "Edm.String"
    = "'" s:$("''"/[^'])* "'"
    {return s.replace(/''/g,"'")}

  doubleQuotedString
    = '"' s:$('\\"'/[^"])* '"'
    {return s.replace(/\\\\/g,"\\").replace(/\\"/g,'"')}

  word
    = s:$([a-zA-Z0-9.+-]+)

  date
    = s:$( [0-9]+"-"[0-9][0-9]"-"[0-9][0-9] // date
      ("T"[0-9][0-9]":"[0-9][0-9](":"[0-9][0-9]("."[0-9]+)?)? // time
      ( "Z" / (("+" / "-")[0-9][0-9]":"[0-9][0-9]) )? // timezone (Z or +-hh:mm)
    )?)

  number
    = s:$( [+-]? [0-9]+ ("."[0-9]+)? ("e"[0-9]+)? )
    {return safeNumber(s)}

  integer
    = s:$( [+-]? [0-9]+ )
    {return parseInt(s)}

  identifier
    = !bool !guid s:$([_a-zA-Z][_a-zA-Z0-9"."]*) {return s}

  guid = val:$([0-9a-zA-Z]+ "-" ([0-9a-zA-Z]+ "-"?)+)
    {return {val}}

//
// ---------- Punctuation ----------

  COLON = o":"o
  COMMA = o","o
  SEMI  = o";"o
  OPEN  = o"("o
  CLOSE = o")"

//
// ---------- Whitespaces -----------

  o "optional whitespaces" = $[ \t\n]*
  _ "mandatory whitespaces" = $[ \t\n]+

//
// ------------------------------------
