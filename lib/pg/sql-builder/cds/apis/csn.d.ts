import { SELECT, expr, predicate, column_expr } from "./cqn"

export type csn = CSN

/** A parsed model. */
export interface CSN {

    /** The assigned namespace. If parsed from multiple sources, this is the topmost model's namespace, if any, not the ones of imported models. */
    namespace? : string

    /** The list of usings in this parsed model. Not available after imports have been resolved into a merged model. */
    using? : { name: string, as?: string, from?: string }[]

    /** All definitions in the model including those from imported models. */
    definitions? : Definitions

    /** All extensions in the model including those from imported models. Not available after extensions have been applied. */
    extensions? : Definition[]

    $sources?: string[]
}

export interface DefinitionRegistry {
    type: type,
    struct: struct,
    entity: entity,
    Association: Association,
}
export type Definition = DefinitionRegistry[keyof DefinitionRegistry];

export interface Definitions {
    [name:string]: Definition
}

export type kind = 'context' | 'service' | 'type' | 'entity' | 'element' | 'const' | 'annotation'
export type Element = type & struct & Association & {
    kind : 'element' | undefined
}

export interface type {
    kind? : kind
    type? : string
    name : string
}

export interface struct extends type {
    /** structs have elements which are in turn Definitions */
    elements : { [name:string]: Element }
    /** References to definitions to be included. Not available after extensions have been applied. */
    include? : string[]
}

export interface entity extends struct {
    kind : 'entity'
    /** Entities with a query signify a view */
    query?: SELECT & { cql: string }
    /** Elements of entities may have additional qualifiers */
    elements : {
        [name:string]: Element & {
            key? : boolean
            virtual? : boolean
            unique? : boolean
            notNull? : boolean
        }
    }
    keys : {
        [name:string]: Definition
    }
}

export interface Association extends type {
    type : 'cds.Association' | 'cds.Composition'
    /** The fully-qualified name of the Association's target entity */
    target : string
    /** The specified cardinality. to-one = {max:1}, to-many = {max:'*'} */
    cardinality? : {src?:1,min?:1|0,max?:1|'*'}
    /** The parsed on condition in case of unmanaged Associations */
    on? : predicate
    /** The optionally specified keys in case of managed Associations */
    keys? : column_expr[]
}
