# 代码审查报告（2026-08-15）落地状态 · v1.5.98

> 原文审查覆盖 v1.5.76 → v1.5.98。本页是落地清单，不重复 07-23 已修项。

## P0

| ID | 主题 | 状态 |
|---|---|---|
| F2 / P0-1 | heartbeat tick 互斥 | 已修（`ticking` 跳过重入） |
| F1 / P0-2 | DingTalk fetch 超时 + outbox `doSend` 60s | 已修 |
| F3 / P0-3 | 崩溃后 inline job → `interrupted` | 已修 |
| U1–U3 / P0-4 | en 词典去中文、启动横幅 i18n、LANG 回退、`agim go` 语言选择 | 已修 |

## P1

| ID | 主题 | 状态 |
|---|---|---|
| F4 / P1-1 | WS ping/pong 心跳 | 已修 |
| S2 / P1-2 | REST 顶层 try/catch + requestTimeout | 已修 |
| S3 / P1-3 | callHelperAgent AbortController | 已修 |
| F6 / P1-4 | SQLite broken 5min 重试 + `/api/service/status` | 已修 |
| U8 / P1-5 | 高频 API `sendError` + errors.json | 已修 |
| U4/U7/U9 / P1-6 | Agents 重复 spec、钉钉 Back、token 菜单、卸载不再问语言、GLOBAL_IM 提示 | 已修 |
| U5 / P1-7 | IM 高频错误 en/zh + per-user 记忆 | 已修 |
| P1-8 | npm audit fix（ip-address / fast-uri / hono / tar） | 已修；sharp 无修复版；undici 仍经 discord.js |

## P2

| ID | 主题 | 状态 |
|---|---|---|
| S1 / P2-1 | Loop 热路径内存缓存 | 已修（读路径 Map） |
| F7 / P2-2 | messenger.start 30s 超时 | 已修 |
| F5/F9 / P2-3 | WeChat 入站先持久化再推进游标；去重 TTL 10min | 已修 |
| F11/S4 / P2-4 | active-runs 400K + LRU；thread-queue 深度上限 | 已修 |
| F8/F12 / P2-5 | reminders prune；媒体清理中央化 | 已修 |
| F10 / P2-6 | restart 推送失败保留 pending | 已修 |
| S5 / P2-7 | 退役 loop 输入窗口压缩 | 已修 |
| U6 | SPA 代码块复制走 i18n | 已修 |
| U7 断线文案 | 不再承诺“可以继续输入” | 已修 |

## 残留

- `sharp`（`@huggingface/transformers`）无修复版 — 可选 `--omit=optional`
- `undici` 经 `discord.js` 传递，需等上游
- setup-llm / setup-mcp / diag 子向导仍为英文（U7 细节）
