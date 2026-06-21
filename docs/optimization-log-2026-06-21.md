# Agim 优化日志（2026-06-21）

## 背景

基于 `docs/code-review-2026-06-21-main.md` 的审查结论，对业务闭环、安全边界与文档一致性进行了集中修复。

## 本次已完成优化

### 1) ask_user 闭环修复（按钮回调共存）

- 在 `src/core/approval-router.ts` 的统一按钮分发入口中新增 `ask:*` 路由分支。
- 现在审批卡（`apv:*`）、恢复卡（`rec:*`）和 ask 卡（`ask:*`）可通过同一 callback 通道共存处理，避免回调覆盖导致 ask 无响应。

### 2) WeChat 平台映射修复

- 在 `src/core/ask-user-rpc.ts` 中将 messenger 解析从 `registry.getMessenger(ctx.platform)` 改为 `resolveMessenger(ctx.platform)`。
- 通过统一解析能力自动覆盖 `wechat -> wechat-ilink` 等别名映射，避免 `no-messenger`。

### 3) Outbox 接口权限收敛

- 在 `src/web/server.ts` 中将以下接口改为 admin 访问：
  - `GET /api/outbox`
  - `GET /api/outbox/stats`
- 与已有控制面接口权限策略保持一致，降低敏感投递内容被低权限 token 读取的风险。

### 4) 文档与产品文案一致性修复

- 修复 `README.md`、`README.zh-CN.md` 中 `agim token bootstrap` 的错误路径说明：
  - `~/.agim/admin-bootstrap-token` → `~/.agim/web-bootstrap-token`
- 修复 README 中旧路由说明：
  - `/tasks#memory` → `/memory/facts` + `/memory/persona`
  - `/tasks#cost` → `/observability/health` + `/observability/topn`
- 修复登录页文案（`src/web-app/src/routes/login.tsx` + i18n）：
  - 不再引导 `tokens.json` / `agim token list`
  - 改为引导 `agim token bootstrap`（首次）或 `agim token create`
- 修复 `docs/deployment.md` 多处“Web 无内建鉴权”的过时描述，明确默认 token 鉴权与反向代理叠加策略。

### 5) 测试补强

- `src/core/ask-user-rpc.test.ts`：新增 WeChat 平台名映射回归用例（`wechat -> wechat-ilink`）。
- `src/core/approval-router.test.ts`：新增 `ask:*` 按钮分发回归用例，覆盖 ask 卡按钮到 resolver 的闭环。
- `test/integration/web-server-api.test.ts`：将 `/api/outbox` 与 `/api/outbox/stats` 纳入 role=user 禁止访问断言集合。

## 仍待后续治理（未在本次改动完成）

1. `handleMessage` 端到端编排专属集成 harness（当前仍依赖分散测试间接覆盖）。
2. Node+SQLite 稳定 CI 作业（降低 bun 环境下持久化跳测影响）。
3. 超大文件拆分（`src/web/server.ts`、`src/cli.ts`、`src/core/approval-bus.ts`）。

