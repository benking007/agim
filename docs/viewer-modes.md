# Viewer modes — picking how long IM replies become links

> agim's "viewer" turns long markdown replies into a short link the IM
> user can tap to open a full-page render. As of **v1.2.42** there are
> three transport modes to produce that link. Pick whichever matches
> your deployment.

## Why this matters

WeChat / Telegram / Feishu / DingTalk all render rich markdown poorly
(tables collapse, code blocks wrap, screenshots eat the screen). When
the agent's reply is long, agim stashes the full markdown somewhere
that has a public URL and the IM message becomes a one-line summary
plus a 📎 link.

The hard part is **where to stash it**.

## The three modes

| Mode | Storage | Public URL source | Best for |
|---|---|---|---|
| `local` | This host's `~/.agim/viewer.db` | Your own reverse proxy (`IMHUB_VIEWER_PUBLIC_BASE_URL`) | Operators with a domain + TLS reverse proxy |
| `tunnel` | This host's `~/.agim/viewer.db` | `cloudflared` quick tunnel (`https://*.trycloudflare.com`) | Tinkering / overseas; the URL changes per restart and is often blocked in mainland China |
| `remote` | An external paste server you (or your maintainer) host | The paste server returns the URL on upload | Users without their own domain — perfect for shipping agim-cli with a single hosted paste service for everyone |

Mode is picked **automatically** in this order, first non-empty wins:

1. `IMHUB_VIEWER_REMOTE_PASTE_URL` is set → **remote** (operator-chosen)
2. `IMHUB_VIEWER_PUBLIC_BASE_URL` is set → **local**
3. `IMHUB_VIEWER_TUNNEL_MODE=quick` → **tunnel**
4. fallback → **remote** routed through the community default
   `https://viewer.iclaw.host/paste` (introduced in v1.2.43; turn off
   with `IMHUB_VIEWER_NO_DEFAULT_REMOTE=1`)
5. nothing usable → degrade to inline (IM gets the full markdown text,
   may be ugly but never lost)

## Privacy callout

The community default in step 4 means an out-of-the-box agim install
**uploads long agent replies over HTTPS** to `viewer.iclaw.host`. If
your deployment can't accept that, set
`IMHUB_VIEWER_NO_DEFAULT_REMOTE=1` (no upload, no public link — the
IM gets inline markdown), or set `IMHUB_VIEWER_PUBLIC_BASE_URL` to
keep storage on your own host.

## Mode `local` — your own domain

```bash
# ~/.agim/env
IMHUB_VIEWER_ENABLED=1
IMHUB_VIEWER_PUBLIC_BASE_URL=https://agent.example.com
```

What you also need:

- HTTPS reverse proxy (caddy / nginx / cloudflared named tunnel /
  tailscale serve) pointing at this host's `:3000`
- Public DNS for `agent.example.com`

Pastes live in `~/.agim/viewer.db`. The web console serves them at
`<your-domain>/v/<id>`. Data never leaves your host.

## Mode `tunnel` — cloudflared quick

```bash
# ~/.agim/env
IMHUB_VIEWER_ENABLED=1
IMHUB_VIEWER_TUNNEL_MODE=quick
# (leave PUBLIC_BASE_URL unset)
```

What you need:

- `cloudflared` binary in PATH (or `~/.agim/bin/cloudflared`)
- Outbound HTTPS to `*.trycloudflare.com`

⚠️ **Mainland China caveat**: `trycloudflare.com` DNS is frequently
unreachable in China. If `cloudflared` can't establish the tunnel,
agim falls back to the inline mode and IM messages contain the full
markdown body. Either get a domain (mode `local`) or use the
`remote` mode below.

## Mode `remote` — POST to a hosted paste server

```bash
# ~/.agim/env
IMHUB_VIEWER_ENABLED=1
IMHUB_VIEWER_REMOTE_PASTE_URL=https://paste.example.com/paste
IMHUB_VIEWER_REMOTE_PASTE_TOKEN=optional-shared-secret
```

What you need:

- A running paste server. See [services/viewer-paste/README.md](../services/viewer-paste/README.md)
  for a one-file Node.js reference implementation.
- Outbound HTTPS to your paste server (China-friendly if the server
  is on a CN-reachable IP / domain).

Behaviour:

- The user's full markdown is **uploaded** to your paste server over
  HTTPS. The server replies with a `{url}` that agim hands to the IM.
- Local `viewer.db` is **not** used in this mode (saves disk and
  keeps storage centralised).
- On any failure (timeout, non-2xx, missing url field) agim
  transparently falls back to a local paste — so users get *something*
  even if your central server is briefly down. The fallback URL only
  works if the user *also* has a `PUBLIC_BASE_URL` or `tunnel`
  configured; otherwise the IM gets inline markdown.

### Privacy / compliance

This mode means the user's agent output **leaves their host** to your
server. agim's CLI wizard explicitly warns when this mode is selected.
If you ship agim-cli with the remote mode preconfigured, make this
trade-off visible in your install docs.

### Why this exists

For mainland China users with no public domain and no working
cloudflared tunnel, mode `local` and `tunnel` both fail. Mode
`remote` lets the maintainer (or any community admin) host one
paste server and have every agim user link through it.

## Switching modes

Change the env, restart agim. No DB migration is needed — pastes
produced in `local` mode keep working from the same URL; pastes from
`remote` mode keep working as long as your paste server retains them
(default 30 days).

## Operator FAQ

**Q: Can I use multiple modes at once?**

A: No. The picker chooses one mode at a time based on the order
above. Best practice: pick one and document it for your users.

**Q: My remote paste server went down — do I lose all the links?**

A: All links generated during the outage that pointed to your remote
server will 404 until you bring it back. New replies during the
outage degrade to inline (or to the local fallback if PUBLIC_BASE_URL
is also configured).

**Q: How big can a paste be?**

A: 1 MB cap on the agim client side before degrading. A single
markdown reply that big is rare (~ a small book).
