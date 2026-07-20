# Agim macOS — native shell + WebUI

Thin **WKWebView** desktop shell that wraps the Agent Portal at `/m/chat`
(same surface as the iOS app in `apps/ios`).

## Requirements

- macOS 14+ and Xcode 16+
- Reachable Agim host with the built SPA (`/m/chat`)

## Open

```bash
cd apps/macos
./scripts/generate-xcodeproj.sh   # optional regenerate
open Agim.xcodeproj
```

Set your Apple Development Team in Xcode Signing if needed, then Run (⌘R).

## Flow

1. Paste the Mobile login URL from **Settings → Mobile** (or host + token) → Keychain  
2. Shell opens `{host}/m/login?t=…&next=/m/chat`  
3. Agent Portal WebUI handles chat / explore / voice  

Also accepts deep links: `agim://pair?t=…&host=https%3A%2F%2F…`

Menu: **重新加载** (⌘R) / **退出配对…**

## Layout

```
Agim/
  AgimApp.swift          session + menu commands
  Views/
    PairingView.swift    paste URL / host+token
    WebShellView.swift   WKWebView (NSViewRepresentable)
    RootView.swift
  Services/
    KeychainStore.swift  host.iclaw.agim.mac.credentials
    PairingParser.swift
  Models/
    HostCredentials.swift
  Agim.entitlements      App Sandbox + network.client
```

## Notes

- Bundle ID: `host.iclaw.agim.mac` (separate from iOS `host.iclaw.agim`)
- ATS allows local networking (`http://192.168.x.x:3000`) for LAN hosts
- External http(s) links open in the system browser
