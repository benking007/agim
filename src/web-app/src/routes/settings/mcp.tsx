/**
 * /settings/mcp — external MCP servers admin (Stage 6).
 *
 * Front-end for the `/api/mcp/*` REST surface. List configured servers,
 * see their connection status + tool count, add stdio / HTTP / SSE
 * servers, probe per-server health, remove.
 *
 * The native agent loop consumes any tools advertised here; CLI agents
 * have their own MCP configs and ignore this list. See
 * docs/llm-backends.md § External MCP servers.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, Plus, RefreshCcw, ServerCog, Trash2, Activity } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  useMcpList, useMcpAddServer, useMcpRemoveServer, useMcpHealth,
  type McpServerRow,
} from '@/hooks/use-llm-admin'

export default function SettingsMcpRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const listQuery = useMcpList()
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header className="flex items-center gap-3">
        <ServerCog className="h-5 w-5 text-text-dim" />
        <h1 className="text-xl font-semibold">{t('mcp.title')}</h1>
        <Button
          variant="ghost" size="sm" className="ml-auto"
          onClick={() => void listQuery.refetch()}
          disabled={listQuery.isFetching}
          aria-label={t('actions.refresh', { ns: 'common' })}
        >
          {listQuery.isFetching
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <RefreshCcw className="h-4 w-4" />}
          <span className="hidden sm:inline">{t('mcp.refresh')}</span>
        </Button>
      </header>
      <p className="text-sm text-text-dim">{t('mcp.subtitle')}</p>

      {listQuery.isLoading ? (
        <div className="h-48 rounded-md bg-surface-2 animate-pulse" />
      ) : (
        <>
          <ServersCard data={listQuery.data} />
          <AddServerCard />
        </>
      )}
    </div>
  )
}

/* ─────────────── Servers list ─────────────── */

function ServersCard({ data }: { data: ReturnType<typeof useMcpList>['data'] }): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const removeServer = useMcpRemoveServer()
  const health = useMcpHealth()
  const [healthResults, setHealthResults] = useState<Record<string, string>>({})

  async function onRemove(name: string): Promise<void> {
    if (!confirm(t('mcp.removeConfirm', { name }))) return
    try {
      await removeServer.mutateAsync(name)
      toast.success(t('mcp.removedToast', { name }))
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  async function onHealth(name: string): Promise<void> {
    setHealthResults((m) => ({ ...m, [name]: t('mcp.probing') }))
    try {
      const r = await health.mutateAsync(name)
      const msg = r.connected
        ? `✓ ${r.toolCount === 1
          ? t('mcp.runtimeConnectedOne', { count: r.toolCount })
          : t('mcp.runtimeConnected', { count: r.toolCount })}`
        : `✗ ${r.lastError ?? t('mcp.runtimeDisconnected')}`
      setHealthResults((m) => ({ ...m, [name]: msg }))
    } catch (err) {
      setHealthResults((m) => ({ ...m, [name]: `✗ ${((err as Error)?.message ?? String(err))}` }))
    }
  }

  const rows = data?.servers ?? []
  const runtime = data?.runtime?.servers ?? []
  if (rows.length === 0) {
    return (
      <section className="rounded-md border border-border bg-surface p-6 text-center text-sm text-text-dim">
        {t('mcp.serversEmpty')}
      </section>
    )
  }

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{t('mcp.serversTitle', { count: rows.length })}</h2>
        {data?.runtime && (
          <Badge variant="info">{t('mcp.totalTools', { count: data.runtime.totalTools })}</Badge>
        )}
      </header>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('mcp.col.name')}</TableHead>
            <TableHead>{t('mcp.col.transport')}</TableHead>
            <TableHead>{t('mcp.col.target')}</TableHead>
            <TableHead>{t('mcp.col.runtime')}</TableHead>
            <TableHead>{t('mcp.col.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => {
            const rt = runtime.find((r) => r.name === s.name)
            const transport = transportLabel(s, t)
            const target = s.command
              ? `${s.command} ${(s.args ?? []).join(' ')}`.trim()
              : (s.url ?? '—')
            const runtimeBadge = !rt
              ? <Badge variant="outline">{t('mcp.runtimeUnknown')}</Badge>
              : rt.connected
                ? <Badge variant="success">
                    {rt.toolCount === 1
                      ? t('mcp.runtimeConnectedOne', { count: rt.toolCount })
                      : t('mcp.runtimeConnected', { count: rt.toolCount })}
                  </Badge>
                : <Badge variant="danger">{t('mcp.runtimeDisconnected')}</Badge>
            return (
              <TableRow key={s.name}>
                <TableCell className="font-mono text-xs">{s.name}</TableCell>
                <TableCell>{transport}</TableCell>
                <TableCell className="break-all font-mono text-[11px] text-text-dim">{target}</TableCell>
                <TableCell>{runtimeBadge}</TableCell>
                <TableCell className="flex flex-col gap-1 sm:flex-row sm:items-center">
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => void onHealth(s.name)}
                    disabled={health.isPending}
                  >
                    <Activity className="h-4 w-4" />
                    <span>{t('mcp.health')}</span>
                  </Button>
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => void onRemove(s.name)}
                    disabled={removeServer.isPending}
                    className="text-danger hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" />
                    <span className="hidden sm:inline">{t('mcp.remove')}</span>
                  </Button>
                  {healthResults[s.name] && (
                    <span className="ml-2 text-[11px] text-text-dim">{healthResults[s.name]}</span>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </section>
  )
}

function transportLabel(
  s: McpServerRow,
  t: (key: string) => string,
): string {
  if (s.command) return t('mcp.transportStdio')
  if (s.url) return s.url.endsWith('/sse') ? t('mcp.transportSse') : t('mcp.transportHttp')
  return '—'
}

/* ─────────────── Add server form ─────────────── */

function AddServerCard(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const addServer = useMcpAddServer()
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [headersJson, setHeadersJson] = useState('')

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!name.trim()) { toast.error(t('mcp.nameRequired')); return }
    let headers: Record<string, string> | undefined
    if (headersJson.trim()) {
      try { headers = JSON.parse(headersJson) }
      catch { toast.error(t('mcp.headersInvalid')); return }
    }
    const body: Parameters<typeof addServer.mutateAsync>[0] = { name: name.trim() }
    if (transport === 'stdio') {
      if (!command.trim()) { toast.error(t('mcp.commandRequired')); return }
      body.command = command.trim()
      const splitArgs = args.split(/\s+/).filter(Boolean)
      if (splitArgs.length > 0) body.args = splitArgs
    } else {
      if (!url.trim()) { toast.error(t('mcp.urlRequired')); return }
      body.url = url.trim()
      if (headers) body.headers = headers
    }
    try {
      await addServer.mutateAsync(body)
      toast.success(t('mcp.addedToast', { name: name.trim() }))
      setName(''); setCommand(''); setArgs(''); setUrl(''); setHeadersJson('')
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{t('mcp.addTitle')}</h2>
      </header>
      <form onSubmit={(e) => void onSubmit(e)} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <div>
          <Label className="text-xs font-medium">{t('mcp.nameLabel')}</Label>
          <Input
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder={t('mcp.namePlaceholder')}
            className="font-mono text-xs"
          />
        </div>
        <div>
          <Label className="text-xs font-medium">{t('mcp.transportLabel')}</Label>
          <Select value={transport} onValueChange={(v) => setTransport(v as 'stdio' | 'http')}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">{t('mcp.transportStdioOption')}</SelectItem>
              <SelectItem value="http">{t('mcp.transportHttpOption')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {transport === 'stdio' ? (
          <>
            <div>
              <Label className="text-xs font-medium">{t('mcp.commandLabel')}</Label>
              <Input
                value={command} onChange={(e) => setCommand(e.target.value)}
                placeholder={t('mcp.commandPlaceholder')}
                className="font-mono text-xs"
              />
            </div>
            <div>
              <Label className="text-xs font-medium">{t('mcp.argsLabel')}</Label>
              <Input
                value={args} onChange={(e) => setArgs(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-filesystem /data"
                className="font-mono text-xs"
              />
            </div>
          </>
        ) : (
          <>
            <div className="sm:col-span-2">
              <Label className="text-xs font-medium">{t('mcp.urlLabel')}</Label>
              <Input
                value={url} onChange={(e) => setUrl(e.target.value)}
                placeholder={t('mcp.urlPlaceholder')}
                className="font-mono text-xs"
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs font-medium">{t('mcp.headersLabel')}</Label>
              <Input
                value={headersJson} onChange={(e) => setHeadersJson(e.target.value)}
                placeholder={t('mcp.headersPlaceholder')}
                className="font-mono text-xs"
              />
            </div>
          </>
        )}
        <div className="sm:col-span-2 flex">
          <Button type="submit" disabled={addServer.isPending} className="ml-auto">
            {addServer.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {t('mcp.addServer')}
          </Button>
        </div>
      </form>
    </section>
  )
}
