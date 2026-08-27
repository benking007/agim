# Agent specialty profiles（派工能力画像）

> **状态**：现行 · 2026-07-28  
> **用户面**：Settings → Agents →「派工能力画像（CLI / Agim backend）」  
> **消费方**：Agim Agent **系统提示**（完整目录 + capability caps）+ `call_agent` / `call_agents` **工具说明**（短提示指向目录）  
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
| `capabilities` | **结构化能力维度**（见 §1.1） |
| `capabilityNotes?` | 维度备注（如 finance=`非专长`） |

新增内置 CLI adapter 时：在 `DEFAULT_AGENT_PROFILES` 补一条默认画像（含 capabilities）（见 [`agent-integration-sop.md`](../agent-integration-sop.md)）。

### 1.1 能力维度（CLI 与 Agim backend 共用刻度）

| dim | 含义 | 示例（强） |
|-----|------|-----------|
| `coding` | 编码/重构 | codex / claude-code |
| `finance` | 金融分析 | deepseek-v4-pro（中文金融语料） |
| `zhWriting` | 中文长文写作 | deepseek / kimi（母语级） |
| `reasoning` | 多步推理 | codex / deepseek / claude |
| `dataCheck` | 数据校验 | codex / deepseek |

等级：`strong` \| `medium` \| `weak`。

**对比示例（内置启发式）**：

| 能力 | codex（CLI） | deepseek-v4-pro（Agim backend） |
|------|--------------|--------------------------------|
| 编码/重构 | 强 | 中 |
| 金融分析 | 中（非专长） | **强**（中文金融语料丰富） |
| 中文长文写作 | 中（翻译腔明显） | **强**（母语级） |
| 多步推理 | 强 | **强** |
| 数据校验 | 强 | 强 |

- CLI 画像：`config.agentProfiles` / `src/core/agent-profiles.ts`  
- Backend 画像：按 `llmBackends.name`+`model` 启发式（`src/core/backend-profiles.ts`），稀疏覆盖 `config.backendProfiles`  
- Prompt catalog **同时**列出 CLI（`agent=`）与 backends（`backend=`），带 `caps: coding=strong finance=medium(非专长) …`

---

## 2. 配置与 API

### 2.1 稀疏覆盖

`~/.agim/config.json` 只存相对默认有改动的项：

```json
{
  "agentProfiles": {
    "codex": {
      "summary": "自定义一句话",
      "capabilities": { "coding": "strong", "finance": "medium" },
      "capabilityNotes": { "finance": "非专长" },
      "strengths": ["…"],
      "avoid": ["…"],
      "tags": ["code", "fix"]
    }
  },
  "backendProfiles": {
    "deepseek-v4-pro": {
      "capabilities": { "coding": "medium", "finance": "strong", "zhWriting": "strong" },
      "capabilityNotes": { "finance": "中文金融语料丰富", "zhWriting": "母语级" }
    }
  }
}
```

- 未出现的 CLI Agent → 用内置默认  
- 未出现的 backend → 用 name/model 启发式  
- 未知 CLI id / Agim id → 忽略  
- Settings 保存：生效值 → 稀疏 overrides

### 2.2 REST

| 方向 | 行为 |
|------|------|
| `GET /api/config` | `agentProfiles` / `backendProfiles` = **生效值**；另附 `agentProfileDefaults` / `backendProfileDefaults` |
| `PUT /api/config` | 接受完整生效表；服务端写成稀疏 overrides；忽略 `*Defaults` 回传 |

Schema：`src/core/config-schema.ts`（`agentProfiles` + `backendProfiles`）。

### 2.3 Settings UI

Settings → Agents：

1. **派工能力画像（CLI）** — 维度评分 + summary / strengths / avoid / tags  
2. **派工能力画像（Agim backend）** — 已配置 `llmBackends` 的维度评分（空则提示先去 LLM 页添加）

i18n：`settings` 命名空间（zh/en）。

---

### 2.4 任务派发速查（与画像互补）

Settings → **LLM → 任务派发速查**：三行下拉（编码 agent；金融 agent+backend；采集 agent+backend）。

| 任务 | Agent | Backend 绑定 |
|------|-------|----------------|
| 编码 / 修 bug | `dispatchRoutes.codingAgents`（默认 codex / claude-code） | — |
| 中文金融分析 / 报告 | `dispatchRoutes.financeAgent`（默认 agim） | `llmRoles.finance` |
| 批量采集 / 行情 | `dispatchRoutes.dataAgent`（默认 agim） | `llmRoles.cheap` |

未绑定 backend 时，prompt 只提示去 Settings 选择，**不会捏造 deepseek 等厂商名**。  
实现：`src/core/dispatch-routes.ts` · 注入：`getDispatchCheatSheetForPrompt()` → `buildSubagentDelegationGuidance`。

---

## 3. 运行时注入（两层，勿混）

| 层 | 内容 | 落点 |
|----|------|------|
| **系统提示（完整目录）** | 派发速查表 + `getAgentProfilesCatalogForPrompt()` | Agim `buildSystemPrompt` / 委派启发式（`subagent-heuristics`） |
| **工具 description（短提示）** | 有目录时追加一句「按 specialty fit 选 `agent=`；详见 system catalog」 | `mcp__agim__call_agent` / `mcp__agim__call_agents` |

设计意图：

- **完整目录只进 system**，避免把长 catalog 塞进每个 tool schema（token / 体积）。  
- 工具侧只提醒「要按画像选」，模型去读 system 里的 catalog。  
- 目录只列出 **已启用 ∩ 此刻可派** 的非 Agim CLI；`agents` 为空时不再倒全部内置 id。  
- system 另注入 **live preferred picks**：按 `caps` 维排序（strong > medium > weak）；编码维同分优先 CLI。

伪代码：

```text
effective = merge(DEFAULT_AGENT_PROFILES, config.agentProfiles)
catalog   = format(effective, enabled ∩ available)   // skip Agim; never dump all builtins
picks     = rank(caps, coding prefers CLI)
system   += Subagent heuristics + live picks + cheat sheet + catalog
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
| **Loop 派工** | 父在 DISPATCH 时按 live picks / catalog 选 Subagent | 运行时按维排序写入 prompt；仍不是硬切模型 |
| **可用性** | — | 登录/订阅/`spawn` 失败仍靠探测与 quarantine；画像≠「已登录」 |
| **Sticky handoff** | — | `/cc` 换主会话不是 Subagent，不读画像派工 |

产品立场（现行）：**Agim 编排，CLI 当工人**。画像服务这一立场；「某 CLI 当完整 Loop 父」不在本文范围。

交叉：

- 拆解与「要不要派」→ [`subagent.md`](./subagent.md) §5（§5.3 含 specialty 一步）  
- Loop 状态机 / 门禁 → [`loop-engineering.md`](./loop-engineering.md)  
- 阶段勾选 → [`orchestration-roadmap.md`](./orchestration-roadmap.md)

---

## 5. 非目标（本轮）

- 硬切模型的 coding router（看图已有硬路由；编码仍由父规划后 `call_agent`）  
- 把完整 catalog 塞进每个 `call_agent(s)` tool JSON schema（live picks 只进 system）  
- 为 Agim **编排者本身**建 specialty 行（工人用 backend= / agent=）  
- 用画像代替 CLI auth / version 探测  
- Portal `/`「子代理」脚手架句自动展开某 Agent 名（仍是引导句；真实选型靠父模型 + catalog）

---

## 6. 验收要点

- 默认 10 个非 Agim id 均有 builtin profile  
- Settings 改 `codex.summary` → 稀疏写入 → GET 生效值变、其余保持默认  
- Agim system prompt 含 live preferred picks + 可派 CLI catalog（不倒全部 builtin id）  
- `call_agent` / `call_agents` description 含 specialty-fit 短提示（非全文 dump）  
- 单测：`src/core/agent-profiles.test.ts`；Settings：`agents.test.tsx`

---

## 7. TL;DR

> **画像 = Agim 派 CLI Subagent 时的「谁擅长什么」目录。**  
> Settings 可改；稀疏落盘；**全文进 system，工具只点一句。**  
> **任务派发速查**（§2.4）= 「这类任务默认派谁」：编码 CLI / 金融与采集用 Agim+已绑 backend；下拉配置，不硬编码厂商。  
> 适合谁 ≠ 能不能用；Loop/Subagent 仍走既有门禁与 brief。
