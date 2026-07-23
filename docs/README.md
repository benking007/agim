# Agim 文档导航

本页用于快速定位文档。  
建议先看根目录 `README.md` / `README.zh-CN.md`，再按角色进入对应模块。

**后端清单以 [`agents.md`](./agents.md) 为唯一权威来源**；架构文只解释立场，避免再维护第二份 inventory。  
历史计划 / 旧 CR / 分析快照一律在 [`archive/`](./archive/README.md)，**不再作为现行实施指南**。

## 入门

- [`../README.md`](../README.md) / [`../README.zh-CN.md`](../README.zh-CN.md)：项目概览与快速开始（`agim go`）
- [`agents.md`](./agents.md)：支持的 Agent 后端、安装入口、模型切换与工具能力
- [`deployment.md`](./deployment.md)：部署与上线清单
- [`naming.md`](./naming.md)：命名术语表（Agim Agent / `agim` / ACP≠A2A / tenants）
- [`migration-naming-v2.md`](./migration-naming-v2.md)：Naming v2 新老迁移指引
- [`llm-backends.md`](./llm-backends.md)：Agim Agent 大模型 API 配置与排障（含 SSRF / 私网 hatch）
- [`agim-agent-context-budget.md`](./agim-agent-context-budget.md)：上下文预算（L1/L2 / compact / 指标）

## 架构

- [`architecture/current.md`](./architecture/current.md)：**现行**组合根 / 域模块地图、数据流、文件预算与扩展配方（架构首页）
- [`architecture-bridge-and-agim-agent.md`](./architecture-bridge-and-agim-agent.md)：桥接 + Agim Agent 产品立场（旧名 `architecture-bridge-and-native.md` 仅作跳转）
- [`architecture/agent-cwd-and-memory.md`](./architecture/agent-cwd-and-memory.md)：工作目录与记忆隔离（已实施）
- [`architecture/reminders.md`](./architecture/reminders.md)：提醒与主动通知链路
- [`endpoint-contracts.md`](./endpoint-contracts.md)：Web 路由清单与 SPA API 合同维护
- [`session-model.md`](./session-model.md)：会话模型与恢复（含 Web Chat、Agim Agent quarantine）

## 安全

- [`security-hardening.md`](./security-hardening.md)：安全基线与防护项（AUTO_APPROVE 默认关、URL 守卫、角色 ACL、非受信 IM 清单）
- 交叉：[`coding-standards.md`](./coding-standards.md) 中的安全默认表；[`deployment.md`](./deployment.md) §5 / §10

## 运维

- [`runbook.md`](./runbook.md)：高频运维操作
- [`release.md`](./release.md)：npm 发版（Auto Version Bump → `workflow_call` / 手动 `workflow_dispatch`）
- [`messenger-capability-matrix.md`](./messenger-capability-matrix.md)：各 IM 的 HITL / 附件 / 网关能力差异
- [`discord-setup.md`](./discord-setup.md)：Discord 接入（需 `AGIM_ENABLE_GLOBAL_IM=1`）
- [`im-workspaces-guide.md`](./im-workspaces-guide.md)：IM 工作区使用指南
- [`keyring-integration.md`](./keyring-integration.md)：keyring/dbus 集成（高级）
- [`viewer-modes.md`](./viewer-modes.md)：长内容 viewer 模式
- [`macos-shell.md`](./macos-shell.md)：macOS 桌面壳（WKWebView；配对优先 `?c=` 兑换码）

## 能力专题

- [`skills.md`](./skills.md)：Skills 机制
- [`portal-composer.md`](./portal-composer.md)：Portal（`/m/chat`）输入框 `/`·`@`、chip、长文折叠与附件预览
- [`goals.md`](./goals.md)：`/goal` 长目标
- [`ask-user.md`](./ask-user.md)：结构化提问（ask_user）
- [`memory-and-vector.md`](./memory-and-vector.md)：长期记忆与向量召回

## 规范

- [`coding-standards.md`](./coding-standards.md)：编码 / 测试 / 文档 / 发版约定
- [`agent-integration-sop.md`](./agent-integration-sop.md)：新增 agent 接入 SOP
- [`tech-debt.md`](./tech-debt.md)：历史债 / 死开关 / 文档债盘点

## ADR

- [`adr/`](./adr/)：架构决策记录（0001–0005）

## 归档

历史背景、计划 stub、旧 CR、分析快照与 UI 原型：见 [`archive/README.md`](./archive/README.md)。

近期已关闭的 CR 清单（含 #219/#220 收口状态与残留 backlog）：  
[`archive/code-review-2026-07-21-main.md`](./archive/code-review-2026-07-21-main.md)。

## 版本变更

- [`../CHANGELOG.md`](../CHANGELOG.md)：唯一版本变更来源
