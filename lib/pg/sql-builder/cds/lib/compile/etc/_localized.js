const cds = require('../..'), {env} = cds
const DEBUG = cds.debug('alpha|_localized')
const _locales_4sql = {
	sqlite : env.i18n.for_sqlite || env.i18n.for_sql || [],
	plain  : env.i18n.for_sql || [],
}

// FIXME: we reliably need to now if we'll be on sqlite even before the connect happened
const _on_sqlite = (env.requires.db || env.requires.sql).dialect === 'sqlite'
const { _texts_entries, _localized_entries } = env.cdsc.cv2 || {}
const _been_here = Symbol('is _localized')



/**
 * In case of, for each localized_<view> we get from the compiler,
 * create additional views localized_<locale>_<views>
 */
function unfold_ddl (ddl, csn, o={}) { // NOSONAR
	const _locales = _locales_4sql[o.dialect]; if (!_locales)  return ddl
	const localized_views = ddl.filter (each => each.startsWith ('CREATE VIEW localized_'))
	for (let localized_view of localized_views) {
		for (let locale of _locales) ddl.push (localized_view
			.replace (/localized_/g, `localized_${locale}_`)
			.replace (/\.locale = 'en'/, `.locale = '${locale}'`)
		)
	}
	DEBUG && localized_views.length && DEBUG ('Added localized views to DDL for', csn.$sources)
	return ddl
}



/**
 * Add localized. entries and localized.<locale> entries (as in compiler v1) to reflect what
 * For each localized.<view> we get from the compiler, ensure there's a
 * corresponding localized.<locale>. entry in the model to support reflection.
 * In addition
 */
function unfold_csn (m) { // NOSONAR

	// only do that once per model
	if (!m || m[_been_here]) return m
	// eslint-disable-next-line no-console
	DEBUG && console.trace ('unfolding csn...')
	const pass2 = []

	const _locales = _on_sqlite && _locales_4sql.sqlite

	// Pass 1 - add localized.<locale> entities and views
	for (let each in m.definitions) {
		const d = m.definitions [each]
		// Add <entry>_texts proxies for all <entry>.texts entities
		if (_texts_entries !== false && each.endsWith('.texts')) {
			_add_proxy4 (d, each.slice(0,-6)+'_texts')
		}
		// Add localized.<entry> for all entities marked as .$localized
		if (_localized_entries !== false && d.own('$localized')) {
			let x = _add_proxy4 (d,`localized.${each}`)
			if (x) pass2.push ([x])
			// if running on sqlite add additional localized.<locale>. views
			if (_locales) for (let locale of _locales) {
				let x = _add_proxy4 (d,`localized.${locale}.${each}`)
				if (x) pass2.push ([x,locale])
			}
		}
	}

	// Pass 2 - redirect associations/compositions in elements to localized.<locale> targets
	for (let [x,locale] of pass2) {
		let overlayed = null
		for (let each in x.elements) {
			let e = x.elements [each]
			if (e._target && e._target.$localized) {
				let elements = overlayed || (overlayed = x.elements = {__proto__:x.elements})
				let target = locale ? `localized.${locale}.${e.target}` : `localized.${e.target}`
				let _target = m.definitions[target]
				if (_target) {
					elements[each] = Object.defineProperty ({__proto__:e,target},'_target',{value:_target})
					DEBUG && DEBUG ('overriding:', each, ':', elements[each], 'in', { entity: x.name })
				}
				else DEBUG && DEBUG ('NOT!! overriding:', each, ':', elements[each], 'in', { entity: x.name })
			}
		}
	}

	// done
	DEBUG && pass2.length && DEBUG ('Added localized views for sqlite to csn for', m.$sources)
	return Object.defineProperty (m, _been_here, {value:true})

	function _add_proxy4 (d, name) {
		if (name in m.definitions) return DEBUG && DEBUG ('NOT overriding existing:', name)
		let x = {__proto__:d, name }
		DEBUG && DEBUG ('adding proxy:', x)
		Object.defineProperty (m.definitions, name, {value:x,writable:true,configurable:true})
		return x
	}
}


// feature-toggled exports
module.exports = Object.assign ( unfold_csn, { unfold_ddl })
if (!env.features.localized) module.exports = Object.assign ( x=>x, { unfold_ddl: x=>x })
