# Loop（开发闭环 · Phase C）

> **状态**：设计文档 · 未实现运行时（实现前以本文为准）。  
> **用户面命令**：`/loop`（推荐）。  
> **内部类型名（可选）**：`LoopRun` / `LoopSession`。  
> **关联**：[Focus](./focus.md)（硬依赖）· [Goals 废弃说明](../goals.md) · [Roadmap Phase C](../roadmap.md#phase-c--loop开发闭环) · [命名约定](../naming.md)

---

## 0. 一句话

**Focus** 管「盯什么」；**Loop** 管「围着 Focus，executor 改代码 + 只读 observer 判 continue / revise / stop」。

| 概念 | 职责 | 是否改仓库 |
|------|------|-----------|
| **Focus** | 聚焦文本 + on/off + 注入 | 否 |
| **Loop** | 多轮工程闭环（本文） | executor **是**；observer **否** |
| ~~Goal~~ | **已废弃** → 用 Focus | — |

**不是**：Heartbeat、子代理编排、把 Focus 做成「任务完成系统」。

---

## 1. 产品决策（已拍板）

| # | 决策 | 说明 |
|---|------|------|
| D1 | **Focus 单独成原语** | 自动注入 / 开启 / 关闭；见 [focus.md](./focus.md) |
| D2 | **废弃 goal** | `/goal`、`long_task`、`complete_goal` 迁到 Focus；完成语义不挂在 Focus 上 |
| D3 | **Phase C 叫 Loop** | 用户面 `/loop`；文档与 roadmap 统一用 Loop |
| D4 | **双角色** | Executor（可写）+ Observer（只读） |
| D5 | **Verdict** | `continue` \| `revise` \| `stop` |
| D6 | **Focus 与 Loop 开法** | 分步：先 focus 再 loop，结束**不**关 focus；直开：`/loop <text>` 代开 focus，结束 **focus off** |
| D7 | **与 Heartbeat 正交** | Loop 不复用 Heartbeat 调度 |

---

## 2. 用户面命令（目标形态）

```text
/focus …               # 见 focus.md
/loop <text>           # 或 /loop start <text>
/loop status
/loop stop
/loop pause | resume   # 可选，后置
```

**开 Loop（两种合法路径）**

| 当前 Focus | 命令 | 行为 | 结束时 Focus |
|------------|------|------|--------------|
| **已 on** | `/loop` 或 `/loop <note>` | 启动 Loop；`<note>` 只进 Loop 状态，**不改** Focus 正文 | **不** off（路径 A） |
| **未 on**（无内容或 off） | `/loop <text>`（**必填**） | 自动 `focus set <text>` + on，`openedFocus=true`，再开 Loop | **focus off**（路径 B） |
| **未 on** | `/loop` 无文本 | **拒绝**，提示补 `<text>` 或先 `/focus` |

**斜杠解析约定（实现时）**：`/loop …` 优先匹配 Loop；不再用 `/goal` 驱动工程闭环。

**兼容**：过渡期 `/goal` → Focus 提示；`/long` 若曾作别名，改为提示改用 `/loop`（实现阶段定）。

---

## 3. 架构关系

```text
┌─────────────────────────────────────────────────────────┐
│  Conversation / Session                                  │
│    Focus (on) ──注入正文──┐                               │
│                           ├──► 每轮 LLM 上下文            │
│    LoopRun ──注入状态─────┘   （两者叠加，非二选一）        │
│      ├─ 门禁：启动/续跑要求 Focus 保持 on                   │
│      ├─ Executor turn  → 改代码 / 跑测试 / 工具            │
│      └─ Observer turn  → 只读 → continue|revise|stop      │
└─────────────────────────────────────────────────────────┘
         │
         ▼ 可选
   Heartbeat / 子代理 / MCP …（不驱动 Loop 状态机）
```

### 3.1 「绑 Focus」是什么意思

**不是**「Loop 有自己的 focus，和用户 Focus 比谁大」。  
**是**：Loop 运行期间必须有 Focus **on**（可事先设好，或由 `/loop <text>` 代开）；用户把 Focus off/clear → **取消 Loop**。

| 层 | 注入什么 | SSOT |
|----|----------|------|
| Focus | title/body（盯什么） | thread 唯一 Focus 记录 |
| Loop | round、status、最近 verdict、`nextHint`、可选 start note | `LoopRun` |

同时存在时：**两层都注入**（Focus 正文 + Loop 状态）。正文只有 Focus 一份。

### 3.2 Focus 在 Loop 中的规则

| 规则 | 行为 |
|------|------|
| 启动 · 路径 A | Focus 已 on → 直接开 Loop，`openedFocus=false` |
| 启动 · 路径 B | Focus 未 on → `/loop <text>` 代开 Focus，`openedFocus=true` |
| 运行中 Focus off/clear（用户） | **取消 Loop** |
| 运行中改 Focus 文本 | 允许；下一轮以**当前 Focus**注入；记 `focus_updated` |
| `focusSnapshot` | 启动时拷贝，供 status/审计；**不覆盖**实时 Focus 注入 |
| Loop 结束 · `openedFocus=false` | **不**自动 Focus off（用户事先聚焦，继续聊） |
| Loop 结束 · `openedFocus=true` | **Focus off**（代开的临时锚点收掉注入；内容可保留） |

### 3.3 为何不用 Goal 当 Loop 载体

历史上「goal ≈ 聚焦」已被占用；若把完成/验收塞回 goal，会再次混淆。  
**Focus = 注意力；Loop = 闭环执行。** 完成判定属于 Loop（或未来独立 complete），**不属于 Focus**。

---

## 4. 角色与权限

### 4.1 Executor

- 普通 Agim Agent 能力：读改文件、跑命令、MCP、（策略允许时）子代理。
- 每轮开始注入：**Focus 正文（on）** + **Loop 状态**（round / 最近 verdict / `nextHint`）——叠加注入。
- 结束信号：本轮工具/回复收敛后 → 进入 Observer（或达步数上限）。

### 4.2 Observer（只读）

| 允许 | 禁止 |
|------|------|
| 读文件、`git diff` / `git status`、读日志 | 写文件、改配置 |
| 只读 shell（白名单） | 网络副作用、部署 |
| 输出结构化 verdict | 调用会突变状态的 MCP |

实现倾向：**独立 system 段 + 工具白名单**；与 executor 分 session 或分 turn policy。

### 4.3 Verdict

```ts
type LoopVerdict = {
  decision: "continue" | "revise" | "stop";
  summary: string;       // 给用户看的短摘要
  reasons?: string[];    // 可选要点
  nextHint?: string;     // continue/revise 时给 executor 的提示
};
```

| decision | 含义 | 下一动作 |
|----------|------|----------|
| `continue` | 方向对，未完成 | 下一轮 executor |
| `revise` | 偏了 / 质量不够 | 下一轮 executor + `nextHint` |
| `stop` | 够好或不可继续 | 结束 Loop；**不**改 Focus on/off |

用户 `/loop stop` 或达上限 → 强制 `stop`。

---

## 5. 状态机

```text
                  /loop start (Focus on)
                         │
                         ▼
                    ┌─────────┐
         ┌─────────►│ RUNNING │◄────────┐
         │          └────┬────┘         │
         │               │              │
         │         executor turn        │
         │               │              │
         │               ▼              │
         │        ┌────────────┐        │
         │        │ OBSERVING  │        │
         │        └─────┬──────┘        │
         │              │               │
         │     continue / revise ───────┘
         │              │
         │            stop / cancel / limit / focus-off
         │              │
         │              ▼
         │         ┌─────────┐
         └─────────│  ENDED  │
                   └─────────┘
```

可选：`PAUSED`（用户 pause 或会话休眠）——后置。

---

## 6. 持久化草图

路径倾向：`~/.agim/sessions/<sessionId>/loop.json`（或并入 session store 字段 `loop`）。

```ts
type LoopRun = {
  id: string;
  sessionId: string;
  /** 启动时 Focus 正文快照（审计/status）；实时注入仍读 thread Focus */
  focusSnapshot: string;
  /** true = 本次 Loop 代开/代打开了 Focus → 结束时 focus off */
  openedFocus: boolean;
  status: "running" | "observing" | "paused" | "ended";
  endReason?: "stop_verdict" | "user_stop" | "limit" | "focus_off" | "error";
  round: number;
  maxRounds: number;
  createdAt: number;
  updatedAt: number;
  lastVerdict?: LoopVerdict;
  timeline: Array<{
    at: number;
    kind: "executor" | "observer" | "user" | "system";
    summary: string;
  }>;
};
```

**Focus 本体**仍在 session 的 focus 字段（见 focus.md），不把聚焦正文只存在 Loop 里。

---

## 7. 与现有子系统边界

| 子系统 | 关系 |
|--------|------|
| **Focus** | 硬依赖；注入与 on/off 见 focus.md |
| **~~Goal / long_task / complete_goal~~** | 废弃；不参与 Loop |
| **Heartbeat** | 不驱动 Loop；Loop 不注册 Heartbeat job |
| **子代理 Phase B** | Executor 可按策略调用；Observer **默认禁止** fan-out |
| **goal-critic** | 可内化为 Loop 内「廉价 on-track」；**不能替代** Observer verdict |
| **Plan mode** | Loop 运行时默认拒绝进 plan，或 pause Loop（实现期二选一，倾向拒绝） |

---

## 8. 安全与资源

| 项 | 默认倾向 |
|----|----------|
| `maxRounds` | 有限（如 8～20，可配） |
| Observer 工具 | 白名单只读 |
| 每轮 wall time | 复用/对齐 agent 超时，可另设 `loopRoundTimeoutMs` |
| 并发 | **同一 session 至多一个** LoopRun |
| 费用 | 每轮 ≈ 2 次主模型；需在 `/loop status` 可见 round 数 |

---

## 9. 分阶段实现（建议）

| 阶段 | 内容 | 验收 |
|------|------|------|
| **C0** | Focus 运行时（迁移 goal）+ 废弃提示 | 见 [focus.md §7](./focus.md) |
| **C1** | `LoopRun` + `/loop` 路径 A/B + `openedFocus` 收尾 | 分步结束保留 focus；直开结束 focus off |
| **C2** | Executor ↔ Observer 交替 + verdict 解析 | 三态驱动状态机 |
| **C3** | Observer 只读强制（测试证明不能写） | 红队：observer 写文件失败 |
| **C4** | SPA：Focus 控件 + Loop 状态条 | 与 slash 一致 |
| **C5** | 可选 pause/resume、导出 timeline | 非阻塞 |

**本 PR 只落文档；C0+ 另开实现 PR。**

---

## 10. 非目标（本期）

- 多 agent 投票 / 委员会式 review  
- 自动开 PR / 自动 merge  
- 用 Heartbeat 定时「偷偷」跑 Loop  
- 把 Loop 做成第二个 Claude Code 产品壳  
- 在 Focus 上实现「任务完成勾选」  

---

## 11. 待实现期确认（不阻塞文档）

1. Observer：同模型不同 prompt，还是允许 `observerModel`？  
2. `revise` 是否强制插入用户确认？  
3. Focus off 时：cancel vs pause（文档倾向 **cancel**）。  
4. 路径 B：结束时 focus off 是只停注入，还是顺带 clear？（倾向 **只 off**）  
5. CLI 非 Web 会话是否完整支持 `/loop`。  

---

## 12. 文档维护

| 变更 | 更新 |
|------|------|
| 重命名用户命令 | 本文 + naming + roadmap |
| Focus 语义变更 | [focus.md](./focus.md) 优先 |
| 实现落地 | CHANGELOG + roadmap Phase C 勾选 |

**作者倾向**：Focus / Loop 拆分已按产品拍板写入；实现以 C0→C1 顺序，避免无 Focus 的 Loop。
