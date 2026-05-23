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
} from './provider-base.js'

export {
  OpenAICompatProvider,
  type OpenAICompatProviderConfig,
} from './openai-compat-provider.js'

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
