'use strict';

const { createOptionProcessor } = require('./base/optionProcessorHelper');

// This option processor is used both by the command line parser (to translate cmd line options
// into an options object) and by the API functions (to verify options)
const optionProcessor = createOptionProcessor();

// General options
// FIXME: Since they mainly affect the compiler, they could also live near main.compile
optionProcessor
  .option('-h, --help')
  .option('-v, --version')
  .option('-w, --warning <level>', ['0', '1', '2', '3'])
  .option('    --show-message-id')
  .option('    --no-message-context')
  .option('    --color <mode>', ['auto', 'always', 'never'])
  .option('-o, --out <dir>')
  .option('    --cds-home <dir>')
  .option('    --lint-mode')
  .option('    --fuzzy-csn-error')
  .option('    --trace-parser')
  .option('    --trace-parser-amb')
  .option('    --trace-fs')
  .option('-E, --enrich-csn')
  .option('-R, --raw-output <name>')
  .option('    --internal-msg')
  .option('    --beta-mode')
  .option('    --beta <list>')
  .option('    --constraints-not-validated')
  .option('    --constraints-not-enforced')
  .option('    --deprecated <list>')
  .option('    --hana-flavor')
  .option('    --direct-backend')
  .option('    --parse-only')
  .option('    --fallback-parser <type>', ['cdl', 'csn', 'csn!'])
  .option('    --test-mode')
  .option('    --test-sort-csn')
  .option('    --doc-comment')
  .option('    --add-texts-language-assoc')
  .option('    --localized-without-coalesce')
  .option('    --defaultStringLength <length>')
  .option('    --no-recompile')
  .positionalArgument('<files...>')
  .help(`
  Usage: cdsc <command> [options] <files...>

  Compile a CDS model given from input <files...>s and generate results according to <command>.
  Input files may be CDS source files (.cds), CSN model files (.json) or pre-processed ODATA
  annotation XML files (.xml). Output depends on <command>, see below. If no command is given,
  "toCsn" is used by default.

  Use "cdsc <command> --help" to get more detailed help for each command.

  General options
   -h, --help               Show this help text
   -v, --version            Display version number and exit
   -w, --warning <level>    Show messages up to <level>
                              0: Error
                              1: Warnings
                              2: (default) Info
                              3: Debug
       --show-message-id    Show message ID in error, warning and info messages
       --no-message-context Print messages as single lines without code context (useful for
                            redirecting output to other processes). Default is to print human
                            readable text similar to Rust's compiler with a code excerpt.
       --color <mode>       Use colors for warnings. Modes are:
                              auto: (default) Detect color support of the tty.
                              always:
                              never:
   -o, --out <dir>          Place generated files in directory <dir>, default is "-" for <stdout>
       --cds-home <dir>     When set, modules starting with '@sap/cds/' are searched in <dir>
       --lint-mode          Generate nothing, just produce messages if any (for use by editors)
       --fuzzy-csn-error    Report free-style CSN properties as errors
       --                   Indicate the end of options (helpful if source names start with "-")

  Type options
       --defaultStringLength <length> Default 'length' for 'cds.String'

  Diagnostic options
       --trace-parser       Trace parser
       --trace-parser-amb   Trace parser ambiguities
       --trace-fs           Trace file system access caused by "using from"

  Internal options (for testing only, may be changed/removed at any time)
   -E, --enrich-csn         Show non-enumerable CSN properties and locations of references
   -R, --raw-output <name>  Write XSN for definition "name" and error output to <stdout>,
                            with name = "+", write complete XSN, long!
       --internal-msg       Write raw messages with call stack to <stdout>/<stderr>
       --beta-mode          Enable all unsupported, incomplete (beta) features
       --beta <list>        Comma separated list of unsupported, incomplete (beta) features to use.
                            Valid values are:
                              foreignKeyConstraints
                              addTextsLanguageAssoc
                              hanaAssocRealCardinality
                              mapAssocToJoinCardinality
                              ignoreAssocPublishingInUnion
                              windowFunctions
       --constraints-not-enforced  If this option is supplied, referential constraints are NOT ENFORCED
                                   This option is also applied to result of "cdsc manageConstraints"
       --constraints-not-validated If this option is supplied, referential constraints are NOT VALIDATED
                                   This option is also applied to result of "cdsc manageConstraints"
       --deprecated <list>  Comma separated list of deprecated options.
                            Valid values are:
                              noElementsExpansion
                              v1KeysForTemporal
                              parensAsStrings
                              projectionAsQuery
                              renderVirtualElements
                              unmanagedUpInComponent
                              createLocalizedViews
       --hana-flavor        Compile with backward compatibility for HANA CDS (incomplete)
       --parse-only         Stop compilation after parsing and write result to <stdout>
       --fallback-parser <type>  If the language cannot be deduced by the file's extensions, use this
                                 parser as a fallback. Valid values are:
                                   cdl  : Use CDL parser
                                   csn  : Use CSN parser
                                   csn! : Use CSN parser even with extension cds, cdl, hdbcds and hdbdd
       --direct-backend     Do not compile the given CSN but directly pass it to the backend.
                            Can only be used with certain new CSN based backends. Combination with
                            other flags is limited, e.g. --test-mode will not run a consistency check.
                            No recompilation is triggered in case of errors. cdsc will dump.
       --test-mode          Produce extra-stable output for automated tests (normalize filenames
                            in errors, sort properties in CSN, omit version in CSN)
       --test-sort-csn      Sort the generated CSN by definitions.  This impacts the order of EDMX,
                            OData CSN, CDL order and more.  When --test-mode is enabled, this
                            option is implicitly enabled as well.
       --doc-comment        Preserve /** */ comments at annotation positions as doc property in CSN
       --add-texts-language-assoc   In generated texts entities, add association "language"
                                    to "sap.common.Languages" if it exists
       --localized-without-coalesce Omit coalesce in localized convenience views
       --no-recompile       Don't recompile in case of internal errors
  
  Commands
    H, toHana [options] <files...>              Generate HANA CDS source files
    O, toOdata [options] <files...>             Generate ODATA metadata and annotations
    C, toCdl <files...>                         Generate CDS source files
    Q, toSql [options] <files...>               Generate SQL DDL statements
       toCsn [options] <files...>               (default) Generate original model as CSN
       parseCdl [options] <file>                Generate a CSN that is close to the CDL source.
       explain <message-id>                     Explain a compiler message.
       toRename [options] <files...>            (internal) Generate SQL DDL rename statements
       manageConstraints [options] <files...>    (internal) Generate ALTER TABLE statements to
                                                           add / modify referential constraints.
`);

// ----------- toHana -----------
optionProcessor.command('H, toHana')
  .option('-h, --help')
  .option('-n, --names <style>', ['plain', 'quoted', 'hdbcds'])
  .option('    --render-virtual')
  .option('    --joinfk')
  .option('    --skip-db-constraints')
  .option('-u, --user <user>')
  .option('-s, --src')
  .option('-c, --csn')
  .help(`
  Usage: cdsc toHana [options] <files...>

  Generate HANA CDS source files, or CSN.

  Options
   -h, --help                 Show this help text
   -n, --names <style>        Naming style for generated entity and element names:
                                plain  : (default) Produce HANA entity and element names in
                                         uppercase and flattened with underscores. Do not generate
                                         structured types.
                                quoted : Produce HANA entity and element names in original case as
                                         in CDL. Keep nested contexts (resulting in entity names
                                         with dots), but flatten element names with underscores.
                                         Generate structured types, too.
                                hdbcds : Produce HANA entity end element names as HANA CDS would
                                         generate them from the same CDS source (like "quoted", but
                                         using element names with dots).
       --render-virtual       Render virtual elements in views and draft tables
       --joinfk               Create JOINs for foreign key accesses
       --skip-db-constraints  Do not render referential constraints for associations
   -u, --user <user>          Value for the "$user" variable
   -s, --src                  (default) Generate HANA CDS source files "<artifact>.hdbcds"
   -c, --csn                  Generate "hana_csn.json" with HANA-preprocessed model
`);

optionProcessor.command('O, toOdata')
  .option('-h, --help')
  .option('-v, --version <version>', ['v2', 'v4', 'v4x'])
  .option('-x, --xml')
  .option('-j, --json')
  .option('    --odata-containment')
  .option('    --odata-proxies')
  .option('    --odata-x-service-refs')
  .option('    --odata-foreign-keys')
  .option('    --odata-v2-partial-constr')
  .option('-c, --csn')
  .option('-f, --odata-format <format>', ['flat', 'structured'])
  .option('-n, --names <style>', ['plain', 'quoted', 'hdbcds'])
  .help(`
  Usage: cdsc toOdata [options] <files...>

  Generate ODATA metadata and annotations, or CSN.

  Options
   -h, --help               Show this help text
   -v, --version <version>  ODATA version
                              v2: ODATA V2
                              v4: (default) ODATA V4
                              v4x: { version: 'v4', odataContainment:true, format:'structured' }
   -x, --xml                (default) Generate XML output (separate or combined)
   -j, --json               Generate JSON output as "<svc>.json" (not available for v2)
   -c, --csn                Generate "odata_csn.json" with ODATA-preprocessed model
   -f, --odata-format <format>  Set the format of the identifier rendering
                                  flat       : (default) Flat type and property names
                                  structured : (V4 only) Render structured metadata
       --odata-containment         Generate Containment Navigation Properties for compositions (V4 only)
       --odata-proxies             Generate Proxies for out-of-service navigation targets (V4 only).
       --odata-x-service-refs      Generate schema references (V4 only).
       --odata-foreign-keys        Render foreign keys in structured format (V4 only)
       --odata-v2-partial-constr   Render referential constraints also for partial principal key tuple
                                   (Not spec compliant and V2 only)
   -n, --names <style>      Annotate artifacts and elements with "@cds.persistence.name", which is
                            the corresponding database name (see "--names" for "toHana or "toSql")
                              plain   : (default) Names in uppercase and flattened with underscores
                              quoted  : Names in original case as in CDL. Entity names with dots,
                                        but element names flattened with underscores
                              hdbcds  : Names as HANA CDS would generate them from the same CDS
                                        source (like "quoted", but using element names with dots)
`);

optionProcessor.command('C, toCdl')
  .option('-h, --help')
  .help(`
  Usage: cdsc toCdl [options] <files...>

  Generate CDS source files "<artifact>.cds".

  Options
   -h, --help      Show this help text
`);

optionProcessor.command('Q, toSql')
  .option('-h, --help')
  .option('-n, --names <style>', ['plain', 'quoted', 'hdbcds'])
  .option('    --render-virtual')
  .option('    --joinfk')
  .option('    --skip-db-constraints')
  .option('-d, --dialect <dialect>', ['hana', 'sqlite', 'plain'])
  .option('-u, --user <user>')
  .option('-l, --locale <locale>')
  .option('-s, --src <style>', ['sql', 'hdi'])
  .option('-c, --csn')
  .help(`
  Usage: cdsc toSql [options] <files...>

  Generate SQL DDL statements to create tables and views, or CSN

  Options
   -h, --help                 Show this help text
   -n, --names <style>        Naming style for generated entity and element names:
                                plain  : (default) Produce SQL table and view names in
                                         flattened with underscores format (no quotes required)
                                quoted : Produce SQL table and view names in original case as in
                                         CDL (with dots), but flatten element names with
                                         underscores (requires quotes). Can only be used in
                                         combination with "hana" dialect.
                                hdbcds : Produce SQL table, view and column names as HANA CDS would
                                         generate them from the same CDS source (like "quoted", but
                                         using element names with dots). Can only be used in
                                         combination with "hana" dialect.
       --render-virtual       Render virtual elements in views and draft tables
       --joinfk               Create JOINs for foreign key accesses
       --skip-db-constraints  Do not render referential constraints for associations
   -d, --dialect <dialect>    SQL dialect to be generated:
                                plain  : (default) Common SQL - no assumptions about DB restrictions
                                hana   : SQL with HANA specific language features
                                sqlite : Common SQL for sqlite
   -u, --user <user>          Value for the "$user" variable
   -l, --locale <locale>      Value for the "$user.locale" variable in "sqlite"/"plain" dialect
   -s, --src <style>          Generate SQL source files as <artifact>.<suffix>
                                sql    : (default) <suffix> is "sql"
                                hdi    : HANA Deployment Infrastructure source files, <suffix> is
                                         the HDI plugin name. Can only be used in combination with
                                         "hana" dialect.
   -c, --csn                  Generate "sql_csn.json" with SQL-preprocessed model
`);

optionProcessor.command('toRename')
  .option('-h, --help')
  .option('-n, --names <style>', ['quoted', 'hdbcds'])
  .help(`
  Usage: cdsc toRename [options] <files...>

  (internal, subject to change): Generate SQL stored procedure containing DDL statements to
  "storedProcedure.sql" that allows to rename existing tables and their columns so that they
  match the result of "toHana" or "toSql" with the "--names plain" option.

  Options
   -h, --help           Display this help text
   -n, --names <style>  Assume existing tables were generated with "--names <style>":
                          quoted   : Assume existing SQL tables and views were named in original
                                     case as in CDL (with dots), but column names were flattened
                                     with underscores (e.g. resulting from "toHana --names quoted")
                          hdbcds   : (default) Assume existing SQL tables, views and columns were
                                     generated by HANA CDS from the same CDS source (or resulting
                                     from "toHana --names hdbcds")
`);

optionProcessor.command('manageConstraints')
  .option('-h, --help')
  .option('-n, --names <style>', ['plain', 'quoted', 'hdbcds'])
  .option('-s, --src <style>', ['sql', 'hdi'])
  .option('    --drop')
  .option('    --alter')
  .option('    --violations')
  .help(`
  Usage: cdsc manageConstraints [options] <files...>

  (internal, subject to change): Generate SQL DDL ALTER TABLE statements to add / modify
  referential constraints on an existing model.
  Combine with options "--constraints-not-enforced" and "--constraint-not-validated"
  to switch off foreign key constraint enforcement / validation.

  Options
   -h, --help             Display this help text
   -n, --names <style>    Assume existing tables were generated with "--names <style>":
                            plain    : (default) Assume SQL tables were flattened and dots were
                                        replaced by underscores
                            quoted   : Assume existing SQL tables and views were named in original
                                       case as in CDL (with dots), but column names were flattened
                                       with underscores
                            hdbcds   : Assume existing SQL tables and column names were produced
                                       as HANA CDS would have generated them from the same CDS source
                                       (like "quoted", but using element names with dots).
  -s, --src <style>       Generate SQL source files as <artifact>.<suffix>
                            sql   : (default) <suffix> is "sql"
                            hdi   : constraint will be generated with <suffix> "hdbconstraint"
      --drop              Generate "ALTER TABLE <table> DROP CONSTRAINT <constraint>" statements
      --alter             Generate "ALTER TABLE <table> ALTER CONSTRAINT <constraint>" statements
      --violations        Generates SELECT statements which can be used to list
                          referential integrity violations on the existing data
`);

optionProcessor.command('toCsn')
  .option('-h, --help')
  .option('-f, --flavor <flavor>', ['client', 'gensrc', 'universal'])
  .option('    --with-localized')
  .help(`
  Usage: cdsc toCsn [options] <files...>

  Generate original model as CSN to "csn.json"

  Options
   -h, --help             Show this help text
   -f, --flavor <flavor>  Generate CSN in one of two flavors:
                            client  : (default) Standard CSN consumable by clients and backends
                            gensrc  : CSN specifically for use as a source, e.g. for
                                      combination with additional "extend" or "annotate"
                                      statements, but not suitable for consumption by clients or
                                      backends
                            universal: in development (BETA)

  Internal options (for testing only, may be changed/removed at any time)
       --with-localized   Add localized convenience views to the CSN output.
`);

optionProcessor.command('parseCdl')
  .option('-h, --help')
  .help(`
  Usage: cdsc parseCdl [options] <file>

  Only parse the CDL and output a CSN that is close to the source. Does not
  resolve imports, apply extensions or expand any queries.

  Options
   -h, --help             Show this help text
`);

optionProcessor.command('explain')
  .option('-h, --help')
  .help(`
  Usage: cdsc explain [options] <message-id>

  Explain the compiler message that has the given message-id.
  The explanation contains a faulty example and a solution.

  Options
   -h, --help             Show this help text
`);

module.exports = {
  optionProcessor
};
