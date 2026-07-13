# Agim 部署指南

本指南面向 Linux 服务器部署。目标是：快速上线、默认安全、便于维护。

## 1. 依赖

- Node.js >= 22.19（推荐 24 LTS）
- npm
- 至少一个可用 Agent 后端（CLI 或 ACP）
- **生产硬依赖**：原生 addon `better-sqlite3`（outbox / jobs / audit）。需要 `gcc/g++/make/python3` 编译。Bun 测试环境加载不了该 addon，不能作为生产运行时。

常见 CLI agent 安装：

```bash
npm i -g @anthropic-ai/claude-code
npm i -g @openai/codex
npm i -g opencode-ai
```

## 2. 安装

### 2.1 全局安装（推荐）

```bash
npm install -g agim-cli
agim --version
```

### 2.2 源码部署（可选）

```bash
git clone https://github.com/benking007/agim.git /opt/agim
cd /opt/agim
npm ci
npm --prefix src/web-app ci
npm run build
npm link
```

## 3. 首次配置

```bash
agim
```

向导会完成：

- IM 通道配置（微信/飞书/钉钉等）
- Agent 可用性检查
- 基础运行配置写入 `~/.agim/config.json`

手工配置入口：

- `~/.agim/config.json`
- `~/.agim/llm-secrets.json`（密钥）

Web 后台与 `agim config`/`agim setup` 会通过带跨进程锁的原子事务保存主配置，
可以并行使用而不会产生半截 JSON 或覆盖无关字段。手工编辑器不会参与该锁协议；
需要直接修改 `config.json` 时，建议先执行 `agim stop`，保存后再执行 `agim start --bg`。

## 4. 启动方式

### 4.1 前台（调试）

```bash
agim start
```

### 4.2 systemd（生产）

`/etc/systemd/system/agim.service` 示例：

```ini
[Unit]
Description=Agim service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agim
Group=agim
WorkingDirectory=/home/agim
Environment="HOME=/home/agim"
Environment="NODE_ENV=production"
Environment="LOG_LEVEL=info"
ExecStart=/usr/local/bin/agim start
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=control-group

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agim
sudo systemctl status agim
```

## 5. 端口、鉴权与审批

- Web 控制台默认 `127.0.0.1:3000`
- ACP 默认 `127.0.0.1:9090`
- Web token 鉴权默认开启
- 工具调用自动审批默认开启（`AGIM_AUTO_APPROVE=1`）

建议：

1. 优先通过反向代理暴露 HTTPS（nginx/caddy/tailscale）。
2. 只对白名单来源开放。
3. 不需要时不要开放 ACP 端口。
4. 需要人工审批时设 `AGIM_AUTO_APPROVE=0`；超时策略用 `AGIM_TIMEOUT_DEFAULT=deny`。

## 6. 常用运维命令

```bash
agim status
agim restart
agim stop
agim token bootstrap
agim token create ops-admin
```

## 7. 备份

核心数据目录：

```text
~/.agim/
```

建议备份内容：

- `config.json`
- `llm-secrets.json`
- `tokens.json`
- `*.db`
- `sessions/`

最简单离线备份：

```bash
sudo systemctl stop agim
tar czf agim-backup-$(date +%F).tgz -C "$HOME" .agim
sudo systemctl start agim
```

## 8. 升级

```bash
sudo systemctl stop agim
npm install -g agim-cli@latest
sudo systemctl start agim
```

升级前后建议检查：

```bash
agim --version
curl -fsS http://127.0.0.1:3000/api/health
```

## 9. 快速排障

### `better-sqlite3` 编译失败

安装编译工具链后重试安装。

### 启动后 401/403

优先检查 token 是否正确、反向代理是否拦截了认证头。

### Agent 不可用

检查对应 CLI 是否在 `PATH`，并可执行 `--version`。

### 端口冲突

修改 `config.json` 的 `webPort`/`acpPort` 后重启。

## 10. 上线检查清单

- [ ] `agim status` 正常
- [ ] `/api/health` 正常
- [ ] 至少一个 IM 通道可收发
- [ ] 至少一个 agent 可执行
- [ ] token 鉴权已启用
- [ ] 审批策略已确认（默认自动放行；需人工审批设 `AGIM_AUTO_APPROVE=0`）
- [ ] 已配置备份
- [ ] 已记录升级回滚流程
