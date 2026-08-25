# Agim macOS 桌面壳

原生 SwiftUI + WKWebView 薄壳，把 Agent Portal（`/m/chat`）装进可常驻的 macOS 窗口。设计对齐 iOS 壳（`apps/ios`）：只保存主机地址，登录走网页账号与 `agim_session` cookie。

## 入口

- 工程：`apps/macos/`
- Bundle ID：`host.iclaw.agim.mac`
- 最低系统：macOS 14+
- 说明：[`apps/macos/README.md`](../apps/macos/README.md)

## 打开工程

```bash
cd apps/macos
./scripts/generate-xcodeproj.sh
open Agim.xcodeproj
```

## 构建为独立应用（装进「应用程序」）

在你的 Mac 上：

```bash
cd apps/macos
./scripts/generate-xcodeproj.sh
./scripts/build-app.sh --install
```

会生成 Release 版 `Agim.app`，并复制到 `/Applications/Agim.app`（无写权限时用 `~/Applications`）。之后可从启动台 / Spotlight 打开。

仅构建不安装：`./scripts/build-app.sh` → 产物在 `apps/macos/dist/Agim.app`。

也可用 Xcode：**Product → Archive → Distribute App → Copy App**，再拖进「应用程序」。

> 说明：这里的「应用程序」是系统文件夹 `/Applications`，不是 Mac App Store。上架商店需额外签名与审核，当前工程面向自用 / 侧载。

首次打开若被拦截：在 Finder 里对 `Agim.app` **右键 → 打开**，或在「隐私与安全性」里允许。有 Apple Developer 账号时可在 Xcode Signing 填 Team，并用 Developer ID + 公证后再分发。

## 主机与会话

1. 在 Mac 应用中填写或粘贴主机（`https://agent.example.com`）  
2. 主机写入 Keychain（`host.iclaw.agim.mac.credentials`）；**不再保存 API token**  
3. 壳读取 WKWebView 的 `agim_session` cookie：有会话则打开 `/m/chat`，否则打开 `/login?next=/m/chat`  
4. 在 WebView 里用用户名 / 密码登录；cookie 留在默认 `WKWebsiteDataStore`  
5. 登录 / 注册页顶部可「更换主机」。已登录后 Portal 全屏

旧的 `/m/login?t=` / `?c=` 扫码配对已不再使用。粘贴这类链接时只取主机。

深链：`agim://pair?host=<urlencoded origin>`（遗留的 `t=` / `c=` 会被忽略）。

## 后台唤醒 / 会话恢复

Mac 合盖、iPhone 切走一段时间后再打开，WKWebView 里的 WebSocket **经常仍显示 OPEN**，但 TCP 已经断了。旧逻辑只在 `readyState === CLOSED` 时重连，结果是：

- 状态仍像「已连接」，发送无响应
- 不会再走 `get-history`，会话像掉了

现行路径：

1. 壳在 `scenePhase == .active` 时向页面派发 `agim-resume`（macOS 另监听 `NSWorkspace.didWakeNotification`）
2. SPA（`src/web-app/src/lib/api/ws.ts`）在 `visibilitychange` / `pageshow` / `agim-resume` / `online` 上 **强制重新握手**（1.5s 去抖，避免冷启动连打）
3. `useChat` 在每次 WS `open` 发 `get-history { threadId }`，把当前会话拉回来

若仍空白，菜单 **重新加载（⌘R）** 会重新探测 cookie，再打开 `/m/chat` 或 `/login`。

## 菜单

| 命令 | 作用 |
|------|------|
| 重新加载（⌘R） | 重新探测 `agim_session`，打开 `/m/chat` 或 `/login` |
| 退出配对… | 清空 Keychain，并清除 WKWebView 网站数据（含会话 cookie） |

## 附件选择（拍照 / 照片 / 文件）

macOS `WKWebView` **默认禁用** `<input type="file">`。壳必须实现
`WKUIDelegate.webView(_:runOpenPanelWith:…)` 并用 `NSOpenPanel` 回传选中路径，
否则加号菜单里三项会「点了没反应」。见 `Agim/Views/WebShellView.swift`。

## 助手气泡导出（按端分流）

操作栏在浏览器与原生壳上**呈现不同按钮**（避免同一图标语义不一致）：

| 端 | 按钮 | 行为 |
|----|------|------|
| 浏览器 | **另存为 Markdown** | Chromium `showSaveFilePicker`，其他 `<a download>` |
| macOS / iOS 壳 | **分享** | `webkit.messageHandlers.agimShare` → 系统分享面板 |

检测：`src/web-app/src/lib/agim-shell.ts`
- 精确：`window.__AGIM_SHELL__ = 'ios' | 'macos'`（壳在 document-start 注入）
- 兼容：是否注册了 `agimShare` / `agimSaveFile`（旧壳无 marker 时再辅以 UA）

### 另存为（仅浏览器）

Web：`src/web-app/src/lib/save-text-file.ts`。壳仍可实现 `agimSaveFile`（备用），但 Portal UI 在壳内不展示该按钮。

### 系统分享（仅 iOS / macOS 壳）

走系统面板，**不内置**各 IM 的 OpenSDK；已安装的微信/钉钉/QQ 等会出现在系统目标列表里。

| 端 | Bridge | 行为 |
|----|--------|------|
| macOS 壳 | `agimShare` | `NSSharingServicePicker`（文本 + 临时 `.md`） |
| iOS 壳 | `agimShare` | `UIActivityViewController`（文本 + 临时 `.md`） |

Web：`src/web-app/src/lib/share-content.ts`。长文在系统面板内会截断展示；完整正文尽量作为附件一并分享。

## 与 iOS 的差异

| | iOS | macOS |
|--|-----|-------|
| 连接主机 | 填写 / 扫描 https 地址 | 粘贴 / 填写主机（无相机） |
| WebView 封装 | `UIViewRepresentable` | `NSViewRepresentable` |
| Keychain service | `host.iclaw.agim.credentials` | `host.iclaw.agim.mac.credentials` |
| 沙箱 | （无独立 entitlements 文件） | App Sandbox + `network.client` |

## 依赖的主机公共路径

- `/login`、`/register`（账号登录 / 首个用户注册；公开）
- `/m/chat`（Portal SPA；无 `agim_session` 时服务端 302 到 `/login`）
- `/fonts/`（CJK 字体，不可 302 到登录页）
- `/api/auth/login`、`/api/auth/me`、`/ws`（由 WebUI 使用）
