// import types from '../lib/core'
import { ReflectedModel, LinkedModel, LinkedDefinition } from './reflect'
import { CSN as csn, Definition } from "./csn"
import { Query as cqn } from "./cqn"
import { EventEmitter } from "events";

export = cds_core
declare class cds_core extends EventEmitter {

	/**
	 * Turns the given plain CSN model into a linked model
	 * @see [capire](https://cap.cloud.sap/docs/node.js/cds-reflect)
	 */
	linked (model : csn) : LinkedModel

	/**
	 * Turns the given plain CSN model into a reflected model
	 * @see [capire](https://cap.cloud.sap/docs/node.js/cds-reflect)
	 */
	reflect (model : csn) : ReflectedModel


	// infer (query : cqn, model : csn) : LinkedDefinition

	builtin: {
		 /**
			* Base classes of linked definitions from reflected models.
			* @see [capire](https://cap.cloud.sap/docs/node.js/cds-reflect#cds-builtin-classes)
			*/
		classes: {
			Association : Definition
			Composition : Definition
			context : Definition
			service : Definition
			type : Definition
			array : Definition
			struct : Definition
			entity : Definition
			event : Definition
		},
		types: {},
	}

	/**
	 * Base class for linked Associations from reflected models.
	 * @see [capire](https://cap.cloud.sap/docs/node.js/cds-reflect#cds-Association)
	 */
	Association : Definition

	/**
	 * Base class for linked Compositions from reflected models.
	 * @see [capire](https://cap.cloud.sap/docs/node.js/cds-reflect#cds-Association)
	 */
	Composition : Definition


	/**
	 * Base class for linked entities from reflected models.
	 * @see [capire](https://cap.cloud.sap/docs/node.js/cds-reflect#cds-entity)
	 */
	entity : Definition

	struct : Definition
	array : Definition
	context : Definition
	service : Definition

	/**
	 * Add aspects to a given object, for example:
	 *
	 *    extend (Object.prototype) .with (class {
	 *       get foo() { return ... }
	 *       bar() {...}
	 *    }.prototype)
	 */
	extend <T> (target:T) : ({
		with <X,Y,Z> (x:X, y:Y, z:Z): ( T & X & Y & Z )
		with <X,Y> (x:X, y:Y): ( T & X & Y )
		with <X> (x:X): ( T & X )
	})

	/**
	 * Equip a given facade object with getters for lazy-loading modules instead
	 * of static requires. Example:
	 *
	 *    const facade = lazify ({
	 *       sub: lazy => require ('./sub-module')
	 *    })
	 *
	 * The first usage of `facade.sub` will load the sub module
	 * using standard Node.js's `module.require` functions.
	 */
	lazify : <T>(target:T) => T

	/**
	 * Prepare a node module for lazy-loading submodules instead
	 * of static requires. Example:
	 *
	 *    require = lazify (module) //> turns require into a lazy one
	 *    const facade = module.exports = {
	 *       sub: require ('./sub-module')
	 *    })
	 *
	 * The first usage of `facade.sub` will load the sub module
	 * using standard Node.js's `module.require` functions.
	 */
	lazified : <T>(target:T) => T

}
// & typeof import ('../lib/index')
