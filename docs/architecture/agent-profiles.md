# Agent specialty profiles（派工能力画像）

> **状态**：现行 · 2026-07-27  
> **用户面**：Settings → Agents →「派工能力画像」  
> **消费方**：Agim Agent 系统提示 + `call_agent(s)` 工具说明（Loop 父编排选 Subagent）

## 一句话

**非 Agim 的 CLI Agent 各有擅长；画像告诉 Agim 该派谁干活。**  
Agim Agent 是编排者，不在画像列表里。

## 覆盖的 Agent

| id | 默认定位（摘要） |
|----|------------------|
| `claude-code` | 复杂推理与工程改造 / review |
| `codex` | 短平快改码与定位 |
| `copilot` | GitHub 生态编码与 PR 协作 |
| `opencode` | 编码 + git + 测试 + devops |
| `antigravity` | Gemini / 检索综合 / 多模态 |
| `cursor` | IDE / 代码库感知编辑 |
| `kimi-code` | 中文友好与长上下文编码 |
| `qoder` | 通用编码实现与修补 |
| `pi` | 轻量会话与脚本试探 |
| `mimo` | 通用编码 CLI |

内置默认：`src/core/agent-profiles.ts`（`DEFAULT_AGENT_PROFILES`）。

## 配置

`~/.agim/config.json` 稀疏覆盖：

```json
{
  "agentProfiles": {
    "codex": {
      "summary": "自定义一句话",
      "strengths": ["…"],
      "avoid": ["…"],
      "tags": ["code", "fix"]
    }
  }
}
```

- 未出现的 Agent → 用内置默认  
- Settings 保存时：只持久化相对默认有改动的项  
- GET `/api/config` 返回 `agentProfiles`（生效值）+ `agentProfileDefaults`（恢复默认用）

## 运行时

- `getAgentProfilesCatalogForPrompt()` 读 live config，注入 Agim 系统提示  
- 优先列出 `config.agents` 已启用的 CLI  
- 与可用性探测 / preferred worker 叠加：画像负责「适合谁」，探测负责「能不能用」
