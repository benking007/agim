# Agim macOS 桌面壳

原生 SwiftUI + WKWebView 薄壳，把 Agent Portal（`/m/chat`）装进可常驻的 macOS 窗口。设计对齐 iOS 壳（`apps/ios`），共用同一套登录桥。

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

## 配对与加载

1. 在 Web 控制台 **Settings → Mobile** 生成 QR / 登录链接  
2. 在 Mac 应用中粘贴 `https://host/m/login?t=…&next=/m/chat`，或分别填写主机 + Token  
3. 凭证写入 Keychain（`host.iclaw.agim.mac.credentials`）  
4. WebView 打开 `{host}/m/login?t=…&next=/m/chat` → cookie / localStorage → `/m/chat`

也支持深链：`agim://pair?t=<token>&host=<urlencoded origin>`。

## 菜单

| 命令 | 作用 |
|------|------|
| 重新加载（⌘R） | 重新走 `/m/login` → `/m/chat` |
| 退出配对… | 清空 Keychain，并清除 WKWebView 网站数据 |

## 附件选择（拍照 / 照片 / 文件）

macOS `WKWebView` **默认禁用** `<input type="file">`。壳必须实现
`WKUIDelegate.webView(_:runOpenPanelWith:…)` 并用 `NSOpenPanel` 回传选中路径，
否则加号菜单里三项会「点了没反应」。见 `Agim/Views/WebShellView.swift`。

## 另存为 Markdown

助手气泡操作栏「另存为」通过 `webkit.messageHandlers.agimSaveFile` 调原生：

| 端 | 行为 |
|----|------|
| 浏览器 Chromium | `showSaveFilePicker` |
| 浏览器其他 | `<a download>` |
| macOS 壳 | `NSSavePanel` |
| iOS 壳 | `UIDocumentPickerViewController`（导出到「文件」） |

Web 实现：`src/web-app/src/lib/save-text-file.ts`。

## 与 iOS 的差异

| | iOS | macOS |
|--|-----|-------|
| 配对 | 扫码 + 手动 | 粘贴链接 / 手动（无相机扫码） |
| WebView 封装 | `UIViewRepresentable` | `NSViewRepresentable` |
| Keychain service | `host.iclaw.agim.credentials` | `host.iclaw.agim.mac.credentials` |
| 沙箱 | （无独立 entitlements 文件） | App Sandbox + `network.client` |

## 依赖的主机公共路径

- `/m/login`（公开登录桥）
- `/m/chat`（Portal SPA）
- `/fonts/`（CJK 字体，不可 302 到登录页）
- `/api/auth/login`、`/ws`（由 WebUI 使用）
