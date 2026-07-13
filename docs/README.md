# Agim 文档导航

本页用于快速定位文档。  
建议先看根目录 `README.md` / `README.zh-CN.md`，再按角色进入对应模块。

## 新用户（先读）

- `README.md` / `README.zh-CN.md`：项目概览与快速开始
- `agents.md`：支持的 Agent 后端、安装入口、模型切换与工具能力
- `deployment.md`：部署与上线
- `architecture-bridge-and-native.md`：桥接 + native 的核心架构立场
- `naming.md`：命名术语表（Agim Agent / native / ACP≠A2A / workspace 两义）
- `llm-backends.md`：native LLM 配置与排障

## AI 能力专题

- `skills.md`：Skills 机制
- `goals.md`：`/goal` 长目标
- `ask-user.md`：结构化提问（ask_user，支持单选/多选/自定义输入）
- `memory-and-vector.md`：长期记忆与向量召回
- `architecture/reminders.md`：提醒与主动通知链路

## 运维与稳定性

- `runbook.md`：高频运维操作
- `release.md`：npm 发版流程（main push 触发、版本号、Actions、npm 验证）
- `security-hardening.md`：安全基线与防护项（含非受信 IM 加固清单）
- `messenger-capability-matrix.md`：各 IM 的 HITL / 附件 / 网关能力差异
- `tech-debt.md`：历史债 / 死开关 / 孤儿代码盘点与跟进
- `session-model.md`：会话模型与恢复
- `task-recovery-testing.md`：恢复链路测试记录
- `viewer-modes.md`：长内容 viewer 模式

## 适配与集成

- `agent-integration-sop.md`：新增 agent 接入 SOP（adapter、工具注入、Skills、Memory、Web/CLI 验收）
- `agents.md`：当前内置 Agent 后端清单与使用说明
- `discord-setup.md`：Discord 接入
- `im-workspaces-guide.md`：IM 工作区使用指南
- `keyring-integration.md`：keyring/dbus 集成

## 架构补充

- `architecture/current.md`：当前实现结构图、模块说明与决策交互链路
- `architecture/agent-cwd-and-memory.md`：工作目录与记忆隔离
- `endpoint-contracts.md`：Web 服务端路由清单与 SPA API 合同维护
- `adr/`：架构决策记录（ADR）

## 归档文档（历史背景）

以下文档保留历史上下文，不再作为当前实施指南：

- `code-review-2026-04-30.md`
- `code-review-2026-04-30-main.md`
- `code-review-2026-05-06-main.md`
- `code-review-2026-06-21-main.md`
- `optimization-log-2026-06-21.md`
- `upgrade-plan.md`
- `im-gateway-v2-plan.md`
- `task-recovery-plan.md`
- `agent-to-agent-plan.md`
- `a2a-l2-plan.md`
- `nanobot-comparison-rollout.md`
- `architecture/target.md`

## 版本变更

- `../CHANGELOG.md`：唯一版本变更来源（含跨版本专题汇总）
