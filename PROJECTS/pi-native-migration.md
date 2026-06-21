# pi-native 引擎迁移 — 状态与 backlog

pi-native = 把 [earendil-works/pi](https://github.com/earendil-works/pi) 的
`@earendil-works/pi-agent-core` (AgentHarness + durable JSONL session) 接成 agim
的默认 native agent 引擎，取代不稳的 in-process 循环。

## 已落地（v1.2.155 / v1.2.156）

- **AgentHarness + durable JSONL session**（v1.2.155）：每个 agim session 一个 JSONL
  文件，pi 持有 history + leaf，崩溃可恢复。
- **tool-bridge**：agim `ToolDef[]`+Dispatcher → pi `AgentTool`。
- **provider-resolver**：agim backend → pi-ai Model + auth。
- **approval gate + plan-mode**：`tool_call` hook 拦截（read-only / allow-list /
  deny-all / IM 审批卡 + plan-mode 硬 deny）。
- **runaway / stuck-loop 护栏**：max-iter（`IMHUB_NATIVE_AGENT_MAX_ITER`）+ 同
  tool+args 连错 3 次中断。
- **system prompt 注入**：真实身份 + role + skills。
- **P0 上下文压缩**（v1.2.156）：每轮 prompt 前按 token 阈值 `harness.compact()`，
  `IMHUB_NATIVE_COMPACTION=off` 可关。pi 不自动压缩，必须自驱。
- **P1 provider 韧性 + prompt 缓存**（v1.2.156）：`streamOptions` 透传
  maxRetries / maxRetryDelayMs / timeoutMs / cacheRetention，全 `IMHUB_NATIVE_*`
  可覆盖（默认 2 / 20s / 120s / short）。

## Backlog — 需 agim 传输层/UI 改造（不是纯 pi 移植）

下面 3 项 pi 侧能力是现成的，但 agim 当前**没有承接它们的传输/UI 通道**，
硬接引擎侧不会对用户生效。故列为 backlog，各自带前置条件。

### B1. token 流式输出（前置：SSE / 增量渲染消费方）
- pi 侧：AgentHarness 暴露 AssistantMessage event stream，可逐 token 取。
- 阻塞点：agim `sendPrompt` 契约是"每个 yield 一条完整 chunk"，legacy native 也
  是 buffer 整段 yield 一次；IM 无 stream；web-job(`src/web/server.ts:~2585`)跑完
  整轮再 `sendJson` 一次性返回。**没有逐字渲染的消费方**。
- 要做先改：web-chat 走 SSE/增量渲染（或 IM 长回复分段多条投递）。

### B2. steering / follow-up 队列（前置：router 会话并发模型）
- pi 侧：turn 进行中可注入 steer/follow-up 消息（`steeringQueueMode` 等）。
- 阻塞点：agim IM 模型里"用户下一条消息 = 新一轮 sendPrompt(新 turn)"
  （CLAUDE.md §6），没有"向运行中的 turn 追加"的通道。
- 要做先改：router 支持同 session 的消息喂入活跃 harness。

### B3. branch-summary / navigateTree 时间旅行（前置：web-chat 树形导航 UI）
- pi 侧：`navigateTree(targetId, {summarize})` + branch-summarization 现成。
- 阻塞点：需要 UI 让用户"回到某历史 leaf 并 fork"。agim web-chat 无树形导航。
- 要做先改：web-chat 加会话树 UI + 触发入口。

## 备注
- pi 全量源码评估见 auto-memory `pi-agent-core-eval`。
- 运维教训：本机 3.6GB，**别在 IM 会话里同步跑全量 bun test/build**（会把托管
  会话的 agim 挤进 swap 触发重启）——验证只 typecheck + pi-native 子集，全量交 CI。
