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

Set your Apple Development Team in Xcode **Signing & Capabilities** if needed, then Run (⌘R).

## Build a standalone app (install into Applications)

Goal: get a normal `Agim.app` you can keep in **应用程序 / Applications** (Launchpad / Spotlight), not “run only from Xcode”.

### One-liner (recommended)

On your Mac:

```bash
cd apps/macos
./scripts/generate-xcodeproj.sh
./scripts/build-app.sh --install
```

- Builds **Release** → `apps/macos/dist/Agim.app`
- Copies into `/Applications/Agim.app` (falls back to `~/Applications` if needed)
- Clears quarantine attrs for a quieter first launch

Then open from Launchpad / Spotlight, or:

```bash
open /Applications/Agim.app
```

Build only (no install):

```bash
./scripts/build-app.sh
```

### Via Xcode UI

1. Open `Agim.xcodeproj`, select scheme **Agim**, destination **My Mac**
2. Product → **Archive**
3. Organizer → **Distribute App** → **Copy App** (or Developer ID if you have a paid Apple Developer account)
4. Drag the exported `Agim.app` into **应用程序**

### Signing / Gatekeeper notes

| Situation | What happens |
|-----------|----------------|
| Personal Team / ad-hoc local build | App works on **your** Mac; first open may need right-click → Open |
| Apple Developer Program + **Developer ID** + notarize | Freely share `.app` / `.dmg` with others |
| Mac App Store | Needs App Store Connect, review, different certs — not set up yet |

This repo’s shell is for **self-host / sideload** (same host + session cookie as iOS). App Store listing is a separate product track.

## Flow

1. Enter the Agim origin (`https://agent.example.com`) → Keychain (host only)  
2. Shell reads WKWebView `agim_session`. With a cookie it opens `{host}/m/chat`; without one it opens `{host}/login?next=/m/chat`  
3. Sign in with username / password in the WebView; the session cookie stays in the WebView store  
4. Agent Portal WebUI handles chat / explore / voice  

Also accepts deep links: `agim://pair?host=https%3A%2F%2F…` (legacy `t=` / `c=` query items are ignored).

Menu: **重新加载** (⌘R) / **退出配对…**

## Layout

```
Agim/
  AgimApp.swift          session + menu commands
  Views/
    PairingView.swift    paste / type host URL
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
- File pickers (拍照 / 照片 / 文件) need `WKUIDelegate.runOpenPanelWith` — implemented in `WebShellView`
