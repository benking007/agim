# task-recovery 灰度测试指南

> **已归档** · 分支 `feat/task-recovery` 当时的灰度笔记（未作为现行运维指南）。  
> 现行 outbox / 任务恢复行为见 [`runbook.md`](../runbook.md)、[`session-model.md`](../session-model.md) 与 CHANGELOG。  
> 历史设计见归档 [`task-recovery-plan.md`](./task-recovery-plan.md)。

> 原文状态：`feat/task-recovery`（4 commits、未合并 main）；部署笔记含 `/root/.agim` 路径，仅作历史参考。

---

## 0. 前置：触发首次重启

新代码需要 service 重启一次才生效。两条路径任选：

- **A（推荐）IM 内**：发 `重启服务`（中文）或 `/restart`。这条路径走 agim 自身的 IM-initiated graceful restart，含 pre-flight 检查 + 接力消息（v1.0.x 的 d26b150 引入）。
- **B 终端**：`systemctl restart agim`（运维侧，会触发 SIGTERM → 测试 Phase 3 SIGTERM 修复）

重启后第一次回复看到 `dist/cli.js` 时间戳 ≥ 当前 build 时间即可确认 Phase 3 进程在跑。

健康度快查：

```bash
# service 起来后
ls -la /root/.agim/outbox.db          # Phase 1 新 db 文件应该存在
sqlite3 /root/.agim/outbox.db '.schema outbox' | head -5
sqlite3 /root/.agim/jobs.db 'PRAGMA table_info(jobs)' | grep -E "kind|thread_key|started_at|delivered_at|last_outbox_id"
```

---

## 1. Phase 1 — Outbox 投递队列

### 1.1 happy path（应当无感知）

任意发条消息，正常拿到回复。背后已走 outbox。

```bash
sqlite3 /root/.agim/outbox.db "SELECT id, kind, priority, status, attempts FROM outbox ORDER BY id DESC LIMIT 5"
# 应该看到刚发的那条 status='delivered'，attempts=1
```

### 1.2 `/outbox` 命令

IM 内发：

- `/outbox` 或 `/outbox status` — 看 pending / delivered / giving_up 统计
- `/outbox list 10` — 看最近 10 行
- `/outbox failed` — 看 giving_up 行
- `/outbox retry <id>` — 重新入队（giving_up → pending）

### 1.3 重试 + 给定放弃（高级 — 选做）

模拟 IM 端短暂故障：

1. 临时 block telegram 出站（`iptables` 加规则丢包，或直接关掉 telegram 进程出口）
2. 在 IM 内发条消息（agim 处理完，sink 把回复入 outbox 但 telegram API 失败）
3. 观察 outbox 行 `attempts` 递增：`1s → 5s → 30s → 5min → 30min → 2h`
4. 在 attempts 到 6 之前恢复 telegram —— 应该自动 delivered
5. 或者放任 7 次失败 —— 应该转 giving_up
6. `/outbox retry <id>` 把 giving_up 重新入队

```bash
# 观察 worker
sudo journalctl -u agim -f | grep -E "sink\.|outbox"
```

---

## 2. Phase 2 — Inline jobs 状态机

### 2.1 每条消息建一行

随便发条消息，让 agent 跑一次。然后：

```bash
sqlite3 /root/.agim/jobs.db \
  "SELECT id, agent, kind, status, started_at, completed_at, delivered_at, last_outbox_id
   FROM jobs WHERE kind='inline' ORDER BY id DESC LIMIT 3"
```

期望看到一行：
- `kind='inline'`
- 状态从 `pending` → `running` → `completed` → `delivered`
- `started_at` 和 `completed_at` 和 `delivered_at` 都非 NULL
- `last_outbox_id` 指向 outbox 表的对应行（同主键，sink ↔ jobs 级联通了）

### 2.2 `/job list` 应该能看到 inline 行

IM 内发：

- `/job list` — 默认显示最近 10 条所有 kind
- `/job check <id>` — 查单条详情（含状态、时间、prompt、result）

### 2.3 失败路径

让 agent 出错（比如发个明显违规的请求，让安全策略 reject）。检查：

```bash
sqlite3 /root/.agim/jobs.db \
  "SELECT id, status, error FROM jobs WHERE kind='inline' AND status='failed' ORDER BY id DESC LIMIT 3"
```

应该 status='failed'，error 列有错误文本。

### 2.4 env 关停

```bash
# 临时关停 inline tracking
sudo systemctl edit agim
# [Service]
# Environment="AGIM_INLINE_JOB_TRACKING=0"
sudo systemctl restart agim

# 再发条消息，jobs 表不应该新增 inline 行
sqlite3 /root/.agim/jobs.db "SELECT COUNT(*) FROM jobs WHERE kind='inline'"

# 测完别忘了删掉这个 env override 恢复默认开
```

### 2.5 retention 拆分

`kind='inline'` 24h 后被 prune；`kind='job'` 30d 后。本次测试不强求验证 retention（要等真实时间），知道行为即可。

---

## 3. Phase 3 — 重启恢复（最关键）

### 3.1 中断 + 恢复正向流程

1. **发条会让 agent 跑一会儿的消息**，比如：
   ```
   写一个 Python 脚本，分析 GitHub trending 仓库，每天 top10
   ```
2. **在 agent 没回完之前**（看到"思考中..."但还没出结果时），**立刻**触发 service 重启。两个方式都行：
   - IM 内发 `重启服务`
   - 运维终端 `systemctl restart agim`
3. 重启完成（约 5-15s）后应该收到：
   ```
   ⚠️ 上次的消息被服务重启中断了：
   「写一个 Python 脚本，分析 GitHub trending...」

   回复 `1` 重发 / `2` 取消（10 分钟内有效）
   ```
4. 回 `1`：
   - 应该立刻收到 `🔁 好的，重发中…`
   - 接着 agent 重新跑、给出最终回复
5. 观察 DB：

   ```bash
   sqlite3 /root/.agim/jobs.db \
     "SELECT id, status, replaced_by, error FROM jobs
      WHERE kind='inline' ORDER BY id DESC LIMIT 5"
   ```

   应该看到：
   - 旧行：`status='replaced'`，`replaced_by=<新行id>`
   - 新行：`status='delivered'`（重发后正常完成）

### 3.2 取消分支

重复 3.1 步骤 1-3，但回 `2`：

- 应该收到 `✅ 已取消，不再处理上次的消息。`
- DB 中旧行 `status='cancelled'`

### 3.3 超时分支

重复 3.1 步骤 1-3，**不回任何东西**，等 11 分钟。

- 不应该有额外提示
- DB 中旧行最终被下次启动 sweep 成 `status='abandoned'`（或下一轮启动扫描时）

### 3.4 多次中断同一线程

如果一条消息中断 → 重启前又发了另一条 → 又一次中断：

- 期望：恢复扫描只对**最新一条**发 prompt
- 较老那条自动转 `cancelled`
- 验证：`SELECT status FROM jobs WHERE thread_key='<你的thread>' AND kind='inline' ORDER BY id DESC LIMIT 5`

### 3.5 SIGTERM 修复验证

`systemctl restart agim` 走的是 SIGTERM。验证：

```bash
sudo journalctl -u agim --since "5 minutes ago" | grep -E "Received SIGTERM|Shutting down|interrupted|recovery"
```

期望看到：
- `Received SIGTERM, shutting down...`
- `Marked N inline job(s) as interrupted (agim shutdown (SIGTERM))`
- 启动侧：`Recovery scan: notified N retry-prompt(s) sent`

如果只看到 `Received SIGINT` 或没有 graceful 日志 → Phase 3 没生效，可能 dist 没换或 service 还在跑老进程。

---

## 4. 异常 / fallback 路径（最坏情况验证）

### 4.1 jobs.db 损坏（模拟）

```bash
sudo mv /root/.agim/jobs.db /root/.agim/jobs.db.bak
sudo touch /root/.agim/jobs.db    # 空文件 → sqlite 打开会失败 / 表不在
# 发条消息
# 预期：用户能拿到回复（fallback 内存路径）；agim 日志有 createInlineJob fell back to in-memory
sudo mv /root/.agim/jobs.db.bak /root/.agim/jobs.db
sudo systemctl restart agim
```

### 4.2 outbox.db 不可写

类似，验证 sink 走 last-ditch 直发路径，用户不丢消息。

---

## 5. 部署回滚

如果发现严重问题：

```bash
cd /root/workspace/agim
git checkout main
npm run build
# 触发重启（IM 内 / 运维端）
```

数据兼容性：
- `outbox.db` 是新文件，回 main 后它静止不用，不影响 main
- `jobs.db` 多了 6 列，main 的代码读旧列没问题，写入也兼容（新列允许 NULL / 有默认值）
- 反向兼容已经验证过：`ALTER TABLE ADD COLUMN` 是幂等的

---

## 6. 快速看板（一次性体检）

```bash
# 全套体检
echo "=== service ==="
systemctl status agim | head -5
echo
echo "=== dist timestamp ==="
ls -la /root/workspace/agim/dist/cli.js
echo
echo "=== outbox stats ==="
sqlite3 /root/.agim/outbox.db "SELECT status, COUNT(*) FROM outbox GROUP BY status"
echo
echo "=== inline jobs stats ==="
sqlite3 /root/.agim/jobs.db "SELECT status, COUNT(*) FROM jobs WHERE kind='inline' GROUP BY status"
echo
echo "=== last 5 inline jobs ==="
sqlite3 /root/.agim/jobs.db \
  "SELECT id, status, agent, substr(prompt,1,40), delivered_at FROM jobs WHERE kind='inline' ORDER BY id DESC LIMIT 5"
echo
echo "=== KillMode ==="
systemctl cat agim | grep KillMode
```
