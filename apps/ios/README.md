# Agim iOS — Chat MVP

Native SwiftUI client for Agim chat. Phase 1: **Chat only** (pair via QR / paste → WebSocket `/ws`). Ops tabs come later.

## Requirements

- macOS with Xcode 16+ (iOS 17 deployment target)
- A reachable Agim host (`AGIM_WEB_BIND` / reverse proxy with HTTPS recommended)
- Access token from **Settings → Mobile → QR** (or paste any valid token)

## Generate & open the Xcode project

```bash
cd apps/ios
./scripts/generate-xcodeproj.sh
open Agim.xcodeproj
```

`generate-xcodeproj.sh` uses **XcodeGen** when installed (`brew install xcodegen`), otherwise falls back to `scripts/generate-pbxproj.mjs` (Node). A checked-in `Agim.xcodeproj` is also included so you can open immediately and regenerate after adding files.

## Pairing

1. On the Agim web console (admin): **Settings → Mobile** → generate QR  
2. In the app: **Scan QR** (or paste host + token)  
3. QR URL shape (existing): `https://<host>/m/login?t=<token>&next=/m/chat`  
4. App stores `{ host, token }` in Keychain and connects with  
   `Authorization: Bearer <token>` on `wss://<host>/ws`

Also accepted:

- `agim://pair?t=<token>&host=https%3A%2F%2Fexample.com`
- Manual host (`https://agent.example.com`) + token (`agim_…`)

## Features (MVP)

- Streamed chat (chunk / done)
- Thread resume (`web-…` threadId + `get-history`)
- Agent switch / new conversation
- Approval + ask_user docks
- Run activity (“处理中”)
- Foreground reconnect after iOS suspends the socket

## Layout

```
apps/ios/
  project.yml                 # XcodeGen spec
  scripts/generate-xcodeproj.sh
  Agim/
    AgimApp.swift
    Info.plist
    Models/                   # WS wire types (mirror web-app types/ws.ts)
    Services/                 # Keychain, WebSocket, ChatStore
    Views/                    # Pairing, Chat, docks
  AgimTests/                  # Pairing URL parser tests
```

## Protocol

Wire frames match `src/web-app/src/types/ws.ts`. Do not fork the protocol — change the server + SPA + this app together.
