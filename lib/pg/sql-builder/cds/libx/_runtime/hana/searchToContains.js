/**
 * Computes a `CONTAINS` CQN expression for a search query.
 *
 * OData search string           | `CONTAINS` search string
 * ----------------------------- | ------------------------
 * `foo`                         | `"%foo%"`
 * `NOT foo`                     | `-"%foo%"` (Currently disabled -> BCP 2180256508)
 * `foo AND bar`                 | `"%foo%" "%bar%"`
 * `foo OR bar`                  | `"%foo%" OR "%bar%"`
 * `foo or bar`                  | `"%foo%" OR "%bar%"`
 * `" foo" OR " bar"`            | `"% foo%" OR "% bar%"`
 * ` foo`                        | `"% foo%"`
 * `foo bar`                     | `"%foo%" "%bar%"`
 *
 * **Some limitations of the `CONTAINS` predicate in SAP HANA:**
 * - The `-` (minus sign) search operator can not be placed directly after `OR`.
 * - Brackets are not supported as search operators.
 * - REVISIT: The `AND` operator in combination with the `OR` operator does not
 * always return the expected result.
 * - Search terms starting with whitespace after a `NOT` operator does not return
 * the expected result. For example: `-%" "foo%` .
 *
 * @param {array} cqnSearchPhrase
 * @param {import("../types/api").ColumnRefs} columns The columns to be searched
 * @returns {import("../types/api").searchContainsExp} The `CONTAINS` CQN expression
 */
const searchToContains = (cqnSearchPhrase, columns) => {
  // serialize CQN search phrase
  const searchString = cqnSearchPhrase.reduce((searchStringAccumulator, currentValue) => {
    // Multiple search terms separated by an space are automatically
    // interpreted as an AND operator. Therefore, it is not mandatory
    // to explicitly specify the it.
    if (currentValue === 'and') return (searchStringAccumulator += ' ')

    // the OR keyword is a reserved word and it is case-sensitive
    if (currentValue === 'or') return (searchStringAccumulator += ' OR ')

    // the - (minus sign) is used to exclude terms from the search
    if (currentValue === 'not') return (searchStringAccumulator += '-')

    // escape double quotation mark(s) with \\
    const searchTermEscaped = currentValue.val.replace(/"/g, '\\$&')

    // A search term enclosed with the wildcard character % (percentage sign)
    // is used to match zero or more characters. In SAP HANA, the % sign is
    // replaced with an asterisk (*), and a wildcard search is run.
    // The % sign also prevents ambiguity, as a search input might contain
    // an 'OR' (uppercase characters), causing semantics issues.
    return (searchStringAccumulator += `"%${searchTermEscaped}%"`)
  }, '')

  const expressionArgs = [{ list: columns }, { val: searchString }]

  // REVISIT: Mark the expression args with a `_$search` flag, as the `CONTAINS`
  // predicate is not fully supported in the CustomFunctionBuilder class.
  // The `_$search` property is enumerable: false (default), writable: false (default)
  Object.defineProperty(expressionArgs, '_$search', { value: true })

  const expression = {
    func: 'contains',
    args: expressionArgs
  }

  return expression
}

const isContainsPredicateSupported = query => {
  const cqnSearchPhrase = query.SELECT.search

  // REVISIT: In the future, to further optimize search queries, you might
  // want to remove the following condition(s).
  if (query._aggregated) return false

  // REVISIT: search terms starting with whitespace after a `NOT` operator does not
  // return the expected result on SAP HANA (BCP 2180256508). In addition, double
  // quotation marks after a `NOT` operator do not return the desired result.
  // if (cqnSearchPhrase[0] === 'not' && cqnSearchPhrase[1].val[0] === ' ') return false

  // so for now do not optimize for the `NOT` operator
  if (cqnSearchPhrase[0] === 'not') return false

  // The `AND` operator in combination with the `OR` operator does not
  // return the expected result
  const andOR = cqnSearchPhrase.includes('or') && cqnSearchPhrase.includes('and')
  if (andOR) return false

  // brackets are not supported as search operators in SAP HANA
  if (cqnSearchPhrase.some(searchXpr => searchXpr.xpr)) return false

  return true
}

module.exports = { searchToContains, isContainsPredicateSupported }
