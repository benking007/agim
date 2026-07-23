// agent-loop — facade re-exporting the full public API of the agent loop.
//
// PRODUCTION STATUS: Agim Agent (`native` registry id) runs on
// `plugins/agents/agim-agent` (AgentHarness). Shared prompt/policy helpers
// live in `plugins/agents/agim-agent-shared`.
// `runAgentLoop` is the retired in-process loop. Shared helpers still live
// here (`ApprovalGate`, `isSemanticStuckLoop`, `resolveSemanticStuckLoopOn`)
// and are imported by pi-native. Do not wire new production call sites to
// `runAgentLoop`; shrink or extract helpers in a follow-up.
//
// Implementation is split across sibling files:
//   agent-loop-types.ts   — types, interfaces, alwaysAllowGate
//   agent-loop-config.ts  — env resolvers, constants, nudge strings
//   agent-loop-stream.ts  — streaming accumulation (streamThenBuffer etc.)
//   agent-loop-stuck.ts   — stuck-loop & semantic-stuck detection
//   agent-loop-helpers.ts — policy/approval/dispatch/audit/signal helpers
//   agent-loop-run.ts     — runAgentLoop implementation

export { runAgentLoop } from './agent-loop-run.js'

export {
  alwaysAllowGate,
  type MaybePromise,
  type ApprovalGate,
  type ToolPolicyDecision,
  type AgentToolPolicyContext,
  type AgentToolPolicy,
  type LoopFinishReason,
  type AgentLoopPrepareNextTurnContext,
  type AgentLoopStopAfterTurnContext,
  type AgentLoopStopDecision,
  type AgentLoopPolicy,
  type AgentLoopInput,
  type ToolCallReport,
  type AgentLoopResult,
} from './agent-loop-types.js'

export {
  stableStringify,
  extractErrorType,
  isStuckLoop,
  isSemanticStuckLoop,
  extractSalientStrings,
  resolveSemanticStuckLoopOn,
} from './agent-loop-stuck.js'
