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

## Troubleshooting

| 现象 | 处理 |
|------|------|
| 顶栏一直「连接中 / 同步中」 | 菜单 → **重新连接**；确认 host 从模拟器可达（本机服务用 Mac 的局域网 IP，不要用仅监听 `127.0.0.1` 的地址给真机） |
| 能配对但不能发消息 | 等状态变成「已连接」；若仍卡住，菜单 → **取消卡住的回复** 后再发 |
| Xcode 控制台 | 过滤 subsystem `host.iclaw.agim` 查看 WS 握手 / decode 日志 |

WS 使用 `wss?token=`（兼 `Authorization: Bearer`），与 Web `/ws` 同一协议。
