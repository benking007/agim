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

### 3.1 浏览器手测（消息流 / Plan / Stop）

在 §3 的 mock LLM + `agim start` 环境下，于桌面 `/` 或 Portal `/m/chat` 发送下列 mock 标记（由 `tools/mock-llm-server.mjs` 识别）：

| 标记 / 场景 | 期望 |
|---|---|
| 普通同族 spawn（如「派 cheap 调研」） | 消息流出现 Subagent 卡片；点击半浮层居中对齐内容列；可见 brief / 结果 |
| `PHASE_A_LONG_SHEET_TEST` | 半浮层默认半高 + 内部滚动；expand / collapse 可用 |
| `PHASE_A_TODO_PROGRESS_TEST` | Todo/Plan **中途**出现并更新（不必等整 turn 结束） |
| `PHASE_A_TODO_AND_SUBAGENT_TEST` | Plan 叠在 Subagent **上方**；二者同时可见 |
| 运行中卡片右侧 **Stop** | 子代理停止；父 turn 收到阶段性摘要并继续（非整 turn 硬失败） |
| `AGIM_AUTO_APPROVE=0` + 需审批工具 | 审批卡紧凑；子代理审批可标 origin；Settings 未配置时显示 OFF |
| `AGIM_AUTO_APPROVE=1` | 主/子共用自动放行；`agim_todo_write` 不因原生 gate 卡住 Plan |

生产抽检前：`npm run build` 后重启进程，确认 SPA 已同步到 `dist/web/public`。
