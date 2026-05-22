# 安全加固参考 · Security Hardening Reference

> 本页是 R12 / R13 / R14 / R15 跨多个 PR 落地的所有安全控制的**单页索引**。受众：客户安全团队 / DPO / 内部 CISO / 合规审计。
>
> 每条改动都附文件路径，便于现场 grep。

适用版本：v1.2.23+（包含 R12-R15 全套）

---

## 0. 一页摘要

agim **默认状态**就是合规友好的：

| 维度 | 默认 |
|---|---|
| Web 控制台监听 | 仅 `127.0.0.1`；非回环必须显式 env 切换 |
| Discord / Telegram | **隐藏**（需 `IMHUB_ENABLE_GLOBAL_IM=1` 启用）|
| 远程 ACP Agent | **隐藏**（需 `IMHUB_ENABLE_REMOTE_AGENT=1` 启用）|
| 长期记忆 / 备忘 | 默认关 |
| 出网 | 唯一必需：与 IM 厂商通信；其他全部可关 |
| 用户消息进日志 | 默认只有 `len` / `prefix(6)` / `sha256(12)`，无原文 |
| 凭据存储 | `0o600` 文件 + sha256 哈希；Web 令牌支持 admin / user 双角色 |
| 凭据出口防护 | 输出消息走脱敏扫描，10 类 token 模式自动 `[REDACTED]` |
| 敏感路径读取 | 硬拒（不弹审批卡，无法运维"放过"） |
| 审计 | `audit_events` 表 + 30/180 天保留；10 类事件可查 |

---

## 1. 环境变量速查（本轮新增）

| 变量 | 默认 | 用途 | 引入 |
|---|---|---|---|
| `IMHUB_ENABLE_GLOBAL_IM` | 未设 = 关 | `=1` 开启 Discord + Telegram 的 CLI 配置入口、Web 设置卡片、运行时适配器加载 | R12 |
| `IMHUB_ENABLE_REMOTE_AGENT` | 未设 = 关 | `=1` 开启 ACP（远程 Agent over HTTP）的 CLI 入口、Web 卡片、端口配置、运行时加载、`.well-known/acp` 自动发现 | R12 |
| `IMHUB_LOG_USER_TEXT` | 未设 = 关 | `=1` 让 pino 日志带原文 user message（默认只记 `len`/`prefix(6)`/`sha256(12)`）。**严格匹配**，`true`/`yes`/`on`/`0` 都视为关 | R12 ① |
| `IMHUB_MEMORY_FACT_RETENTION_DAYS` | `90` | 长期事实 TTL（按 `last_referenced_at` 而非创建时间，LRU 友好）。`0` 永久 | R12 ② |
| `IMHUB_PERSONA_RETENTION_DAYS` | `180` | 用户画像 TTL（按 `updated_at`）。`0` 永久 | R12 ② |
| `IMHUB_PASTE_RETENTION_DAYS` | `30` | viewer paste TTL（按 `created_at`）。`0` 永久 | R12 ② |
| `IMHUB_AUDIT_EVENTS_RETENTION_DAYS` | `180` | 审计事件表保留天数（满足等保 2.0 三级 ≥ 6 个月） | R12 ⑤ |
| `IMHUB_SKILLHUB_ENABLED` | `1` = 开 | `=0` 关闭技能热榜对外 fetch（气隙部署） | R12 ⑥ |
| `IMHUB_ACP_BIND` | `127.0.0.1` | ACP 服务监听地址；改成非回环值会触发 warn + 持久审计记录 | R13 G4 |
| `IMHUB_WEB_TLS_ACK` | 未设 = 警告 | `=1` 静默非回环 Web bind 时的启动横幅（操作员确认 TLS 反代已就位） | R13 G5 C2 |
| `IMHUB_WS_MAX_PER_IP` | `20` | WebSocket 单 IP 并发上限 | R13 G5 A4 |
| `IMHUB_WS_MAX_NEW_PER_IP_PER_MIN` | `30` | WebSocket 单 IP 60 秒内新建数 | R13 G5 A4 |
| (已有) `IMHUB_TIMEOUT_DEFAULT` | `deny` | 审批超时策略；设 `allow` 时启动 + 每小时 reminder | R13 G5 C1 |

> **重要**：`IMHUB_ENABLE_GLOBAL_IM` 和 `IMHUB_ENABLE_REMOTE_AGENT` 的设计目的是合规分发 —— 它们**不会出现**在任何 README / 安装指南 / 配置向导提示里。要么通过 SSH 编辑 `~/.agim/env`，要么 systemd `Environment=`，要么进程启动前 export。运维之外的人**不可能**通过 Web UI 反向启用。

---

## 2. 数据存储与凭据

### 2.1 SQLite 表（10 张）

| 表 | 数据库 | 含敏感原文 | 保留期 (env 可调) |
|---|---|---|---|
| `invocations` | `audit.db` | ❌ 仅元数据 | `IM_HUB_AUDIT_RETENTION_DAYS=30` |
| `audit_events` | `audit.db` | ❌ 仅字段名 / 长度 / 哈希前缀 | `IMHUB_AUDIT_EVENTS_RETENTION_DAYS=180` |
| `jobs` | `jobs.db` | ✅ prompt + result | `IM_HUB_JOB_RETENTION_DAYS=30` |
| `outbox` | `outbox.db` | ✅ IM 消息体 | `IMHUB_OUTBOX_RETENTION_HOURS=24` |
| `schedules` | `schedules.db` | ✅ prompt | 永久（单条手删） |
| `persona_profile` | `memory.db` | ✅ summary | `IMHUB_PERSONA_RETENTION_DAYS=180` |
| `facts` | `memory.db` | ✅ 5W1H + embedding | `IMHUB_MEMORY_FACT_RETENTION_DAYS=90` |
| `memos` | `memos.db` | ✅ 5W1H + 地理坐标 | 单条 `expires_at` |
| `pastes` | `viewer.db` | ✅ 完整 markdown | `IMHUB_PASTE_RETENTION_DAYS=30` + 容量上限 LRU |
| `admin_allowlist` | `admin-allowlist.db` | ❌ | 永久（手 删） |

### 2.2 文件权限

| 路径 | 权限 | 创建处 |
|---|---|---|
| `~/.agim/env` | 0o600 | `cli-ui/env-file.ts:updateEnvFile` |
| `~/.agim/config.json` | 0o600 | `core/onboarding.ts:saveConfig` |
| `~/.agim/tokens.json` | 0o600 | `core/access-token.ts:writeFile` |
| `~/.agim/admin-bootstrap-token` | 0o600 | `core/admin-bootstrap.ts:ensureBootstrapTokenIfNeeded` |
| `~/.agim/acp-token` | 0o600 | `core/acp-server.ts:getOrCreateAcpToken` |
| `~/.agim/approval-bus.sock` | 0o600 | `core/approval-bus.ts:start` 后 chmod |
| `~/.agim/im-hub.pid` | 0o600 | `cli.ts:agim start` 写入（R15） |
| `~/.agim/sessions/<key>.log` | 0o600 | `core/session.ts:appendFile` |
| `~/.agim/artifacts/<jobId>/*` | 0o600 文件 / 0o700 目录 | `core/artifacts.ts:ensureArtifactsDir` |

R12 ④ 加固：之前依赖 umask，现在每个 write/mkdir 显式带 mode。

### 2.3 凭据保护链

1. **写入**：所有 secret 文件 `writeFileSync(..., { mode: 0o600 })` + 显式 `chmodSync` 双重保险
2. **读取掩码**：`/api/config` 等敏感字段返回时统一 `ab****yz`
3. **回写防护**：客户端 echo 回掩码时服务端 `isMasked()` 检测，保留磁盘原值
4. **pino redact**：`token / botToken / apiKey / appSecret / password / secret / authorization` 路径自动 `[REDACTED]`
5. **R12 ① 用户消息脱敏**：`sanitizeUserText()` 替代 `text.substring(0, 120)`，默认不入日志

### 2.4 Bootstrap 令牌（R13 A3）

之前 admin bootstrap + web bootstrap token **都写 stdout 和 pino**，systemd journald 可读权限的人都能拿。R13 加固后：

- Web bootstrap (`core/access-token.ts`)：banner 只显示 **token id + 文件路径**，原值通过 `consumeBootstrapTokenRaw()` 一次性 TTY 取回
- IM admin bootstrap (`core/admin-bootstrap.ts`)：pino log 不带 token；stdout banner 引导 `cat ~/.agim/admin-bootstrap-token`

---

## 3. 鉴权与访问控制

### 3.1 Web 令牌角色（R13 G1）

| 角色 | 权限 |
|---|---|
| `admin` | 所有 mutation 端点（创建工作区 / 改配置 / 改 env / 管理员名单 / 服务生命周期 / batch jobs / 等 20+ 个） |
| `user` | 只读端点 + 操作员自己创建的资源（自己的 job / 自己的 memo / 自己的 reminder） |

- 老 token（缺 `role` 字段）→ 读为 `admin`（向后兼容）
- Bootstrap 创建的 token 默认 `admin`
- 通过 `createToken(label, { role: 'user' })` 显式创建 user-role token
- `setTokenRole(id, role)` 升降级
- API：`isAdminTokenId(tokenId): boolean`

### 3.2 Loopback / auth-off 绕过

`isRequestAdmin(req)` 信任顺序：
1. `IMHUB_WEB_AUTH=off` → admin（操作员显式关闭鉴权）
2. Loopback peer（127.0.0.1 / ::1）→ admin（操作员在本机）
3. Bearer token `role === 'admin'` → admin
4. 否则 → 403

### 3.3 WebSocket（R9 + R13）

- `verifyClient` 走 token 鉴权 + Origin 同源校验（防 CSWSH）
- ClientID 用 `randomBytes(12).toString('base64url')`（96 比特熵）
- `threadOwners` map 防跨令牌劫持
- 每令牌上限 100 连接（`IMHUB_MAX_WS_CLIENTS`）
- **R13 G5 A4 新增按 IP 限流**：`IMHUB_WS_MAX_PER_IP=20` 并发 + `IMHUB_WS_MAX_NEW_PER_IP_PER_MIN=30` 滚动窗口；rate-limit 在鉴权**之前**跑，防止 sha256 暴力 CPU 占用

### 3.4 ACP 入站端口（R13 G4）

- **默认** `127.0.0.1`（之前是 0.0.0.0 —— 我审计时 Explore agent 报告错了，实际一直是回环）
- 通过 `IMHUB_ACP_BIND=<addr>` 可改非回环
- 改非回环时启动 warn + 持久审计行 `target=acp-server.bind`
- 客户端鉴权：`acp-token` Bearer（`~/.agim/acp-token`，0o600）

### 3.5 `?token=` URL 回退（R13 G5 A5）

继续兼容 WS upgrade / iframe 场景，但**首次命中时每进程 warn 一次**并入 audit-event，建议运维迁移到 `Authorization: Bearer` 或 `agim_token` cookie。

---

## 4. 出网防护（数据外流面）

### 4.1 出网清单

| # | 目标 | 触发条件 | 关闭方式 | 备注 |
|---|---|---|---|---|
| 1 | `ilinkai.weixin.qq.com` | 微信适配器启用 | 不配 wechat | TLS |
| 2 | `api.telegram.org` | Telegram 启用 + R12 IM gate 开 | `IMHUB_ENABLE_GLOBAL_IM` 不设 | TLS |
| 3 | `api.dingtalk.com` | 钉钉启用 | 不配 | TLS |
| 4 | `open.feishu.cn` | 飞书启用 | 不配 | TLS |
| 5 | `discord.com` | Discord + R12 IM gate 开 | `IMHUB_ENABLE_GLOBAL_IM` 不设 | TLS |
| 6 | SMTP 服务器 | `IMHUB_SMTP_*` + `/remind email` | 不设 `IMHUB_SMTP_HOST` | TLS / STARTTLS |
| 7 | `api.map.baidu.com` | `IMHUB_BAIDU_MAP_AK` + `/memo` 地址 | 不设 AK | TLS |
| 8 | `*.trycloudflare.com` | `IMHUB_VIEWER_TUNNEL_MODE=quick` | 默认关 | TLS |
| 9 | OpenAI 兼容服务 | `OPENAI_API_KEY` + 语音/向量功能 | 不设；或 base_url 指向内网 Ollama / LM Studio | TLS |
| 10 | ACP 远程 Agent | `acpAgents[]` + R12 ACP gate 开 | `IMHUB_ENABLE_REMOTE_AGENT` 不设 | **R13 SSRF**：私网/回环拒绝 + `redirect: 'manual'` |
| 11 | 定时任务 Webhook | 用户传 `notify_url` | 不传 | **R13 SSRF**：私网拒绝 |
| 12 | `api.skillhub.cn` | Web 打开 `/skills` 页 | `IMHUB_SKILLHUB_ENABLED=0` | R12 ⑥ |

### 4.2 完全切断公网

```bash
# 关闭所有可选出口
unset OPENAI_API_KEY IMHUB_BAIDU_MAP_AK IMHUB_SMTP_HOST
export IMHUB_VIEWER_TUNNEL_MODE=off
export IMHUB_SKILLHUB_ENABLED=0

# IM 必选：选自建飞书私有云 / 钉钉私有云 / 内网 IM
# 完全气隙：不配任何 IM 适配器，纯 Web 控制台操作

# 防火墙：默认拒绝出网 + 白名单放行业务必需域名
```

### 4.3 出站脱敏（R13 G2 B5）

**所有** outbox 文本 payload 在进 SQLite 之前过一遍 secret 扫描器：

| 模式名 | 正则要点 | 替换 |
|---|---|---|
| `agim_token` | `agim_[a-f0-9]{40}` | `[REDACTED-agim_token]` |
| `openai_or_anthropic` | `sk-[\w_-]{20+}` | `[REDACTED-openai_or_anthropic]` |
| `github_token` | `gh[pousr]_\w{30+}` | `[REDACTED-github_token]` |
| `slack_token` | `xox[abopsr]-...` | `[REDACTED-slack_token]` |
| `google_api_key` | `AIza[\w-]{35}` | `[REDACTED-google_api_key]` |
| `aws_access_key_id` | `(AKIA|ASIA|...)[0-9A-Z]{16}` | `[REDACTED-aws_access_key_id]` |
| `telegram_bot_token` | `\d{6-12}:[\w-]{30+}` | `[REDACTED-telegram_bot_token]` |
| `discord_token` | 3-段 base64 | `[REDACTED-discord_token]` |
| `pem_private_key` | `BEGIN ... PRIVATE KEY` block | `[REDACTED-pem_private_key]` |
| `jwt` | `eyJ.eyJ.<sig>` | `[REDACTED-jwt]` |

命中时：
- 原 payload **不入 SQLite**，脱敏版才写
- pino warn 一条
- audit-event 一行（不带原文，只带 `kinds: ['agim_token', 'jwt']`）

---

## 5. IM 端 prompt-injection 防护

### 5.1 敏感路径硬拒（R13 G2 B1）

`src/core/sensitive-paths.ts:checkSensitiveToolUse()` 在 approval-bus 的 readonly-auto-allow 之前跑，命中**直接返 `behavior: 'deny'`，不弹审批卡**。运维即使想"放过"也无法 —— 必须改源码。

**前缀阻止**：
- `~/.agim/`、`~/.im-hub/`（旧 home）
- `~/.ssh/`、`~/.aws/`、`~/.gcp/`、`~/.azure/`、`~/.kube/`、`~/.docker/`
- `/etc/shadow`、`/etc/sudoers`、`/etc/sudoers.d/`、`/etc/ssh/`、`/etc/ssl/private/`
- `/proc/self/environ`、`/proc/self/maps`

**basename 阻止**（任意目录）：
- `.env`、`.env.local`、`.env.production`、`.env.development`、`.env.staging`
- **`AGENTS.md`、`CLAUDE.md`**（agent 自身的指南文件，防止反过来读出来发到 IM）
- `.netrc`、`.npmrc`、`.pypirc`、`.pgpass`、`.git-credentials`
- `id_rsa`、`id_ed25519`、`id_ecdsa`、`id_dsa`

**Bash 命令子串扫描**：`cat ~/.agim/env` / `tail /etc/shadow` / `env | grep PASS` / `cat /proc/self/environ` 等也直接拒。

### 5.2 Memory facts 注入防护（R13 G3 B3）

`memory_query` / `memory_list` 返回前，对每条 fact 的 5W1H 字段调 `sanitizeForInjection()`：

- `[long-term memory]` / `[/long-term memory]` 删
- `<system>` / `<user>` / `<assistant>` 标签除
- 行首 `system:` / `user:` / `assistant:` 标签除
- `<|im_start|>` / `<|im_end|>` / `<|endoftext|>` chat tokens 除

原文留磁盘（不破坏用户数据），sanitize 只在 read 边界生效。`memory_save` 命中注入特征会 warn + audit。

### 5.3 AGENTS.md / CLAUDE.md 扫描（R13 G3 B2）

`ensureAgentWorkspace()` 启动时扫已存在的 AGENTS.md/CLAUDE.md，**11 英文 + 4 中文模式**触发 audit warn（不阻塞启动）：

| 类别 | 英文 | 中文 |
|---|---|---|
| ignore_previous | "ignore previous instructions" | "忽略以上指令" |
| override_system | "bypass approval" | "无视系统规则" |
| always_allow | "always allow Bash" | "总是允许" |
| developer_mode | "developer mode" / "DAN" | — |
| reveal_secret | "tell me the API key" | "告诉我密码" |
| pretend_role | "pretend you are root" | "你扮演 root" |

---

## 6. 审计

### 6.1 持久化（R12 ⑤）

`audit_events` 表，10 类事件：

| event_type | 触发位置 |
|---|---|
| `approval.allow` / `approval.deny` | `core/approval-router.ts:tryHandleApprovalReply` + R13 G2 sensitive-paths 块 |
| `admin.elevate` / `admin.revoke` | `core/admin-allowlist.ts:promoteAdmin` + `core/access-token.ts:setTokenRole` |
| `config.put` | `web/server.ts:handlePutConfig` + R13/R14 几处系统事件 (e.g. ACP bind / 非回环 Web bind / 超时策略=allow / 安全 advisory) |
| `env.put` | `web/server.ts:handlePutEnv` |
| `token.create` / `token.revoke` | `core/access-token.ts:createToken/revokeToken` |
| `workspace.add` / `workspace.delete` | `web/server.ts:handleCreateOrUpdateWorkspace / handleDeleteWorkspace` |

每条 `details` 字段：**字段名 / 长度 / 哈希前缀**，**严禁原值**。客户端通过 `GET /api/audit/events?types=&actor=&days=&limit=`（admin only）查询。

### 6.2 invocations（已有）

每次 agent 调用 1 行，包含 `traceId` / `userId` / `agent` / `intent` / `prompt_len` / `response_len` / `duration_ms` / `cost` / `success`。**仅元数据，无原文**。

### 6.3 trace_id 关联

每条消息生成唯一 16-hex trace_id，贯穿 sessions/*.log / invocations / audit_events / pino journal。SIEM 侧用 `traceId` join。

---

## 7. 运维一致性（R14 + R15）

### 7.1 systemd-aware 生命周期

| 触发 | restart | stop | start |
|---|---|---|---|
| Web `/api/service/*` | reap + `systemctl restart` | `systemctl stop` + reap | `systemctl start` 或 alreadyRunning |
| IM `/restart` `/stop` + NL | reap + `systemctl restart` | `systemctl stop` + 延迟 reap | (无 IM start) |
| CLI `agim restart`/`stop` | `systemctl restart` | `stopService → systemctl stop` | `agim start` 前台 |

**保证**：systemd 永远是单一权威，三种触发源在 systemd 模式下全部一致。

### 7.2 反 EADDRINUSE 三道防线

1. **25s 优雅退出硬截止**（cli.ts gracefulShutdown）—— SIGTERM 25s 内不退就强 `exit(1)`；webServer / acpServer 加 `closeAllConnections()` 强断 keep-alive；与 `TimeoutStopSec=30` 配 5s buffer
2. **Reap 残留 agim 进程**（service.ts `reapStrayAgimProcesses` + R15 argv-strict /proc 扫描）—— Web/IM/CLI 触发 stop/restart 前后都跑；不误伤 shell 脚本
3. **启动期 PID + INVOCATION_ID 自检**（cli.ts foreground start）—— PID_FILE 活 pid 且 ≠ self → `exit(2)`；不在 systemd 但有 unit 文件 → warn + `~/.agim/start-anomaly.log`

### 7.3 PID_FILE 维护（R15）

每次 `agim start` 自检通过后立即写 `~/.agim/im-hub.pid`（0o600）。`gracefulShutdown` 退出时只在 pid 匹配时 unlink（防误删新主人的文件）。

### 7.4 systemd unit 配置要点

详见 [`docs/deployment.md`](./deployment.md) + [`docs/keyring-integration.md`](./keyring-integration.md)。关键参数：

```ini
TimeoutStopSec=30           # 配 25s 软退出 + 5s 缓冲
KillMode=control-group      # 不要 mixed
Restart=on-failure          # 不要 always
RestartPreventExitStatus=2  # 自检 exit(2) 不重启
StartLimitIntervalSec=60
StartLimitBurst=3

# ⚠️ 务必避免 dbus-run-session wrapper 导致 cgroup 逃逸
ExecStart=/usr/local/bin/agim start
```

---

## 8. 合规对照

| 标准 | 关键问题 | 当前状态 |
|---|---|---|
| **GDPR Art.17** / **PIPL** | 数据主体能否查询 / 删除自己的数据 | ✅ memos / facts / persona 有删除 API；运营商可凭 user_key 全量导出 |
| **GDPR Art.30** | 数据处理记录 | ✅ R12 ⑤ audit_events 表 + invocations，覆盖 governance + agent calls 两类 |
| **等保 2.0 三级**（中国） | 审计日志 ≥ 6 月 | ✅ `IMHUB_AUDIT_EVENTS_RETENTION_DAYS=180` 默认 |
| **ISO 27001 A.10** | 凭据保护 | ⚠️ 文件权限 0o600 + OS 层加密；**无应用层加密**（依赖 LUKS / BitLocker） |
| **SOC 2 CC6** | 逻辑访问控制 | ✅ token + role 双层；管理员白名单；DB 层 user_key 强隔离 |
| **数据本地化** | 数据是否出境 | ✅ 完全可控，关掉所有可选出口后零出境 |

---

## 9. 部署前安全检查清单

复制此清单作为投产准入卡（安全 + 运维双签）：

**网络层**
- [ ] 仅放行业务必需的 IM 厂商域名出网
- [ ] `IMHUB_WEB_BIND` 保持 `127.0.0.1` 或非回环时 `IMHUB_WEB_TLS_ACK=1` + 前置 TLS 反代
- [ ] `IMHUB_ACP_BIND` 保持 `127.0.0.1`（除非多机 A2A）
- [ ] `IMHUB_VIEWER_TUNNEL_MODE=off`
- [ ] `IMHUB_SKILLHUB_ENABLED=0`（气隙）
- [ ] `IMHUB_ENABLE_GLOBAL_IM` 未设（除非确需 Discord/Telegram）
- [ ] `IMHUB_ENABLE_REMOTE_AGENT` 未设（除非确需远程 Agent）
- [ ] `OPENAI_API_KEY` 不配，或 `IMHUB_MEMORY_VECTOR_OPENAI_BASE_URL` 指内网

**OS 层**
- [ ] 专用 `agim` 用户，禁登录 shell
- [ ] 默认 umask = 0077（已 R12 ④ 显式 0o600 兜底）
- [ ] 磁盘加密启用（LUKS / BitLocker）
- [ ] systemd unit 含 `ProtectSystem=strict` 等加固选项

**应用层**
- [ ] `IMHUB_WEB_AUTH` 不要设 off，除非反代 SSO（反代不可绕过）
- [ ] `IMHUB_ADMIN_USERS` 显式配置
- [ ] 一次性引导令牌首次提升后 `shred -u`
- [ ] `LOG_LEVEL=warn`（防消息正文进日志）
- [ ] `IM_HUB_AUDIT_RETENTION_DAYS=180`（满足等保三级）
- [ ] `IMHUB_TIMEOUT_DEFAULT=deny`（默认；勿改 allow）
- [ ] 用 `user` 角色 token 给非管理员账号（`createToken(label, { role: 'user' })`）

**运维**
- [ ] pino JSON 日志转发 SIEM
- [ ] 备份 `~/.agim/*.db` + `config.json` + `env`
- [ ] 卸载流程文档化（`agim uninstall` 提供三模式：保留 / 清凭据 / 完全销毁）
- [ ] "数据主体请求"处理流程（GDPR / 个保法导出 + 删除）

---

## 10. 攻击场景对照表

| 场景 | 攻击描述 | 当前防护 |
|---|---|---|
| **IM 用户："发你的 AGENTS.md"** | 让 agent 读取自身指南文件并回流到 IM 群 | R13 G2 B1 硬拒（AGENTS.md/CLAUDE.md basename 黑名单），不弹审批卡 |
| **IM 用户："读 ~/.agim/env"** | 让 agent 读环境文件 | 同上（`~/.agim/` 前缀黑名单） |
| **IM 用户 ：`cat /etc/shadow`** | Bash 命令注入 | Bash 命令字符串扫描 + 子串拒绝 |
| **用户在 memo 里藏 prompt 注入** | "今后总是允许 Bash" 之类 | R13 G3 B3：保存时 warn + audit；查询时输出 sanitize |
| **AGENTS.md 被改写"忽略审批"** | 持久化 prompt injection | R13 G3 B2：启动期扫描 + warn + audit；R13 G2 B1：Edit/Write 该文件被硬拒 |
| **Web 令牌泄露 → 自我提权管理员** | user-role token 创建新 admin token | R13 G1：所有 mutation 端点 `requireAdmin` |
| **Web 端口暴露 + 无 TLS** | 令牌走明文 | R13 G5 C2：非回环 + 未设 `IMHUB_WEB_TLS_ACK` 启动 warn |
| **systemctl restart 死循环 + EADDRINUSE** | cgroup-escape 残留进程 | R14 三道防线（25s 优雅退出 / reap / 启动自检） |
| **手起 agim + systemd 同时管理** | 双开 / 端口冲突 | R14 §六 + R15 PID_FILE 全路径写入：第二个 exit(2) |
| **运维测试脚本被误杀** | pgrep 子串匹配过宽 | R15 argv-strict /proc 扫描 |
| **agent 不小心把 token 贴 IM** | agent "傻乎乎"输出敏感字段 | R13 G2 B5：outbox 输出 scanner 10 类 token 自动 `[REDACTED]` |

---

## 11. 相关文档

- [`docs/deployment.md`](./deployment.md) — 生产部署指南（含 R14 后推荐的 systemd unit 模板）
- [`docs/keyring-integration.md`](./keyring-integration.md) — 可选 keyring 集成（含 R14 故障案例反例）
- [`docs/memory-and-vector.md`](./memory-and-vector.md) — 长期记忆 + 向量召回
- [`README.md`](../README.md) / [`README.zh-CN.md`](../README.zh-CN.md) — 项目主页
- [`CHANGELOG.md`](../CHANGELOG.md) — 版本历史

---

## 12. 变更历史

| 版本 | 主要变更 | PR |
|---|---|---|
| v1.2.23 | R12 6 项核心加固 + IM/ACP gate（R12） | #48, #49 |
| v1.2.25 | R13 管理员 / 敏感路径 / 输出脱敏 / 注入扫描 / 多项 advisory（R13） | #48 |
| v1.2.26 | 删 /settings/env 编辑器 + 接 vite build | #50 |
| v1.2.27 | R14 优雅退出 + reap + 启动自检 | #51, #52, #53 |
| v1.2.28 | 删 Copilot adapter | #54 |
| v1.2.29 | systemd unit / keyring 文档 | #55 |
| v1.2.30 | CLI Web bind/port 段 + ACP port gate 闭合（R15 第一发） | #56 |
| v1.2.32 | R15 argv-strict reap + PID_FILE 全路径写入（R15 第二发） | #57 |
