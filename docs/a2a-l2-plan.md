# A2A Layer 2 · Shared artifacts

> 目标：让 A2A 调用支持**文件传递**，不只是字符串往返。
> 起始日期：2026-05-15
> 当前分支：main（待开 feat/a2a-l2）
> 前置：L1 已上线（v1.1.2），生产已验证自然语言 + 显式 MCP 两条路径

---

## 为什么需要

L1 让 agent A 调 agent B：A 发字符串 prompt，B 返回字符串 result，A 接着推理。这覆盖**只读**场景（"用 codex 跑 git status" / "让 opencode 看下这段代码"），但碰到**带产物**的工作就别扭：

- A 让 B 改 100 行的文件 → 文件内容塞进 prompt 浪费 token，塞进 result 浪费 context
- A 让 B 跑数据查询输出 CSV → 没法直接传文件，只能让 B 把 CSV 内容贴回 result
- A 跑了一半攒了几个中间产物，想让 B 接着干 → 必须重新生成或全文贴

L2 的"啊哈"瞬间：**给每个 A2A 调用一个独立工作目录，agents 之间通过文件交换产物，A 读 B 写过的文件就跟读自己写的没区别**。

---

## 现状摸底（基于 L1 实战）

| 事实 | 出处 | 含义 |
|---|---|---|
| L1 已有 inline-job 行 + parent_id + call_depth | `jobs.db` (v1.1.2) | artifacts 用 job_id 当目录名是自然 key |
| 每个 agent 已有独立 cwd | `~/.agim-workspaces/<agent>/`（`core/agent-cwd.ts`）| 但 cwd 是**长期共享**的，不是 per-job 的 |
| sink + outbox 跟 artifacts 无关 | — | L2 不动投递层，只动 agent 工作目录 |
| audit 已记 `intent='a2a'` | `audit.db` (v1.1.2) | 可以在 audit 行加 artifact 大小列后续观察 |
| L1 callee 用 `agent.sendPrompt(\`a2a-${jobId}\`, prompt, [], opts)` | `core/a2a.ts` | 注入 prompt 前置块的入口在这里 |
| sidecar tool 已注册 `mcp__imhub__call_agent` | `mcp-approval-server.ts` | 扩展 inputSchema 加 inputs/outputs 字段 |

---

## 设计

### A. 目录布局

```
~/.agim/artifacts/
└── <job_id>/                  ← 一个 inline-job 一个目录
    ├── _agim-input/           ← caller 通过 inputs 复制进来的文件（只读语义）
    │   ├── data.csv
    │   └── design.md
    └── _agim-output/          ← callee 写产物，caller 读
        └── report.md
```

> 设计决策 6：原稿提到的 `_agim-scratch/` 已砍。临时中间文件让 callee 自己用 `/tmp` 即可，少一个心智负担。

**关键决策**：artifacts 放在 `~/.agim/artifacts/`（集中目录），不放在 callee 的 cwd 下：

- ✅ caller / callee 都用绝对路径，跨 agent 一致
- ✅ retention 跟 inline-job 表绑定，prune 简单
- ✅ 不污染 agent 的工作目录 / 长期记忆
- 缺点：callee 不能用相对路径"./report.md"读写 — agim 在 prompt 注入完整绝对路径解决

### B. tool 接口扩展（向后兼容）

```typescript
mcp__imhub__call_agent({
  agent: 'codex',
  prompt: '把 data.csv 转成 markdown 表格写到 report.md',
  // L2 新增 — 全部可选，旧调用 = 纯 L1 行为
  inputs?: Array<{
    name: string                  // 落在 callee artifacts/_agim-input/ 下的文件名
    /** 取数源 — 三选一 */
    fromCallerOutput?: string     // caller 自己 artifacts/_agim-output/ 下的文件名
    fromAbsolutePath?: string     // 绝对路径（caller 工作目录、临时文件等）
    content?: string              // 内联文本内容
  }>
  expectOutputs?: string[]        // 期望 callee 产出的文件名（验收清单；缺失则 result.warnings 列出，不强失败）
  timeoutMs?: number
}) → {
  ok: true,
  result: string,                 // L1 同款 — callee 的最终回复
  jobId: number,
  agent: string,
  durationMs: number,
  // L2 新增
  artifactsDir: '/root/.agim/artifacts/<jobId>',
  outputs: Array<{ name: string; bytes: number; mtime: string }>,
  warnings?: string[]             // 比如某 expectOutputs 没产出
} | { ok: false, error: string }
```

### C. Prompt 注入（让 callee 知道有这个目录）

agim 在 spawn callee 之前，自动给原 prompt 前置一段（不修改用户原意，只追加 envelope）：

```
[A2A workspace]
Your dedicated artifacts directory for this run:
  /root/.agim/artifacts/42/_agim-output/

Input files placed by the caller (under _agim-input/):
  - data.csv      (4.2 KB)
  - design.md     (1.1 KB)
Read with absolute paths.

Expected outputs (place in _agim-output/):
  - report.md

Anything you write under _agim-output/ will be visible to the caller after
you return.

---
<原 prompt 接在此处>
```

设计取舍：
- **绝对路径**而不是相对路径：跨 agent / 跨 cwd 都一致；agent 不需要 cd
- **outputs 是软验收**：缺失只是 warning，不当失败（更宽松，模型才不会因为"少了一个文件"就重试）

### D. retention

| 文件类 | 生命周期 | prune 触发 |
|---|---|---|
| `_agim-input/` | 跟 job 行同 | inline job 24h 后 + dir 一起删 |
| `_agim-output/` | 跟 job 行同 | 同上 |

artifacts.db 不另开 — 信息全在 jobs 行 + 文件系统 mtime 上。

### E. 多级嵌套（A → B → C）的产物传递

L1 已支持 `call_depth` 递增。L2 加：

- B 拿到 A 给的 inputs（来自 A 的 outputs）后，如果想给 C 用，**显式列出** —— `inputs: [{ name: 'data.csv', fromCallerOutput: 'data.csv' }]` 让 agim 从 B 的 outputs 复制到 C 的 inputs
- 不做"透明继承"：A 的 inputs 不自动到 B 不自动到 C，避免意外泄露 + 控制成本

### F. 大小护栏

| 配置 | 默认 | 作用 |
|---|---|---|
| `IMHUB_A2A_ARTIFACT_MAX_BYTES_PER_FILE` | 50 MB | 单个文件上限 |
| `IMHUB_A2A_ARTIFACT_MAX_BYTES_PER_JOB` | 200 MB | 一个 job artifacts dir 合计上限 |
| `IMHUB_A2A_ARTIFACT_MAX_FILES_PER_JOB` | 200 | 文件数上限 |

超限时 `inputs[*].content` 写入直接返回 `ok: false, error: 'artifact too large'`；callee 写超时由 OS fs 限制兜底（不再额外加 chroot 类 sandbox，单机 trust model 内）。

---

## 实施清单

### 必做（L2 v1）— 已全部落地 2026-05-15

- [x] `core/artifacts.ts` 新模块（24 单元测试覆盖）：
  - `getArtifactsDir(jobId)` / `ensureArtifactsDir(jobId)`
  - `copyInputs(jobId, inputs[], callerJobId?): Promise<{ name, bytes }[]>`
  - `listOutputs(jobId)` / `readOutput(jobId, name)`
  - `pruneArtifacts(jobId)` / `pruneArtifactsBatch(ids[])`
  - `statJob(jobId)` (用于未来 /a2a stats 扩展)
  - `buildEnvelope({ jobId, inputs, expectOutputs })` — 生成 prompt 前置块
- [x] `core/a2a.ts` callAgentByName 加 `inputs / expectOutputs`
  - copyInputs 在 spawn 前；ensureArtifactsDir 提前；artifacts 失败时 markJobFailed + 早返回（不浪费 tokens）
  - buildEnvelope → 拼接到 prompt 前
  - listOutputs 在 callee 完成后 + expectOutputs 软验收 → warnings
- [x] `sidecar/mcp-approval-server.ts` tool schema 加 inputs / expectOutputs + zod 校验 + 描述里加 L2 段
- [x] `bus.handleA2A` 透传 inputs / expectOutputs；`sendA2AResult` 序列化 artifactsDir / outputs / warnings；sidecar 端反序列化时按字段校验
- [x] `jobs.db` pruneOldJobs 收集 ids 后 `pruneArtifactsBatch(allIds)` 异步联动（fire-and-forget，失败只 log）
- [x] `/a2a tree <id>` 显示每个 row 下的 `📎 文件名 (大小)`

### 可选（L2 v1.5）

- [ ] Web UI 上 inline job 详情页 列 artifacts 文件 + 直接下载
- [ ] artifact diff（caller pre-call snapshot vs callee post-call）便于审计

### 不做（往 L3 推）

- ❌ 跨 thread 共享 artifacts
- ❌ 远端 artifacts（ACP agent 落本地）
- ❌ artifact 版本控制 / 历史

---

## 风险 / 取舍

| 风险 | 对策 |
|---|---|
| callee 误读其他 job 的 artifacts dir | 不做 chroot，靠 prompt 明确告知本 job 路径；agent 故意越权属于 agent 自身问题，单机 trust model |
| callee 把敏感数据写进 outputs，caller 读到 + 落盘 | retention 24h 限定；用户自己负责不让 callee 处理跨用户数据；workspace 白名单已挡跨租户 |
| 大文件爆盘 | 三道护栏（单文件 / 单 job / 文件数）|
| inputs 复制慢，spawn 延迟 | 复制时同 fs hard-link（不 cp），近乎零开销；只有跨 fs / 跨设备 fall back 到 cp |
| outputs 没产出时模型卡住等回包 | expectOutputs 不强失败，模型按自己节奏 return；warnings 提示用户 |
| 多级嵌套上下文丢失 | 显式 inputs 透传；每个 hop 独立 dir 反而帮模型隔离责任 |

---

## 工作量预估

| 块 | 时长 |
|---|---|
| artifacts.ts 模块 + 单测 | 0.5 天 |
| a2a.ts 接入 + envelope 注入 + retention 串联 | 0.5 天 |
| tool schema 扩展 + bus 透传 | 0.5 天 |
| /a2a tree 显示 outputs + 文档 | 0.5 天 |
| 端到端测试（claude→codex 改文件→claude 读）| 0.5 天 |

**总 ~2-3 天**。比 L1 略小（L1 ~3 天）。

---

## 跟 L1 的对比

| 维度 | L1 | L2 |
|---|---|---|
| 调用语义 | string in / string out | string in + files in / string out + files out |
| 是否需 callee 知道有此机制 | 否（自然语言触发即可）| 是（通过 prompt envelope 告知） |
| 适用场景 | 只读、问答、单步 | 改文件、跑长产出、多步流水线（手动编排）|
| 工作量 | ~3 天 | ~2-3 天 |
| 兼容性 | — | 完全向后兼容 L1（旧调用不传 inputs/outputs 行为不变） |

---

## 跨会话恢复指引

如果新会话要接力本工作：

1. 先读本文件 `docs/a2a-l2-plan.md`
2. 读 `docs/agent-to-agent-plan.md`（v1.1.2 时的总计划）了解 L1/L2/L3 全景
3. 看 `git log --oneline src/core/a2a.ts src/core/artifacts.ts` 看进度
4. 检查 retention：`ls ~/.agim/artifacts/ | wc -l` 应该跟 inline job 行数同量级

---

## 待讨论 / 用户决策点

1. **artifacts 目录布局** — 集中（`~/.agim/artifacts/`） vs 散落（per-agent cwd 下）：方案选了**集中**，是否同意？
2. **prompt envelope 注入** — 自动加 `[A2A workspace]` 前置块。简洁 vs 直白哪个更好？
3. **expectOutputs 验收** — 软（缺失只 warn）vs 硬（缺失算失败）：方案选了**软**，是否同意？
4. **大小上限** — 50 MB / 200 MB / 200 files 这套数字合理吗？
5. **多级嵌套传递语义** — 显式 `inputs.fromCallerOutput` vs 自动透传：方案选了**显式**，是否同意？
6. **scratch 是否真需要** — 增加心智负担。可以砍掉，让 callee 用临时目录即可？

每个决策都不是不可逆，但定下来再改成本远比一开始定对高。
