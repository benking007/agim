# viewer-paste — reference paste server for agim viewer remote mode

Companion service for `IMHUB_VIEWER_REMOTE_PASTE_URL` (introduced in
agim **v1.2.42**). agim clients POST markdown here; this service
returns a public URL the IM message can link to.

This directory is a **reference implementation** — you do not have to
use it. Any HTTP server that respects the wire contract below will
work.

## Wire contract

### POST `<your-domain>/paste`

Request:

```
POST /paste HTTP/1.1
Content-Type: application/json
Authorization: Bearer <optional-shared-token>

{
  "content":    "# heading\n\n…full markdown…",
  "source":     "telegram:default:12345",     // optional context tag
  "ttlSeconds": 2592000                       // optional retention hint
}
```

Response (2xx):

```
{ "url": "https://your-domain.example/v/abcd1234" }
```

agim's client (`src/core/viewer-remote.ts`) treats any non-2xx,
non-JSON, or missing-`url` response as failure and degrades to the
local viewer fallback. So **never block agim** by hanging the
request — return fast (under ~10 s) or return an error.

### GET `<your-domain>/v/:id`

Render the stored markdown to HTML. Return 404 when the paste is
gone (expired or deleted).

## Minimal Node.js implementation

Single-file, no framework, sqlite for storage. Drop into a 1C/1G VPS,
behind your TLS-terminating reverse proxy.

```js
// paste-server.js
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { marked } from 'marked'

const db = new Database('./paste.db')
db.exec(`
  CREATE TABLE IF NOT EXISTS pastes (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    source      TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pastes_expires ON pastes(expires_at);
`)

const PORT = Number(process.env.PORT || 8080)
const TOKEN = process.env.PASTE_TOKEN || ''          // optional bearer
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL      // e.g. https://paste.example
const MAX_BYTES = 1_000_000                          // 1 MB cap
const DEFAULT_TTL_SECONDS = 30 * 86_400               // 30 days

function shortId() {
  return randomBytes(6).toString('base64url')
}

setInterval(() => {
  db.prepare('DELETE FROM pastes WHERE expires_at < ?').run(Math.floor(Date.now() / 1000))
}, 60 * 60 * 1000).unref()

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/paste') {
      if (TOKEN) {
        const auth = req.headers.authorization || ''
        if (!auth.startsWith('Bearer ') || auth.slice(7) !== TOKEN) {
          res.writeHead(401).end('unauthorized'); return
        }
      }
      const chunks = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > MAX_BYTES) { res.writeHead(413).end('too big'); return }
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const content = String(body.content ?? '')
      if (!content) { res.writeHead(400).end('content required'); return }
      const ttl = Math.min(Number(body.ttlSeconds) || DEFAULT_TTL_SECONDS, DEFAULT_TTL_SECONDS)
      const id = shortId()
      const now = Math.floor(Date.now() / 1000)
      db.prepare('INSERT INTO pastes (id, content, source, created_at, expires_at) VALUES (?,?,?,?,?)')
        .run(id, content, String(body.source || ''), now, now + ttl)
      const url = `${PUBLIC_BASE}/v/${id}`
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ url }))
      return
    }

    const viewMatch = req.url?.match(/^\/v\/([A-Za-z0-9_-]+)$/)
    if (req.method === 'GET' && viewMatch) {
      const row = db.prepare('SELECT content, expires_at FROM pastes WHERE id = ?').get(viewMatch[1])
      if (!row || row.expires_at < Math.floor(Date.now() / 1000)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
        return
      }
      const html = marked.parse(row.content)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>agim paste</title></head><body>${html}</body></html>`)
      return
    }

    res.writeHead(404).end('not found')
  } catch (err) {
    console.error(err)
    res.writeHead(500).end('internal error')
  }
})

server.listen(PORT, () => console.log(`viewer-paste listening :${PORT}`))
```

Run:

```bash
npm i better-sqlite3 marked
PUBLIC_BASE_URL=https://paste.example PASTE_TOKEN=optional-shared-secret \
  node paste-server.js
```

Front with caddy / nginx / cloudflared for HTTPS.

## Operator checklist

- [ ] Outbound HTTP works from the agim user's side (China-friendly)
- [ ] PUBLIC_BASE_URL matches the URL behind your TLS reverse proxy
- [ ] PASTE_TOKEN set (and the same value goes into agim's
      `IMHUB_VIEWER_REMOTE_PASTE_TOKEN`)
- [ ] Disk + bandwidth quota on the host (markdown bodies can add up)
- [ ] Backup or accept that pastes are ephemeral (30-day default TTL)

## Privacy note

Activating remote-paste mode in agim means the agent's reply content
**leaves the user's host** and is stored on your server until TTL.
Communicate this to users; agim itself surfaces a hint in the CLI
wizard when this mode is selected.
