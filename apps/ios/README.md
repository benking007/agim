# Agim iOS — native shell + WebUI

Thin **WKWebView** shell that loads the Agent Portal at `/m/chat`
(design: `docs/design/chatgpt_mobile_design_prototype.tsx`).

macOS twin (same host + session cookie): [`apps/macos`](../macos) · [`docs/macos-shell.md`](../../docs/macos-shell.md).

## Requirements

- macOS + Xcode 16+ (iOS 17)
- Reachable Agim host with the built SPA (`/m/chat`)

## Open

```bash
cd apps/ios
./scripts/generate-xcodeproj.sh   # optional regenerate
open Agim.xcodeproj
```

## Flow

1. Enter the Agim origin (`https://agent.example.com`), or scan an `https://` host URL → Keychain (host only)
2. Shell reads WKWebView `agim_session`. With a cookie it opens `{host}/m/chat`; without one it opens `{host}/login?next=/m/chat`
3. Sign in with username / password in the WebView; the session cookie stays in the WebView store
4. WebUI Agent Portal handles chat / explore / voice UI

On the login / register page a native **更换主机** bar can unpair. After sign-in the portal is full-bleed.

Returning from background: the shell dispatches `agim-resume` on
`scenePhase == .active` so the SPA force-reconnects the chat WebSocket
and reloads history (`get-history`). WKWebView often leaves a zombie
OPEN socket after suspend.

Save-as Markdown from Portal message actions uses `webkit.messageHandlers.agimSaveFile`
→ iOS Files export picker (`UIDocumentPickerViewController`).

## Layout

```
Agim/
  AgimApp.swift          session + host pairing state
  Views/
    PairingView.swift    host URL (optional camera scan)
    QRScannerView.swift  scan an https:// origin
    WebShellView.swift   WKWebView
    RootView.swift
  Services/
    KeychainStore.swift
    PairingParser.swift
```
