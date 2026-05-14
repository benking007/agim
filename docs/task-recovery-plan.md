# agim 任务恢复升级计划

> 目标：让 agim 在 **进程崩溃 / systemd 重启 / IM 平台短暂断连** 三类故障下，不丢任务、不丢回复、并主动告诉用户上次状态。
> 起始日期：2026-05-14
> 当前分支：main（待开 feat/task-recovery）
> 维护人：ben.wangzj@gmail.com（用户）+ Claude Code（执行）

---

## 背景

agim v1.1.1 把 30 min 硬总超时换成了 60 min idle watchdog，长任务终于能跑。但仍有 3 类"任务消失"场景：

1. **agim 进程崩溃 / 被 systemd 重启** → 正在跑的 agent 子进程被带走，router 内存里的会话/路由状态全丢，用户不知道发生了什么
2. **agent 跑完了，但 messenger.sendMessage 发不出去** → IM 平台短暂断连、API 5xx、token 过期等情况下，回复消失，没有重试队列
3. **重启完成后 agim 不主动通知** → 用户上一条消息其实"被吃了"，但 agim 装作什么都没发生，下一条消息进来又重新触发推理

idle watchdog 让 agent 进程更稳定了，反过来把 **重启 / 投递路径** 暴露成 1 号失败点。

---

## 现状摸底（2026-05-14）

| 事实 | 出处 | 含义 |
|---|---|---|
| 入站主回路全程在内存 | `cli.ts:728` `routeMessage → generator → accumulate → sendMessage` | 任何一步崩溃，整条消息丢；不写库、不可重放 |
| `messenger.sendMessage` 是直发，调用点散在 5 处 | `cli.ts:746,757` / `reminders.ts:1004` / `approval-router.ts:392,675` / `restart-completion.ts:150` | 发送失败 = 丢；没有 outbox / 没有重试 |
| 只挂 SIGINT，没挂 SIGTERM | `cli.ts:524` `process.on('SIGINT', ...)` | **隐藏 bug**：`systemctl restart` 发 SIGTERM 走不进 graceful 路径，sessionManager/audit/job-board DB 都在 SIGKILL 时被硬切断 |
| systemd unit 默认 KillMode=control-group | `/etc/systemd/system/agim.service`（待确认） | 重启时 agent 子进程跟主进程一起被砍，没机会收尾 |
| job-board 已有完整 SQLite 范式 | `core/job-board.ts` | retention sweep / worker / db close 全套现成，**直接复用**，不需要造轮 |
| reminder polish 在 sendMessage 上游 | `reminders.ts:937-955` `polishReminderText(...)` → `1004 messenger.sendMessage(...)` | **关键**：收口 sendMessage 不破坏 polish / memo 注入，sink 只接管 plain payload → IM 投递这一段 |
| v1.1.1 idle watchdog 已默认 60 min | `core/agent-base.ts:17 DEFAULT_IDLE_TIMEOUT_MS` | 长任务比以前稳，但仍受 agim 进程生命周期约束 |
| job-board 表已有 creator_id / workspace_id | `core/job-board.ts:140-155` | 扩展 inline kind 不破多租户隔离 |

---

## 路线图

按依赖顺序：**Phase 1（Outbox） → Phase 2（Inline jobs） → Phase 3（Lifecycle）**。每个 Phase 独立可上线、独立可回滚。

### Phase 1 — Outbox（投递保障）

#### Schema（新表）

```sql
CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          INTEGER,                                     -- 关联 jobs.id，可空（reminder / approval 等不关 job）
  thread_key      TEXT    NOT NULL,                            -- platform:channelId:threadId
  platform        TEXT    NOT NULL,
  channel_id      TEXT    NOT NULL,
  thread_id       TEXT    NOT NULL,
  payload         TEXT    NOT NULL,                            -- 文本 / 卡片 JSON
  kind            TEXT    NOT NULL,                            -- 'text' | 'card' | 'typing'
  priority        TEXT    NOT NULL DEFAULT 'normal',           -- 'high' | 'normal'
  status          TEXT    NOT NULL DEFAULT 'pending',          -- pending | delivered | giving_up
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error      TEXT,
  delivered_at    TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status, priority, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_retention ON outbox(status, delivered_at);
```

#### 新模块 `core/message-sink.ts`

```typescript
export type SinkPayload = {
  threadId: string
  platform: string
  channelId: string
  payload: string | object
  kind: 'text' | 'card' | 'typing'
  priority?: 'high' | 'normal'   // 默认 normal
  jobId?: number                 // 关联 inline / 显式 job，可空
}

export const sink = {
  /** 入队/直发。返回 outboxId 用于追踪；若 priority=high 且直发成功，immediate=true 表示绕过了 worker。 */
  deliver(p: SinkPayload): Promise<{ outboxId: number; immediate: boolean }>,
  /** worker 控制（cli start/stop 时调用） */
  startWorker(): void,
  stopWorker(): void,
}
```

**调度策略**：

- `priority='high'`（approval / restart-completion）：先尝试同步 `messenger.sendMessage`，**成功**直接标 delivered；**失败**写 outbox pending（worker 兜底）。这保证审批类消息不被 1s+ worker 间隔拖累。
- `priority='normal'`（reminder / cli 主回路 / memo / 任何无强时效）：直接写 outbox pending，worker 拉走真发。

**Worker**：

- `setInterval(tick, 1000)`：每秒拉 `status='pending'` 行（按 `priority='high'` desc、`created_at` asc 排序）
- 单 worker 串行投递（避免对同一 thread 乱序），如 throughput 不够再引入 per-thread queue
- Backoff 序列 `[1s, 5s, 30s, 5min, 30min, 2h]`，第 7 次失败 → `status='giving_up'` + 写一条 audit 行
- 每次 attempt 写 `attempts++, last_attempt_at, last_error`

**Retention**：

- `delivered` + `giving_up` 行 24h 后 prune
- 沿用 job-board 的 sweep 范式（`setInterval` 6h）

**实施清单**：

- [ ] Schema migration（job-board.ts 同库新增 outbox 表，省一个 db 文件）
- [ ] `core/message-sink.ts` + worker
- [ ] cli.ts:746,757 主回路 → sink（priority=normal）
- [ ] reminders.ts:1004 → sink（priority=normal）
- [ ] approval-router.ts:392,675 → sink（priority=high）
- [ ] restart-completion.ts:150 → sink（priority=high）
- [ ] `sendCard` / `sendTyping` 也走同一 sink（kind='card'/'typing'）
- [ ] `/outbox` 命令：查待发 / 失败 / 重试
- [ ] 端到端测试：mock messenger 断连 → 恢复后 outbox 自动消化

### Phase 2 — Inline jobs（in-flight 持久化）

#### Schema 扩展

```sql
ALTER TABLE jobs ADD COLUMN thread_key   TEXT    NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN kind         TEXT    NOT NULL DEFAULT 'job';   -- 'job' | 'inline'
ALTER TABLE jobs ADD COLUMN started_at   TEXT;
ALTER TABLE jobs ADD COLUMN delivered_at TEXT;
ALTER TABLE jobs ADD COLUMN replaced_by  INTEGER;                          -- 重发链
ALTER TABLE jobs ADD COLUMN last_outbox_id INTEGER;                        -- 关联 outbox
CREATE INDEX IF NOT EXISTS idx_jobs_inflight ON jobs(kind, status) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_jobs_inline_thread ON jobs(thread_key, status) WHERE kind = 'inline';
```

#### cli.ts 主回路改造

每条会触发 agent 的入站消息：

```
入站 → createJob(kind='inline', thread_key, prompt) status='pending'
     → 进入 callAgentWithHistory: 标 status='running', started_at
     → AsyncGenerator accumulate 完毕: 标 status='completed', completed_at, result
     → sink.deliver(...): outboxId 写回 jobs.last_outbox_id
     → outbox worker delivered 时回标 jobs.status='delivered', delivered_at
```

#### 失败路径

- agent 抛错：标 `status='failed', error=...`
- 写库失败（磁盘满 / SQLite locked）：**log warn + fallback 跑内存路径**，绝不阻塞用户消息处理
- env `IMHUB_INLINE_JOB_TRACKING=0` 整套关停（保险开关）

#### Retention

- `kind='inline'` 且 status ∈ {completed, delivered, failed, cancelled, abandoned} → 24h prune
- `kind='job'` 沿用现有 30 天

**实施清单**：

- [ ] Schema migration
- [ ] `createJob` 加 `kind` / `threadKey` 参数
- [ ] cli.ts 主回路：5 个状态切换点（pending → running → completed → delivered / failed）
- [ ] outbox worker delivered 回写 jobs.status='delivered'（通过 last_outbox_id）
- [ ] retention sweep 区分 kind
- [ ] env 开关 + 写库失败 fallback
- [ ] 单元测试覆盖 5 个状态切换 + fallback 路径
- [ ] 端到端：跑 100 条消息看 jobs 表 + outbox 表数据一致性

### Phase 3 — Lifecycle（崩溃恢复 + 用户通知）

#### A. 修 SIGTERM bug

```typescript
// cli.ts:524 附近
const gracefulShutdown = async (signal: string) => {
  console.log(`\n👋 Received ${signal}, shutting down...`)
  // ... 现有 SIGINT 的全部步骤
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
```

systemd unit 改造：

```ini
[Service]
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=15s   # 给 graceful 路径 15s 跑完 + 5s agent 子进程 grace
```

#### B. Shutdown 时

- 在 `sessionManager.stop()` 之前加一步：扫 `kind='inline' AND status IN ('pending','running')` 的行
- 全部标 `status='interrupted', error='agim shutdown'`
- agent 子进程 SIGTERM → 5s grace → SIGKILL（agent-base 已有 watchdog 范式可参考）
- 现有 WAL checkpoint 顺序保留

#### C. 启动时

- 在 messenger.start() **完成后**（确保能发送）调一次 `recoverInterruptedJobs()`
- 扫 `kind='inline' AND status='interrupted' AND completed_at IS NULL AND <10 min 内>` 的行
- 对每条 → `sink.deliver({ priority: 'normal', payload: formatInterruptedNotice(job) })`
  - 文案模板：`⚠️ 上次的消息「<prompt 前 40 字>...」被服务重启中断了。回复 1 重发 / 2 取消（10 分钟内有效）`
- 超过 10 分钟的 interrupted 行 → 静默标 `status='abandoned'`（保留用于审计）

#### D. 重发流程

- router 拦截 `1` / `2` 回复（仅当用户在 10 分钟内、且本 thread 有 interrupted 行）
- 用户回 `1` → 创建新 inline job（prompt = 原 prompt）、旧 job 标 `replaced_by=新id`、`status='replaced'`
- 用户回 `2` → 旧 job 标 `status='cancelled'`
- 用户既不回也不发新消息 → 1h 后自动 `abandoned`

**实施清单**：

- [ ] cli.ts 注册 SIGTERM handler，共用 graceful 路径
- [ ] systemd unit 加 `KillMode=mixed` + `TimeoutStopSec`
- [ ] graceful agent 子进程关停（5s grace → SIGKILL）
- [ ] shutdown 时扫 in-flight + 标 interrupted
- [ ] 启动时 `recoverInterruptedJobs()` + 文案
- [ ] router 拦截 1/2 回复（注意只在有 interrupted 行时拦，避免误伤）
- [ ] 端到端测试：跑 + `systemctl restart agim` + 检查通知到达 + 测试 1/2 重发

---

## 工作量预估

| Phase | 工作量 | 主风险 | 可独立上线 |
|---|---|---|---|
| 1 Outbox | 2-3 天 | 5 个 send 调用点改造；worker 单线程吞吐够不够；priority=high 双路径心智 | ✅ |
| 2 Inline jobs | 2 天 | jobs 表膨胀（retention 要靠谱）；写库失败 fallback；5 个状态切换点要全 | ✅ |
| 3 Lifecycle | 1-2 天 | 启动通知 UX；1/2 拦截误伤普通对话；systemd unit 改造 | ✅ |

**总 ~1 周**。每个 Phase 落地后跑一周观察，再开下一个。

---

## 风险与对策

| 风险 | 对策 |
|---|---|
| outbox worker 单线程对同一 thread 严格顺序，跨 thread 也串行，throughput 可能瓶颈 | 先测：实测 IM 平台 send rate 大概几 r/s，单 worker 应该够。瓶颈时改成 per-thread 子队列 |
| Priority=high 双路径（先 sync 后 outbox）出现"消息发了两次"的 race | sink 实现里：sync 成功才标 delivered + return immediate=true；失败才入库。代码集中后单测覆盖 |
| Inline job 表膨胀（每条消息一行 + 状态切换写多次） | 写一次行，UPDATE 状态原地改；24h retention；prune sweep 6h 跑一次 |
| 写库失败 fallback 后用户感受不到"内部失败"，问题被掩盖 | fallback 时 `logger.warn({event: 'inline-job.write_failed'})`，audit / alert 看得见 |
| 启动扫描的"10 分钟"窗口对慢启动 / 大重启不够 | env `IMHUB_RECOVERY_WINDOW_MS` 可调（默认 600000） |
| 用户回 `1`/`2` 时其实想发别的内容 | 拦截前严格检查 thread 是否有 interrupted 行；其他内容（含 `12`、`1 重发`）都不拦 |
| 重启时正在跑的 agent 子进程被 SIGKILL，文件 / 状态不一致 | 5s SIGTERM grace；claude-code / opencode / codex 的 claude/opencode-session 落盘机制已存在（v2-plan Phase D 修过的 claudeSessionId 持久化），重启后能 resume |

---

## 与现有架构的关系

- **不破坏 v2-plan A/D**：sticky agent / TTL 双层照常工作；inline job 是**外挂的持久层**，原 session 机制保持
- **不破坏 v2-plan B/C**：per-agent cwd / 长期记忆与本计划正交
- **不破坏 v1.1.1 idle watchdog**：idle 仍按 agent 输出节奏，inline job 的状态机只在 agent stream 结束 / 抛错 / cancel 时切
- **复用 v1.1.1 的 fingerprint 思路**：interrupted 通知文案里加 prompt 前 40 字作为 user-facing 指纹

---

## 跨会话恢复指引（给下一次接手的我）

如果新会话需要接力本工作：

1. 先读本文件 `docs/task-recovery-plan.md`
2. 看 `git log --oneline -20 src/core/job-board.ts src/core/message-sink.ts src/cli.ts` 确认每个 Phase 的提交进度
3. 数据库现状：
   ```bash
   sqlite3 ~/.agim/jobs.db ".schema outbox"
   sqlite3 ~/.agim/jobs.db "SELECT kind, status, COUNT(*) FROM jobs GROUP BY kind, status"
   sqlite3 ~/.agim/jobs.db "SELECT status, COUNT(*) FROM outbox GROUP BY status"
   ```
4. 服务现状：
   ```bash
   systemctl cat agim | grep -E "KillMode|KillSignal|TimeoutStop"
   ```
5. 灰度状态：`echo $IMHUB_INLINE_JOB_TRACKING`（默认 1）

---

## 参考文件

| 文件 | 角色 |
|---|---|
| `src/core/job-board.ts` | SQLite 范式参考 + 扩展点（Phase 1/2 共用） |
| `src/core/agent-base.ts:17` | idle watchdog 现状（不动） |
| `src/cli.ts:524-560` | SIGINT shutdown 顺序（Phase 3 共用） |
| `src/cli.ts:728-770` | 入站主回路（Phase 2 改造） |
| `src/core/reminders.ts:937-1004` | reminder polish 上游 + 投递点（验证 sink 不破坏） |
| `src/core/approval-router.ts:392,675` | approval send（Phase 1 priority=high） |
| `src/core/restart-completion.ts:150` | 重启完成通知（Phase 1 priority=high） |
| `/etc/systemd/system/agim.service` | KillMode 配置（Phase 3 改造） |

---

## 进度追踪

| Phase | 状态 | 完成日 | PR / Commit | 备注 |
|---|---|---|---|---|
| 1 Outbox | ⏳ planned | — | — | — |
| 2 Inline jobs | ⏳ planned | — | — | — |
| 3 Lifecycle | ⏳ planned | — | — | — |

---

## 变更记录

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-05-14 | 初始版本，三 Phase 设计定稿、等待开 feat/task-recovery 实施 | Claude Code |
