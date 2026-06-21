# Agim 严格代码审查报告（2026-06-21）

## 1. 审查范围

- 后端主链路：`src/cli.ts`、`src/core/router.ts`、`src/core/approval-router.ts`、`src/core/ask-user-rpc.ts`、`src/core/message-sink.ts`
- 平台适配：`src/plugins/messengers/wechat/ilink-adapter.ts`
- Web 鉴权与运维面：`src/web/server.ts`、`src/core/access-token.ts`、`src/core/sender-allowlist.ts`
- 测试与 CI：`test/**`、`.github/workflows/ci.yml`
- 对外表达：`README.md`、`README.zh-CN.md`、`docs/deployment.md`、`src/web-app/src/routes/login.tsx`

## 2. 审查方法

1. 从 IM 入站到 Agent 出站进行代码级链路追踪（消息→路由→工具审批/ask→投递）。
2. 校验关键安全策略默认值（鉴权、allowlist、敏感信息保护）。
3. 对测试基建进行回归可信度评估（隔离性、可重复性、是否覆盖真实链路）。
4. 对文档、UI 文案与实际实现进行一致性核对。

## 3. 关键问题清单（按严重度）

### High

1. `ask_user` 按钮在多路按钮回调场景下存在闭环缺口（审批与 ask 共用 callback 通道，易互相覆盖）。
2. WeChat 平台名 `wechat` 与注册名 `wechat-ilink` 在 `ask_user` 发送路径未统一映射，可能 `no-messenger`。
3. token 指引存在文档与实现偏差（`admin-bootstrap-token` vs `web-bootstrap-token`）。
4. 入站 sender allowlist 默认开放策略（未配置时 fail-open）在公网部署风险较高。

### Medium

1. `/api/outbox` 读接口权限边界偏宽（仅 checkAuth，不要求 admin）。
2. `handleMessage` 无专门集成测试，关键编排路径依赖分散测试间接覆盖。
3. SQLite 在 Bun 环境下存在跳测路径，部分持久化回归置信度不足。
4. 部分部署文档仍按“Web 无内建鉴权”叙事，容易误导运维策略。

### Low

1. 超大文件（`src/web/server.ts`、`src/cli.ts`、`src/core/approval-bus.ts`）可维护性风险持续累积。
2. prompt injection 检测默认仅审计告警，不阻断高危模式。

## 4. 整改优先级建议

### P0（立即）

- 修复 `ask_user` 与审批卡按钮共存能力。
- 修复 WeChat 平台映射不一致。
- 修复 token 指引与实现不一致。

### P1（本轮可并行）

- 收紧 `/api/outbox` 读取权限。
- 同步 README/部署文档/Web 登录文案，消除认知分叉。

### P2（后续治理）

- 补 `handleMessage` 真实集成 harness。
- 增加 Node+SQLite 稳定 CI 作业（与 bun 作业并行）。
- 拆分超大模块，降低单文件复杂度。

## 5. 本次审查结论

Agim 的整体工程基础较好（有 outbox、恢复、审批、熔断、审计等完整机制），但在“多通道交互闭环”和“文档/实现一致性”上存在关键缺口。优先修复 P0/P1 后，可显著降低线上沟通断链与安全误配置风险。

