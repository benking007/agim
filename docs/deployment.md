# agim 部署指南

> 适用版本：v0.2.13+（2026-05-02 v2 升级后包括 sticky-agent 绝对锁、双层 TTL、per-Agent 工作目录）

本文档覆盖在 Linux 服务器上部署 agim 的完整流程：依赖、构建、systemd 守护、端口暴露、配置、平滑升级。Windows 与 macOS 部署路径相似（仅 systemd 部分需替换）。

---

## 一、最小依赖

| 依赖 | 版本 | 必需 |
|---|---|---|
| Node.js | ≥ 22 LTS | ✅ |
| npm | ≥ 10 | ✅（随 Node） |
| 至少一个 Agent CLI | — | ✅（详见下） |
| SQLite native build toolchain | gcc / make / python3 | ⚠️ 仅在 npm 装 better-sqlite3 时编译需要 |
| 可选：bun | ≥ 1.3 | 仅本地跑测试用，不在生产用 |

**Agent CLI**（至少装一个）：

```bash
npm i -g @anthropic-ai/claude-code   # Claude Code
npm i -g @openai/codex                # Codex
npm i -g @github/copilot              # Copilot
npm i -g opencode-ai                  # OpenCode
```

或者只对接 ACP 远端 agent，本机不装任何 CLI 也行。

---

## 二、安装

### 2.1 全局安装（推荐生产）

```bash
npm install -g agim
agim --version    # 应该输出已安装 npm 包的版本，例如 0.2.30
```

> 如果 `npm view agim version` 仍低于仓库 `package.json`，说明对应 release commit
> 还没有发布到 npm。生产全局安装只会拿到 npm 上的最新版本；需要先发布再升级。

### 2.2 从源码部署

```bash
# 克隆 + 构建
git clone https://github.com/benking007/imhub.git /opt/agim
cd /opt/agim
npm install
npm run build

# 全局软链
npm link
```

---

## 三、首次配置

`agim` 把所有运行时数据放在 `~/.agim/`（从 0.x 升级则继续用 `~/.agim/`）。结构如下：

```
~/.agim/
├── config.json              # 主配置（所有 messengers / agents / workspaces）
├── acp-token                # ACP（第三方 agent 调用）鉴权 token，自动生成
├── audit.db                 # 审计日志（30 天保留，可改）
├── jobs.db                  # Job Board
├── schedules.db             # 定时任务
└── sessions/                # 会话历史（每会话一个 .json + .log）
```

> Web 控制台（:3000）**没有内建鉴权**——不要直接 0.0.0.0 暴露，访问控制走反向代理 / 防火墙 / SSH 隧道 / VPN。ACP 端口（:9090）仍走 bearer-token 鉴权。

### 3.1 接入 IM 通道

至少配一个：

```bash
agim config telegram   # 输入 @BotFather 给的 bot token
agim config feishu     # 输入飞书 App ID / App Secret
agim config wechat     # 扫二维码登录
```

> Web 控制台单独跑也行，不一定要接 IM。

### 3.2 接入自定义 ACP Agent（可选）

```bash
agim config agent
# 交互式向导：name / endpoint / 鉴权方式
```

或在 `config.json` 里直接写：

```json
{
  "acpAgents": [
    { "name": "weather", "endpoint": "https://example.com/acp",
      "auth": { "type": "bearer", "token": "..." } }
  ],
  "acpDiscoveryUrls": [
    "https://internal.team.example.com"
  ]
}
```

`acpDiscoveryUrls` 会在启动时拉 `<url>/.well-known/acp`，自动注册其中所有 agent。

### 3.3 Workspace（多租户，可选）

```json
{
  "workspaces": [
    {
      "id": "engineering",
      "name": "Engineering",
      "agents": ["claude-code", "opencode"],
      "members": ["wx_alice", "wx_bob"],
      "rateLimit": { "rate": 30, "intervalSec": 60, "burst": 60 }
    }
  ]
}
```

不配置任何 workspace 时，默认 workspace 不限制（所有已注册 agent 都可用）。

### 3.4 IM Agent 工作区（v2 升级后默认启用）

通过 IM 入口（微信 / Telegram / 飞书 / Web）调用的 Claude Code 与 opencode，会以
独立工作目录启动，与你直连终端跑的 `claude` / `opencode` 完全隔离。Web 控制台 /
定时任务 / intent-llm 路由不走该机制（cwd 不变）。

**默认目录**：

```
~/.agim-workspaces/
├── claude-code/
│   ├── CLAUDE.md          # IM 入口的 Claude 角色定义（首次启动种子，后续不覆盖）
│   └── memory/            # Claude auto-memory（per-cwd 自然落入）
└── opencode/
    ├── AGENTS.md          # IM 入口的 opencode 角色定义
    └── memory/
```

启动时 agim 会幂等创建这两个目录并种入初始模板。**已存在的 CLAUDE.md / AGENTS.md
不会被覆盖**，可以直接 vim 编辑当作"IM 入口的角色书"。

**调整工作区位置**：

```ini
# /etc/systemd/system/agim.service
Environment="IMHUB_WORKSPACES_ROOT=/srv/imhub-workspaces"
# 或单独覆盖某个 agent
Environment="IMHUB_CLAUDE_CODE_CWD=/srv/imhub/cc"
Environment="IMHUB_OPENCODE_CWD=/srv/imhub/oc"
```

**验证**：

```bash
# 1. 工作区存在 + 种子文件就位
ls -la ~/.agim-workspaces/claude-code/CLAUDE.md
ls -la ~/.agim-workspaces/opencode/AGENTS.md

# 2. 通过 IM 给 Claude 发 "pwd"
#    → 返回 /root/.agim-workspaces/claude-code（而非 /）
# 3. 通过 IM 给 opencode 发 "pwd"
#    → 返回 /root/.agim-workspaces/opencode
```

详细使用方式见 [`docs/im-workspaces-guide.md`](./im-workspaces-guide.md)。

### 3.5 会话保持（v2 双层 TTL）

| TTL | 默认 | env 覆盖 | 含义 |
|---|---|---|---|
| 消息历史 | 30 min | `IMHUB_SESSION_MESSAGES_TTL_MS` | idle 后清空内存 + 删 `<key>.log` |
| 会话元数据 | 7 d | `IMHUB_SESSION_META_TTL_MS` | idle 后才完整删 session（含 sticky agent + Claude resumable id） |

**正常含义**：30 min 不说话也不会切 agent；7 天内回来 Claude 还能 `--resume` 续上之前
的 jsonl 历史。多用户高流量场景可下调 META TTL：

```ini
Environment="IMHUB_SESSION_META_TTL_MS=86400000"   # 1 天
```

---

## 四、启动

### 4.1 直接前台运行（用于调试）

```bash
agim start
```

### 4.2 systemd 服务（生产）

`/etc/systemd/system/agim.service`：

```ini
[Unit]
Description=agim — IM-to-Agent gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=imhub
Group=imhub
WorkingDirectory=/home/imhub
Environment="HOME=/home/imhub"
Environment="NODE_ENV=production"
Environment="LOG_LEVEL=info"
Environment="LOG_FORMAT=json"
# 任务并发上限（默认 3）
Environment="IM_HUB_MAX_CONCURRENT_JOBS=5"
# 审计日志保留天数（默认 30）
Environment="IM_HUB_AUDIT_RETENTION_DAYS=60"
# 可选：让 LLM 兜底参与意图路由
# Environment="IM_HUB_LLM_JUDGE_AGENT=claude-code"

# ⚠️ 务必直接 exec /usr/local/bin/agim start
# 不要用 ExecStart=/usr/bin/dbus-run-session -- /bin/bash -c 'exec agim start'
# 之类的 wrapper —— dbus / 子 shell 会把 agim 子进程从 cgroup 里挂出去,
# systemctl stop 之后 cgroup-kill 失败、老进程残留、新进程 EADDRINUSE
# (这就是 R14 修复的故障模式).
# 如果一定要起 keyring / dbus, 把它们放进 ExecStartPre=, 见
# docs/keyring-integration.md.
ExecStart=/usr/local/bin/agim start

# R14 — 生命周期 + 失败处理
# - on-failure (不要 always): EADDRINUSE / pid 自检退出 (exit 2) 应该让
#   人介入, 不要每 5 秒重撞.
# - StartLimit*: 60s 内最多 3 次, 超过转 failed 状态停止自动重启.
# - RestartPreventExitStatus=2: cli.ts 启动期 PID 自检失败用 exit 2 表
#   示 "已有另一个 agim 在跑", systemd 应该尊重这个决定.
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=3
RestartPreventExitStatus=2

# R14 — 优雅退出 + cgroup 完整性
# - TimeoutStopSec=30: 与 agim 内置 25s 硬截止 (src/cli.ts) 配合, 留
#   5s 缓冲. systemd 在 30s 后 SIGKILL.
# - KillMode=control-group: 整组 kill 比 mixed 更可靠, 遇孤儿态时整组
#   清理. 不要用 mixed —— 它只对 MainPID SIGTERM, 子进程要等超时.
TimeoutStopSec=30
KillMode=control-group

# 安全加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/imhub/.agim
PrivateTmp=true
PrivateDevices=true

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo useradd -m -s /bin/bash imhub
sudo cp agim.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agim
sudo systemctl status agim
sudo journalctl -u agim -f
```

> 全局安装的 `agim` 路径取决于你的 npm prefix。`which agim` 找一下，把 `ExecStart` 改成实际路径。

> **如果你的部署需要 gnome-keyring / dbus**（典型场景：cloudflared 需要在无 GUI session 的情况下拿 OAuth 凭据），**不要**用 `dbus-run-session` wrapper —— 见 [`docs/keyring-integration.md`](./keyring-integration.md) 的正反例。

### 4.3 Docker（可选）

最简 Dockerfile：

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache python3 make g++ sqlite-libs
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY src/web/public ./dist/web/public
ENV HOME=/data
VOLUME /data
EXPOSE 3000 9090
CMD ["node", "dist/cli.js", "start"]
```

```bash
docker build -t agim .
docker run -d \
  --name agim \
  -v /opt/agim-data:/data \
  -p 3000:3000 \
  -p 9090:9090 \
  -e LOG_LEVEL=info \
  -e LOG_FORMAT=json \
  agim
```

---

## 五、端口与暴露

| 端口 | 服务 | 默认绑定 | 暴露建议 |
|---|---|---|---|
| 3000 | Web 控制台 + REST API | **`127.0.0.1`**（v0.2.30 起默认回环） | 公网部署时放在 HTTPS 反代后；需要直连时显式设置 `IMHUB_WEB_BIND=0.0.0.0` |
| 9090 | ACP Server | `127.0.0.1` only | 仅 ACP 上游需要时 |

> ⚠️ Web 控制台默认只监听回环地址，避免新部署误暴露到公网。
> 如需从局域网/公网访问，请在 systemd 或容器环境变量里显式声明：
>
> ```ini
> Environment="IMHUB_WEB_BIND=0.0.0.0"
> ```
>
> **Agim 的 web 控制台不带任何内建鉴权（无登录页、无 token、无 session cookie）**——0.0.0.0 暴露时所有访问控制必须走外面：
> 1. 用防火墙（云厂商安全组 / iptables / ufw）只允许已知来源 IP；
> 2. 用 nginx/Caddy 做 HTTPS 反代 + Basic Auth / OAuth2 Proxy / mTLS；
> 3. 或者别开 0.0.0.0，留在 127.0.0.1 然后用 SSH 隧道 / Tailscale / WireGuard 接进来。

### 5.1 nginx 反代示例

```nginx
upstream imhub_web { server 127.0.0.1:3000; }

server {
  listen 443 ssl http2;
  server_name imhub.example.com;
  ssl_certificate     /etc/letsencrypt/live/imhub.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/imhub.example.com/privkey.pem;

  # WebSocket 升级
  location / {
    proxy_pass http://imhub_web;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 600s;        # 长 agent 任务
    proxy_send_timeout 600s;
  }
}

server {
  listen 80;
  server_name imhub.example.com;
  return 301 https://$server_name$request_uri;
}
```

### 5.2 端口冲突

修改 `~/.agim/config.json`：

```json
{ "webPort": 3001, "acpPort": 9091 }
```

---

## 六、Web 控制台

启动后浏览器访问 `http://<host>:3000`。三个页面：

| 路径 | 功能 |
|---|---|
| `/` | Agent 对话 |
| `/tasks` | 任务面板（jobs + schedules，可创建/取消/查看结果） |
| `/settings` | 配置 agents / messengers / ACP / discovery |

无内建鉴权——所有 `/api/*` 请求直接放行。访问控制必须靠反向代理 / 防火墙。

---

## 七、监控

### 7.1 Prometheus 抓取

`/api/metrics` 输出 Prometheus text exposition 格式：

```
scrape_configs:
  - job_name: agim
    metrics_path: /api/metrics
    static_configs:
      - targets: ['imhub.example.com']
    scheme: https
```

> 公网暴露请用 nginx Basic Auth 等手段在反代层加保护，Agim 自身不鉴权。

关键指标：

```
im_hub_agent_invocations_total{agent,result}
im_hub_agent_latency_ms{agent,quantile=0.5|0.95|0.99}
im_hub_agent_cost_sum{agent}
im_hub_intent_total{intent}
im_hub_uptime_seconds
```

### 7.2 健康检查

```bash
curl http://127.0.0.1:3000/api/health
```

返回 `{ ok: true, agents: { ... } }`，所有 agent 都不可用时返回 503。可用作 k8s readiness probe。

### 7.3 日志

`LOG_FORMAT=json` 时输出结构化日志（pino），每条都带 `traceId`，可以串到 ELK / Loki：

```json
{"level":30,"time":...,"traceId":"a4b3c8...",
 "platform":"telegram","component":"router","msg":"router.intent",
 "agent":"opencode","intent":"topic","score":3.2}
```

`grep traceId=a4b3c8` 就能拉出某次请求从 messenger → router → agent → audit 的全链路。

---

## 八、备份

业务数据完全在 `~/.agim/` 下，**无外部依赖**。备份策略：

```bash
# 停服 → 备份 → 起服（推荐：业务低峰）
sudo systemctl stop agim
tar czf agim-$(date +%F).tgz -C /home/imhub .agim
sudo systemctl start agim

# 或热备（SQLite WAL 模式安全；v1.2.0+ 加了 memory.db）
sqlite3 /home/imhub/.agim/audit.db    ".backup /backup/audit.db"
sqlite3 /home/imhub/.agim/jobs.db     ".backup /backup/jobs.db"
sqlite3 /home/imhub/.agim/schedules.db ".backup /backup/schedules.db"
sqlite3 /home/imhub/.agim/outbox.db   ".backup /backup/outbox.db"
sqlite3 /home/imhub/.agim/memos.db    ".backup /backup/memos.db"
sqlite3 /home/imhub/.agim/reminders.db ".backup /backup/reminders.db"
sqlite3 /home/imhub/.agim/memory.db   ".backup /backup/memory.db"   # v1.2.0+
sqlite3 /home/imhub/.agim/viewer.db   ".backup /backup/viewer.db"   # v1.1.6+
cp /home/imhub/.agim/config.json /backup/
cp /home/imhub/.agim/env         /backup/   # 含 IMHUB_ADMIN_USERS / SMTP 等
cp /home/imhub/.agim/tokens.json /backup/   # v1.1.10+ Web 鉴权 token
cp -r /home/imhub/.agim/sessions /backup/
# 不需要备份的：cache/ (transformers 模型，重启会重下) / *.log / *.pid
```

**v1.2.0+ 记忆数据**：`memory.db` 体积小（每用户 < 1MB / 千条 fact），但**含用户偏好 / 隐私信息**，建议加密备份或限定备份目标。模型缓存 `~/.agim/cache/transformers/` 不用备份——重新启用 vector 时按需重下即可。

---

## 九、管理员管理（v1.0+，v1.2.2 加 invite）

服务管控类操作（`/restart` / `/stop` / 自然语言"重启服务" / web Safety 卡片）都要 admin。

### 9.1 首次部署：bootstrap token

agim 启动时检测 `IMHUB_ADMIN_USERS` 为空，会自动生成 12 字符 base32 一次性 token 写到 `~/.agim/admin-bootstrap-token`（chmod 600）+ 日志：

```
journalctl -u agim | grep "setup admin"
# 或
cat ~/.agim/admin-bootstrap-token
```

在 IM 里发：

```
/setup admin <token>
```

token 消费后被 unlink，你当前账号 (platform:userId) 写入 `~/.agim/env` 的 `IMHUB_ADMIN_USERS`。

### 9.2 新增管理员（v1.2.2+）

**方式 A · 已有 admin 在终端**：

```bash
agim admin invite
# 输出：
#   ✓ Admin invite token generated.
#       token : ABCD-EFGH-IJKL
#   Forward this to the invitee:
#       /setup admin ABCD-EFGH-IJKL
```

把 `/setup admin <token>` 那条发给被邀人，他在自己的 IM（任意接入的渠道）里粘贴即升级。**单次有效**，再生成新 invite 会作废上一个未消费的。

**方式 B · 已有 admin 用交互菜单**：

```bash
agim              # 进入主菜单
# 选「邀请新管理员（生成一次性 IM token）」/「Invite a new admin」
```

**方式 C · web Safety 卡片**：Settings 页 → 安全 → 直接填 platform + user id（适合你已经知道对方 ID 的场景）。

### 9.3 查看 / 删除

```bash
agim admin list
# Admins (2):
#   wechat:wxid_abc123
#   telegram:8754479311

# 删除：直接编辑 ~/.agim/env 的 IMHUB_ADMIN_USERS 逗号分隔列表，重启服务
# 或 web Safety 卡片点「移除」按钮（即时生效，无需重启）
```

### 9.4 拒绝 / 被忽悠的场景

- 非 admin 在 IM 发 `/restart` → `🛑 你没有权限执行此操作`
- 完全没配 admin 的全新部署 → 引导消息显示如何取 bootstrap token
- 群聊里别人点你的恢复卡按钮 → v1.2.0+ 校验 creator_id，bystander 被拒

---

## 十、升级

```bash
# 全局安装
sudo systemctl stop agim
npm install -g agim@latest
sudo systemctl start agim

# 源码部署
cd /opt/agim
sudo systemctl stop agim
git pull
npm install
npm run build
sudo systemctl start agim
```

升级前看一下 `CHANGELOG.md`。配置文件向前兼容（新字段都是可选）。

会话格式向前兼容：旧的单文件 session JSON 会被读取并迁移到新的"metadata.json + log.jsonl"split format，不需要手工迁移。

---

## 十一、常见问题

### `better-sqlite3` 装不上

需要 build toolchain：

```bash
# Debian/Ubuntu
sudo apt install build-essential python3
# CentOS/RHEL
sudo yum groupinstall "Development Tools"
sudo yum install python3
# Alpine
apk add python3 make g++ sqlite-libs
```

或装预编译 binary：

```bash
npm install -g agim --build-from-source=false
```

### 启动后 Web 端 401 / 403

Agim 1.x 的 Web 控制台无内建鉴权，401/403 一般来自前面的反向代理。检查 nginx/Caddy 的 Basic Auth、OAuth2 Proxy、Cloudflare Access 等配置。

### 任务跑得太多把内存吃满

调小 `IM_HUB_MAX_CONCURRENT_JOBS`（默认 3，建议跟 CPU/内存量对齐：每个 agent 进程峰值 200-500 MB）。

### 想关掉审计日志

```bash
export IM_HUB_AUDIT_RETENTION_DAYS=1   # 仍写入但只保留 1 天
```

或者直接删 `~/.agim/audit.db`，agim 会重建空表（重启后生效）。

### 飞书 / Telegram bot 有时收不到消息

检查日志的 `level=40` 行；最常见原因是 webhook/long-polling 网络中断。systemd 配 `Restart=always` 让进程重启即可恢复。

### IM 中 Claude 总是漂移到 opencode（或反之）

v0.2.15 + v2 升级后此问题应已修复（sticky-agent 绝对锁 + meta TTL 7d）。如仍发生：

1. 看 `/audit`（IM 内命令）最近一行 `intent` 字段：应为 `sticky`
2. 检查 `~/.agim/sessions/<key>.json` 是否还在（meta TTL 内不应被删）
3. 没有 `.json` → 说明超过 7d 触发 meta cleanup，属于预期；用 `/cc` 或 `/oc` 重新锁定
4. 有 `.json` 但 agent 还是被改 → 排查 `intent.ts:classifyIntent` 的早返回逻辑是否生效（`bun test test/unit/intent.test.ts`）

### IM 给 Claude 发 `pwd` 仍返回 `/`

说明 v2 升级后还没重启 agim，或 `~/.agim-workspaces/` 目录有权限问题。

```bash
sudo systemctl restart agim
ls -la ~/.agim-workspaces/      # 确认存在 + agim 可写
ls /root/workspace/imhub/dist/core/agent-cwd.js  # 确认新代码已编译
```

### 想关掉 IM 工作区隔离（回到全局共享）

不推荐（会让 IM 与终端记忆互相污染），但若必须：

```ini
# 单 agent
Environment="IMHUB_CLAUDE_CODE_CWD=/"
Environment="IMHUB_OPENCODE_CWD=/"
```

或者改源码 `core/agent-cwd.ts:resolveAgentCwd` 让它直接返回 `undefined`。

### 想把 Web/ACP 暴露到公网

**Web 控制台没有内建鉴权**，不要直接开放。一定要：
1. 反向代理强制 HTTPS + Basic Auth / OAuth2 Proxy / mTLS（见 §5.1）
2. 防火墙只允许已知来源 IP
3. ACP 端口（默认 9090）走 bearer-token 鉴权，token 在 `~/.agim/acp-token`；删该文件 + 重启服务可轮换

---

## 十二、自检清单

部署完跑一遍：

```bash
# 1. 服务起来了
systemctl status agim 2>/dev/null || systemctl status agim
journalctl -u agim --since "5 min ago" 2>/dev/null || \
  journalctl -u agim --since "5 min ago"

# 2. 端口监听
ss -lntp | grep -E ':(3000|9090)'

# 3. Web 健康
curl -fsS http://127.0.0.1:3000/api/health | jq

# 4. agent 可用性
curl -fsS http://127.0.0.1:3000/api/agents/status | jq

# 5. metrics 正常
curl -fsS http://127.0.0.1:3000/api/metrics | head

# 6. 跑一个回环任务
curl -fsS -X POST \
  -H "Content-Type: application/json" \
  -d '{"prompt":"echo hello","agent":"claude-code"}' \
  http://127.0.0.1:3000/api/invoke | jq
```

每条都返回成功就 OK。

---

## 十三、环境变量速查

| 变量 | 默认 | 说明 |
|---|---|---|
| `LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error`/`fatal`/`silent` |
| `LOG_FORMAT` | `pretty` (TTY) / `json` (非 TTY) | 强制：`pretty` / `json` |
| `IM_HUB_MAX_CONCURRENT_JOBS` | `3` | 同时执行的 Job 数上限 |
| `IM_HUB_AUDIT_RETENTION_DAYS` | `30` | 审计日志保留天数 |
| `IM_HUB_LLM_JUDGE_AGENT` | （未设） | LLM 兜底路由的 judge agent 名 |
| `IM_HUB_LLM_JUDGE_THRESHOLD` | `1.0` | judge 触发的规则引擎置信度阈值 |
| `<AGENT>_TIMEOUT_MS` | `1800000` (30min) | 单 agent 超时（如 `OPENCODE_TIMEOUT_MS`） |
| `IMHUB_SESSION_MESSAGES_TTL_MS` | `1800000` (30min) | 消息历史 idle TTL（v2 拆分） |
| `IMHUB_SESSION_META_TTL_MS` | `604800000` (7d) | 会话元数据 idle TTL（v2 拆分，sticky agent + Claude resumable id 寿命） |
| `IMHUB_WORKSPACES_ROOT` | `~/.agim-workspaces` | IM Agent 工作区根目录（v2 引入） |
| `IMHUB_CLAUDE_CODE_CWD` | （未设） | 单独覆盖 IM 入口 Claude 的 cwd |
| `IMHUB_OPENCODE_CWD` | （未设） | 单独覆盖 IM 入口 opencode 的 cwd |
| `IMHUB_ADMIN_USERS` | （空：拒绝所有服务管控命令） | 逗号分隔 `platform:userId`；管理 `/restart` / `/stop` / Safety 卡片权限。一般通过 `agim admin invite` 或 web UI 管理，不手动编辑 |
| `IMHUB_WEB_AUTH` | `on` | `off` 退回 1.1.10 之前的无 token 模式（自担风险） |
| **v1.2.0+ 记忆** | | |
| `IMHUB_MEMORY_ENABLED` | `0` | `1`/`true`/`yes` 启用记忆 + 蒸馏 |
| `IMHUB_MEMORY_CONSOLIDATE_ENABLED` | `1` | 单独关闭 daily consolidation（保留蒸馏） |
| `IMHUB_MEMORY_CONSOLIDATE_HOURS` | `24` | consolidation 周期 |
| `IMHUB_MEMORY_VECTOR_BACKEND` | `off` | `off` / `local` / `openai` |
| `IMHUB_MEMORY_VECTOR_LOCAL_MODEL` | `Xenova/bge-base-zh-v1.5` | HuggingFace repo id；预设：small/base/large 三档 |
| `IMHUB_MEMORY_VECTOR_OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容端点 |
| `IMHUB_MEMORY_VECTOR_OPENAI_MODEL` | `text-embedding-3-small` | 嵌入模型 id |
| `IMHUB_MEMORY_VECTOR_OPENAI_API_KEY` | （空） | API key（secret，web UI 默认掩码） |
| `IMHUB_PUSH_RATE_PER_HOUR` | `20` | 单用户 push 每小时上限 |
| `IMHUB_PUSH_CROSS_THREAD` | `0` | `1` 允许 push 到非原发起 thread |
| **v1.1.6+ Viewer** | | |
| `IMHUB_VIEWER_ENABLED` | `0` | `1` 启用长消息 viewer |
| `IMHUB_VIEWER_PUBLIC_BASE_URL` | （空） | 反代后的公网域名，例如 `https://agim.example.com` |

---

## 十四、卸载

```bash
sudo systemctl disable --now agim
sudo rm /etc/systemd/system/agim.service
sudo systemctl daemon-reload
npm uninstall -g im-hub-pro
sudo userdel -r imhub          # 同时删 ~/.agim 数据
```
