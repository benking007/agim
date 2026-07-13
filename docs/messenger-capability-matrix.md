# Messenger 能力矩阵

> 产品是「统一桥接」，但各 IM 平台能力并不对等。本表写清现状，避免把「都能聊」读成「HITL / 附件 / 网关行为完全一致」。

适用版本：v1.5.13+

## 入站与网关

| 平台 | 默认启用 | 入站 handler | 说明 |
|---|---|---|---|
| 微信 iLink | 是 | 异步 | 出站依赖 context token；冷用户/重启后可能需用户先发言 |
| 飞书 | 是 | fire-and-forget | 适配器层不阻塞 WS 事件 |
| 钉钉 | 是 | Stream 回调 | 富媒体能力有限（见下） |
| 邮件 | 是 | 出站为主 | 非双向聊天桥 |
| Web | 运行时注册 | WS 串行队列 | token 门控 |
| Telegram | `AGIM_ENABLE_GLOBAL_IM=1` | fire-and-forget | grammy 按 chat 串行；handler 不可 await HITL |
| Discord | `AGIM_ENABLE_GLOBAL_IM=1` | fire-and-forget | 与 Telegram 同纪律；勿在 gateway 上 await agent |

## HITL（审批 / ask_user）

| 平台 | 原生审批卡 | 文本 fallback（`y` / `1`） |
|---|---|---|
| Telegram | 有（inline button） | 有 |
| Discord | 文本为主 | 有 |
| 微信 / 飞书 / 钉钉 | 无完整原生卡 | 有（主路径） |
| Web / TUI | 有 | — |

## 附件 / 多媒体入站

| 平台 | 图片 | 语音 | 文件 | 备注 |
|---|---|---|---|---|
| 微信 | 强 | 强（可转写） | 有 | 能力最完整之一 |
| Telegram | 强 | 强 | 有 | 下载后落盘再交给 agent |
| Discord | 依赖附件字段 | 有限 | 有限 | 以文本+附件元数据为主 |
| 飞书 | 弱/无完整下载路径 | — | — | 当前偏文本 + location |
| 钉钉 | 计数为主 | — | — | Stream 以 text 为主 |

## 出站投递语义（全平台共用）

- 统一走 `message-sink` → SQLite **outbox**
- 语义为 **at-least-once**：进程在「已发出但未 ack」时崩溃，重启可能重复投递
- 生产硬依赖 `better-sqlite3`；无 DB 时 sink 退化为尽力发送，失败可丢
- 审批卡等同步 UX 路径可能绕过 outbox（崩溃不可重放）

## 运维建议

- 面向开放/半受信用户：见 [`security-hardening.md`](./security-hardening.md) §0.1
- 不要假设「飞书上的审批体验 = Telegram」；上线前按本表验收
- Discord / Telegram 未设 `AGIM_ENABLE_GLOBAL_IM=1` 时，即使 `config.messengers` 写了也不会加载
