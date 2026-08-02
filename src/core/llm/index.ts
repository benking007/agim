// Barrel re-export — the public surface of the native LLM client (D+ Stage 1).
//
// Internal modules should import from `./llm/index.js` to keep deep-path
// imports out of caller code. Stage 2 will add tool-loop / MCP exports
// here without breaking Stage-1 callers.

export {
  LlmProvider,
  LlmProviderError,
  type ChatOptions,
  type ChatResult,
  type ChatStreamChunk,
  type FinishReason,
  type LlmMessage,
  type LlmMessageRole,
  type LlmUsage,
  type ProviderConfigBase,
  type NormalizedOptions,
  type ToolCallRequest,
  type ToolChoice,
  type ToolDef,
} from './provider-base.js'

export {
  OpenAICompatProvider,
  type OpenAICompatProviderConfig,
} from './openai-compat-provider.js'

export {
  AnthropicProvider,
  type AnthropicProviderConfig,
} from './anthropic-provider.js'

export {
  DEEPSEEK_ANTHROPIC_BASE,
  DEEPSEEK_BETA_BASE,
  DEEPSEEK_OPENAI_BASE,
  DEEPSEEK_THINKING_LEVEL_MAP,
  hashDeepSeekUserId,
  normalizeJsonSchemaForStrict,
  type DeepSeekApiDialect,
} from './deepseek-compat.js'

export {
  completeDeepSeekFim,
  createDeepSeekResponse,
  withChatPrefixAssistant,
} from './deepseek-api.js'

export {
  loadFromConfig,
  getProvider,
  getAnyProvider,
  getProviderByName,
  getAnyBackendBinding,
  listProviders,
  describeRegistry,
  _resetRegistry,
  type LlmRole,
} from './registry.js'

export {
  LLM_SECRETS_PATH,
  envKeyForBackend,
  loadSecretsFile,
  resolveSecret,
  saveSecret,
  removeSecret,
  listConfiguredBackends,
  describeSecretSource,
} from './secrets.js'

export {
  tryIntrospect,
  type IntrospectionInput,
  type IntrospectionResult,
} from './introspection.js'

export {
  McpClient,
  type McpServerConfig,
  type ToolCallResult,
} from './mcp-client.js'

export {
  loadFromConfig as loadMcpFromConfig,
  connectAll as connectAllMcp,
  getAllTools as getAllMcpTools,
  getOwningServer as getMcpOwningServer,
  callToolByName as callMcpToolByName,
  describeRegistry as describeMcpRegistry,
  closeAll as closeAllMcp,
  _resetRegistry as _resetMcpRegistry,
} from './mcp-registry.js'

export {
  alwaysAllowGate,
  isSemanticStuckLoop,
  resolveSemanticStuckLoopOn,
  type AgentLoopInput,
  type AgentLoopResult,
  type ApprovalGate,
  type LoopFinishReason,
  type ToolCallReport,
  // `runAgentLoop` is intentionally NOT re-exported: production Agim Agent
  // uses pi-native AgentHarness. The function remains in agent-loop.ts for
  // shared helpers + historical unit tests; import it from there only if
  // you need the retired in-process loop in a test.
} from './agent-loop.js'

export {
  buildMcpDispatcher,
  combineDispatchers,
  type DispatcherResult,
  type ToolDispatcher,
} from './tool-dispatcher.js'
