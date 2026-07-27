# Agent specialty profiles（派工能力画像）

> **状态**：现行 · 2026-07-27  
> **用户面**：Settings → Agents →「派工能力画像」  
> **消费方**：Agim Agent **系统提示**（完整目录）+ `call_agent` / `call_agents` **工具说明**（短提示指向目录）  
> **关联**：[Subagent](./subagent.md) · [Loop](./loop-engineering.md) · [编排路线图](./orchestration-roadmap.md) · [命名](../naming.md) · [接入 SOP](../agent-integration-sop.md)

## 0. 一句话

**非 Agim 的 CLI Agent 各有擅长；画像告诉 Agim「该派谁干活」。**  
Agim Agent 是编排者（Loop 父 / `call_agents` 调用方），**不在**画像列表里。

画像负责「适合谁」；可用性探测 / 登录态负责「能不能用」——二者叠加，互不替代。

---

## 1. 覆盖的 Agent

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

内置默认：`src/core/agent-profiles.ts`（`DEFAULT_AGENT_PROFILES` / `NON_AGIM_AGENT_IDS`）。  
每个画像字段：

| 字段 | 含义 |
|------|------|
| `summary` | 一句话定位（Settings + prompt） |
| `strengths[]` | 擅长什么 |
| `avoid[]` | 不宜派什么 |
| `tags[]` | 短标签（匹配 / UI） |

新增内置 CLI adapter 时：在 `DEFAULT_AGENT_PROFILES` 补一条默认画像（见 [`agent-integration-sop.md`](../agent-integration-sop.md)）。

---

## 2. 配置与 API

### 2.1 稀疏覆盖

`~/.agim/config.json` 只存相对内置默认有改动的项：

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
- 未知 id / Agim id → 忽略（写入时规范化到 `NON_AGIM_AGENT_IDS`）  
- Settings 保存：生效值 → `agentProfileOverridesFromEffective` → 只持久化差异

### 2.2 REST

| 方向 | 行为 |
|------|------|
| `GET /api/config` | `agentProfiles` = **生效值**（defaults ⊕ overrides）；另附 `agentProfileDefaults` 供「恢复默认」 |
| `PUT /api/config` | 接受完整生效表；服务端写成稀疏 `agentProfiles`；忽略客户端回传的 `agentProfileDefaults` |

Schema：`src/core/config-schema.ts`（`agentProfiles` record）。

### 2.3 Settings UI

Settings → Agents →「派工能力画像」：按 Agent 手风琴编辑 `summary` / strengths / avoid / tags；可单项重置为默认。  
i18n：`settings` 命名空间（zh/en）。

---

## 3. 运行时注入（两层，勿混）

| 层 | 内容 | 落点 |
|----|------|------|
| **系统提示（完整目录）** | `getAgentProfilesCatalogForPrompt()` → `formatAgentProfilesForPrompt` | Agim `buildSystemPrompt` / 委派启发式（`subagent-heuristics`） |
| **工具 description（短提示）** | 有目录时追加一句「按 specialty fit 选 `agent=`；详见 system catalog」 | `mcp__agim__call_agent` / `mcp__agim__call_agents` |

设计意图：

- **完整目录只进 system**，避免把长 catalog 塞进每个 tool schema（token / 体积）。  
- 工具侧只提醒「要按画像选」，模型去读 system 里的 catalog。  
- 目录优先列出 `config.agents` **已启用**的非 Agim CLI；若 `agents` 为空则列出全部内置 id（兜底）。

伪代码：

```text
effective = merge(DEFAULT_AGENT_PROFILES, config.agentProfiles)
catalog   = format(effective, enabledAgents=config.agents)   // skip Agim
system   += Subagent heuristics + catalog
toolDesc += "Prefer agent= by specialty fit (see system specialty catalog)."
```

实现文件：

- `src/core/agent-profiles.ts` — 默认 / 合并 / 格式化 / live 读取  
- `src/core/subagent-heuristics.ts` — 委派指引挂载 catalog；tool 短提示  
- `src/plugins/agents/agim-agent-shared/` · `src/core/llm/agim-dispatcher.ts` — 注入调用点  
- `src/web/config-api.ts` — GET/PUT 合同

---

## 4. 与 Loop / Subagent / 探测的边界

| 能力 | 画像做什么 | 不做什么 |
|------|------------|----------|
| **Subagent 跨 adapter** | 指引父模型选 `claude-code` / `codex` / … | 不替代 brief 四件套；不同族 spawn 规则 |
| **Loop 派工** | 父在 DISPATCH 时按 fit 选 Subagent | 不强制硬匹配分数；无结构化 scorer（后续可选） |
| **可用性** | — | 登录/订阅/`spawn` 失败仍靠探测与 quarantine；画像≠「已登录」 |
| **Sticky handoff** | — | `/cc` 换主会话不是 Subagent，不读画像派工 |

产品立场（现行）：**Agim 编排，CLI 当工人**。画像服务这一立场；「某 CLI 当完整 Loop 父」不在本文范围。

交叉：

- 拆解与「要不要派」→ [`subagent.md`](./subagent.md) §5（§5.3 含 specialty 一步）  
- Loop 状态机 / 门禁 → [`loop-engineering.md`](./loop-engineering.md)  
- 阶段勾选 → [`orchestration-roadmap.md`](./orchestration-roadmap.md)

---

## 5. 非目标（本轮）

- 结构化能力打分 / 自动 ranking API（prompt catalog 已够用）  
- 把完整 catalog 塞进每个 `call_agent(s)` tool JSON schema  
- 为 Agim 自身建 specialty 行  
- 用画像代替 CLI auth / version 探测  
- Portal `/`「子代理」脚手架句自动展开某 Agent 名（仍是引导句；真实选型靠父模型 + catalog）

---

## 6. 验收要点

- 默认 10 个非 Agim id 均有 builtin profile  
- Settings 改 `codex.summary` → 稀疏写入 → GET 生效值变、其余保持默认  
- Agim system prompt 含 `CLI Subagent specialty catalog` 且优先已启用 agents  
- `call_agent` / `call_agents` description 含 specialty-fit 短提示（非全文 dump）  
- 单测：`src/core/agent-profiles.test.ts`；Settings：`agents.test.tsx`

---

## 7. TL;DR

> **画像 = Agim 派 CLI Subagent 时的「谁擅长什么」目录。**  
> Settings 可改；稀疏落盘；**全文进 system，工具只点一句。**  
> 适合谁 ≠ 能不能用；Loop/Subagent 仍走既有门禁与 brief。
