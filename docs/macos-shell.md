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
