# 退役候选盘点（2026-07-26）

> 本批已落地：Goal 残留 UI/工具链、Skillhub Hot、ACP（入站 `:9090` + 出站 Remote agents）。  
> 下文是**尚未动手**、可按产品优先级继续裁的候选。

## 本批已退役

| 项 | 处置 |
|----|------|
| Goal SPA `/tasks/goals` + `/api/goals*` + slash/MCP/RPC | 已删；Focus 复用 `goals.db` |
| Skillhub Hot 页 + `/api/skills/remote/hot` | 已删；本地 Skills 管理保留 |
| ACP 入站服务 + `acpAgents` 发现/配置 UI/CLI | 已删；`url-guard` 迁到 `src/core/url-guard.ts` |

## 建议下一波（低风险 / 低使用）

| 候选 | 现状 | 建议 |
|------|------|------|
| `/tasks/plans` | `native_exit_plan_mode` 审计页 | UI 可下线；`plan-history` 核心可留作审计 API/日志 |
| `/dev/chat-docks` | 未挂导航的 DEV 视觉沙箱 | 可直接删路由与文件 |
| Viewer 隧道设置 | Portal 已内联长文；cloudflared quick tunnel 偏冷 | 可先藏设置项；保留 paste/viewer 读路径 |
| TG / Discord | 已由 `AGIM_ENABLE_GLOBAL_IM=1` 默认隐藏 | 维持门控即可；全删代码侵入大，暂不建议 |
| Search / STT 提供商矩阵 | Settings 面较重 | 可降级为「高级 / CLI-only」 |
| `docs/goals.md` 长文 | 仍描述旧 `/goal` 行为 | 缩成迁移附录或改指向 `goal-residue.md` |

## 刻意保留（勿当死代码删）

| 项 | 原因 |
|----|------|
| `src/core/goals.ts` / `goals.db` | Focus 存储 |
| `goal-evidence.ts` / `goal-critic.ts` | Focus/Loop 证据账本与偏航检测 |
| 记忆 `FactCategory: 'goal'` | 用户画像语义 ≠ 产品 Goal |
| 本地 Skills / skill CLI 文案 | Hot 榜已退役，安装能力仍在 |
| A2A / Subagent / Loop | 现行编排面，与已退役 ACP 无关 |

## 真减压（bundle，非功能退役）

SPA entry 预算 350 KiB 的热点主要是 Chat 急切加载 + i18n 全量进 entry。  
退役冷门设置页对 entry 帮助有限；要降体积优先：Chat route lazy + i18n 按路由加载。
