# Goals（已退役）

> **已退役（2026-07-26）**  
> 用户面与工具链已移除。请使用：
>
> - **[Focus](./architecture/focus.md)** — `/focus`，线程注意力锚点  
> - **[Loop](./architecture/loop-engineering.md)** — `/loop`，工程闭环  
>
> 残留说明与刻意保留的底层存储见 [`architecture/goal-residue.md`](./architecture/goal-residue.md)。

旧的 `/goal`、`long_task`、`complete_goal` slash/MCP/RPC 与 SPA `/tasks/goals`、REST `/api/goals*` 均已删除。  
`~/.agim/goals.db` 仍由 Focus 复用（active/paused 行），勿与已退役产品原语混淆。
