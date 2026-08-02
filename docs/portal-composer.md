# Portal 输入框与消息条（`/m/chat`）

本文记录 Agent Portal（移动端聊天页 `/m/chat`）本轮交互能力，便于验收与后续迭代。

## 入口

- 路径：`/m/chat`
- 传输：既有 WebSocket `useChat()`（与桌面 `/` 共用会话模型）
- 主题：跟随系统 / 设置中的 light·dark

## Composer（底部输入框）

### `/` — Skills 与 Commands

输入 `/`（行首或空白后）弹出深色分区菜单：

| 分区 | 行为 |
|------|------|
| **Skills** | 展示最常用 3 个（本地使用频次 + 名称排序）；`Show N more skills` 打开模态选全部 |
| **Commands** | 高优：Plan / Memo / Focus / 循环任务 / 子代理 / Remember / Models；其余经 `Show N more commands` |

选择后：

- **Skill** → 插入蓝色 skill chip（发送标记 `[技能：name]`）
- **Plan** → 直接发送 `/plan on` 或 `/plan off`
- **Memo** → 填入 `/memo here`
- **Focus / 循环任务** → 填入 `/focus ` / `/loop `
- **子代理** → 填入引导句「请用子代理（call_agent / call_agents）完成：」（脚手架，**不**预选某 CLI；选型靠 Agim + [派工画像](./architecture/agent-profiles.md)；sticky CLI 亦可派工，见 [`architecture/cli-subagent-dispatch.md`](./architecture/cli-subagent-dispatch.md)；`/loop` 仍须 Agim）
- **Remember** → 填入 `/remind `
- **Models** → 直接发送 `/models`

键盘：↑↓ 高亮，Enter 确认，Esc 关闭。过滤查询变化时重置高亮；同一查询下不会被 keyup 冲掉。

发送：单独 Enter 换行；**Ctrl+Enter**（Windows/Linux）或 **⌘+Enter**（macOS）发送当前内容（含附件）。`/` `@` 菜单打开时，裸 Enter 仍用于选中项，修饰键+Enter 照常发送。

技能列表优先 `GET /api/agim-skills`（已认证可读）；失败时回退 `GET /api/skills`。

### 状态栏（composer 下方）

与桌面 `/` 共用 `ComposerStatusBar`：

| 控件 | 作用 |
|------|------|
| 模型 | 切换当前 preset 下 backend / 打开 LLM 配置 |
| 思考开 · low/high/max | `/think …`（会话级） |
| **替我审批 / 请求审批** | 主 Agent 工具审批模式（见下） |
| 上下文环 | 用量估算 / 压缩率 |

**审批模式（主 Agent only）**

| 选项 | `AGIM_AUTO_APPROVE` | 行为 |
|------|---------------------|------|
| **请求审批**（默认） | `0` | 遇 exec/write 等弹审批卡 |
| **替我审批** | `1` | 系统代用户批准（安全检查仍先跑） |

- API：`GET/PUT /api/policy/auto-approve`（**任意已登录** token，含 Portal QR；热写 `~/.agim/env` + `process.env`）
- 与 Settings → Policy 同源；任一侧改动会互相刷新
- **不**影响子代理：子代理始终代审免卡（见 [`architecture/subagent.md`](./architecture/subagent.md) §7.2）
- **bwrap 沙箱开**：沙箱内 `agim_exec` 走全局自动放行
- **bwrap 缺失/off + 目标进行中**：无隔离 `agim_exec` 的 pinnable 显式卡在「替我审批」有效时**同样自动放行**；关闭时仍可「本类自动放行」。`plan-exit` / `complete_goal` 仍需人工确认
- 接开放 IM 且无严格 allowlist 时，环境层仍可能抑制 effective auto-approve（`AGIM_AUTO_APPROVE_OPEN_IM`）

### `@` — Workspace 与文件

输入 `@` 弹出：

1. **workspace** — 引用当前 agent 工作区，蓝色文件夹 chip（标记 `[工作区]`）
2. **Files & Folders** — 钻取 `GET /api/workspace-files?agent=&path=` 目录树；可选文件或目录（标记 `[工作区文件：…]` / `[工作区目录：…]`）

`GET /api/workspace-files` 对已认证用户可读；`PUT` 仍需 admin。

### 加号菜单（`+`）

快捷：

- **Plan / Memo / Focus** → Plan 切换 · `/memo here` · `/focus `
- **循环任务** → `/loop `
- **子代理** → 填入子代理引导句（同上；真实 `agent=` 由父模型按 specialty catalog 选，见 [`architecture/subagent.md`](./architecture/subagent.md) §5.3 · [`architecture/agent-profiles.md`](./architecture/agent-profiles.md)）
- **Remember** → `/remind `
- **Models** → 发送 `/models`
- **Skills** → 填入 `/` 并唤出 slash 菜单

另含拍照 / 相册 / 文件附件（上传后以媒体标记入消息）。  
`/goal` 已废弃，菜单不再出现 Goal 入口（见 [`architecture/goal-residue.md`](./architecture/goal-residue.md)）。

### Mention chip 与 Backspace

Workspace / 文件 / skill 以蓝色 chip 显示在输入区；光标在文本开头时 **Backspace** 删除最后一个 chip（点击 chip 亦可移除）。

发送正文为 markers + 纯文本拼接，与气泡解析共用同一套标记格式。

## 用户消息条

### 媒体预览

消息中的 `[图片附件：…]` / `[文件附件：…]` 在气泡内渲染为缩略图网格（约 5 列）与 `@文件名` 链接；文件可开模态预览（文本 / 图 / PDF）。

接口：`GET /api/chat/media/file?path=`（限 media 根）。

### 长文折叠

除图片外，正文默认折叠为约 **3.5 行**（3 行完整 + 底边半遮罩）。点击消息条展开；**点击消息外区域**再次折起。

本地验收：`/m/chat?demo=collapse`

### 换行

用户气泡强制 `overflow-wrap` / `word-break`，避免超长无空格串撑破布局。

### Subagent 卡片（消息流）

与桌面共用 `ChatSubagentCard`：

| 状态 | 展示 |
|------|------|
| 运行中 | `SUBAGENT` 徽章旁 **teal 已执行时间**（每秒刷新）；右侧 **Stop** |
| 完成 | preview 可含 `439.9s · 4501 chars`；点击行打开半浮层看 brief / 结果 |

契约见 [`architecture/subagent.md`](./architecture/subagent.md) §7.1。

## 小精灵（Portal Pet）

停在输入框右上沿；仅脚部被 composer 遮挡（`bottom: calc(100% - 0.55rem)`）。忙时脉搏、任务角标与完成飘字见 `portal-pet.tsx`。

点击展开左侧任务面板，分组展示：

| kind | 含义 |
|------|------|
| `approval` / `ask` | 待你处理 |
| `run` | 本轮 Agent 执行 |
| `bgjob` | 后台任务 |

**不再**用小精灵琥珀色气泡 / `loop` 任务行镜像 Loop 状态（启动后会抢输入区）。Loop 进展只走下方底栏 docks。

## Loop 底栏（与审批同级）

Lazy 加载 `portal-loop-dock.tsx`（轮询 `GET /api/loop`，不进 SPA entry；组件 `memo`，避免主输入按键重渲长正文）：

| 状态 | 底栏 |
|------|------|
| 待对焦 | 表单：目标 + 退出条件 + **正文（可选）** →「确定并开始」。路径 A：Focus→正文（标注）；`/loop start <text>`→目标预填。正文 **>240 字默认折叠** |
| 待派工 / 待验收（Agent 空闲，且无审批/提问挡板；`liveSubagents=0`） | 「立即行动」代用户发推进句 |
| 结论已就绪 | 结案浮窗：确认结束 / 继续下一轮 |
| 确认结束后（可选） | 是否生成详细报告 |

契约与门禁见 [`architecture/loop-engineering.md`](./architecture/loop-engineering.md) §6。Tasks 审计见同文 §6.3.1（`/tasks/loops`）。

**重启护栏**：在 Portal（及 Web 控制台 `/`）聊天里发 `/restart` **不会**重启服务——会直接拒绝，以免进程重启打断当前 Loop 底栏。运维重启请用 **设置 → 服务 → Restart**，或终端 `agim restart`；IM 管理员仍可用 `/restart`（见 [`runbook.md`](./runbook.md) §4）。

## 输入性能（长 Context）

主输入 `inputMessage` 仍挂在 `AgentPortal`，但按键时：

- `memo(PortalMessageList)` / `memo(PortalLoopDock)` + 稳定回调，避免整页重渲 Markdown / 对焦长正文；
- caret 用 ref；`/` `@` 触发只在状态真正变化时 `setState`；
- 对焦「正文」过长时默认折叠，减少常驻大 textarea。

现象：Focus / 对焦正文很长时，主输入仍应跟手。

## 相关文件

| 区域 | 路径 |
|------|------|
| 页面 | `src/web-app/src/components/m-portal/agent-portal.tsx` |
| Slash / @ 菜单 | `portal-composer-menus.tsx`、`portal-slash-commands.ts` |
| Chip 输入 | `portal-composer-input.tsx`、`portal-mention-chip.tsx` |
| 加号菜单 | `portal-composer-plus.tsx` |
| 状态栏 | `composer-status-bar.tsx`、`use-composer-auto-approve.ts` |
| 小精灵 / Loop 底栏 | `portal-pet.tsx`、`use-portal-pet-tasks.ts`、`portal-loop-dock.tsx`、`use-portal-loop.ts` |
| 气泡渲染 | `portal-user-content.tsx`、`lib/parse-user-media.ts` |
| 媒体 API | `src/core/web-media-upload.ts`、`src/web/chat-media-api.ts` |
| Loop REST | `src/web/loop-api.ts`、`src/web-app/src/lib/api/loop.ts` |
| 审批策略 API | `src/web/env-api.ts`（`/api/policy/auto-approve`） |

## 安全与权限摘要

- Slash skill 列表 / workspace 浏览：任意已认证 token 可读（Portal 扫码用户可用）
- **审批模式切换**（`/api/policy/auto-approve`）：任意已认证可读可写（单用户本机产品面）
- Workspace / agim-skills **写入**：仍需 admin
- 媒体文件读取：路径限制在 web media 根下
- **`/restart`**：Portal / Web 聊天拒绝（`platform=web`）；Settings → 服务 或 CLI / IM admin 仍可重启
