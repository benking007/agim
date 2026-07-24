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

## 3. Phase A（Subagent）正式验收

同族 spawn / 多 Subagent activity / 拆解启发式的**脚本化验收**（需 mock OpenAI + pro/flash 双 backend）：

```bash
# terminal A
node tools/mock-llm-server.mjs

# config: llmBackends mock-pro + mock-flash → http://127.0.0.1:18080/v1
#         llmRoles.native-chat=mock-pro, cheap=mock-flash
#         ~/.agim/llm-secrets.json keys for both

# terminal B
export AGIM_URL_ALLOW_PRIVATE=1 AGIM_WEB_AUTH=off AGIM_TODO_GATE=off
export AGIM_AUTO_APPROVE=1 AGIM_ALLOWED_USERS='*'
node dist/cli.js start </dev/null

# terminal C
node tools/phase-a-acceptance.mjs
# report → /opt/cursor/artifacts/phase-a-acceptance-report.json (or PHASE_A_REPORT=)
```

覆盖：`isolate:true`、`role=cheap`→flash、vacuous 自调用拒绝、跨 adapter `claude-code`、串行双 Subagent（`agim/cheap`+`agim` + 双 `jobId`）、A3 启发式出现在 system/tool description。
