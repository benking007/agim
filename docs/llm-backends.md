# Agim Agent 大模型 API 配置指南

本页说明如何为 **Agim Agent**（registry id：`agim`，兼容别名 `native`）配置大模型 API。
目标：**只配一次就能跑**，角色绑定是可选优化项，不是阻塞条件。

## 1. 核心原则

- Agim Agent 只需要至少一个可用 backend（`baseUrl + model + apiKey`）。
- `llmRoles` 是可选策略层，用于精细路由（如 cheap/evaluator）。
- 未配置角色时，会自动回退到任意可用 backend。

## 2. 配置方式

建议优先用 `agim config`：

1. CLI 主入口：`agim config` → `Agim Agent 大模型 API`
2. Web：`/settings/llm`
3. CLI 高级命令：`agim setup llm`
4. 手工编辑 `~/.agim/config.json` + `~/.agim/llm-secrets.json`

> `agim setup llm add` 现在要求 API Key 必填；如果你走环境变量模式，也需要保证对应 backend 名称能解析到有效密钥来源。

## 3. 配置结构

### 3.1 `config.json`

```json
{
  "llmBackends": [
    {
      "name": "deepseek-v4-pro",
      "provider": "openai-compat",
      "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-v4-pro",
      "label": "deepseek"
    },
    {
      "name": "deepseek-v4-flash",
      "provider": "openai-compat",
      "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-v4-flash",
      "label": "deepseek"
    }
  ],
  "llmRoles": {
    "native-chat": "deepseek-v4-pro",
    "cheap": "deepseek-v4-flash",
    "finance": "deepseek-v4-pro",
    "evaluator": "deepseek-v4-flash"
  },
  "dispatchRoutes": {
    "codingAgents": ["codex", "claude-code"],
    "financeAgent": "agim",
    "dataAgent": "agim"
  },
  "defaultAgent": "agim"
}
```

> **任务派发速查（Settings → LLM）**：用下拉选择「编码 / 金融分析 / 批量采集」对应的 agent 与 backend。Backend 写入 `llmRoles.finance`（分析）与 `llmRoles.cheap`（采集）；**不硬编码 deepseek**——选你已配置的任意 backend。速查表注入 Agim 系统提示。SSOT：`src/core/dispatch-routes.ts`。

> **Recommended first-run:** `agim setup llm quick`（默认 DeepSeek / `deepseek-v4-pro`，粘贴 API Key 一键启用双模型）。Web `/settings/llm`、桌面聊天与 `/m/chat` 在 Agim 未配置时也会引导同一流程；可切换其他厂商预设。
>
> 一键启用后：backend **name = model ID**（可含 `.`，如 `kimi-k2.6`）；`label` 写入预设 key（如 `deepseek`）供分组与去重。

### 3.2 密钥文件（推荐）

`~/.agim/llm-secrets.json`

```json
{
  "version": 1,
  "keys": {
    "deepseek-v4-pro": "sk-xxxx",
    "deepseek-v4-flash": "sk-xxxx"
  }
}
```

> 该文件应为私有权限（仅当前用户可读写）。

### 3.3 环境变量密钥（可选）

格式：`AGIM_LLM_SECRET_<BACKEND_NAME_UPPER>`

例如 backend `deepseek-v4-pro`：

```bash
export AGIM_LLM_SECRET_DEEPSEEK_V4_PRO=sk-xxxx
```

环境变量优先级高于密钥文件。

## 4. 字段说明

| 字段 | 是否必需 | 说明 |
|---|---|---|
| `name` | 是 | backend 唯一标识（一键启用时通常等于 `model`） |
| `provider` | 是 | `openai-compat` 或 `anthropic` |
| `baseUrl` | 建议 | API 基地址 |
| `model` | 是 | 默认模型 ID |
| `label` | 否 | 预设分组键（`deepseek` / `moonshot` / `zhipu` / `mimo`）；自定义项不写 |
| `temperature` | 否 | 默认 0.2~0.3（OpenAICompat 探测/辅助路径使用） |
| `maxTokens` | 否 | 输出 token 上限 |
| `contextWindow` | 否 | Agim Agent 上下文窗口；未设时走厂商启发式或保守 32k |
| `thinkingFormat` | 否 | `off` / `deepseek` / `openai`；自定义网关显式声明思考协议（见 §4.1） |
| `maxTokensField` | 否 | `max_tokens` / `max_completion_tokens` |
| `extraHeaders` | 否 | 额外 HTTP Header（勿覆盖 Authorization） |
| `enabled` | 否 | 软开关，默认启用 |

> Web「添加 API → 自定义」默认只填身份字段；折叠 **高级参数** 可配置上表可选项，也可一键套用 DeepSeek / Kimi K3 / MiMo 兼容模板。

### 4.1 `thinkingFormat` 语义

| 值 | 行为 |
|---|---|
| （未设） | 按 `baseUrl` / 模型 ID / catalog 启发式启用思考（DeepSeek / Kimi / GLM / MiMo） |
| `deepseek` | 强制 `thinking.type` + `reasoning_content` 兼容（GLM / MiMo / Kimi K2 等） |
| `openai` | 强制 `reasoning_effort` 兼容（如 Kimi K3） |
| `off` | 关闭思考：`reasoning=false`，并清除 catalog/厂商的 thinking compat 与 level map；仍可单独设置 `maxTokensField` |

`GET /api/llm` 会原样返回 `off`（勿用 truthy 判断丢弃）。

## 5. 内置预设（一键启用）

| key | 品牌 | 主模型 / 廉价模型 | baseUrl | 思考协议 |
|---|---|---|---|---|
| `deepseek`（默认） | DeepSeek | `deepseek-v4-pro` / `deepseek-v4-flash` | `https://api.deepseek.com` | deepseek |
| `moonshot` | Kimi | `kimi-k3` / `kimi-k2.6` | `https://api.moonshot.cn/v1`（国际站可改 `api.moonshot.ai`） | K3: openai；K2: deepseek |
| `zhipu` | 智谱 GLM | `glm-5.2` / `glm-4.7-flash` | `https://open.bigmodel.cn/api/paas/v4` | deepseek（5.2 带 effort） |
| `mimo` | 小米 MiMo | `mimo-v2.5-pro` / `mimo-v2.5` | `https://api.xiaomimimo.com/v1` | deepseek |
| `custom` | 自定义 | 自填 | 自填 | 高级参数中显式声明 |

OpenAI / Anthropic **不再**作为内置预设；用 `custom` 填入兼容 `baseUrl` 即可。

### 5.1 去重与删除

- 每个内置预设只允许添加一次：匹配 `label` **或** 同一厂商 host 族（例如 Kimi 的 `api.moonshot.cn` ↔ `api.moonshot.ai`；智谱 `bigmodel.cn` ↔ `api.z.ai`）。
- Web 下拉对已添加预设显示「（已添加）」并禁用；二次 `quick-enable` / `POST /api/llm/quick-enable` 返回 conflict。
- 设置页按品牌分组；删除为**组级**（一次移除该 `label` 下全部 backend + 角色绑定），不是单行删除。
- `GET /api/llm` 会对 `extraHeaders` 中的 `Authorization` / `api-key` / `x-api-key` 等敏感值脱敏为 `***`；写入时禁止带 `Authorization`（密钥走 `apiKey` / `llm-secrets.json`）。

### 5.2 其他兼容网关示例

| 平台 | provider | baseUrl 示例 |
|---|---|---|
| Qwen 兼容网关 | openai-compat | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Ollama | openai-compat | `http://localhost:11434/v1` |
| vLLM | openai-compat | `http://localhost:8000/v1` |
| 自定义 OpenAI / Anthropic 兼容 | openai-compat / anthropic | 例如 `https://api.openai.com/v1` 或 `https://api.anthropic.com` |

### 5.3 URL 安全（SSRF）

写入 `baseUrl`（以及 MCP HTTP URL）时会走共享 `assertSafeUrl` 校验：拒绝非 http(s)、userinfo、解析到私网 / 回环 / 链路本地 / 云 metadata 的地址。

| 场景 | 做法 |
|------|------|
| 公网 HTTPS API | 直接配置即可 |
| 本机 Ollama / 局域网 vLLM | 启动前设 `AGIM_URL_ALLOW_PRIVATE=1`（或开发用 `AGIM_ACP_ALLOW_LOOPBACK=1`） |
| DNS 解析失败 | 配置保存失败（fail-closed）；检查主机名是否可达 |

组删除：设置页按品牌删组时走 `DELETE /api/llm/backends?label=` / `?names=`（原子事务），不必逐条 DELETE。

## 6. 角色绑定（可选）

常见角色：

- `cheap`：低成本任务（摘要、分类、日常推理）
- `evaluator`：通知评估等判定任务
- `native-chat`：指定聊天主角色（可选）

一键启用时：`native-chat` → 主模型，`cheap` / `evaluator` → 廉价模型（若有）。

即使不配置这些角色，只要有可用 backend，Agim Agent（`agim`）仍可运行。

## 7. 常用 CLI

```bash
agim config
# → 选择 "Agim Agent 大模型 API"

agim setup llm
agim setup llm quick          # 一键启用（默认 DeepSeek）
agim setup llm native-enable  # 历史子命令名；效果是启用 Agim Agent + 绑定角色
agim diag llm
```

## 8. 运行时行为

当收到 Agim Agent 请求（`agim` / 别名 `native`）时：

1. 先尝试角色绑定对应 backend（如果有）。
2. 若角色无可用项，自动回退到任意已配置且可用 backend。
3. 若仍无可用 backend，返回配置引导错误。

Composer「思考开」与 effort 会按当前 backend 的思考协议映射到 pi-ai（`reasoning_effort` 或 `thinking.type`）。

## 9. 排障

### 9.1 提示“no usable LLM backend configured”

排查顺序：

1. `llmBackends` 是否至少有一项
2. 对应 API key 是否存在（环境变量或 secrets 文件）
3. `baseUrl` 是否可访问；本机/私网是否已设 `AGIM_URL_ALLOW_PRIVATE=1`
4. `model` 是否存在/可用
5. 保存时报 SSRF / `dns_failed`：见 §5.3

### 9.2 刚保存配置但 Agim Agent 仍不可用

一般无需重启；若仍异常：

- 执行 `agim diag llm` 检查每个 backend 健康状态
- 查看服务日志确认是否加载到新配置

### 9.3 角色绑定写错

角色不是硬依赖。
只要 backend 有一个可用，Agim Agent 依然可跑；修复角色绑定用于优化而非解阻塞。

### 9.4 预设显示「已添加」但仍想重配

先在设置页删除该品牌组，再重新一键启用（会写入新的密钥与角色绑定）。

## 10. 最小上线建议

1. 先一键启用 DeepSeek（或任选内置预设）
2. 验证 Agim Agent（Web 对话或 `/agim`）能跑通
3. 需要时再在 Composer 切换模型 / 调整思考强度
4. 自定义网关用「高级参数」声明思考协议与 context

## 11. 相关文档

- 上下文预算（晚压 / 清 tool / 中途 compact / 会话压缩率）：`agim-agent-context-budget.md`
- 架构立场：`architecture-bridge-and-agim-agent.md`
- 部署：`deployment.md`
- 安全：`security-hardening.md`
- 版本变更：`../CHANGELOG.md`
