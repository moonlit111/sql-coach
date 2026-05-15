// Lightweight Agent orchestrator (formerly intended to be LangGraph.js).
//
// Validates: R17.1 (five-node coordination), R17.2 (state-machine
// transitions), R17.3 (immutable Partial<state> spread), R17.4 (any
// node throwing aborts the flow with `failedAgent` set).
//
// === Architectural deviation ===
// The design originally specified LangGraph.js. We swap in a custom
// orchestrator with the same node interface (each node is
// `(state, ...args) => Promise<Partial<AgentState>>`). Reasons:
//
//  1. LangGraph.js drags in a heavy dependency tree that is awkward to
//     load through a static `<script type="importmap">` in the test env.
//  2. The node interface is identical, so swapping back to LangGraph.js
//     later is a one-file change inside this module — the nodes don't
//     need to know.
//  3. Per-node retries already live INSIDE each node (R6.5 / R8.7), so
//     the graph layer's only responsibilities are routing and immutable
//     state merging — both trivial.
//
// Production users who need full LangGraph features (checkpointing,
// streaming, branching) can replace `runNode` with a LangGraph build.

import { createSchemaGenNode }   from './nodes/schema-gen.js';
import { createQuestionGenNode } from './nodes/question-gen.js';
import { createJudgeNode }       from './nodes/judge.js';
import { createTutorNode }       from './nodes/tutor.js';
import { createReporterNode }    from './nodes/reporter.js';
import { mergePartial, withFailure } from './state.js';

/**
 * @typedef {import('../types.js').AgentState} AgentState
 */

/**
 * Build the graph. The returned object exposes the node functions and a
 * `runNode` helper that calls a node and folds its `Partial<AgentState>`
 * return into the running state.
 *
 * @param {{
 *   llmClient: { chat: (messages: any[], opts?: any) => Promise<{ content: string }> },
 *   sandbox:   any,
 *   onProgress?: (event: { node: string, phase: string, attempt: number, status: 'running'|'ok'|'fail', detail?: string }) => void,
 * }} deps
 */
export function createGraph({ llmClient, sandbox, onProgress }) {
  // Tag every progress event with the node name so the UI can route them
  // (currently only schemaGen and questionGen emit, but tutor/reporter can
  // adopt the same pattern later).
  const tagged = (node) => onProgress
    ? (ev) => onProgress({ node, ...ev })
    : undefined;

  const nodes = {
    schemaGen:   createSchemaGenNode({ llmClient, sandbox, onProgress: tagged('schemaGen') }),
    questionGen: createQuestionGenNode({ llmClient, sandbox, onProgress: tagged('questionGen') }),
    judge:       createJudgeNode({ sandbox }),
    tutor:       createTutorNode({ llmClient }),  // exposes { firstMessage, followup, resetForNewQuestion }
    reporter:    createReporterNode({ llmClient }),
  };

  /**
   * Run a named node (or sub-action of a node object) and merge its return
   * value back into `state`. If the node throws, R17.4 demands we abort
   * the flow and tag `failedAgent` — we do that here so individual node
   * authors don't have to wrap every line.
   *
   * Routing rules:
   *   - schemaGen / questionGen / judge / reporter — function nodes
   *   - tutor.firstMessage / tutor.followup / tutor.resetForNewQuestion
   *     — sub-action methods on the tutor node object
   *
   * @param {keyof typeof nodes | `tutor.${'firstMessage'|'followup'|'resetForNewQuestion'}`} name
   * @param {AgentState} state
   * @param  {...any} args
   * @returns {Promise<AgentState>}
   */
  async function runNode(name, state, ...args) {
    let partial;
    try {
      if (typeof name === 'string' && name.startsWith('tutor.')) {
        const action = name.slice('tutor.'.length);
        const fn = nodes.tutor[action];
        if (typeof fn !== 'function') {
          throw new Error(`unknown tutor action: ${action}`);
        }
        partial = await fn.call(nodes.tutor, state, ...args);
      } else {
        const fn = nodes[name];
        if (typeof fn !== 'function') {
          throw new Error(`unknown node: ${name}`);
        }
        partial = await fn(state, ...args);
      }
    } catch (e) {
      // R17.4 — any thrown exception ends the flow with failedAgent set.
      const agentName = nameToFailedAgent(name);
      return withFailure(state, agentName, String(e?.message ?? e?.kind ?? e));
    }
    return mergePartial(state, partial);
  }

  return { nodes, runNode };
}

/**
 * Map a `runNode` name to the corresponding `FailedAgentName` used by
 * `state.failedAgent`. Defaults to `Tutor` for any tutor sub-action.
 *
 * @param {string} name
 * @returns {import('../types.js').FailedAgentName}
 */
function nameToFailedAgent(name) {
  if (typeof name !== 'string') return 'SchemaGen';
  if (name.startsWith('tutor.')) return 'Tutor';
  switch (name) {
    case 'schemaGen':   return 'SchemaGen';
    case 'questionGen': return 'QuestionGen';
    case 'judge':       return 'Judge';
    case 'reporter':    return 'Reporter';
    default:            return 'SchemaGen';
  }
}
