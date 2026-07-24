# Goal 残留盘点（Focus / Loop 迁移）

> 状态：2026-07-24 · Focus/Loop 运行时已落地后的残留清单  
> 产品原语：[`focus.md`](./focus.md) · [`loop-engineering.md`](./loop-engineering.md)  
> 现行兼容说明：[`../goals.md`](../goals.md)（顶部废弃横幅）

## 已切换（用户面）

| 面 | 状态 |
|----|------|
| `/focus` / `/loop` slash + MCP focus_* / loop_verdict | 已落地 |
| Portal `/` 斜杠 · `+` 菜单：Focus / 循环任务 / 子代理 | 本批对齐 |
| `/help` 文案 | 本批改为 focus/loop，goal 标废弃 |
| `mcp__agim__long_task` | 转发 focus_set + deprecated |
| `mcp__agim__complete_goal` | 标 deprecated，CAS 仍可跑旧行 |

## 刻意保留（兼容 / 底层）

| 残留 | 原因 | 后续 |
|------|------|------|
| `src/core/goals.ts` + `goals.db` | Focus 存储复用 active/paused 行 | Focus 专表迁移可另开 |
| `goal-rpc.ts` / `goal-evidence.ts` / `goal-critic.ts` | complete_goal / critic 过渡期 | Loop observer 成熟后收缩 |
| `/goal` `/g` `/目标` 解析 | 兼容转发 Focus | ≥1 次要版本后可删 |
| `/api/goals` + SPA `/tasks/goals` | Admin 活跃行浏览仍读 goals 表 | 改名 Focus 管理页（非阻断） |
| 记忆分类 `FactCategory: 'goal'` | 用户画像语义，≠ `/goal` 原语 | 可改文案为「目标偏好」，勿与 Focus 混 |

## 文档

| 文件 | 处置 |
|------|------|
| `docs/goals.md` | 废弃横幅 + 现行实现说明 |
| `docs/portal-composer.md` | Goal → Focus；+菜单含循环任务/子代理 |
| `docs/naming.md` | Focus / Loop / goal(deprecated) |
| 归档 `docs/archive/*` | 历史，不改 |

## 非目标（本批不做）

- 重命名 `/api/goals` / `goals.db` / Tasks 路由（需迁移与 SPA 大改）
- 删除 `complete_goal` CAS 路径
- 改记忆 `goal` 分类枚举
