/*
	This is the inner core of cds: its type system, bootstrapped from in-place
	CSN models itself. Besides the actual root types, a set of common and
	recommended scalar types is added to builtin.types.
*/
const classes = Object.assign (
	require('./classes'),
	require('./entities'),
)

// Type system roots -> can be used with instanceof
const roots = _bootstrap ({
	context: {},
	type: {},
		scalar: {type:'type'},
			string: {type:'scalar'},
			number: {type:'scalar'},
			boolean: {type:'scalar'},
			date: {type:'scalar'},
		array: {type:'type'},
		struct: {type:'type'},
			aspect: {type:'struct'},
			entity: {type:'struct'},
			event: {type:'struct'},
	Association: {type:'type'},
	Composition: {type:'Association'},
	service: {type:'context'},
})

// Adding common recommended types
const common = { __proto__:roots,
	UUID: {type:'string',length:36},
	Boolean: {type:'boolean'},
	Integer: {type:'number'},
		Integer16: {type:'Integer'},
		Integer32: {type:'Integer'},
		Integer64: {type:'Integer'},
	Decimal: {type:'number'},
	DecimalFloat: {type:'number'},
	Float: {type:'number'},
	Double: {type:'number'},
	DateTime: {type:'date'},
	Date: {type:'date'},
	Time: {type:'date'},
	Timestamp: {type:'date'},
	String: {type:'string'},
	Binary: {type:'string'},
	LargeString: {type:'string'},
	LargeBinary: {type:'string'},
}

/**
 * Construct builtin.types as dictionary of all roots and common types
 * @type { typeof roots & typeof common }
 */
const types = { __proto__:common }

// Link all definitions, essentially by: d.__proto__ = resolved (d.type)
for (let [name,d] of Object.entries(common)) {
	common[name] = Object.defineProperty({ ...d, __proto__: types[d.type] }, 'name', {value:name})
}

// Prefix all common types with a namespace 'cds'
for (let t of Object.keys(common))  types['cds.'+t] = types[t]
types['cds.Association'] = types.Association
types['cds.Composition'] = types.Composition

module.exports = { types, classes }


/**
 * Turns the given CSN definitions into linked definitions.
 * @type <T>(csn:T) => T
 */
function _bootstrap (csn) {
	const defs = { any: classes.any.prototype }
	for (const t in csn) {
		if (t in classes) {
			defs[t] = classes[t].prototype
			continue
		}
		const c = class extends classes[csn[t].type || 'any'] {}
		defs[t] = Object.defineProperty(c.prototype, 'name', { value: t })
		classes[t] = Object.defineProperty(c, 'name', { value: t })
	}
	return defs
}
