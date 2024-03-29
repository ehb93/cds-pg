import edm from "@sap/cds-compiler/lib/edm/edm"
import { Query, expr, _xpr } from "./cqn"
import { CSN } from "./csn"

type csn = CSN
type cqn = Query

type _flavor = 'parsed' | 'xtended' | 'inferred'
type _odata_options = {
    flavor?: 'v2' | 'v4' | 'w4'| 'x4',
    version?: 'v2' | 'v4',
    structs?: boolean,
    refs?: boolean,
}
type _options = {
    flavor?: _flavor,
    plain?: boolean,
    docs?: boolean,
    names?: string,
    odata?: _odata_options,
} | _flavor

type JSON = string
type YAML = string
type CDL = string
type SQL = string
type XML = string
type EDM = { $version:string }
type EDMX = XML
type filename = string


export = cds_models
declare class cds_models {

    /**
     * Provides a set of methods to parse a given model, query or expression.
     * You can also use `cds.parse()` as a shortcut to `cds.parse.cdl()`.
     */
    parse : {
        /** Shortcut to `cds.parse.cdl()` */
        (cdl:CDL) : csn
        cdl (cdl:CDL) : csn
        cql (src:string) : cqn
        expr (src:string) : expr
        xpr (src:string) : _xpr
        ref (src:string) : string[]
    }


    /**
     * Provides a set of methods to parse a given model, query or expression.
     * You can also use `cds.compile(csn).to('<output>')` as a fluent variant.
     */
    compile : {
        /** Shortcut for `cds.compile.to.csn()` */
        cdl (model:CDL, o?:_options) : csn,

        for: {
            odata (model:csn, o?:_options) : csn
            sql (model:csn, o?:_options) : csn
        },
        to: {
            parsed:{
                csn (files:filename[], o?:_options) : Promise<csn>
                csn (model:CDL, o?:_options) : csn
            }
            xtended:{
                csn (files:filename[], o?:_options) : Promise<csn>
                csn (model:CDL, o?:_options) : csn
            }
            inferred:{
                csn (files:filename[], o?:_options) : Promise<csn>
                csn (model:CDL, o?:_options) : csn
            }
            csn (files:filename[], o?:_options) : Promise<csn>
            csn (model:CDL, o?:_options) : csn
            yml (model:csn, o?:_options) : YAML
            yaml (model:csn, o?:_options) : YAML
            json (model:csn, o?:_options) : JSON
            sql (model:csn, o?:_options) : SQL[]
            cdl (model:csn, o?:_options) : CDL | Iterable<[CDL,{file:filename}]>
            edm (model:csn, o?:_options|_odata_options) : EDM | string
            edmx (model:csn, o?:_options|_odata_options) : EDMX | Iterable<[EDMX,{file:filename}]>
            hdbcds (model:csn, o?:_options) : SQL | Iterable<[SQL,{file:filename}]>
            hdbtable (model:csn, o?:_options) : SQL | Iterable<[SQL,{file:filename}]>
        }

        /** Fluent API variant */
        (model: csn | CDL) : {
            for: {
                odata (o?:_options) : csn
                sql (o?:_options) : csn
            },
            to: {
                parsed:{ csn (o?:_options) : csn }
                xtended:{ csn (o?:_options) : csn }
                inferred:{ csn (o?:_options) : csn }
                csn (o?:_options) : csn
                yml (o?:_options) : YAML
                yaml (o?:_options) : YAML
                json (o?:_options) : JSON
                sql (o?:_options) : SQL[]
                cdl (o?:_options) : CDL | Iterable<[CDL,{file:filename}]>
                edm (o?:_options|_odata_options) : EDM | string
                edmx (o?:_options|_odata_options) : EDMX | Iterable<[EDMX,{file:filename}]>
                hdbcds (o?:_options) : SQL | Iterable<[SQL,{file:filename}]>
                hdbtable (o?:_options) : SQL | Iterable<[SQL,{file:filename}]>
            }
        }

        /** Async fluent variant reading from files */
        (files: filename[]) : {
            for: {
                odata (o?:_options) : Promise<csn>
                sql (o?:_options) : Promise<csn>
            },
            to: {
                parsed:{ csn (o?:_options) : Promise <csn> }
                xtended:{ csn (o?:_options) : Promise <csn> }
                inferred:{ csn (o?:_options) : Promise <csn> }
                csn (o?:_options) : Promise <csn>
                yml (o?:_options) : Promise <YAML>
                yaml (o?:_options) : Promise <YAML>
                json (o?:_options) : Promise <JSON>
                sql (o?:_options) : Promise <SQL[]>
                cdl (o?:_options) : Promise <CDL | Iterable<[CDL,{file:filename}]>>
                edm (o?:_options|_odata_options) : Promise <EDM | string>
                edmx (o?:_options|_odata_options) : Promise <EDMX | Iterable<[EDMX,{file:filename}]>>
                hdbcds (o?:_options) : Promise <SQL | Iterable<[SQL,{file:filename}]>>
                hdbtable (o?:_options) : Promise <SQL | Iterable<[SQL,{file:filename}]>>
            }
        }
    }

    /**
     * Loads and parses models from the specified files.
     * Uses `cds.resolve` to fetch the respective models.
     * Essentially a shortcut for `cds.compile.to.csn(files)`
     * @param {string} files - filenames of models or if folder containing models
     */
    get(files: '*' | filename | filename[], o?:_options) : Promise<csn>

    /**
     * Shortcut for `cds.get(files, 'inferred')`
     * @param {string} files - filenames of models or if folder containing models
     */
    load(files: '*' | filename | filename[], o?:_options) : Promise<csn>

    /**
	 * Emitted whenever a model is loaded using cds.load().
	 */
	on (event : 'loaded', listener : (model : csn) => void) : this


    /**
     * Resolves given file or module name(s) to an array of absolute file names.
     * Uses Node's `require.resolve` internally with the following additions:
     * - relative names are resolved relative to the current working directory instead of the current JavaScript module; hence, use __dirname if you want to find or load models relative to the current module.
     * - if no file extension is given, `.csn` and `.cds` will be appended in that order.
     * @param files - The file or module name(s) of a model or a folder containing models. Specify `'*'` to fetch moels from default locations, i.e. `[ 'db/', 'srv/', 'app/' ]`
     * @returns An array of absolute file names or `undefined` if none could be resolved.
     */
    resolve (files: '*' | filename | filename[]) : filename[] | undefined

    /**
     * Access to the configuration for Node.js runtime and tools.
     * The object is the effective result of configuration merged from various sources,
     * filtered through the currently active profiles, thus highly dependent on the current working
     * directory and process environment.
     */
    env : {
        build: object,
        hana: object,
        i18n: object,
        mtx: object,
        requires: object,
        folders: object,
        odata: object,
        query: object,
        sql: object
    }

}
