export type Query = SELECT | INSERT | UPDATE | DELETE | CREATE | DROP
export type ParsedExpr = expr & { _:string }

export type SELECT = {SELECT:{
	distinct?: true
	one? : boolean
	from : source
	columns? : column_expr[]
	excluding? : string[]
	where? : predicate
	having? : predicate
	groupBy? : expr[]
	orderBy? : ordering_term[]
	limit?: { rows:number, offset:number }
}}

export type INSERT = {INSERT:{
	into : name
	entries : any[]
	columns : string[]
	values : any[]
	rows : any[]
}}

export type UPDATE = {UPDATE:{
	entity : name
	data : { [key:string] : expr }
	where? : predicate
}}

export type DELETE = {DELETE:{
	from : name
	where? : predicate
}}

export type CREATE = {CREATE:{
	entity : name
}}

export type DROP = {DROP:{
	entity : name
}}

type name = string
type source = ( ref | SELECT ) & { as?: name, join?:name, on?:xpr }
export type column_expr = expr & { as?: name, cast?:any, expand?: column_expr[], inline?: column_expr[] }
export type predicate = _xpr
type ordering_term = expr & { asc?:true, desc?:true }

export type expr = ref | val | xpr | SELECT
type ref = {ref:( name & { id?:string, where?:expr, args?:expr[] } )[]}
type val = {val:any}
type xpr = {xpr:_xpr}
type _xpr = ( expr | operator ) []
type operator = string

export type enum_literal = {"#": string}
export type expr_literal = {"=": string}
