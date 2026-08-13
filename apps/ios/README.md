# Agim iOS — native shell + WebUI

Phase 1 pivot: **WKWebView shell** loads the Agent Portal at `/m/chat`
(design: `docs/design/chatgpt_mobile_design_prototype.tsx`).

macOS twin (same login bridge): [`apps/macos`](../macos) · [`docs/macos-shell.md`](../../docs/macos-shell.md).

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

1. Scan Mobile QR (or paste host + token) → Keychain  
2. Shell opens `{host}/m/login?t=…&next=/m/chat`  
3. WebUI Agent Portal handles chat / explore / voice UI  

Returning from background: the shell dispatches `agim-resume` on
`scenePhase == .active` so the SPA force-reconnects the chat WebSocket
and reloads history (`get-history`). WKWebView often leaves a zombie
OPEN socket after suspend.

Menu (⋯): refresh WebView / logout.

Save-as Markdown from Portal message actions uses `webkit.messageHandlers.agimSaveFile`
→ iOS Files export picker (`UIDocumentPickerViewController`).

## Layout

```
Agim/
  AgimApp.swift          session + pairing state
  Views/
    PairingView.swift    QR / paste
    QRScannerView.swift
    WebShellView.swift   WKWebView
    RootView.swift
  Services/
    KeychainStore.swift
    PairingParser.swift
```
