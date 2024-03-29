import { Service, ServiceImpl } from "./services"
import { LinkedDefinition } from "./reflect"
import { csn } from "./csn"
import * as http from "http";

// stub to avoid hard dependencies for typescript projects
declare namespace express {
	interface Application {}
}

// export const Service : _Service

interface _fluent {
	from (model : string | csn) : this
	to (protocol: string) : this
	at (path: string) : this
	in (app: express.Application) : this
	with (impl: ServiceImpl | string) : this
	// (req,res) : void
}

export = cds_serve
declare class cds_serve {

	/**
	 * Constructs service providers from respective service definitions
	 * @see [capire](https://cap.cloud.sap/docs/node.js/api#cds-serve)
	 */
	serve (service : string) : _fluent & Promise<cds_services>

	/**
	 * The default bootstrap function as loaded from server.js
	 */
	server: cds_server

	/**
	 * Emitted at the very beginning of the bootsrapping process, when the
	 * express application has been constructed but no middlewares or routes
	 * added yet.
	 */
	on   (event : 'bootstrap', listener : (app : express.Application) => void) : this
	once (event : 'bootstrap', listener : (app : express.Application) => void) : this

	/**
	 * Emitted for each service served by cds.serve().
	 */
	on (event : 'serving', listener : (srv : Service) => void) : this

	/**
	 * Emitted by the default, built-in `server.js` when all services are
	 * constructed and mounted by cds.serve().
	 */
	on   (event : 'served', listener : (all : cds_services) => void) : this
	once (event : 'served', listener : (all : cds_services) => void) : this

	/**
	 * Emitted by the default, built-in `server.js` when the http server
	 * is started and listening for incoming requests.
	 */
	on   (event : 'listening', listener : (args : { server: http.Server, url:string }) => void) : this
	once (event : 'listening', listener : (args : { server: http.Server, url:string }) => void) : this

	/**
	 * Dictionary of all services constructed and/or connected.
	 */
	services : cds_services

	/**
	 * Shortcut to base class for all service definitions from linked models.
	 * Plus accessors to impl functions and constructed providers.
	 */
	service : LinkedDefinition & {
		/**
		 * Dummy wrapper for service implementation functions.
		 * Use that in modules to get IntelliSense.
		 */
		impl (impl: ServiceImpl) : typeof impl
		impl <T> (srv:T, impl: ( this: T, srv: (T) ) => any) : typeof impl
		/**
		 * Array of all services constructed.
		 */
		providers : Service
	}

	/**
	 * The effective CDS model loaded during bootstrapping, which contains all service and entity definitions,
	 * including required services.
	 */
	model?: csn

}

declare type cds_services = { [name:string]: Service }
declare type cds_server = Function
