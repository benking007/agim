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
| `AGIM_AUTO_APPROVE=0` + 需审批工具 | 主 turn 弹审批卡；**子代理（depth>0）免审代批**；Settings 未配置时显示 OFF |
| `AGIM_AUTO_APPROVE=1` | 主 turn 也自动放行；`agim_todo_write` 不因原生 gate 卡住 Plan |
| Composer「替我审批 / 请求审批」 | 输入框下状态栏可切换；默认「请求审批」；切到「替我审批」后主 Agent 不再弹工具审批卡（含无 bwrap 时目标中的 unconfined `agim_exec`；plan-exit / complete_goal 仍需确认） |

生产抽检前：`npm run build` 后重启进程，确认 SPA 已同步到 `dist/web/public`。

### 3.2 Loop Engineering（Portal / mock）

前置同 §3；建议 `AGIM_LOOP_DISPATCH_GATE` / `AGIM_LOOP_VERIFY_GATE` 保持默认 on。契约见 [`architecture/loop-engineering.md`](./architecture/loop-engineering.md) §6。

| 标记 / 场景 | 期望 |
|---|---|
| `/loop`（空） | Portal **待对焦**底栏；小精灵气泡「待对焦」；填目标+退出 →「确定并开始」后进入待派工 |
| `LOOP_SELF_RESEARCH_TEST`（已确认使命） | 父侧不可自行调研；须 `call_agents`；小精灵/底栏「待派工」→「立即行动」可推进 |
| `LOOP_E2E_TEST` | 派工后验收；`loop_verdict` stop+met；结束总结；**不**残留待验收条 |
| `LOOP_SKIP_VERDICT_TEST` | 跳过 verdict 时 follow-up / `verify_skipped` 强制收尾，不挂死（无 pending ask / live 子代理时） |
| 子代理进行中 | 本轮 `liveSubagents>0` 时小精灵「子代理进行中」；**不**弹出待验收；单子代理结束不触发评审 |
| VERIFY 中途提问 | **仅父侧**且子代理已齐；结论不确定时可 `ask_user`；子代理不得提问；`live>0` 父侧也不得提问解阻塞 |
| 子代理调研 | 同线程子代理不被 `loop-parent-wait` 禁 `web_fetch`/`exec`（门禁仅 depth=0） |
| 子代理审批 | `AGIM_AUTO_APPROVE=0` 时：主 turn 仍弹卡；子代理 exec/write **不弹卡**（代审） |
| R2 再派工 | `continue/revise` 后同 turn 可再 `call_agents`（委托上限按轮重置；`planning`+0 派工时也会清 stale history）；**已完成子代理卡片仍在** |
| 同轮二次派工 | 本轮已 `call_agents` 后再派 → `loop-parent-wait` 拒绝（须先 `loop_verdict`）；勿与 turn-cap 错误混淆 |
| `met=true` 结案 | Portal「结论已就绪」浮窗；可补充 →「确认结束」或「继续下一轮」 |
| 退出「至少 N 轮」 | 第 1 轮 `stop`+`met=true` → `need_more_rounds`；须继续到 N 或放弃 `stop`+`met=false` |
| 「重复 N 轮」 | min=N、max=N×2 |
| 用量文案 | 显示「独立验收 N」，勿把 N=0 当成「没验收」（独立验收可能 skip） |

离线门禁（无浏览器）：

```bash
npm run build   # 需要 dist
node tools/loop-gates-sim.mjs
# report → /opt/cursor/artifacts/loop-gates-sim-report.json（若目录存在）
```

## 4. Phase B（并行 call_agents）验收

```bash
# terminal A — mock LLM（含 PHASE_B_* 慢车道探针）
node tools/mock-llm-server.mjs

# terminal B — Phase B 构建后的 agim
export AGIM_URL_ALLOW_PRIVATE=1 AGIM_WEB_AUTH=off AGIM_TODO_GATE=off
export AGIM_AUTO_APPROVE=1 AGIM_ALLOWED_USERS='*'
# PARALLEL 默认 on；可显式：
export AGIM_SUBAGENT_PARALLEL=1 AGIM_SUBAGENT_PARALLEL_MAX=3
export AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN=3
node dist/cli.js start </dev/null

# terminal C
node tools/phase-b-acceptance.mjs
# report → /opt/cursor/artifacts/phase-b-acceptance-report.json
```

覆盖：`call_agents` 三路 fan-out、`toolCallId#i` activity、三 `jobId`、mock `peakSlow≥2`（真并行）、墙钟低于串行、`agim/cheap` 标签。

