# Heartbeat

> 状态：**调度器已接线**（随 `agim start` 启动；自动 tick 仍 opt-in）
> 命令：`/heartbeat`
> 源码：`src/core/heartbeat.ts`、`src/core/heartbeat-store.ts`、`src/core/commands/heartbeat.ts`
> Web：`/tasks/heartbeat`（绑定列表）；自动调度与 UI 无关

## 一句话

Heartbeat 是按 IM 线程绑定的周期主动循环：DECIDE（cheap LLM）→ EXECUTE（用户当前 agent）→ EVALUATE（通知门）。`/heartbeat bind` / `show` 随时可用；**自动 tick 默认关闭**，避免未配置时烧 LLM。

## 启用自动 tick

在 `~/.agim/env`（或进程环境）里打开：

```bash
AGIM_HEARTBEAT_ENABLED=1
```

接受 `on` / `1` / `true`。未设置时 `startHeartbeatScheduler()` 只打 `heartbeat.scheduler.disabled` 日志，不 `setInterval`。

可选：

| 变量 | 含义 | 默认 |
|---|---|---|
| `AGIM_HEARTBEAT_TICK_INTERVAL_MS` | 调度扫描周期（5s–600s） | `60000` |
| `AGIM_HEARTBEAT_DEFAULT_INTERVAL_MIN` | 新绑定的复发间隔（分钟） | `30` |

生命周期：`src/cli/start-runtime.ts` 在 reminders 之后调用 `startHeartbeatScheduler()`；`src/cli/graceful-shutdown.ts` 对称调用 `stopHeartbeatScheduler()`。

## 与 Reminders 的区别

Reminders（[`reminders.md`](./reminders.md)）是一次性 / 定期**投递提醒**。Heartbeat 是「定期判断要不要做事」的主动循环，中间会跑 agent。两者不要混用文档。
