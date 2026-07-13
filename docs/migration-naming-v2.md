# Naming v2 迁移指引（新老对照）

本指南对应将原先「高破坏成本、已延期」的四项命名对齐落地：

1. Registry id：`native` → `agim`
2. 工具名：`native_*` → `agim_*`
3. 会话目录：`~/.agim/pi-sessions` → `~/.agim/agim-sessions`
4. 配置字段：`workspaces[]` → `tenants[]`

兼容策略：**写入规范名，读取新旧双轨**（一个发行窗口）。升级后首次启动会自动迁移；运维侧若手改配置，按下表操作即可。

完整术语表见 [`naming.md`](./naming.md)。

---

## 一览表

| 层面 | 旧（仍可读） | 新（规范 / 写入） | 谁迁移 |
|------|--------------|-------------------|--------|
| 内置 Agent 显示名 | — | **Agim Agent** | UI（已完成） |
| Registry / `defaultAgent` / `agents[]` | `native` | `agim` | Boot：`migrateNamingV2` |
| Slash / 别名 | `/native`、`/na`、`/llm` | `/agim`（别名仍可用） | 路由别名 |
| 工具名（模型可见） | `native_read_file` 等 | `agim_read_file` 等 | 广告面；分发接受双名 |
| Deny / autoAllow 环境变量列表 | `native_*` | `agim_*`（旧名仍生效） | `expandToolNameList` |
| Agim Agent 会话根目录 | `~/.agim/pi-sessions` | `~/.agim/agim-sessions` | Boot：`migratePiSessionsDir` |
| Agent CWD 树 | `~/.agim-workspaces/native/` | `~/.agim-workspaces/agim/` | Boot：`migrateAgentWorkspaceDir` |
| Session meta `agent` | `"native"` | `"agim"` | Boot：`migrateSessionAgentIds` |
| 访问规则配置字段 | `workspaces[]` | `tenants[]` | Boot：`migrateWorkspacesToTenants` |
| SPA / REST 访问规则路径 | `/settings/workspaces`、`/api/workspaces` | 暂保留（API 别名） | 写入时双写 `tenants`+`workspaces` |

---

## 1. Registry id：`native` → `agim`

### 旧

```json
{
  "agents": ["claude-code", "native"],
  "defaultAgent": "native"
}
```

### 新

```json
{
  "agents": ["claude-code", "agim"],
  "defaultAgent": "agim",
  "agimAgentIdMigrated": true,
  "nativeAgentToggleMigrated": true
}
```

### 行为

- 启动时把 `defaultAgent`、`agents[]`、以及 `tenants`/`workspaces` 里的 agent 白名单中的 `native` 改写为 `agim`（去重）。
- 运行时 `native` 仍是 routing **别名**（`findAgent('native')` 仍可达）。
- SPA / 设置页以 `agim` 为内置 Agent 主键；历史配置里的 `native` 仍视为已启用。

### 运维注意

- Cron / 外部脚本若写死 `agent: "native"`：可暂不改（别名有效），建议改为 `"agim"`。
- Job / schedule / audit 行里的历史 `agent='native'` 不强制改库；新写入用 `agim`。

---

## 2. 工具名：`native_*` → `agim_*`

| 旧名 | 新名 |
|------|------|
| `native_echo` | `agim_echo` |
| `native_now` | `agim_now` |
| `native_sleep_ms` | `agim_sleep_ms` |
| `native_random_uuid` | `agim_random_uuid` |
| `native_read_file` | `agim_read_file` |
| `native_write_file` | `agim_write_file` |
| `native_list_dir` | `agim_list_dir` |
| `native_glob` | `agim_glob` |
| `native_grep` | `agim_grep` |
| `native_web_fetch` | `agim_web_fetch` |
| `native_web_search` | `agim_web_search` |
| `native_exec` | `agim_exec` |
| `native_todo_write` | `agim_todo_write` |
| `native_exit_plan_mode` | `agim_exit_plan_mode` |

### 行为

- **广告给模型的只有 `agim_*`**。
- 分发、plan-mode 白/黑名单、policy gate、goal-evidence、幻觉检测均通过 `canonicalizeToolName` / `expandToolNameList` **同时接受旧名**。
- 环境变量示例：

```bash
# 新旧写法等价
AGIM_NATIVE_AGENT_DENYLIST=agim_exec,agim_write_file
AGIM_NATIVE_AGENT_DENYLIST=native_exec,native_write_file
AGIM_NATIVE_AGENT_AUTOALLOW=agim_read_file,native_web_search
```

### 运维注意

- 自定义 prompt / skill 文档请改成 `agim_*`；旧文档在兼容窗口内仍可用。
- SQLite 表名 `native_todos` **不改**（磁盘 schema，与工具对外名无关）。

---

## 3. 会话目录：`pi-sessions` → `agim-sessions`

| 旧路径 | 新路径 |
|--------|--------|
| `~/.agim/pi-sessions/` | `~/.agim/agim-sessions/` |
| `~/.agim-workspaces/native/` | `~/.agim-workspaces/agim/` |

### 行为

- 若仅有旧目录、没有新目录 → `rename`。
- 两者都存在 → **不覆盖**，继续用新路径；请人工合并后删旧目录。
- 与外部 **PI CLI** 工作区下的 `.pi-sessions/` **无关**（那是 PI 自己的会话）。

---

## 4. 配置：`workspaces[]` → `tenants[]`

### 旧

```json
{
  "workspaces": [
    { "id": "team-a", "name": "Team A", "agents": ["native"], "members": ["u1"] }
  ]
}
```

### 新

```json
{
  "tenants": [
    { "id": "team-a", "name": "Team A", "agents": ["agim"], "members": ["u1"] }
  ],
  "workspaces": [
    { "id": "team-a", "name": "Team A", "agents": ["agim"], "members": ["u1"] }
  ],
  "tenantsFieldMigrated": true
}
```

### 行为

- Boot 把 `workspaces` 复制到 `tenants`（若尚无 `tenants`），并打上 `tenantsFieldMigrated`。
- 读取优先 `tenants`，否则回退 `workspaces`（`getTenantsFromConfig`）。
- Web 保存访问规则时 **双写** `tenants` 与 `workspaces`，避免旧工具读不到。
- SPA 路由 `/settings/workspaces`、API `/api/workspaces` **本窗口不改 URL**（避免前端大面积 churn）；语义仍是「访问规则 / tenants」。

---

## Boot 做了什么

`agim start` / `start-prod.js` 会依次：

1. `migrateNativeAgentToggle` — 历史「未列出内置 Agent」列表补上 `agim`
2. `migrateAgentIdNativeToAgim` — `native` → `agim`
3. `migrateWorkspacesToTenants` — 提升 `tenants`
4. `migratePiSessionsDir` / `migrateAgentWorkspaceDir` / `migrateSessionAgentIds` — 磁盘与 session meta

幂等标志（写在 `~/.agim/config.json`）：

| Flag | 含义 |
|------|------|
| `nativeAgentToggleMigrated` | 已做过内置 Agent 开关补全 |
| `agimAgentIdMigrated` | 已做过 registry id 改写 |
| `tenantsFieldMigrated` | 已做过 tenants 字段提升 |

---

## 运维检查清单

升级后建议：

1. `cat ~/.agim/config.json` — 确认 `defaultAgent` / `agents` 为 `agim`，存在 `tenants`（或仍可读的 `workspaces`）。
2. `ls ~/.agim/agim-sessions` — 会话根已迁到新目录。
3. `ls ~/.agim-workspaces/agim` — CWD 树已迁（若以前用过 `native`）。
4. 若自定义了 `AGIM_NATIVE_AGENT_DENYLIST` / `AUTOALLOW`，可逐步改成 `agim_*`（旧名仍有效）。
5. 重启后在 Web「Agents」页确认默认 Agent 显示为 **Agim Agent**，主键为 `agim`。

---

## 兼容窗口与回滚

- **兼容窗口**：本发行及下一发行仍接受 `native` / `native_*` / `workspaces` 读取。
- **回滚**：将 `defaultAgent` / `agents` 改回 `native` 仍可启动（别名）；工具旧名仍可分发。目录若已 rename，回滚需手动 `mv agim-sessions pi-sessions`（仅当没有新写入依赖新路径时）。
- **不要**删除 `agimAgentIdMigrated` 等 flag 指望「重跑改写」——flag 存在时仍会做内存归一化，但不会反复改写你故意写回的 `native`（除非去掉 flag 并重启）。若需强制再迁移，备份后移除对应 flag 再启动。

---

## 相关代码

| 模块 | 职责 |
|------|------|
| `src/core/naming-migrate.ts` | Boot 迁移编排 |
| `src/core/llm/tool-names.ts` | 工具名规范化 / 列表展开 |
| `src/plugins/agents/agim-agent/factory.ts` | Registry `name: 'agim'` + aliases |
| `docs/naming.md` | 现行术语表 |
