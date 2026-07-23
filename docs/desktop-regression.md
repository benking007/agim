# 桌面全功能回归（本地）

在合入大型架构 / 安全变更后，建议跑一轮「单元 + 桌面」回归。

## 1. 单元与门禁

```bash
npm test
npm run typecheck
npm run lint
npm run check:contracts
npm run build
npm run test:node
```

## 2. 桌面环境（mock LLM）

准备 `~/.agim/config.json`（web-console-only + mock backend），密钥格式：

```json
{ "version": 1, "keys": { "mock-llm": "mock-key" } }
```

启动本机 mock OpenAI 兼容服务（示例见 `tools/desktop-regression.mjs` 注释环境），并：

```bash
export AGIM_URL_ALLOW_PRIVATE=1
export AGIM_WEB_AUTH=off   # 或使用 bootstrap token
export AGIM_AUTO_APPROVE=0
export AGIM_ALLOWED_USERS='*'
npm run build
node dist/cli.js start </dev/null
node tools/desktop-regression.mjs
```

脚本覆盖：health / SPA / LLM / presets / MCP / SSRF 拒绝 / Mobile QR `?c=` / exchange-mobile / agents / Portal 路由 / WebSocket mock 对话。

浏览器手测建议路径：`/` 聊天、`/settings/llm`、`/settings/mobile`、`/m/chat`、`/m/login`。
