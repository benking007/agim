# Agim iOS — native shell + WebUI

Phase 1 pivot: **WKWebView shell** loads the Agent Portal at `/m/chat`
(design: `docs/design/chatgpt_mobile_design_prototype.tsx`).

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

Menu (⋯): refresh WebView / logout.

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
