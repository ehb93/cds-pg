import { SELECT, INSERT, UPDATE, DELETE, Query, ConstructedQuery } from './ql'
import { LinkedModel, Definition, Definitions } from './reflect'
import { csn, type } from "./csn"
// import { Service } from './cds'


export class QueryAPI {

	/**
	 * @see [docs](https://cap.cloud.sap/docs/node.js/services#srv-run)
	 */
	read <T>(entity : Definition | string, key?: any) : SELECT<T>

	/**
	 * @see [docs](https://cap.cloud.sap/docs/node.js/services#srv-run)
	 */
	create <T>(entity : Definition | string, key?: any) : INSERT<T>

	/**
	 * @see [docs](https://cap.cloud.sap/docs/node.js/services#srv-run)
	 */
	insert <T>(data : object | object[]) : INSERT<T>

	/**
	 * @see [docs](https://cap.cloud.sap/docs/node.js/services#srv-run)
	 */
	update <T>(entity : Definition | string, key?: any) : UPDATE<T>

	/**
	 * @see [docs](https://cap.cloud.sap/docs/node.js/services#srv-run)
	 */
	delete <T>(entity : Definition | string, key?: any) : DELETE<T>

	/**
	 * @see [docs](https://cap.cloud.sap/docs/node.js/services#srv-run)
	 */
	run (query : ConstructedQuery) : Promise<ResultSet | any>

	/**
	 * @see [docs](https://cap.cloud.sap/docs/node.js/services#srv-run)
	 */
	run (query : Query) : Promise<ResultSet | any>

	/**
	 * @see [docs](https://cap.cloud.sap/docs/node.js/services#srv-run)
	 */
	foreach (query : Query, callback: (row:object) => void) : this

	/**
	 * @see [docs](https://cap.cloud.sap/docs/node.js/services#srv-stream)
	 */
	stream (column:string) : {
		from (entity : Definition | string) : {
			where (filter : any) : ReadableStream
		}
	}

	/**
	 * @see [docs](https://cap.cloud.sap/docs/node.js/services#srv-stream)
	 */
	stream (query:Query) : Promise<ReadableStream>

	/**
	 * Starts or joins a transaction
	 * @see [docs](https://cap.cloud.sap/docs/node.js/services#srv-tx)
	 */
	tx (context : object) : Transaction
	transaction (context : object) : Transaction
}

/**
 * Class cds.Service
 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services)
 */
export class Service extends QueryAPI {

	constructor (name:String, model: csn, options: {
		kind: String
		impl: String | ServiceImpl
	})

	/**
	 * The model from which the service's definition was loaded
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services#srv-reflect)
	 */
	model: LinkedModel

	/**
	 * Provides access to the entities exposed by a service
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services#srv-reflect)
	 */
	entities: Definitions & ((namespace: string) => Definitions)

	/**
	 * Provides access to the events declared by a service
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services#srv-reflect)
	 */
	events: Definitions & ((namespace: string) => Definitions)

	/**
	 * Provides access to the types exposed by a service
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services#srv-reflect)
	 */
	types: Definitions & ((namespace: string) => Definitions)

	/**
	 * Provides access to the operations, i.e. actions and functions, exposed by a service
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services#srv-reflect)
	 */
	operations: Definitions & ((namespace: string) => Definitions)

	/**
	 * Acts like a parameter-less constructor. Ensure to call `await super.init()` to have the base class’s handlers added.
	 * You may register own handlers before the base class’s ones, to intercept requests before the default handlers snap in.
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services#cds-service-subclasses)
	 */
	init() : Promise<void>

	/**
	 * Constructs and emits an asynchronous event.
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services#srv-emit)
	 */
	emit (details: { event: Events, data?: object, headers?: object }) : Promise<this>

	/**
	 * Constructs and emits an asynchronous event.
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services#srv-emit)
	 */
	emit (event: Events, data?: object, headers?: object) : Promise<this>

	/**
	 * Constructs and sends a synchronous request.
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services#srv-send)
	 */
	send (event: Events, data?: object, headers?: object) : Promise<this>

	/**
	 * Constructs and sends a synchronous request.
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services#srv-send)
	 */
	send (details: { event: Events, data?: object, headers?: object }) : Promise<this>

	/**
	 * Constructs and sends a GET request.
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services#srv-send)
	 */
	get (entityOrPath: Target, data?: object) : Promise<this>
	 /**
	 * Constructs and sends a POST request.
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services#srv-send)
	 */
	post (entityOrPath: Target, data?: object) : Promise<this>
	/**
	 * Constructs and sends a PUT request.
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services#srv-send)
	 */
	put (entityOrPath: Target, data?: object) : Promise<this>
	/**
	 * Constructs and sends a PATCH request.
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services#srv-send)
	 */
	patch (entityOrPath: Target, data?: object) : Promise<this>
	 /**
	 * Constructs and sends a DELETE request.
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services#srv-send)
	 */
	delete (entityOrPath: Target, data?: object) : Promise<this>
	/**
	 * @see [docs](https://cap.cloud.sap/docs/node.js/services#srv-run)
	 */
	delete <T>(entity : Definition | string, key?: any) : DELETE<T>

	 // The central method to dispatch events
	dispatch (msg: EventMessage): Promise<any>


	// Provider API
	prepend (fn: ServiceImpl): Promise<this>
	on (eve: Events, entity: Target, handler: OnEventHandler): this
	on (eve: Events, handler: OnEventHandler): this
	// onSucceeded (eve: Events, entity: Target, handler: EventHandler): this
	// onSucceeded (eve: Events, handler: EventHandler): this
	// onFailed (eve: Events, entity: Target, handler: EventHandler): this
	// onFailed (eve: Events, handler: EventHandler): this
	before (eve: Events, entity: Target, handler: EventHandler): this
	before (eve: Events, handler: EventHandler): this
	after (eve: Events, entity: Target, handler: ResultsHandler): this
	after (eve: Events, handler: ResultsHandler): this
	reject (eves: Events, ...entity: Target[]): this

}

export interface Transaction extends QueryAPI {
	commit() : Promise<void>
	rollback() : Promise<void>
}

export class DatabaseService extends Service {
	deploy (model?: csn | string) : Promise<csn>
	begin() : Promise<void>
	commit() : Promise<void>
	rollback() : Promise<void>
}

export interface ResultSet extends Array<{}> {}

export class cds_facade {

	/**
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/services)
	 */
	Service : typeof Service

	/**
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/app-services)
	 */
	ApplicationService : typeof Service

	/**
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/remote-services)
	 */
	RemoteService : typeof Service

	/**
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/messaging)
	 */
	MessagingService : typeof Service

	/**
	 * @see [capire docs](https://cap.cloud.sap/docs/node.js/databases)
	 */
	DatabaseService : typeof DatabaseService
}


export interface ServiceImpl {
	( this: Service, srv: Service ) : any
}

export interface EventHandler {
	// (msg : EventMessage) : Promise<any> | any | void
	(req : Request) : Promise<any> | any | void
}

export interface OnEventHandler {
	(req : Request, next: Function) : Promise<any> | any | void
}

interface ResultsHandler {
	(results : any[], req : Request) : void
	(each : any, req : Request) : void
}

/**
 * Represents the user in a given context.
 * @see [capire docs](https://cap.cloud.sap/docs/node.js/authentication#cds-user)
 */
interface User {
	id: string,
	locale: string,
	tenant: string | undefined,
	attr: Record<string, string>,

	is: (role : string) => boolean
}

/**
 * Represents the invocation context of incoming request and event messages.
 * @see [capire docs](https://cap.cloud.sap/docs/node.js/requests)
 */
interface EventContext {
	timestamp : Date
	locale : string
	id : string
	user : User
	tenant : string
}

/**
 * @see [capire docs](https://cap.cloud.sap/docs/node.js/requests)
 */
 interface EventMessage extends EventContext{
	event : string
	data : any
	headers : {}
}

/**
 * @see [capire docs](https://cap.cloud.sap/docs/node.js/requests)
 */
 interface Request extends EventMessage {
	params : (string|{})[]
	method : string
	path : string
	target : Definition
	query : Query

	reply (results) : void

	notify (code:number, msg:string, target?:string, args?:{}) : Error
	info (code:number, msg:string, target?:string, args?:{}) : Error
	warn (code:number, msg:string, target?:string, args?:{}) : Error
	error (code:number, msg:string, target?:string, args?:{}) : Error
	reject (code:number, msg:string, target?:string, args?:{}) : Error

	notify (msg:string, target?:string, args?:{}) : Error
	info (msg:string, target?:string, args?:{}) : Error
	warn (msg:string, target?:string, args?:{}) : Error
	error (msg:string, target?:string, args?:{}) : Error
	reject (msg:string, target?:string, args?:{}) : Error

	notify (msg:{ code?:number|string, msg:string, target?:string, args?:{} }) : Error
	info (msg:{ code?:number|string, msg:string, target?:string, args?:{} }) : Error
	warn (msg:{ code?:number|string, msg:string, target?:string, args?:{} }) : Error
	error (msg:{ code?:number|string, msg:string, target?:string, args?:{} }) : Error
	reject (msg:{ code?:number|string, msg:string, target?:string, args?:{} }) : Error
}

type Events = Event | Event[]
type Event = ( CRUD | TX | HTTP | DRAFT ) | CustomOp
type CRUD = 'CREATE' | 'READ' | 'UPDATE' | 'DELETE'
type DRAFT = 'NEW' | 'EDIT' | 'PATCH' | 'SAVE'
type HTTP = 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE'
type TX = 'COMMIT' | 'ROLLBACK'
type CustomOp = string
type Target = string | Definition
