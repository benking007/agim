# Agent integration SOP

Agim 的核心定位是“把各类 IM 连接到各类 Agent”。接入新 agent 时，目标不是让它“能回一句话”就结束，而是把它接成 Agim 的完整后端：可发现、可启用、可作为默认 agent、可在 Web/IM 中对话、可进入独立工作区、可续接会话、可使用或明确声明不支持 Agim 工具、Skills、Memory、审批、A2A 等能力。

这份 SOP 是后续逐一接入主流 agent 工具的固定流程。每接一个新 agent，都按本文建调研卡、实现、测试和验收，避免长期上下文丢失后遗漏关键环节。

## 0. 接入路径分类

先判断目标 agent 属于哪类。

| 类型 | 例子 | 接入方式 |
|---|---|---|
| CLI agent | Claude Code、Codex、OpenCode、Cursor、Antigravity、Kimi Code、Qoder、PI、MiMo Code、Gemini CLI、Qwen Code | 实现 `AgentAdapter`，通常继承 `AgentBase`，每轮 spawn CLI |
| In-process agent | Agim Agent（`agim`，别名 `native`） | 直接在 Agim 进程内调用 LLM loop 和 tool dispatcher |
| Hosted agent | 托管 agent 服务 | 通过该服务的官方 HTTP API 实现 `AgentAdapter` |
| Prompt-only bridge | 不支持非交互、工具或 MCP 的 CLI | 只能降级为对话桥接，UI/文档必须明确能力受限 |

优先级：能做 CLI/remote 原生协议就不要做 prompt-only。prompt-only 容易让用户误以为 Skills、Memory、审批都可用，实际只是纯聊天。

## 1. 调研卡

每个 agent 新建一个调研卡，先填完再动代码。

```text
Agent ID:
展示名:
官网/文档:
安装方式:
CLI binary:
常见安装路径:
版本探测命令:
登录方式:
凭据位置:

非交互运行命令:
输入方式:
输出格式:
是否支持流式:
错误输出格式:
退出码语义:
超时/取消方式:

是否支持会话续接:
会话 ID 来源:
首轮参数:
续接参数:
/new 时需要清理什么:

是否支持 model list:
是否支持 per-call --model:
默认模型读取位置:

是否支持 plan/read-only:
是否支持 workspace/cwd/trust:
是否支持 MCP 或等价工具协议:
是否支持外部审批/permission hook:
高危操作默认策略:

Agim 能力目标:
Skills:
Memory:
Memo:
Reminder:
Goal:
Ask user:
Push message:
A2A call_agent:
Approval:
Viewer:
```

调研时必须实际跑一次 CLI，不只看文档。重点确认非交互模式、JSON/JSONL/纯文本输出、session id、模型切换、MCP/工具、审批和 cwd 行为。

## 2. 后端适配器

新增路径：

```text
src/plugins/agents/<agent>/index.ts
src/plugins/agents/<agent>/adapter.test.ts
```

优先继承 `AgentBase`，除非目标不是 CLI 或协议无法落到 stdout/stderr 流。

必须实现：

- `name`: 稳定 ID，使用小写 kebab-case。
- `aliases`: IM 里可用的短命令，例如 `/cc`、`/cx`。
- `kind`: `cli`、`in-process` 或 `remote`。
- `commandName`: 可探测的 binary，必要时支持 `AGIM_<AGENT>_BIN` 覆盖。
- `isAvailable()`: 默认 `<command> --version`，不适配时要覆写。
- `buildArgs()` 或 `prepareCommand()`: 构造每轮调用。
- `extractText()`: 从 JSONL/事件中提取正文。
- `inspectEvent()`: 可选，用于捕获 session id、usage、cost、模型信息。
- `handleError()`: 可选，把常见 CLI 报错翻译成用户能理解的消息。
- `describe()`: 可选，给 `/agents` 和 UI 一句状态摘要。

实现原则：

- adapter 是 singleton，不要把每轮状态放在实例字段上。
- 每次 spawn 的临时文件、runId、cleanup 都放进 `SpawnPlan`。
- 支持 `opts.signal`，超时/取消时终止子进程。
- stdout 解析要容忍半行、多字节字符和非 JSON 行。
- stderr 不要原样泄露 token、路径和长堆栈给 IM 用户。

## 3. 注册与可发现

在 `src/core/registry.ts` 的 `loadBuiltInPlugins()` 中注册新 adapter。

还要同步所有用户入口：

| 位置 | 需要更新 |
|---|---|
| `src/core/onboarding.ts` | 安装提示、availability hint |
| `src/cli-ui/config-wizard.ts` | `AGENT_SPECS`、启用/禁用、默认 agent |
| `src/cli-ui/readiness.ts` | `AGENT_PRIORITY` 和 quickstart/doctor 检测 |
| `src/cli-ui/i18n.ts` | 中英文名称、安装、登录提示 |
| `src/web-app/src/routes/settings/agents.tsx` | Web 设置页 agent 元数据 |
| `src/web-app/src/lib/agent-label.ts` | 展示名 |
| `src/core/commands/model.ts` | 若支持 `/models`，添加 `ModelDriver` |
| `src/cli.ts` | IM 主入口 `onAgentResolved` 的原生 session 续接 |
| `README` / `docs` | 安装、登录、能力限制 |

注意：现在 agent 元数据散在后端、CLI、Web 多处。后续建议抽成统一 `agent-catalog`，减少漂移。接入前必须检查已有元数据是否已同步。

## 4. 会话续接

如果 agent 支持原生 session/thread/conversation，必须接入 Agim 的 sticky session。

需要确认：

- session id 是 Agim 预分配，还是 CLI 首轮返回。
- 首轮命令参数是什么。
- 后续续接命令参数是什么。
- 续接后是否还需要把 Agim history 传给 CLI。
- `/new` 是否必须清理该 agent 的原生 session id。

当前代码里每个 agent 的 session 字段是独立字段，例如 `claudeSessionId`、`codexSessionId`、`opencodeSessionId`。新增 agent 时通常要改：

- `src/core/types.ts`: `Session` 类型。
- `src/core/session.ts`: setter、保存、加载、`/new` 清理。
- `src/core/router.ts`: `onAgentSessionId` 持久化逻辑。
- `src/cli.ts`: `onAgentResolved` 把已保存的 session id 填回 `RouteContext.agentSessionId`。
- `prepareSubtaskAgentCallOptions()`: A2A 子任务是否需要续接。

长期建议把这些字段收敛成：

```ts
agentSessions?: Record<string, { id: string; primed?: boolean }>
```

这样后续接新 agent 不必改 Session schema。

## 5. 工作区与安全

所有能读写文件的 agent 都必须有工作区策略。

标准要求：

- IM 场景使用 `resolveAgentCwd(agentName, opts)`。
- 默认 cwd 为 `~/.agim-workspaces/<agent>/`。
- cwd 不存在时懒创建。
- 若 CLI 需要 `--workspace`、`--add-dir`、`--trust`，必须显式传入。
- 不能默认继承 systemd 下的 `/`。
- 不能污染用户终端里直接使用该 CLI 的全局项目记忆。
- 支持 `AGIM_<AGENT>_CWD` 覆盖。

Plan/read-only：

- 若 agent 有只读/plan 模式，把 `opts.planMode` 映射过去。
- 若不支持，只能用 sandbox、只读 cwd 或清楚声明不支持。
- 子 agent / A2A 调用必须继承 parent 的 planMode，不能在计划模式下放大权限。

高危工具：

- 若 agent 有 permission hook，接入 Agim approval bus。
- 若没有 permission hook，必须写明安全下限，比如 read-only、workspace-write、禁用 shell 或仅依赖 agent 自身策略。
- 不允许为了“好用”默认打开全自动无审批的高危模式，除非有显式 env opt-in 且 UI 文案说明风险。

## 6. 工具注入

接入新 agent 时必须判断工具注入能力，不支持也要明确记录。

### 6.1 Agim Agent

Agim Agent 走内部工具注册表：

```text
src/plugins/agents/agim-agent-shared/tool-registry.ts
src/plugins/agents/agim-agent/tool-bridge.ts
src/core/llm/agim-dispatcher.ts
```

它直接拿到 Agim 的 `ToolDef[] + dispatcher`，包括文件、Web、exec、todo、plan-exit、Agim tools、外部 MCP tools 等。

### 6.2 CLI agent

优先使用目标 CLI 的 MCP 或等价工具协议。若支持 MCP，通常要实现：

- `ensure-mcp-config.ts`: 将 Agim MCP sidecar 写入该 CLI 的配置。
- 每轮运行生成 `runId`。
- 注入 `AGIM_APPROVAL_SOCK`。
- 必要时注入 `AGIM_RUN_ID`。
- `approvalBus.registerRun(runId, ctx)`。
- 退出时 cleanup / unregister。
- 把 `threadId`、`platform`、`channelId`、`userId`、`parentJobId`、`callDepth`、`planMode` 透传到工具上下文。
- 把本轮实际 `cwd` 透传到 `RunContext.cwd`，让审批后的 `agim_bash` / `agim_write` / `agim_edit` 落在 agent 正在看的工作区。
- 若 MCP config 是每轮 inline 注入（例如 Qoder），直接把本轮 `AGIM_RUN_ID` 写进 inline JSON；若是用户级持久配置（例如 Kimi 的 `~/.kimi-code/mcp.json`），必须每轮刷新 agim server entry，不要用一次性 `mcpReady` 缓存，否则下一轮工具会拿到旧 runId。
- 如果目标 CLI 默认禁用了原生 `Bash` / `Edit` / `Write`，把 `mcp__agim__*` 放进 allowlist，并让 agent 使用 `agim_bash` / `agim_write` / `agim_edit` 走 Agim 审批后执行。不要为了“可写”直接解除原生 mutation 工具限制。

必须验证工具调用能回到正确 IM thread。最常见的事故是工具可见，但因为 runId/socket/env 过期，memo/reminder/ask_user 静默失败。

### 6.3 Extension / custom-tool bridge

如果目标 CLI 不支持 MCP，但支持 extension/custom tool（例如 PI），可以通过 Agim approval bus 做一层工具桥。

标准做法：

- adapter 每轮生成 `runId`，调用 `approvalBus.registerRun(runId, ctx)`。
- 子进程注入 `AGIM_APPROVAL_SOCK` 与 `AGIM_RUN_ID`。
- extension 注册 `mcp__agim__*` 工具，将 Skills、Memory、Memo、Reminder、Ask、Push、A2A、Goal 等请求转发到 bus。
- 只把明确安全的 native 只读能力做白名单别名，例如 `web_search` / `web_fetch` → `native_web_search` / `native_web_fetch`。
- 对写入/执行能力，不要直接放开目标 CLI 的原生 `bash` / `write` / `edit`。应注入 Agim 代理工具，例如 `agim_bash` / `agim_write` / `agim_edit`：先通过 approval bus 生成 `Bash` / `Write` / `Edit` 审批卡，用户同意后再调用 Agim native dispatcher（`native_exec` / `native_write_file` / 精确 edit）。这样敏感路径拦截、auto-allow、超时和审计都能复用。
- 不要把 `native_exec`、write/edit/bash、任意 MCP 工具泛化转发给 extension agent；需要逐项白名单、审批、沙箱和 UI 风险说明。
- 默认 `--tools` / allowlist 必须包含 extension 注册的工具名，否则 CLI 可能看得到 extension 但无法实际调用工具。

验收：

- agent 能列出并调用 Agim MCP/RPC 工具。
- agent 能调用已白名单的 native 只读工具。
- agent 能调用 Agim 代理写入/执行工具，并在用户审批后才真正执行。
- 缺失 `runId` 或过期 run 时工具返回清晰错误。
- 高危 native 工具默认不可见、不可调用。

### 6.4 不支持工具协议

如果目标 CLI 不支持 MCP/工具协议：

- 只能注入 prompt hint。
- 不能宣称支持 Agim tools。
- Web/CLI 应标注“仅对话桥接”或“工具能力受限”。
- 文档写清楚哪些能力不可用。

## 7. Skills、Memory、Memo 与上下文注入

这是最容易漏的层。Agim 的 agent 能力不只是工具列表，还包括每轮 prompt 注入和回复后的异步沉淀。

### 7.1 Router prompt 注入

`src/core/router.ts` 在每轮调用前会拼接：

```text
personaSnippet
goalSnippet
skillsSnippet
viewerHint
reminderContext
用户原始 prompt
```

新 adapter 必须确认：

- 没有丢掉 `augmentedPrompt`。
- 没有只使用 history 而忽略当前 prompt。
- 没有把注入内容写进持久 history，避免每轮重复膨胀。
- 如果 adapter 设置 `handlesAgimSkillsPrompt = true`，必须自己注入 Skills，且不能重复注入。

### 7.2 Skills

Skills 是三层 progressive disclosure：

- Tier 1: `buildSkillsSummary()` 每轮注入 skill 名称和描述。
- Tier 2: agent 通过 `mcp__agim__read_skill(name)` 读取完整 `SKILL.md`。
- Tier 3: skill body 里引用的 `scripts/`、`references/`、`assets/` 由 agent 的文件工具按需读取。

验收：

- Prompt 中能看到 `[agim skills available ...]`。
- `mcp__agim__list_skills` 可用。
- `mcp__agim__read_skill` 可用。
- `always: true` skill body 能被注入。
- 缺失依赖的 skill 会显示 unavailable reason。
- agent 会根据 description 主动读取相关 skill，而不是猜。

### 7.3 Memory / Persona

Memory 是长期用户事实与画像。

两条链路：

- Prompt: `buildPersonaSnippet()` 注入用户画像摘要。
- Tools: `memory_query`、`memory_save`、`memory_list`、`memory_delete`。

要求：

- 只有存在 `platform + userId` 且 memory 开启时才注入。
- 注入内容经过 prompt-injection sanitize。
- `memory_query` 必须按当前 IM 用户隔离，不能串用户。
- 每轮成功回复后，`memory-distill` 应异步提炼事实。
- agent 在用户提到“之前告诉过你”时应调用 `memory_query`。
- agent 学到长期偏好、身份、项目、关系等事实时可调用 `memory_save`，但不要滥用。

### 7.4 Memo

Memo 是用户显式记事，与 Memory 不同。

常用工具：

- `mcp__agim__save_memo`
- `mcp__agim__search_memos`
- `mcp__agim__update_memo`
- `mcp__agim__delete_memo`

要求：

- “帮我记一下”“我的车停在...”等场景能调用 memo 工具。
- 带地点/时间的 memo 能正确保存结构化字段。
- 查询时能按当前用户隔离。
- 不支持工具协议的 agent 不能承诺自动记事。

### 7.5 Goal / Reminder / Viewer

还要检查这些注入：

- Goal: 当前 thread active goal 会进入 prompt，agent 应围绕目标行动。
- Reminder: pending reminder context 会进入 prompt，agent 能看到提醒队列状态。
- Viewer: 长内容模式提示会进入 prompt，agent 应按 `<im-summary>` / `<full-md>` 等约定输出。

## 8. Agim MCP / RPC 工具清单

不同 agent 暴露方式可能不同，但能力层面要确认这些类别。

| 类别 | 代表工具 | 验收重点 |
|---|---|---|
| Skills | `list_skills` / `read_skill` | 能按需读取 `SKILL.md` 全文 |
| Memo | `save_memo` / `search_memos` / `update_memo` / `delete_memo` | 显式记事与召回 |
| Memory | `memory_query` / `memory_save` / `memory_list` / `memory_delete` | 长期用户事实和画像 |
| Reminder | `create_reminder` / `list_reminders` / `cancel_reminder` / `snooze_reminder` | 提醒创建、查询、取消、稍后提醒 |
| Ask user | `ask_user` | Agent 能通过 IM 结构化询问用户 |
| Push | `push_message` | Agent 能主动向当前 IM thread 发消息 |
| A2A / Subagent | `call_agent` / `call_agents` | CLI 父可派 Subagent（单路/批量 fan-out）；bus 带 parent/depth |
| Focus / Loop | `focus_*` / `loop_verdict` | **仅 Agim Agent**（CLI sidecar **不**暴露；`/loop` 请 sticky 到 Agim） |
| Location | `request_location_capture` 等 | 地点记忆闭环 |

注意命名：CLI MCP server 里工具名可能是 `read_skill`，在日志、审批和 native 工具面上常显示为 `mcp__agim__read_skill`。验收时看能力，不只看表面名称。

## 9. Model driver

如果 agent 支持模型列表和 per-call 模型切换，更新 `src/core/commands/model.ts`。

需要实现：

- `ModelDriver.label`
- `namespaced`
- `listModels()`
- `resolveDefault()`
- `switchHint`
- 注册到 `MODEL_DRIVERS`
- 加入 `SUPPORTED_AGENTS`
- adapter 的 `buildArgs()` 支持 `opts.model`

验收：

- `/models` 能列出模型。
- `/models <关键词>` 能过滤。
- `/model #序号` 能切换。
- `/model <名称>` 能切换。
- `/model reset` 行为合理。
- 当前 session 的 `model` 能被后续 agent 调用使用。

不支持模型切换的 agent，要给出友好提示，不能让用户以为命令坏了。

## 10. Web 与 CLI 体验

### CLI

必须验证：

- `agim go` 能识别该 agent 是否可用。
- `agim config` 能启用、禁用、设默认。
- `agim doctor` / readiness 能显示缺失或可用。
- `/agents` 能列出该 agent、kind、aliases、describe。
- 缺失 binary 时有安装提示。
- 未登录时有登录提示。

### Web

必须验证：

- 设置页能看到该 agent。
- 能启用/禁用。
- 能设置为默认 agent。
- 状态显示正确。
- Dashboard/footer 默认 agent 与配置一致。
- Chat agent picker 能切换。
- 不支持工具/模型/审批时有能力提示。
- 错误通过 toast/弹窗/友好文案展示，不直接暴露原始 stderr。

## 11. 测试清单

每个新 agent 至少补这些测试：

- adapter 参数构造。
- binary 探测成功/失败。
- JSONL 或纯文本输出解析。
- session id 捕获与续接。
- `/new` 清理原生 session。
- `opts.signal` 取消/超时。
- planMode 参数映射。
- cwd/workspace 参数。
- `approvalBus.registerRun()` 收到的 `ctx.cwd` 必须等于本轮 `SpawnPlan.cwd`。
- MCP config 写入，若支持工具。
- runId/socket/env 透传，若支持工具。
- approval bus 注册与 cleanup，若支持审批。
- Skills prompt 注入可见。
- `read_skill` / `list_skills` 可用。
- memory persona 注入可见。
- `memory_query` / `memory_save` 用户隔离。
- memo save/search 可用。
- A2A `call_agent` depth/parentJobId。
- A2A 子任务能续接该 agent 的原生 session/conversation。
- IM 主入口下一轮能把已保存的原生 session id 重新传给 adapter。
- model driver，若支持 `/models`。
- Web settings rows/default picker。
- 缺失安装/未登录错误文案。

建议使用 fake CLI fixture，而不是依赖真实第三方 CLI。fixture 应能模拟：

- `--version`
- 首轮输出 session id
- 续接输出
- JSONL 流式事件
- 非零退出
- stderr
- 模型列表
- 慢输出/取消

## 12. 验收定义

新 agent 只有同时满足下面条件，才算“完整接入”：

- 能从 Web 发第一条消息。
- 能从 IM 发第一条消息。
- 能被 `/agents` 发现。
- 能被启用/禁用。
- 能作为默认 agent。
- 缺失安装/未登录时提示清楚。
- 工作区不串到用户终端目录。
- `/new` 能清理当前 agent 的原生会话。
- 如果支持原生 session，能多轮续接。
- 如果支持模型，`/models` 和 `/model` 可用。
- 如果支持工具，Skills、Memory、Memo、Reminder、Ask、Push、A2A 能回到正确 IM thread。
- 如果不支持工具，UI 和文档明确标注能力受限。
- 高危工具能审批，或有明确安全下限。
- Plan/read-only 不会被子 agent 放大权限。
- 回复后的 memory distill 正常调度。
- 所有新增测试通过。

## 13. PR 切分建议

小 agent 可以一 PR 完成；复杂 agent 建议分四步：

1. 调研卡 + fake CLI fixture + adapter skeleton。
2. runtime adapter + registry + session/workspace。
3. tools/skills/memory/model + Web/CLI 配置入口。
4. docs + 完整验收 + release note。

不要把“调研不确定”的 agent 一次性塞进正式用户入口。可以先隐藏在 feature flag 或只注册 adapter，不进入默认 quickstart priority。

## 14. 后续基础设施优化

为后续批量接入主流 agent，建议优先抽象：

```ts
interface AgentCapabilityProfile {
  id: string
  displayName: string
  aliases: string[]
  kind: 'cli' | 'in-process' | 'remote'
  install: { command?: string; docs?: string }
  auth: { hint?: string; env?: string[] }
  binary?: { command: string; candidates?: string[]; envOverride?: string }
  sessions: 'none' | 'preallocated' | 'reported'
  models: 'none' | 'switch-only' | 'list-switch'
  tools: 'none' | 'prompt-only' | 'mcp' | 'native'
  approvals: 'unsupported' | 'agent-native' | 'agim-bus'
  workspace: 'none' | 'cwd' | 'trusted-workspace'
  safety: 'unknown' | 'read-only' | 'workspace-write' | 'approval-gated'
}
```

并把现在散落在 registry、CLI config wizard、readiness、Web settings、i18n、agent-label 的元数据收敛到一个 catalog。这样新增 agent 时，用户入口自动同步，Web 也能展示“完整 Agim 能力接入 / 工具能力受限 / 仅对话桥接”等状态。
