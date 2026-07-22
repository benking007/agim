# Agim Agent 上下文预算（清 tool + 晚压）

本文说明 Agim Agent（`agim`）如何在长对话中控制上下文：先清可重取的 tool 结果，再在接近窗口上限时做 transcript 压缩。目标是 **晚压省 summary 成本**，同时用廉价的 L1 清理 + 紧急清理兜住工具环中途暴涨。

相关代码：

- `src/plugins/agents/agim-agent/context-budget.ts` — 阈值、清理、紧急清理
- `src/plugins/agents/agim-agent/index.ts` — 预轮 compact + context hook

## 1. 三层节奏

| 层 | 时机 | 做什么 | 是否改 JSONL | UI |
|----|------|--------|--------------|-----|
| **L1 常规清理** | 每轮多次请求模型前的 `context` hook | 把旧 `toolResult` 换成短占位 | 否（仅 view） | 否（仅日志） |
| **L1 紧急清理** | 同 hook；估算已超过 `window − reserve` | 更狠地清（最多保留 2 条近期 tool 结果） | 否 | 否 |
| **L2 晚压 compact** | **每轮用户消息进入后、真正调模型前** | 总结旧历史，写入 compaction 条目 | 是（追加 summary） | 有「正在压缩上下文」 |

压缩失败：**不阻断任务**，打 error 步骤后继续本轮。

> P0 不做「中途二次 transcript 总结」。中途爆窗的第一道闸是紧急 tool 清理；完整 mid-turn compact 可作为后续增强。

## 2. 晚压默认（按窗口缩放）

面向 ~1M 级模型锁定的目标值，小窗口会 clamp，避免 `reserve ≥ window` 导致每轮都压。

| 参数 | 1M 窗口生效 | 128K 窗口生效（clamp 后） |
|------|-------------|---------------------------|
| `reserveTokens` | **48,000** | **32,000**（25% 上限） |
| 压缩触发 | `tokens > 1M − 48k` ≈ **952k** | `tokens > 128k − 32k` ≈ **96k** |
| `keepRecentTokens` | **32,000** | **25,600**（20% 上限） |
| L1 clear 触发 | **≤150k**（15%，cap） | **50k**（floor） |
| keep tool uses | **8** | **8** |

### 「压完可续跑」是什么意思

L2 压缩**不是结束任务**。流程是：

1. 预轮发现超阈值 → 调模型写 summary → `session.appendCompaction(...)`
2. **同一轮**继续 `prompt()`，模型带着「summary + 最近 keepRecent 尾部」接着干
3. 用户侧看到的是：可选的「正在压缩上下文」→ 正常回答/工具继续

`keepRecentTokens` 只决定压完后还留多长的**原始尾部**；summary 负责接上更早的目标与约束。任务不会因为压缩而主动中断。

## 3. 紧急清理（中途预算思路）

预轮 compact 只能挡「进门时已经很大」的会话。工具环里一次大 `read` / 搜索结果仍可能把剩余余量打穿。

当前预算策略：

```text
estimatedTokens > contextWindow - reserveTokens
  → emergency tool-result clearing（keep ≤ 2，无 UI）
```

这与 L2 触发线相同：已经进入「本该 compact」的危险区，但本轮已在跑、不便再开一轮总结时，先用清理换生存空间，让任务继续。

后续可增强（未做）：

- 工具返回后预估「下一跳输入」再决定是否插一次 mid-turn compact
- 对超大单次 tool 结果在写入前截断（已有 `AGIM_NATIVE_TOOL_RESULT_MAX_CHARS` 一类上限可配合）

## 4. 环境变量（统一 `AGIM_CTX_*`）

| 变量 | 默认 / 含义 |
|------|-------------|
| `AGIM_CTX_COMPACT` | 开；`off` 关闭 L2 压缩 |
| `AGIM_CTX_COMPACT_RESERVE_TOKENS` | 默认随窗口（1M→48k）；env 上限 256k |
| `AGIM_CTX_COMPACT_KEEP_RECENT_TOKENS` | 默认随窗口（1M→32k） |
| `AGIM_CTX_COMPACT_INSTRUCTIONS` | 非空则替换默认 summary 说明 |
| `AGIM_CTX_CLEAR` | 开；`off` 关闭 L1（含紧急清理） |
| `AGIM_CTX_CLEAR_TRIGGER_TOKENS` | 覆盖 L1 常规触发线 |
| `AGIM_CTX_CLEAR_KEEP_TOOL_USES` | 默认 8 |
| `AGIM_CTX_CLEAR_AT_LEAST_CHARS` | 默认 8000；低于此释放量则跳过常规清理 |
| `AGIM_CTX_CLEAR_EXCLUDE` | 逗号分隔；默认含 memory / goal / ask_user 等 |

**遗留别名（仍生效）：**

- `AGIM_NATIVE_COMPACTION=off` ≡ `AGIM_CTX_COMPACT=off`
- `AGIM_CTX_CLEARING=off` ≡ `AGIM_CTX_CLEAR=off`

以上键已在 Web `/api/env` allowlist 中。

## 5. 与 Usage 弹窗 / catalog 的关系

- Agim Agent 实际 `contextWindow` / `maxTokens` 来自 pi catalog（如 DeepSeek V4 → **1M / 384K**），可被 backend 显式 `contextWindow` 覆盖。
- `GET /api/llm` 会在未手动配置时回填 catalog，供 Usage 状态条显示。
- SPA 本地启发式仅作 fallback；以 API 回填为准。

## 6. 运维速查

```bash
# 关掉压缩（仍可 L1 清理）
AGIM_CTX_COMPACT=off

# 关掉一切清理
AGIM_CTX_CLEAR=off

# 更晚压（1M 上约 968k 才压）
AGIM_CTX_COMPACT_RESERVE_TOKENS=32000

# 压完多留一点原始尾部
AGIM_CTX_COMPACT_KEEP_RECENT_TOKENS=64000
```

日志关键字：

- `[agim-agent] tool-result clearing` / `...(emergency)`
- `[agim-agent] compaction: tokensBefore≈…`
- `[agim-agent] compaction skipped:`（失败后继续本轮）

## 7. 后续优化（约定优先级）

P0（晚压 + L1/紧急清理 + Usage 对齐 + 文档）已收口。后续按下列顺序推进：

| 序 | 项 | 说明 |
|----|----|------|
| **1** | Mid-turn transcript compact | 紧急清 tool 仍不够时，在工具轮之间插一次真正的 summary |
| **2** | 前瞻预算 | 工具返回后估算下一跳输入，预测会爆再决定清 / 压 |
| **5** | 指标 | clear / emergency / compact 次数、tokensBefore、失败率 |
| **7** | 设置页关键旋钮 | 开/关 compact、reserve、keepRecent（带晚压推荐说明） |
| **8** | 按模型档位预设 | 128K / 200K / 1M 显式 preset（替代仅靠 clamp） |

其余（单次 tool 硬上限联动、Portal 对齐、L3 memory promote、退役遗留别名、Usage 真实 usage）不排进上述主线，有体感再插队。
