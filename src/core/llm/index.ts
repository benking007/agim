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
  loadFromConfig,
  getProvider,
  getProviderByName,
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
