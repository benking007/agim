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
| **Commands** | 高优：Plan / Memo / Goal / Remember / Models；其余经 `Show N more commands` |

选择后：

- **Skill** → 插入蓝色 skill chip（发送标记 `[技能：name]`）
- **Plan** → 直接发送 `/plan on` 或 `/plan off`
- **Memo** → 填入 `/memo here`
- **Goal / Remember** → 填入 `/goal ` / `/remind `
- **Models** → 直接发送 `/models`

键盘：↑↓ 高亮，Enter 确认，Esc 关闭。过滤查询变化时重置高亮；同一查询下不会被 keyup 冲掉。

发送：单独 Enter 换行；**Ctrl+Enter**（Windows/Linux）或 **⌘+Enter**（macOS）发送当前内容（含附件）。`/` `@` 菜单打开时，裸 Enter 仍用于选中项，修饰键+Enter 照常发送。

技能列表优先 `GET /api/agim-skills`（已认证可读）；失败时回退 `GET /api/skills`。

### `@` — Workspace 与文件

输入 `@` 弹出：

1. **workspace** — 引用当前 agent 工作区，蓝色文件夹 chip（标记 `[工作区]`）
2. **Files & Folders** — 钻取 `GET /api/workspace-files?agent=&path=` 目录树；可选文件或目录（标记 `[工作区文件：…]` / `[工作区目录：…]`）

`GET /api/workspace-files` 对已认证用户可读；`PUT` 仍需 admin。

### 加号菜单（`+`）

在 Plan / Memo / Goal 之外增加：

- **Remember** → `/remind `
- **Models** → 发送 `/models`
- **Skills** → 填入 `/` 并唤出 slash 菜单

另含拍照 / 相册 / 文件附件（上传后以媒体标记入消息）。

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

## 小精灵（Portal Pet）

停在输入框右上沿；仅脚部被 composer 遮挡（`bottom: calc(100% - 0.55rem)`）。忙时脉搏、任务角标与完成飘字见 `portal-pet.tsx`。

## 相关文件

| 区域 | 路径 |
|------|------|
| 页面 | `src/web-app/src/components/m-portal/agent-portal.tsx` |
| Slash / @ 菜单 | `portal-composer-menus.tsx`、`portal-slash-commands.ts` |
| Chip 输入 | `portal-composer-input.tsx`、`portal-mention-chip.tsx` |
| 加号菜单 | `portal-composer-plus.tsx` |
| 气泡渲染 | `portal-user-content.tsx`、`lib/parse-user-media.ts` |
| 媒体 API | `src/core/web-media-upload.ts`、`src/web/chat-media-api.ts` |

## 安全与权限摘要

- Slash skill 列表 / workspace 浏览：任意已认证 token 可读（Portal 扫码用户可用）
- Workspace / agim-skills **写入**：仍需 admin
- 媒体文件读取：路径限制在 web media 根下
