// Shared type definitions for SQL Coach.
//
// This module is the canonical home for JSDoc @typedef blocks used across
// the codebase. Importing this module (even just for side effects) is enough
// to bring the typedefs into scope for tooling that reads JSDoc.
//
// Each typedef cites the requirement(s) it formalises so the contracts stay
// traceable to requirements.md / design.md.

// ---------------------------------------------------------------------------
// Settings & LLM configuration (R1, R2, R3)
// ---------------------------------------------------------------------------

/**
 * User-configured LLM credentials. Persisted to localStorage as
 * `sqlcoach.settings.v1`. Never sent anywhere except to `apiBaseUrl`.
 * @typedef {Object} LlmConfig
 * @property {string} apiBaseUrl  // R1.1 — e.g. "https://api.openai.com/v1"
 * @property {string} apiKey      // R1.1 / R2.1 — masked in UI by default (R1.7)
 * @property {string} modelName   // R1.1 — e.g. "gpt-4o-mini"
 */

// ---------------------------------------------------------------------------
// Theme & difficulty (R6, R8)
// ---------------------------------------------------------------------------

/**
 * Business scenario picker value.
 * @typedef {'ecommerce' | 'campus' | 'library' | 'hospital' | 'custom'} Theme
 *  // R6.1 — five fixed options
 */

/**
 * Difficulty level. L1 basic, L2 intermediate, L3 advanced, L4 synthesis.
 * @typedef {'L1' | 'L2' | 'L3' | 'L4'} DifficultyLevel
 *  // R8.1 / R8.4 / R8.5
 */

// ---------------------------------------------------------------------------
// Question topics (R8.2 / R9 — see src/data/topics.js)
// ---------------------------------------------------------------------------

/**
 * The 16-topic taxonomy. Mirrors `TOPICS` in src/data/topics.js exactly.
 * @typedef {(
 *   | 'single_table_select' | 'where_filter' | 'order_by_limit'
 *   | 'aggregate_function'
 *   | 'join_inner' | 'join_outer' | 'join_self'
 *   | 'group_by_having'
 *   | 'subquery' | 'correlated_subquery'
 *   | 'exists_not_exists' | 'universal_quantifier'
 *   | 'set_operation_union' | 'set_operation_intersect' | 'set_operation_except'
 *   | 'set_vs_join_compare'
 * )} QuestionTopic
 *  // R8.2 — full coverage of the 16 topics.
 */

// ---------------------------------------------------------------------------
// Schema description (R6.2 / R6.8)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ColumnSchema
 * @property {string}  name      // R5.2 — English identifier
 * @property {string}  type      // VARCHAR(N) | INT | DECIMAL(P,S) | DATE | DATETIME | TEXT | BOOLEAN
 * @property {boolean} nullable
 * @property {string}  [default] // raw SQL literal, omitted when none
 */

/**
 * @typedef {Object} ForeignKey
 * @property {string[]} columns      // local column names in the FK
 * @property {string}   refTable     // referenced table
 * @property {string[]} refColumns   // referenced columns (same arity as `columns`)
 */

/**
 * @typedef {Object} TableSchema
 * @property {string}         name         // R5.2 — English identifier
 * @property {ColumnSchema[]} columns
 * @property {string[]}       primaryKey   // empty array if none
 * @property {ForeignKey[]}   foreignKeys  // R6.2 — at least one across the schema
 */

// ---------------------------------------------------------------------------
// Result sets, sandbox errors (R10, R12)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ResultSet
 * @property {string[]}  columns                // column names (R12.4 — names are advisory)
 * @property {Array<Array<any>>} rows           // 2-D array of normalised SQL values
 * @property {boolean}   [truncated]            // R10.5 — true when row count hit the 10000 cap
 */

/**
 * Sandbox-level execution error. Distinct from `ClassifiedLlmError` (network).
 * `kind` is a runtime string union so JS consumers can switch on it.
 * @typedef {Object} SqlError
 * @property {('syntax'|'runtime'|'timeout'|'rejected_by_safety'|'row_limit_exceeded')} kind
 *  // R10.4 / R11.1 / R11.2 / R10.2 / R10.5
 * @property {string} message
 */

// ---------------------------------------------------------------------------
// Question (R5.2 / R5.3 / R8.3 / R19.1 / R9.6)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Question
 * @property {string}            id             // ulid; persisted under sqlcoach.questions.v1
 * @property {number}            createdAt      // epoch ms
 * @property {DifficultyLevel}   difficulty     // R8.1
 * @property {QuestionTopic[]}   topics         // R8.4 / R8.5 post-validated
 * @property {string}            prompt         // R5.3 — Chinese prompt text
 * @property {string}            refSql         // R5.3 — English SQL, MySQL-compatible subset (R7)
 * @property {string}            [refSqlAlt]    // R9.6 — second reference for set_vs_join_compare
 * @property {ResultSet}         expectedResult // R8.3 — produced by executing refSql in sandbox
 * @property {boolean}           isOrdered      // R19.1 / R19.2 / R19.3
 * @property {string}            schemaRef      // foreign key to the persisted schema record
 */

// ---------------------------------------------------------------------------
// Judge verdict (R12)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} JudgeDiffSummary
 * @property {number} extraRows      // rows in user result that aren't in reference
 * @property {number} missingRows    // rows in reference that aren't in user result
 * @property {{ rowIndex: number, expected: any[], actual: any[] }} [firstMismatch]
 *  // populated only in 'sequence' mode (R12.6)
 */

/**
 * @typedef {Object} JudgeVerdict
 * @property {boolean}          correct       // R12.5 / R12.6
 * @property {JudgeDiffSummary} [diffSummary] // R12.6 — present when correct === false
 * @property {SqlError}         [sandboxError] // R12.7 — execution failed before compare ran
 */

// ---------------------------------------------------------------------------
// Tutor (R13)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TutorMessage
 * @property {('user' | 'assistant')} role
 * @property {string} content
 * @property {number} at     // epoch ms — used by Property 11 sort (R15.4)
 */

// ---------------------------------------------------------------------------
// Answer record & session (R15.1 / R15.2 / R15.3)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} UserResultSummary
 * @property {number}   rowCount
 * @property {string[]} columns
 * @property {boolean}  truncated
 */

/**
 * @typedef {Object} UserResultError
 * @property {string} error  // human-readable; full SqlError lives in verdict.sandboxError
 */

/**
 * One persisted attempt at a question. Stored under `sqlcoach.answers.v1`.
 * @typedef {Object} AnswerRecord
 * @property {string}         id                  // ulid
 * @property {string}         questionId          // FK → Question.id
 * @property {string}         sessionId           // FK → Session.id
 * @property {number}         submittedAt         // R15.4 — sort key
 * @property {string}         userSql             // R15.2
 * @property {string}         [userSqlAlt]        // R9.6 / R12.8 — second submission for set_vs_join_compare
 * @property {(UserResultSummary | UserResultError)} userResultSummary
 *  // raw rows are never persisted; only a summary or an error string (R15.6 size budget)
 * @property {JudgeVerdict}   verdict             // R12 / R15.2
 * @property {TutorMessage[]} tutorThread         // R13.3 / R15.2 — appended turn by turn
 */

/**
 * @typedef {Object} Session
 * @property {string}   id            // ulid
 * @property {number}   startedAt     // epoch ms
 * @property {number}   [endedAt]
 * @property {string}   schemaRef     // FK → persisted schema id
 * @property {string[]} answerIds     // FKs → AnswerRecord.id (in submission order)
 */

// ---------------------------------------------------------------------------
// LLM client errors (R3 / R14 — see Property 4)
// ---------------------------------------------------------------------------

/**
 * Tagged union returned by `classifyError`. Discriminator is `kind`.
 * Priority for `displayedError` (R14.6):
 *   unauthorized > rate_limited > server_error > timeout > cors > network > bad_response
 *
 * @typedef {(
 *   | { kind: 'unauthorized',  status: number, message: string }                          // R14.1
 *   | { kind: 'rate_limited',  status: 429,    retryAfterMs?: number, message: string }   // R14.2
 *   | { kind: 'server_error',  status: number, message: string }                          // R14.3
 *   | { kind: 'timeout',                       message: string }                          // R14.4 / R3.3
 *   | { kind: 'cors',                          message: string }                          // R3.1
 *   | { kind: 'network',                       message: string }                          // generic fetch failure
 *   | { kind: 'bad_response',                  message: string }                          // R14.6 / non-JSON response
 * )} ClassifiedLlmError
 */

// ---------------------------------------------------------------------------
// Orchestrator state (R17.3)
// ---------------------------------------------------------------------------

/**
 * Failed-agent name for state.failedAgent (R17.4 / R14.5).
 * @typedef {('SchemaGen'|'QuestionGen'|'Judge'|'Tutor'|'Reporter')} FailedAgentName
 */

/**
 * Global LangGraph state. Each node is `(state) => Partial<AgentState>` and
 * the orchestrator merges the partial back via spread (R17.3 — structured
 * objects, no shared mutable references). Failure paths only ADD
 * `failedAgent`/`error` and never strip `question`/`userSql` (R14.5).
 *
 * @typedef {Object} AgentState
 * @property {LlmConfig}            llm
 *
 * // Schema phase
 * @property {Theme}                theme
 * @property {string}              [themeDescription]   // R6.6 — only when theme === 'custom'
 * @property {string}              [ddl]
 * @property {string}              [seedSql]
 * @property {TableSchema[]}       [schemaSummary]      // R6.8
 *
 * // Question phase
 * @property {Question}            [question]
 *
 * // Answer phase
 * @property {string}              [userSql]
 * @property {string}              [userSqlAlt]         // R9.6 / R12.8
 * @property {(ResultSet|SqlError)} [userResult]
 *
 * // Judge phase
 * @property {JudgeVerdict}        [verdict]
 *
 * // Tutor phase
 * @property {TutorMessage[]}      [tutorThread]        // R13.3 / R13.5
 *
 * // Session metadata
 * @property {string}               sessionId
 * @property {AnswerRecord[]}       history             // R15.1 / R15.2
 *
 * // Error propagation (R17.4)
 * @property {FailedAgentName}     [failedAgent]
 * @property {(ClassifiedLlmError|string)} [error]
 */

// ---------------------------------------------------------------------------
// Runtime constants
// ---------------------------------------------------------------------------

/**
 * Ordered list of difficulty levels. Use this rather than re-declaring an
 * array elsewhere so UI pickers and validators stay in sync.
 * @type {readonly DifficultyLevel[]}
 */
export const DIFFICULTY_LEVELS = Object.freeze(['L1', 'L2', 'L3', 'L4']);

/**
 * Statement kinds recognised by the parser (R18.1) and consumed by the
 * safety filter (R11). 'OTHER' is the catch-all for anything the parser
 * cannot classify; the sandbox is still allowed to attempt execution (R18.5).
 * @type {readonly ('SELECT'|'INSERT'|'UPDATE'|'DELETE'|'DDL'|'OTHER')[]}
 */
export const STATEMENT_KINDS = Object.freeze([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'DDL', 'OTHER',
]);

// Marker export so `import './types.js'` has an observable side effect even
// when the module is imported solely for its typedefs.
export const TYPES_MODULE = '@sql-coach/types';
