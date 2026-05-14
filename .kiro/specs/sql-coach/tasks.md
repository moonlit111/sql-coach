# Implementation Plan: SQL Coach

## Overview

Implementation follows a strict test-first discipline: every Correctness Property and every core pure module has its property-based test written **before** the implementation. The build order moves bottom-up — foundation pure modules first (persistence, SQL parser, judge, safety filter, error classifier), then the sandbox (with Web Worker for real 5s interruptibility), the LLM client, the Settings module, the five Agent nodes with their post-condition validators, the LangGraph orchestrator, the UI views, and finally end-to-end integration plus GitHub Pages deployment.

**Implementation language**: JavaScript (ESM), per Requirement 4.1 (no build step). All vendor dependencies load via CDN through an `<script type="importmap">` block (R4.3).

**Test stack** (decided, can be revisited later): Vitest + fast-check + `@fast-check/vitest`, with MSW for mock LLM responses. The sandbox tests use real sql.js (not mocked).

**Open design decisions defaulted in this plan** (call out and revisit if needed):

| # | Decision | Default applied | Adjust by |
|---|---|---|---|
| D-A | `vendor/` offline mirror | **Not in v1** — CDN only. A post-MVP task (19.1) tracks mirroring. | Move 19.1 into v1 if GitHub Pages must work fully offline. |
| D-B | Web Worker sandbox | **Included in v1** — required to make the 5s timeout (R10.2 / R11.3) a real interruption rather than a soft warning. | If too costly, drop to soft-timeout and document the regression. |
| D-C | PBT framework | **Vitest + fast-check + @fast-check/vitest + MSW**, real sql.js. | Change in 1.2 if a different runner is preferred. |
| D-D | `set_vs_join_compare` UI shape | **Dual textarea side-by-side** (single screen, both visible). | Change in 15.9 if tab-switch UX is preferred. |

**Conventions**:

- Property test files carry a header tag: `// Feature: sql-coach, Property {n}: {summary}` linking back to `design.md` Property {n}.
- All `fast-check` properties use `numRuns: 100` minimum (the library default), bumped per-property where the input space justifies more.
- Sub-tasks postfixed with `*` are test sub-tasks (per workflow convention) — they may be skipped for a fast MVP but are recommended.
- Sub-tasks prefixed with `[OPT]` are v1-optional features (Reporter agent and Markdown report export); they can be deferred without blocking the core loop.
- Every task references the relevant Requirement IDs (e.g. `R10.2`) and, where applicable, the Correctness Property number from `design.md`.

## Tasks

- [x] 1. Project bootstrap and tooling
  - [x] 1.1 Create the repo skeleton
    - Create `index.html`, `styles/main.css`, and the `src/` tree exactly as laid out in `design.md` → "File structure" (`src/ui`, `src/orchestrator/{nodes,prompts}`, `src/sandbox`, `src/sql`, `src/judge`, `src/llm`, `src/persist`, `src/i18n`, `src/data`).
    - Add an `<script type="importmap">` block in `index.html` mapping `langgraph` → `https://esm.sh/@langchain/langgraph@<pinned>` and `sql.js` → `https://cdn.jsdelivr.net/npm/sql.js@<pinned>`. No bundler config files.
    - Add a top-level `module` `<script>` that imports `./src/main.js`.
    - _Requirements: R4.1, R4.2, R4.3_

  - [x] 1.2 Set up the test toolchain
    - Add `package.json` with `devDependencies` only: `vitest`, `fast-check`, `@fast-check/vitest`, `msw`, `@testing-library/dom`, `sql.js` (pinned to the same version as the CDN). Production code never imports from `node_modules`.
    - Add `vitest.config.js` enabling ESM and a `tests/` directory convention.
    - Document in the README that `npm test` runs the suite but `npm` is **not** required to run the app — only to run tests (R4.1 still holds for production).
    - _Requirements: R4.1_

  - [x] 1.3 Create shared type definitions and static data
    - Add `src/i18n/zh.js` with the Chinese UI copy strings.
    - Add `src/data/topics.js` with the 16 `Question_Topic` entries and `minLevel` per the design's taxonomy table.
    - Add JSDoc `@typedef` blocks (in a `src/types.js` module re-exported as needed) for `LlmConfig`, `TableSchema`, `Question`, `AnswerRecord`, `ResultSet`, `JudgeVerdict`, `ClassifiedLlmError`, `AgentState`, `TutorMessage`, `Session`.
    - _Requirements: R5.1, R8.2, R17.3_

- [x] 2. Persistence layer (foundation, no LLM)
  - [ ]* 2.1 Write property test for credential round-trip and clear
    - **Property 3: Credential persistence round-trip and clear**
    - **Validates: Requirements R1.2, R2.1, R2.3, R15.5**
    - File: `tests/persist/store.property.test.js`. Uses real `localStorage` (jsdom). Generates arbitrary `LlmConfig` triples and asserts `load(save(cfg)) === cfg` field-wise; after `clear()` `load() === null` and the raw localStorage string contains no `apiKey` substring.

  - [x] 2.2 Implement `src/persist/store.js`
    - Implement `Store` interface from `design.md`: `get`, `set` (returns `{ ok, quotaExceeded? }`), `remove`, `exportAll`, `importAll`. Probe `localStorage` on init and fall back to an in-memory `Map` adapter when access throws (R2.5).
    - On `QuotaExceededError`, return `{ ok: false, quotaExceeded: true }` (R15.6, Property 12) — never throw past the caller.
    - _Requirements: R2.1, R2.5, R15.1, R15.2, R15.6_

  - [x] 2.3 Implement `src/persist/schema.js` and `src/persist/migrate.js`
    - Export the `PersistKey` constants (`sqlcoach.settings.v1`, `sqlcoach.schema.v1`, `sqlcoach.questions.v1`, `sqlcoach.answers.v1`, `sqlcoach.sessions.v1`, `sqlcoach.meta.schemaVersion`).
    - `migrate.js` exposes a no-op `migrate(currentVersion)` for v1 with the structure ready for future bumps.
    - _Requirements: R15.1, R15.2, R15.3_

  - [ ]* 2.4 Write unit test for `localStorage` disabled fallback
    - Stub `window.localStorage` to throw on `setItem` and assert the in-memory adapter is used and a banner-trigger flag is exposed.
    - _Requirements: R2.5_

- [x] 3. SQL tokenizer, parser, and formatter
  - [ ]* 3.1 Write property test for parse–format–parse round-trip
    - **Property 1: SQL parse-format-parse round-trip consistency**
    - **Validates: Requirements R18.1, R18.2, R18.4**
    - File: `tests/sql/parser.property.test.js`. Build a fast-check arbitrary that generates valid MySQL-compatible-subset SELECT statements (with optional `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`, `JOIN`, subqueries, `EXISTS`, set ops). Assert that `parse(format(parse(s)))` yields an AST equal in all semantic flags (`kind`, `hasOrderBy`, `hasGroupBy`, `hasHaving`, `hasJoin`, `hasSubquery`, `hasExists`, `hasSetOp`) to `parse(s)`.

  - [x] 3.2 Implement `src/sql/tokenizer.js`
    - Tokenize into `keyword | identifier | number | string | operator | punctuation | whitespace | comment`. Strip string literals and `--` / `/* */` comments from the stream consumers will pass to the safety filter (R11 robustness).
    - _Requirements: R18.1_

  - [x] 3.3 Implement `src/sql/parser.js` and `src/sql/ast.js`
    - Top-down scan of the token stream that classifies the leading keyword into `StmtKind` and sets boolean flags by lookahead (`ORDER BY`, `GROUP BY`, `HAVING`, any `JOIN`, parenthesized `SELECT`, `EXISTS`, `UNION`/`INTERSECT`/`EXCEPT`).
    - Return `{ error }` when the leading token is unrecognized; never throw.
    - _Requirements: R18.1, R18.5_

  - [x] 3.4 Implement `src/sql/formatter.js`
    - Token-stream pretty-printer: top-level clauses (`SELECT`, `FROM`, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`) start at column 0; nested subqueries indent by 2 spaces; commas wrap with hanging indent; preserve original identifier casing.
    - _Requirements: R18.2, R18.3_

  - [ ]* 3.5 Write unit test for parser failure passthrough
    - Garbage input returns `{ error }`; the sandbox layer must still be allowed to attempt execution (R18.5).
    - _Requirements: R18.5_

- [x] 4. Judge engine (compare, normalize, diff)
  - [ ]* 4.1 Write property test for result-set equivalence
    - **Property 7: Result-set equivalence — symmetry, reflexivity, mode correctness**
    - **Validates: Requirements R12.1, R12.2, R12.3, R12.4, R12.5, R12.6, R19.4**
    - File: `tests/judge/compare.property.test.js`. Generate result sets and a permutation `π`, plus a column-name renaming `ρ`. Assert: `compare(ρ(r), r, *).correct === true`; `compare(π(r), r, 'multiset').correct === true`; for `|r| ≥ 2` and non-identity `π`, `compare(π(r), r, 'sequence').correct === false`; symmetry of `correct`; non-empty `diffSummary` when not equivalent.

  - [x] 4.2 Implement `src/judge/normalize.js`
    - Numeric coercion (`12 == 12.0`), strict `null` vs `''`, BLOB → base64. Exposed as `normalizeRow(row, columnTypes?)`.
    - _Requirements: R12.1, R12.4_

  - [x] 4.3 Implement `src/judge/compare.js`
    - `compare(user, ref, mode)` returning `JudgeVerdict`. `multiset`: column-count check then `Map<canonicalKey, count>` equality. `sequence`: column-count check then row-by-row `arrayEquals`. Forwards `SqlError` from the user side as `verdict.sandboxError` (R12.7).
    - _Requirements: R12.1, R12.2, R12.3, R12.4, R12.5, R12.6, R12.7, R12.8_

  - [x] 4.4 Implement `src/judge/diff.js`
    - `summarize(user, ref, mode)` returning `{ extraRows, missingRows, firstMismatch }`.
    - _Requirements: R12.6_

- [x] 5. Safety filter
  - [ ]* 5.1 Write property test for safety filter precision
    - **Property 6: Safety filter exactness**
    - **Validates: Requirements R11.1, R11.2**
    - File: `tests/sandbox/safety-filter.property.test.js`. Generate (a) pure-SELECT statements with `DROP`/`ALTER`/etc embedded **only inside string literals or comments** — these must pass; (b) statements containing forbidden keywords as actual tokens — these must be rejected; (c) DML statements with `allowDml=false` — rejected; (d) DML statements with `allowDml=true` — accepted.

  - [x] 5.2 Implement `src/sandbox/safety-filter.js`
    - Feed input through tokenizer first (string literals and comments stripped), then check the token stream against `FORBIDDEN_KEYWORDS = ['DROP','ALTER','TRUNCATE','ATTACH','DETACH','PRAGMA']` and `DML_KEYWORDS = ['INSERT','UPDATE','DELETE','REPLACE']`. Combine with `parser.parse(sql).kind` for the dual-layer check.
    - _Requirements: R11.1, R11.2_

- [x] 6. LLM error classifier
  - [ ]* 6.1 Write property test for error classification + priority
    - **Property 4: LLM error classification coverage and priority**
    - **Validates: Requirements R3.1, R3.3, R14.1, R14.2, R14.3, R14.4, R14.6**
    - File: `tests/llm/errors.property.test.js`. Generate `{status}` objects spanning 200/401/403/429/5xx, plus error objects representing `AbortError` / `TypeError("Failed to fetch")`. Assert classification mapping and the priority ordering `unauthorized > rate_limited > server_error > timeout > cors > network > bad_response`.

  - [x] 6.2 Implement `src/llm/errors.js`
    - Export `classifyError(responseOrError)` and `displayedError(set)` per the design's classification table.
    - _Requirements: R3.1, R3.3, R14.1, R14.2, R14.3, R14.4, R14.6_

- [x] 7. Checkpoint — foundation tests pass
  - Ensure all tests in milestones 2–6 pass, ask the user if questions arise.

- [x] 8. SQL Sandbox with Web Worker
  - [ ]* 8.1 Write property test for snapshot reset idempotency
    - **Property 5: Sandbox baseline reset idempotency**
    - **Validates: Requirements R10.6, R11.4**
    - File: `tests/sandbox/sandbox.property.test.js`. Uses **real sql.js** (not mocked). Loads a fixed schema, generates random sequences of safe DML (INSERT/UPDATE/DELETE) under `allowDml=true`, then `restoreSnapshot()`; asserts every table's `SELECT *` matches the baseline as a multiset, and that `restore()` is idempotent.

  - [x] 8.2 Implement `src/sandbox/sandbox.js` (main-thread wrapper)
    - `init`, `loadSchema(ddl, seedSql)`, `exportSnapshot()`, `restoreSnapshot(bytes)`, `exec(sql, opts)`, `describeSchema()`. Uses `db.export()` for snapshots and `new SQL.Database(snapshot)` for restore (O(1) reset, R10.6 / R11.4).
    - Enforces row truncation at 10000 with `truncated: true` flag (R10.5).
    - _Requirements: R10.1, R10.3, R10.4, R10.5, R10.6, R11.4_

  - [x] 8.3 Implement `src/sandbox/sandbox-worker.js` (Web Worker)
    - Worker script that loads sql.js inside the worker, listens for `{type:'exec', sql, allowDml}` messages, runs the safety filter, then `db.exec`, and posts back `{type:'result'|'error', payload}`. The worker holds the live `db` instance.
    - _Requirements: R10.1, R10.2, R11.3_

  - [x] 8.4 Implement `src/sandbox/timeout.js` and worker-termination recovery
    - Main thread arms `setTimeout(5000)` per `exec`. On timeout, `worker.terminate()`, spawn a fresh worker, and `loadSchema` from the cached `baselineSnapshot` so subsequent answers continue to work.
    - _Requirements: R10.2, R11.3, R11.4_

  - [x] 8.5 Wire `sandbox.js` to use the worker for `exec`
    - The main-thread wrapper exposes the same `Sandbox` interface but routes `exec` through `postMessage`. Snapshot bytes still live in the main thread.
    - _Requirements: R10.1, R10.2_

  - [ ]* 8.6 Write unit test for hard 5s timeout interruption
    - Submit a deliberately long-running SQL (e.g. cross-join over a generated table with many rows) and assert that `exec` resolves with `SqlError(kind:'timeout')` within ≤ 5.5s and that a follow-up `exec` succeeds (worker was successfully restarted).
    - _Requirements: R10.2, R11.3_

- [x] 9. LLM Client
  - [ ]* 9.1 Write property test for outbound request allowlist
    - **Property 2: Outbound request allowlist**
    - **Validates: Requirements R1.3, R2.2, R2.4, R4.4, R10.1**
    - File: `tests/llm/client.property.test.js`. Use MSW to intercept all `fetch`. Generate arbitrary `LlmConfig`s with random `apiBaseUrl` origins and inject Agent invocations; assert (a) only origins in `{originOf(apiBaseUrl)} ∪ CDN_ALLOWLIST` are contacted, (b) only requests to `originOf(apiBaseUrl)` carry `Authorization` or any substring of `apiKey`, (c) console output contains no `apiKey` substring.

  - [x] 9.2 Implement `src/llm/client.js`
    - `chat(messages, opts)` builds an OpenAI-compatible Chat Completions body, sets `Authorization: Bearer ${apiKey}` only for requests to `originOf(apiBaseUrl)`, applies `AbortController` with a 60s default timeout (R3.3, R14.4), and routes all errors through `classifyError` (Milestone 6).
    - _Requirements: R1.3, R1.4, R2.2, R2.4, R3.3, R4.4, R14.4_

  - [ ]* 9.3 Write unit test for 60s LLM timeout
    - With MSW returning a deferred response, assert `chat` rejects with `ClassifiedLlmError(kind:'timeout')` at 60s and that the `AbortController` signal fired.
    - _Requirements: R3.3, R14.4_

- [x] 10. Settings module
  - [x] 10.1 Implement `src/settings/settings.js`
    - `load`, `save`, `clear`, `isComplete`, `testConnection` per the `SettingsModule` contract. `testConnection` issues `POST {apiBaseUrl}/chat/completions` with `max_tokens:1` and a 10s `AbortController` (R1.6).
    - _Requirements: R1.1, R1.2, R1.5, R1.6, R2.3_

  - [ ]* 10.2 Write unit test for masked-display state machine
    - The settings view exposes a `display(apiKey, revealed)` pure helper; assert masked output and the toggle.
    - _Requirements: R1.7_

  - [ ]* 10.3 Write unit test for empty-config rejection
    - Confirm `isComplete(null)` and `isComplete({apiBaseUrl:'',apiKey:'',modelName:''})` both return false; an Agent invocation under that state must short-circuit before any `fetch`.
    - _Requirements: R1.5_

- [x] 11. Checkpoint — sandbox, LLM client, settings tests pass
  - Ensure all tests in milestones 8–10 pass, ask the user if questions arise.

- [x] 12. Agent nodes (LangGraph node implementations)
  - [x] 12.1 Write five prompt templates under `src/orchestrator/prompts/`
    - `schema-gen.md`, `question-gen.md`, `judge-followup.md` (only for borderline diff explanation, not the verdict), `tutor.md`, `reporter.md`. Each template enforces the MySQL-compatible subset (R7.1, R7.2), bans direct disclosure of the reference SQL in Tutor's first reply (R13.2), and instructs JSON output where the post-validator parses the response.
    - _Requirements: R5.1, R5.2, R5.3, R7.3, R7.4, R13.2_

  - [x] 12.2 Implement `src/orchestrator/nodes/schema-gen.js`
    - Calls LLM, extracts DDL + seed SQL, runs them in a fresh sandbox to validate, retries up to 2 times with the prior error fed back into the prompt; on the 3rd failure returns `{ failedAgent: 'SchemaGen', error }`. Asserts `≥3` tables with at least one FK and `≥5` rows per table at the post-validator (R6.2, R6.7). Honors the custom-theme description (R6.6).
    - _Requirements: R6.2, R6.3, R6.4, R6.5, R6.6, R6.7, R7.1, R7.2_

  - [ ]* 12.3 Write property test for QuestionGen post-condition validators
    - **Property 8: Difficulty / topic / ordering post-checks**
    - **Validates: Requirements R5.2, R5.3, R7.4, R8.4, R8.5, R9.1, R9.2, R9.3, R9.4, R9.5, R9.6, R19.1, R19.2, R19.3**
    - File: `tests/orchestrator/question-gen.property.test.js`. Use MSW to mock the LLM with fast-check-generated *candidate* questions (some valid, some violating each rule). Assert the post-validator accepts the valid ones and rejects each violation class for the right reason; for `L3` the topic intersection rule, for `L4` `|topics| ≥ 2`, for `set_operation_except` the `MySQL ... NOT IN/NOT EXISTS` substring, for `is_ordered` the `parse(refSql).hasOrderBy ⇔ is_ordered` equivalence, etc.

  - [x] 12.4 Implement `src/orchestrator/nodes/question-gen.js`
    - Runs the prompt, parses JSON response into `Question`, runs `refSql` (and `refSqlAlt` when topic is `set_vs_join_compare`) through the sandbox to confirm executability and non-empty result when expected, runs the post-validator from 12.3, retries up to 2 times feeding the failure reason back. On 3rd failure returns `failedAgent: 'QuestionGen'`.
    - _Requirements: R8.2, R8.3, R8.4, R8.5, R8.6, R8.7, R8.8, R9.1, R9.2, R9.3, R9.4, R9.5, R9.6, R19.1, R19.2, R19.3_

  - [x] 12.5 Implement `src/orchestrator/nodes/judge.js`
    - Thin wrapper: pulls `mode` from `question.isOrdered`, runs `compare(user, ref, mode)`. For `set_vs_join_compare`, compares both `userSql` and `userSqlAlt` against `refResult` and AND-combines (R12.8).
    - _Requirements: R12.8, R19.4_

  - [ ]* 12.6 Write property test for Tutor context isolation and persistence round-trip
    - **Property 10: Tutor context isolation and persistence round-trip**
    - **Validates: Requirements R13.3, R13.4, R13.5, R15.1, R15.2, R15.3**
    - File: `tests/orchestrator/tutor.property.test.js`. Build random multi-turn conversations on `q1`, then switch to `q2`; assert the `messages` payload sent for `q2`'s first turn contains no substring of `q1.userSql` or `q1.refSql`. Also assert each `i ≥ 2` turn contains all prior turns. Combine with a `store.set/reload/get` round-trip on randomly generated `Question` and `AnswerRecord` objects.

  - [x] 12.7 Implement `src/orchestrator/nodes/tutor.js`
    - Maintains `tutorThread` per question id; first message is the diagnostic in the format dictated by 12.1 (classification + key diff + leading question; never the full `refSql` unless the user explicitly clicks "show answer"). Switching questions resets the thread (R13.5). Supports ≥10 turns by keeping the full thread in `state.tutorThread` until a question switch.
    - _Requirements: R13.1, R13.2, R13.3, R13.4, R13.5_

  - [x] 12.8 [OPT] Implement `src/orchestrator/nodes/reporter.js`
    - Aggregates `Session` answers into per-topic and per-difficulty correct rates, picks weakest topic(s), composes a Markdown report with at least one concrete next-step recommendation (R16.3). Gated on `≥5` answers (R16.1).
    - _Requirements: R16.1, R16.2, R16.3_

- [x] 13. LangGraph orchestrator
  - [ ]* 13.1 Write property test for retry counting and failure propagation
    - **Property 9: Agent retry count and failure propagation**
    - **Validates: Requirements R6.4, R6.5, R8.7, R8.8, R17.4**
    - File: `tests/orchestrator/graph.property.test.js`. Parameterize over `n ∈ {SchemaGen, QuestionGen}` and `k ∈ {1,2,3}`, MSW-mock the LLM to return invalid responses for the first `k-1` calls and a valid one on call `k`; assert the node succeeds and the LLM was called exactly `k` times. With all-3 invalid, assert `state.failedAgent === n`, `error` is a readable string, and call count is exactly 3. Inject a thrown exception and assert downstream nodes do not run and `state.failedAgent` is set.

  - [x] 13.2 Implement `src/orchestrator/state.js`
    - `AgentState` factory + immutable update helpers (`mergePartial(state, partial)`); ensure failure paths only append `failedAgent`/`error`, never strip `question` or `userSql` (R14.5).
    - _Requirements: R14.5, R17.3_

  - [x] 13.3 Implement `src/orchestrator/graph.js`
    - Build the LangGraph with five nodes and the transitions shown in the design's `stateDiagram-v2`. Wire the per-node retry counter (≤2 retries inside the node, not at the graph level). On any node throwing, abort and surface `failedAgent`.
    - _Requirements: R17.1, R17.2, R17.3, R17.4_

  - [ ]* 13.4 Write unit test for state preservation on failure
    - Inject a Tutor failure mid-flow and assert `state.question` and `state.userSql` are unchanged (R14.5).
    - _Requirements: R14.5_

- [x] 14. Checkpoint — orchestrator and agent tests pass
  - Ensure all tests in milestones 12–13 pass, ask the user if questions arise.

- [x] 15. UI views
  - [x] 15.1 Implement `src/ui/settings-view.js`
    - Three input fields, masked API Key with a "显示" toggle (R1.7), "测试连接" button wired to `Settings.testConnection`, "清除配置" button wired to `Settings.clear`, a static notice explaining the cross-origin requirement on the user's LLM endpoint (R3.2).
    - _Requirements: R1.1, R1.6, R1.7, R2.3, R3.2_

  - [x] 15.2 Implement `src/ui/practice-view.js`
    - Theme picker (`电商 / 校园 / 图书馆 / 医院 / 自定义`); when `自定义` is selected, reveal a textarea for the Chinese description (R6.6). Difficulty picker (L1–L4) and multi-select topic chips (16 topics from `topics.js`). Schema display block rendering tables, columns, types, PK/FK after `SchemaGen` succeeds (R6.8).
    - _Requirements: R6.1, R6.6, R6.8, R8.1_

  - [x] 15.3 Implement `src/ui/editor-view.js` and `src/ui/result-view.js`
    - Editor: `<textarea>` with line numbers and a "格式化 SQL" button calling `formatter.format(parser.parse(...))` (R18.3). Result view: HTML table for `ResultSet`, banner when `truncated:true`.
    - _Requirements: R10.5, R18.3_

  - [x] 15.4 Implement `src/ui/tutor-view.js`
    - Threaded chat view bound to `state.tutorThread`. "显示参考答案" button reveals `refSql` only on click (R13.6). Composer disabled while a turn is in flight.
    - _Requirements: R13.1, R13.4, R13.6_

  - [ ]* 15.5 Write property test for history sort and filter
    - **Property 11: History sort, wrong-only filter, empty-state**
    - **Validates: Requirements R15.4, R15.5**
    - File: `tests/ui/history-view.property.test.js`. Generate arbitrary `AnswerRecord[]`. Assert the rendered order is strict descending by `submittedAt`; `filterWrong(rs)` is a subset, contains exactly the `correct=false` records, and yields the exact "没有符合条件的错题" empty-state node when the filtered list is empty. Also assert `clearHistory()` does not mutate the saved settings.

  - [x] 15.6 Implement `src/ui/history-view.js`
    - Pure render helpers `sortDesc`, `filterWrong`, plus the DOM renderer. Wire "清空历史" → `store.remove('sqlcoach.answers.v1')` (settings preserved, R15.5). Empty-state node uses the exact string `没有符合条件的错题`.
    - _Requirements: R15.4, R15.5_

  - [x] 15.7 [OPT] Implement `src/ui/report-view.js`
    - Renders the Reporter agent output and exposes "导出 Markdown" (R16.4). Gated on session answers ≥ 5 (R16.1).
    - _Requirements: R16.1, R16.2, R16.3, R16.4_

  - [x] 15.8 Implement `set_vs_join_compare` dual-textarea editor
    - When the active question's topic is `set_vs_join_compare`, render two side-by-side textareas labelled "集合查询写法" and "连接查询写法", both submitted together as `userSql` and `userSqlAlt` (Default D-D — switch to tab UI later if needed). Submit button passes both values to the Judge node (R9.6 / R12.8).
    - _Requirements: R9.6, R12.8_

  - [ ]* 15.9 Write property test for quotaExceeded → export-dialog binding
    - **Property 12: Persistence failure ⇔ export entry visibility**
    - **Validates: Requirements R15.6**
    - File: `tests/ui/quota.property.test.js`. Generate sequences of `store.set` outcomes (mix of `{ok:true}` and `{ok:false, quotaExceeded:true}`) and assert the export-dialog node is present in the DOM iff the most recent `set` returned `quotaExceeded:true`.

  - [x] 15.10 Implement quotaExceeded toast and JSON export dialog
    - When `store.set` returns `quotaExceeded:true`, render a non-dismissible dialog with a "导出 JSON" button calling `store.exportAll()`; when subsequent writes succeed, the dialog disappears.
    - _Requirements: R15.6_

  - [x] 15.11 Implement single-priority error toast surface
    - Central error sink that, given a set of pending error flags, renders only the highest-priority one per Property 4's ordering. Wires every Agent / sandbox / store error path through this sink.
    - _Requirements: R14.6_

- [x] 16. App boot and integration
  - [x] 16.1 Implement `src/main.js`
    - Probe `localStorage`; load settings; restore most-recent schema and question bank from the store (R15.3); render the appropriate view (Settings if config incomplete, otherwise Practice). Create a single `Sandbox` instance and reuse it across views.
    - _Requirements: R1.5, R4.2, R15.3, R17.2_

  - [ ]* 16.2 Write integration test for end-to-end loop
    - With MSW returning canned valid responses for SchemaGen → QuestionGen → Tutor, drive the orchestrator from `Idle → SchemaGen → QuestionGen → Answering → Judge → Tutor → Idle`. Assert the persisted `AnswerRecord` is round-trippable through the store.
    - _Requirements: R15.1, R15.2, R15.3, R17.1_

  - [ ]* 16.3 Write smoke test that the repo contains no bundler config
    - Assert no files matching `webpack.config.*`, `vite.config.*`, `rollup.config.*`, `tsconfig.json`. Assert `index.html` contains the importmap and that the importmap targets only `https://esm.sh/...`, `https://cdn.jsdelivr.net/...`, or relative `./vendor/` paths.
    - _Requirements: R4.1, R4.3_

- [x] 17. Final checkpoint — full suite green
  - Ensure all tests pass, ask the user if questions arise.

- [x] 18. Deployment and documentation
  - [x] 18.1 Add the GitHub Pages deployment workflow
    - Create `.github/workflows/pages.yml` that uploads the repo root as the Pages artifact and deploys on push to `main`. No build step. Document an alternative `gh-pages` branch flow in the README.
    - _Requirements: R4.1, R4.2_

  - [x] 18.2 Write `README.md`
    - Sections: quick start (open `index.html` or visit Pages URL), settings walk-through with the cross-origin notice, the **MySQL_Compatible_Subset** reference table copied from `design.md` → "Data Models" (R7.3), known incompatibilities list (R7.4), local test instructions, architecture diagram link.
    - _Requirements: R7.3, R7.4_

  - [x] 18.3 Add architecture documentation under `docs/`
    - `docs/architecture.md` containing the high-level Mermaid diagram and the LangGraph topology from `design.md`. `docs/demo-deck.md` with a Markdown skeleton (slide-per-section) covering: motivation, course alignment, five Agents, sandbox, judging strategy, demo flow, future work.
    - _Requirements: R7.3, R17.1_

- [ ] 19. Post-MVP — deferred
  - [~] 19.1 [OPT] Mirror ESM dependencies into `vendor/`
    - Download `@langchain/langgraph` ESM bundle and `sql.js` + `sql-wasm.wasm` into `vendor/`. Add an importmap toggle in `index.html` so the page works fully offline. Document the trade-off in the README.
    - _Requirements: R4.3_

  - [~] 19.2 [OPT] CI smoke test for offline mode
    - Once 19.1 is done, add a CI step that loads `index.html` with all `https://*` requests blocked and asserts the app still boots.
    - _Requirements: R4.3_

## Notes

- Sub-tasks marked with `*` are **test sub-tasks** and may be skipped for a fast MVP, but the project is set up for test-first development — every Correctness Property has a dedicated PBT task placed **before** the implementation it constrains.
- Sub-tasks prefixed with `[OPT]` are **v1-optional features** (Reporter agent, Markdown export, vendor offline mirror). The core out-of-the-box loop (theme → question → answer → judge → tutor → history) does not depend on them.
- All 12 Correctness Properties from `design.md` are covered: 2.1 (P3), 3.1 (P1), 4.1 (P7), 5.1 (P6), 6.1 (P4), 8.1 (P5), 9.1 (P2), 12.3 (P8), 12.6 (P10), 13.1 (P9), 15.5 (P11), 15.9 (P12).
- Each property test file carries a header tag of the form `// Feature: sql-coach, Property {n}: {summary}` linking back to `design.md`.
- All `fast-check` runs use the default `numRuns: 100`; long-running properties (sandbox reset, full-graph) may bump or lower this and are flagged in the test file.
- Open design questions (D-A vendor offline, D-B Web Worker, D-C test stack, D-D dual-textarea UI) have defaults applied (see Overview); reopen them by editing the relevant tasks.

## Task Dependency Graph

The graph below shows wave-based parallelism: every leaf sub-task appears in exactly one wave. Tests targeting a file are scheduled in the wave **before** that file's implementation (test-first); two impl tasks that touch the same file are forced into different waves.

### Mermaid view

```mermaid
graph LR
    subgraph W0["Wave 0: bootstrap"]
        T11[1.1]
        T12[1.2]
        T13[1.3]
    end
    subgraph W1["Wave 1: foundation tests"]
        T21[2.1*]
        T31[3.1*]
        T41[4.1*]
        T51[5.1*]
        T61[6.1*]
    end
    subgraph W2["Wave 2: foundation impls"]
        T22[2.2]
        T23[2.3]
        T24[2.4*]
        T32[3.2]
        T33[3.3]
        T34[3.4]
        T35[3.5*]
        T42[4.2]
        T43[4.3]
        T44[4.4]
        T52[5.2]
        T62[6.2]
    end
    subgraph W3["Wave 3: sandbox+llm+settings tests"]
        T81[8.1*]
        T91[9.1*]
        T102[10.2*]
        T103[10.3*]
    end
    subgraph W4["Wave 4: sandbox + llm client + settings impls"]
        T82[8.2]
        T83[8.3]
        T84[8.4]
        T85[8.5]
        T86[8.6*]
        T92[9.2]
        T93[9.3*]
        T101[10.1]
    end
    subgraph W5["Wave 5: agent post-validator tests"]
        T123[12.3*]
        T126[12.6*]
        T131[13.1*]
    end
    subgraph W6["Wave 6: agent impls + orchestrator state"]
        T121[12.1]
        T122[12.2]
        T124[12.4]
        T125[12.5]
        T127[12.7]
        T128[12.8]
        T132[13.2]
    end
    subgraph W7["Wave 7: orchestrator graph + UI tests"]
        T133[13.3]
        T134[13.4*]
        T155[15.5*]
        T159[15.9*]
    end
    subgraph W8["Wave 8: UI impls"]
        T151[15.1]
        T152[15.2]
        T153[15.3]
        T154[15.4]
        T156[15.6]
        T157[15.7]
        T158[15.8]
        T1510[15.10]
        T1511[15.11]
    end
    subgraph W9["Wave 9: integration"]
        T161[16.1]
        T162[16.2*]
        T163[16.3*]
    end
    subgraph W10["Wave 10: deploy + docs"]
        T181[18.1]
        T182[18.2]
        T183[18.3]
    end
    subgraph W11["Wave 11: post-MVP"]
        T191[19.1]
        T192[19.2]
    end

    W0 --> W1 --> W2 --> W3 --> W4 --> W5 --> W6 --> W7 --> W8 --> W9 --> W10 --> W11
```

### Machine-readable view (for the scheduler)

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1", "5.1", "6.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "3.2", "3.3", "3.4", "3.5", "4.2", "4.3", "4.4", "5.2", "6.2"] },
    { "id": 3, "tasks": ["8.1", "9.1", "10.2", "10.3"] },
    { "id": 4, "tasks": ["8.2", "8.3", "8.4", "8.5", "8.6", "9.2", "9.3", "10.1"] },
    { "id": 5, "tasks": ["12.3", "12.6", "13.1"] },
    { "id": 6, "tasks": ["12.1", "12.2", "12.4", "12.5", "12.7", "12.8", "13.2"] },
    { "id": 7, "tasks": ["13.3", "13.4", "15.5", "15.9"] },
    { "id": 8, "tasks": ["15.1", "15.2", "15.3", "15.4", "15.6", "15.7", "15.8", "15.10", "15.11"] },
    { "id": 9, "tasks": ["16.1", "16.2", "16.3"] },
    { "id": 10, "tasks": ["18.1", "18.2", "18.3"] },
    { "id": 11, "tasks": ["19.1", "19.2"] }
  ]
}
```

## Workflow Completion

This Requirements-First workflow is now complete: `requirements.md`, `design.md`, and `tasks.md` are all in place. To begin executing:

1. Open `.kiro/specs/sql-coach/tasks.md`.
2. Click **Start task** next to any leaf sub-task (the scheduler will respect the wave ordering above when running multiple at once).
3. Test sub-tasks (`*` postfixed) and `[OPT]` features can be skipped for a fast MVP — the dependency graph will still close.
