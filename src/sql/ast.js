// Lightweight AST shape used by parser/formatter/safety filter.
// We do not build a full expression tree — only the structural flags listed in design.md.

/**
 * @typedef {'SELECT'|'INSERT'|'UPDATE'|'DELETE'|'REPLACE'|'DDL'|'OTHER'} StmtKind
 */

/**
 * @typedef {object} SqlAst
 * @property {StmtKind} kind
 * @property {boolean} hasOrderBy
 * @property {boolean} hasGroupBy
 * @property {boolean} hasHaving
 * @property {boolean} hasJoin
 * @property {boolean} hasSubquery
 * @property {boolean} hasExists
 * @property {boolean} hasNotExists  True iff a NOT EXISTS pair appears anywhere.
 * @property {('UNION'|'INTERSECT'|'EXCEPT'|null)} hasSetOp
 * @property {Array} tokens
 */

/**
 * Return a fresh AST shell with all flags defaulted.
 * @returns {SqlAst}
 */
export function emptyAst() {
  return {
    kind: 'OTHER',
    hasOrderBy: false,
    hasGroupBy: false,
    hasHaving: false,
    hasJoin: false,
    hasSubquery: false,
    hasExists: false,
    hasNotExists: false,
    hasSetOp: null,
    tokens: [],
  };
}
