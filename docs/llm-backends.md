# Native LLM 配置指南

本页说明如何为 Agim 配置 `native` agent 的 LLM 后端。
目标：**只配一次就能跑**，角色绑定是可选优化项，不是阻塞条件。

## 1. 核心原则

- `native` 只需要至少一个可用 backend（`baseUrl + model + apiKey`）。
- `llmRoles` 是可选策略层，用于精细路由（如 cheap/evaluator）。
- 未配置角色时，`native` 会自动回退到任意可用 backend。

## 2. 配置方式

你可以任选一种方式：

1. Web：`/settings/llm`
2. CLI：`agim setup llm`
3. 手工编辑 `~/.agim/config.json` + `~/.agim/llm-secrets.json`

## 3. 配置结构

### 3.1 `config.json`

```json
{
  "llmBackends": [
    {
      "name": "deepseek-main",
      "provider": "openai-compat",
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "deepseek-chat",
      "temperature": 0.2,
      "maxTokens": 2048
    }
  ],
  "llmRoles": {
    "cheap": "deepseek-main",
    "evaluator": "deepseek-main"
  }
}
```

### 3.2 密钥文件（推荐）

`~/.agim/llm-secrets.json`

```json
{
  "version": 1,
  "keys": {
    "deepseek-main": "sk-xxxx"
  }
}
```

> 该文件应为私有权限（仅当前用户可读写）。

### 3.3 环境变量密钥（可选）

格式：`AGIM_LLM_SECRET_<BACKEND_NAME_UPPER>`

例如 backend `deepseek-main`：

```bash
export AGIM_LLM_SECRET_DEEPSEEK_MAIN=sk-xxxx
```

环境变量优先级高于密钥文件。

## 4. 字段说明

| 字段 | 是否必需 | 说明 |
|---|---|---|
| `name` | 是 | backend 唯一标识 |
| `provider` | 是 | `openai-compat` 或 `anthropic` |
| `baseUrl` | 建议 | API 基地址 |
| `model` | 是 | 默认模型 ID |
| `temperature` | 否 | 默认 0.2~0.3 |
| `maxTokens` | 否 | 输出 token 上限 |
| `enabled` | 否 | 软开关，默认启用 |

## 5. 推荐 provider 示例

| 平台 | provider | baseUrl 示例 |
|---|---|---|
| OpenAI | openai-compat | `https://api.openai.com/v1` |
| DeepSeek | openai-compat | `https://api.deepseek.com/v1` |
| Moonshot/Kimi | openai-compat | `https://api.moonshot.cn/v1` |
| Qwen 兼容网关 | openai-compat | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Ollama | openai-compat | `http://localhost:11434/v1` |
| vLLM | openai-compat | `http://localhost:8000/v1` |
| Anthropic | anthropic | `https://api.anthropic.com` |

## 6. 角色绑定（可选）

常见角色：

- `cheap`：低成本任务（摘要、分类、日常推理）
- `evaluator`：通知评估等判定任务
- `native-chat`：指定聊天主角色（可选）

即使不配置这些角色，只要有可用 backend，`native` 仍可运行。

## 7. 常用 CLI

```bash
agim setup llm
agim setup llm native-enable
agim diag llm
```

## 8. 运行时行为

当收到 `native` 请求时：

1. 先尝试角色绑定对应 backend（如果有）。
2. 若角色无可用项，自动回退到任意已配置且可用 backend。
3. 若仍无可用 backend，返回配置引导错误。

## 9. 排障

### 9.1 提示“no usable LLM backend configured”

排查顺序：

1. `llmBackends` 是否至少有一项
2. 对应 API key 是否存在（环境变量或 secrets 文件）
3. `baseUrl` 是否可访问
4. `model` 是否存在/可用

### 9.2 刚保存配置但 native 仍不可用

一般无需重启；若仍异常：

- 执行 `agim diag llm` 检查每个 backend 健康状态
- 查看服务日志确认是否加载到新配置

### 9.3 角色绑定写错

角色不是硬依赖。
只要 backend 有一个可用，native 依然可跑；修复角色绑定用于优化而非解阻塞。

## 10. 最小上线建议

1. 先配一个稳定 backend（例如 `deepseek-main`）
2. 验证 `native` 能跑通
3. 再逐步添加 `cheap/evaluator` 角色绑定
4. 最后增加第二 backend 做冗余

## 11. 相关文档

- 架构立场：`architecture-bridge-and-native.md`
- 部署：`deployment.md`
- 安全：`security-hardening.md`
- 版本变更：`../CHANGELOG.md`
