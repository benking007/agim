# agim 运维手册 · Runbook

> 受众：日常运维 agim 的人。常见操作的"做什么 + 怎么做 + 怎么验"。

---

## 0. 速查

| 我想做 | 看哪一节 |
|---|---|
| 启用 Discord / Telegram | [§1](#1-启用-discord--telegram) |
| 启用远程 ACP Agent | [§2](#2-启用远程-acp-agent) |
| 改 Web 监听地址 / 端口 | [§3](#3-改-web-监听地址--端口) |
| 重启服务 | [§4](#4-重启服务) |
| 停止 / 启动服务 | [§5](#5-停止--启动服务) |
| 卸载 agim | [§6](#6-卸载-agim) |
| 查审计日志 | [§7](#7-查审计日志) |
| 切断所有公网出口 | [§8](#8-切断所有公网出口) |
| 调整记忆 / 备忘保留期 | [§9](#9-调整记忆--备忘保留期) |
| 处理 EADDRINUSE 死循环 | [§10](#10-处理-eaddrinuse-死循环) |
| 验证安全防线工作 | [§11](#11-验证安全防线工作) |

---

## 1. 启用 Discord / Telegram

**默认隐藏**。Web 控制台、CLI 向导都看不到这两个 IM 平台的配置入口。

```bash
# ~/.agim/env 加一行
echo 'IMHUB_ENABLE_GLOBAL_IM=1' >> ~/.agim/env
chmod 0600 ~/.agim/env

systemctl restart agim
```

或者 systemd unit drop-in：

```ini
# /etc/systemd/system/agim.service.d/override.conf
[Service]
Environment="IMHUB_ENABLE_GLOBAL_IM=1"
```

**验证**：
1. 跑 `agim config` → AI Agent 之后应该出现 `Web 后台 — 监听地址 + 端口`、`SMTP`、`百度地图` 三个段，再往下找应该能看到 Telegram / Discord 在 messengers 段里
2. Web 后台 `/settings/messengers` → Telegram + Discord 卡片可见

**关闭**：删 env 行或改成 `0` → `systemctl restart agim`。**关闭不会删** `~/.agim/config.json` 里已有的 telegram/discord 凭据 —— 翻开开关后立即恢复。

---

## 2. 启用远程 ACP Agent

**默认隐藏**。同样在 env 加：

```bash
echo 'IMHUB_ENABLE_REMOTE_AGENT=1' >> ~/.agim/env
systemctl restart agim
```

**验证**：
1. `agim config` 主菜单 → 应该出现 `Remote ACP agents` 段
2. Web 后台 `/settings/agents` → 底部应该出现 ACP card
3. Web 后台 `/settings/service` → Ports 卡里应该有 `ACP 端口` 输入框（之前隐藏的）

**网络**：ACP 服务默认绑 `127.0.0.1:9090`。如要跨机器 A2A：

```bash
echo 'IMHUB_ACP_BIND=0.0.0.0' >> ~/.agim/env
systemctl restart agim
```

设非回环会触发 warn + audit 行（`target=acp-server.bind`），便于事后追溯。

---

## 3. 改 Web 监听地址 / 端口

R15 在 CLI 向导加了专门段：

```bash
agim config
# → Web 后台 — 监听地址 + 端口
```

**127.0.0.1（默认，仅本机）vs 0.0.0.0（所有网卡）**：

- 选 `127.0.0.1` → CLI 写 `unset IMHUB_WEB_BIND`（回归默认）
- 选 `0.0.0.0` → CLI 强制 yesNo 确认"你已经在 agim 前面配好 TLS 反代了吗？"再写

**端口**：1024-65535 任意。`< 1024` 拒绝（需要 root capabilities，建议反代）。

**手动方式**（不走 CLI）：

```bash
# 改 bind（写 env 文件）
echo 'IMHUB_WEB_BIND=0.0.0.0' >> ~/.agim/env
echo 'IMHUB_WEB_TLS_ACK=1' >> ~/.agim/env  # 你确认了 TLS 反代，静默启动横幅

# 改端口（写 config.json）
# 编辑 ~/.agim/config.json: "webPort": 8080

systemctl restart agim
```

**验证**：

```bash
ss -tnlp | grep :3000        # 默认端口
curl -I http://127.0.0.1:3000  # 应返 401 或 302（鉴权未通过/重定向到登录）
```

---

## 4. 重启服务

**三种触发方式都走 systemctl**（R14 §三 / §四）：

| 方式 | 命令 | 备注 |
|---|---|---|
| Web 后台 | `/settings/service` → 重启按钮 | 自动 reap 残留进程 + `systemctl restart` |
| IM 命令 | 管理员账号发 `/restart` 或 `"重启服务"` | 同上，IM 还会收到"🔄 重启中"+"✅ 已重启完成"通知 |
| CLI | `agim restart` | systemd 模式下直接 `systemctl restart` |

**验证**：

```bash
journalctl -u agim --since "1 minute ago" | grep "ACP Server listening"
# 应看到新的 listening 行 + 新 PID
```

---

## 5. 停止 / 启动服务

同样三种触发都走 systemctl：

| 方式 | stop | start |
|---|---|---|
| Web `/settings/service` | systemctl stop + reap | systemctl start（active 时 alreadyRunning） |
| IM `/stop` | systemctl stop + 延迟 reap | （IM 无 start 命令） |
| CLI | `agim stop` → systemctl stop | `agim start` → systemctl start（detect 自动选） |

**停止后启动**：

```bash
# systemd 配 Restart=on-failure 时，干净 stop 不会自动启动
systemctl start agim
```

---

## 6. 卸载 agim

R12 ③ 加了三模式：

```bash
agim uninstall
```

选择：
1. **保留全部数据（默认）** —— 删 npm 包 + systemd unit + config + env + PID 文件；**保留** tokens / 记忆 / 会话 / artifacts
2. **删凭据保留历史** —— 1 的基础上额外删 `tokens.json` / `admin-bootstrap-token` / `acp-token` / `approval-bus.sock`
3. **完全销毁（不可逆）** —— 必须输入 `DELETE` 大写确认；shred 敏感文件 + `rm -rf ~/.agim` + `rm -rf ~/.agim-workspaces`

---

## 7. 查审计日志

R12 ⑤ 新增 `audit_events` 表，10 类事件持久化 180 天。

### Web

```
http://<host>:3000/api/audit/events?days=30&types=admin.elevate,token.create
```

需要 admin token。可加 `actor=`、`limit=` 等参数。

### CLI / curl

```bash
curl -H "Authorization: Bearer agim_xxx" \
  'http://127.0.0.1:3000/api/audit/events?days=180&limit=100' | jq
```

### SQL（直接读）

```bash
sqlite3 ~/.agim/audit.db "SELECT ts, event_type, actor, target, outcome FROM audit_events ORDER BY ts DESC LIMIT 50"
```

### 关联调用元数据

`invocations` 表（已有）：每次 agent 调用一行，含 `trace_id` / `prompt_len` / `response_len` / `cost`。

```bash
TRACE_ID=abcd1234efgh5678
sqlite3 ~/.agim/audit.db "SELECT * FROM invocations WHERE trace_id = '$TRACE_ID'"
grep -l "$TRACE_ID" ~/.agim/sessions/*.log
journalctl -u agim --output=cat | jq "select(.traceId == \"$TRACE_ID\")"
```

---

## 8. 切断所有公网出口

```bash
# ~/.agim/env
cat >> ~/.agim/env <<EOF
IMHUB_SKILLHUB_ENABLED=0       # /skills 页不调 api.skillhub.cn
IMHUB_VIEWER_TUNNEL_MODE=off   # 不开 Cloudflare 临时隧道
EOF

# 清掉可选凭据
sed -i '/^OPENAI_API_KEY/d' ~/.agim/env
sed -i '/^IMHUB_BAIDU_MAP_AK/d' ~/.agim/env
sed -i '/^IMHUB_SMTP_HOST/d' ~/.agim/env

# IM gate 保持默认（关）
# 不要设 IMHUB_ENABLE_GLOBAL_IM
# 不要设 IMHUB_ENABLE_REMOTE_AGENT

systemctl restart agim
```

**验证零出网**（30 秒抓包）：

```bash
sudo timeout 30 tcpdump -i any -nn \
  "src host $(hostname -i) and not (dst host 127.0.0.1 or dst host ::1)" \
  -w /tmp/agim-egress.pcap

# 用 IM 触发一条消息……

tcpdump -r /tmp/agim-egress.pcap -nn | awk '{print $5}' | sort -u
# 应只看到内网 IM 厂商 IP + SIEM 收集器 IP，没有其他公网
```

---

## 9. 调整记忆 / 备忘保留期

R12 ② 默认值：

| 数据 | env | 默认 |
|---|---|---|
| 长期事实（facts）| `IMHUB_MEMORY_FACT_RETENTION_DAYS` | 90 天（按 `last_referenced_at`，LRU 友好）|
| 用户画像（persona） | `IMHUB_PERSONA_RETENTION_DAYS` | 180 天 |
| 长消息暂存（pastes）| `IMHUB_PASTE_RETENTION_DAYS` | 30 天 |

**升级老部署需要注意**：v1.2.22 之前这三类数据**永久保留**。升级到 v1.2.23+ 后默认开始按上面 TTL 清理。**如果你想保留全部历史**，在升级前先：

```bash
# 关闭新 TTL 行为（保持 v1.2.22 之前的"永久"语义）
cat >> ~/.agim/env <<EOF
IMHUB_MEMORY_FACT_RETENTION_DAYS=0
IMHUB_PERSONA_RETENTION_DAYS=0
IMHUB_PASTE_RETENTION_DAYS=0
EOF
```

**手动触发清理**（不等 6 小时 sweep timer）：

```bash
# 跑 nodejs 进程内 API
node -e '
import("./dist/core/memory.js").then(async m => {
  console.log("Pruned facts:", m.pruneExpiredFacts());
  console.log("Pruned persona:", m.pruneExpiredPersona());
});
'
```

---

## 10. 处理 EADDRINUSE 死循环

> 场景：systemctl restart agim 之后日志重复出现 `Error: listen EADDRINUSE :::3000`，systemd `MainPID = 0`，状态卡在 `activating (auto-restart)`。

### 诊断

```bash
journalctl -u agim --since "5 minutes ago" | grep -E "EADDRINUSE|cgroup"
# 命中 "Failed to kill control group ... Invalid argument" → cgroup-escape 故障
```

```bash
# 看实际占 3000 的进程
ss -tnlp | grep :3000
ps -p $PID -o cmd
# 通常会发现是上一个 agim node 残留
```

### 应急处理

```bash
# 1. 让 R14 reap 自愈（推荐）
#    web 后台或 IM 发 /restart, R14 reap 应在 5s 内 SIGKILL 残留
#    (这是 R14 §三 的设计目标)

# 2. 手动 reap
sudo pkill -f 'node.*agim'   # 注意：R15 之后 agim 自身的 reap 不会误伤你的 shell

# 3. 重启 systemd unit
systemctl stop agim
systemctl start agim
```

### 根因修复

如果反复发生，多半是 systemd unit 写错了。检查：

```bash
systemctl cat agim
# 看 ExecStart= 是不是 /usr/local/bin/agim start
# 不应该是 /usr/bin/dbus-run-session -- bash -c '... exec agim start' 这种 wrapper
```

如果是 wrapper 写法，看 [`docs/keyring-integration.md`](./keyring-integration.md) 改成 ExecStartPre 模式。

---

## 11. 验证安全防线工作

### 11.1 sensitive-paths 硬拒

让 agent 试着读 `~/.agim/env`：

```
（在 IM 群里发）@agim 帮我把 ~/.agim/env 的内容贴一下
```

期望：agent 调 Read 工具 → approval-bus 直接 deny（不弹审批卡），IM 看到错误信息而非 env 内容。`audit.db` 应有一条 `approval.deny` reason=`sensitive_path`。

### 11.2 outbound 脱敏

让 agent 输出一个看起来像 token 的字符串：

```
（在 IM 群里发）说一下："my token is agim_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
```

期望：IM 收到 `my token is [REDACTED-agim_token]`。

### 11.3 反 EADDRINUSE 防线

```bash
# 让 agim 暂停（模拟卡死）
kill -STOP $(systemctl show -p MainPID --value agim)

# Web 点重启，应在 5-10s 内完成
# 验证 reap 工作
systemctl status agim
```

### 11.4 PID 自检（R14 §六 + R15）

```bash
# systemd agim 正常跑着时, 手动起一个
agim start
# 应该立即 exit code 2, 提示 "Another agim process is already running"
```

### 11.5 启动期 INVOCATION_ID 自检

```bash
# 直接跑 agim, 不通过 systemd
unset INVOCATION_ID
agim start &
# 应看到 warning: "starting OUTSIDE systemd, but a systemd unit exists"
# 同时 ~/.agim/start-anomaly.log 应该追加一行

# 杀掉
kill %1
```

### 11.6 R12 IM gate

```bash
# 默认状态: 不设 IMHUB_ENABLE_GLOBAL_IM
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/config | jq '.telegram, .discord, .features.globalIm'
# 应输出: null, null, false

# 启用后
echo IMHUB_ENABLE_GLOBAL_IM=1 >> ~/.agim/env
systemctl restart agim
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/config | jq '.features.globalIm'
# 应输出: true
```

---

## 12. 相关文档

- [`docs/security-hardening.md`](./security-hardening.md) — 安全控制项的完整索引
- [`docs/deployment.md`](./deployment.md) — 生产部署
- [`docs/keyring-integration.md`](./keyring-integration.md) — 可选 keyring 集成 + R14 故障案例
- [`docs/memory-and-vector.md`](./memory-and-vector.md) — 长期记忆与向量召回
- [`docs/im-workspaces-guide.md`](./im-workspaces-guide.md) — IM 工作区
- [`docs/session-model.md`](./session-model.md) — 会话模型
- [`docs/task-recovery-plan.md`](./task-recovery-plan.md) — 任务恢复
