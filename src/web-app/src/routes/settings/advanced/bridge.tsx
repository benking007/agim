/**
 * /settings/advanced/bridge — connection settings.
 *
 * Admin only (the Advanced group is admin-only, and the API returns 403).
 * The raw token and the caller handoff live in component state for this
 * success only. Reloading the page cannot rebuild them.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, RefreshCcw } from 'lucide-react'

import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api/endpoints'
import { describeError } from '@/lib/api/errors'
import { cn } from '@/lib/utils'

type Issued = { raw: string; callerPrompt: string }
type Peer = {
  peerId: string
  tokenId: string
  agents: string[]
  callbackUrl: string | null
  webhookKeySet: boolean
  enabled: boolean
  maxConcurrent: number
  workspaceId: string
}

function splitAgents(value: string): string[] {
  const names: string[] = []
  for (const part of value.split(/[,，]/)) {
    const name = part.trim()
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value)
}

export default function SettingsBridgeRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const qc = useQueryClient()
  const enabledQuery = useQuery({
    queryKey: ['bridge-admin', 'enabled'],
    queryFn: () => api.getBridgeEnabled(),
  })
  const tokensQuery = useQuery({
    queryKey: ['bridge-admin', 'tokens'],
    queryFn: () => api.listBridgeTokens(),
  })
  const peersQuery = useQuery({
    queryKey: ['bridge-admin', 'peers'],
    queryFn: () => api.listBridgePeers(),
  })

  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [issued, setIssued] = useState<Issued | null>(null)
  const [revokeId, setRevokeId] = useState<string | null>(null)
  const [peerId, setPeerId] = useState('')
  const [tokenId, setTokenId] = useState('')
  const [agents, setAgents] = useState('agim')
  const [maxConcurrent, setMaxConcurrent] = useState('1')
  const [workspaceId, setWorkspaceId] = useState('default')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhookKey, setWebhookKey] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [allowlist, setAllowlist] = useState('')

  const knownBase = tokensQuery.data?.publicBaseUrl ?? null
  const tokens = tokensQuery.data?.tokens ?? []
  const peers = peersQuery.data?.peers ?? []
  const activeTokens = tokens.filter((row) => !row.revoked)

  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) => api.setBridgeEnabled({ enabled }),
    onSuccess: async () => {
      toast.success(t('states.saved', { ns: 'common' }))
      await qc.invalidateQueries({ queryKey: ['bridge-admin', 'enabled'] })
    },
    onError: (err) => toast.error(describeError(err, t).message),
  })

  const createToken = useMutation({
    mutationFn: () => api.createBridgeToken({
      label: label.trim(),
      ...(knownBase ? {} : { baseUrl: baseUrl.trim() }),
    }),
    onSuccess: async (created) => {
      setIssued({ raw: created.raw, callerPrompt: created.callerPrompt })
      setLabel('')
      toast.success(t('bridge.created'))
      await qc.invalidateQueries({ queryKey: ['bridge-admin', 'tokens'] })
    },
    onError: (err) => toast.error(describeError(err, t).message),
  })

  const revokeToken = useMutation({
    mutationFn: (id: string) => api.revokeBridgeToken(id),
    onSuccess: async () => {
      toast.success(t('states.saved', { ns: 'common' }))
      await qc.invalidateQueries({ queryKey: ['bridge-admin', 'tokens'] })
    },
    onError: (err) => {
      toast.error(describeError(err, t).message)
      throw err
    },
  })

  const savePeer = useMutation({
    mutationFn: (body: Parameters<typeof api.createBridgePeer>[0]) => api.createBridgePeer(body),
    onSuccess: async () => {
      setPeerId('')
      setAgents('agim')
      setWebhookUrl('')
      setWebhookKey('')
      toast.success(t('bridge.peerSaved'))
      await qc.invalidateQueries({ queryKey: ['bridge-admin', 'peers'] })
    },
    onError: (err) => toast.error(describeError(err, t).message),
  })

  const patchPeer = useMutation({
    mutationFn: (body: Parameters<typeof api.updateBridgePeer>[0]) => api.updateBridgePeer(body),
    onSuccess: async () => {
      setEditing(null)
      toast.success(t('bridge.peerSaved'))
      await qc.invalidateQueries({ queryKey: ['bridge-admin', 'peers'] })
    },
    onError: (err) => toast.error(describeError(err, t).message),
  })

  async function onCopy(value: string): Promise<void> {
    try {
      await copyText(value)
      toast.success(t('bridge.copied'))
    } catch {
      toast.error(t('bridge.copyFailed'))
    }
  }

  function onAddPeer(): void {
    const parsed = Number(maxConcurrent)
    savePeer.mutate({
      peerId: peerId.trim(),
      tokenId,
      agents: splitAgents(agents),
      maxConcurrent: Number.isInteger(parsed) ? parsed : 1,
      workspaceId: workspaceId.trim() || 'default',
      enabled: true,
      callbackUrl: webhookUrl.trim(),
      webhookKey: webhookKey.trim(),
    })
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{t('bridge.title')}</h1>
        <p className="text-sm text-text-dim">{t('bridge.subtitle')}</p>
      </header>

      <section className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4">
        <span id="bridge-enabled-label" className="text-sm font-medium">{t('bridge.turnOn')}</span>
        <button
          type="button"
          role="switch"
          aria-labelledby="bridge-enabled-label"
          aria-checked={enabledQuery.data?.enabled === true}
          disabled={enabledQuery.isLoading || setEnabled.isPending}
          onClick={() => setEnabled.mutate(enabledQuery.data?.enabled !== true)}
          className={cn(
            'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            'disabled:cursor-not-allowed disabled:opacity-50',
            enabledQuery.data?.enabled ? 'bg-accent' : 'border border-border bg-surface-2',
          )}
        >
          <span
            className={cn(
              'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
              enabledQuery.data?.enabled ? 'translate-x-5' : 'translate-x-0.5',
            )}
          />
        </button>
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t('bridge.tokensTitle')}</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { void tokensQuery.refetch() }}
            disabled={tokensQuery.isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {tokensQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="bridge-token-label">{t('bridge.tokenLabel')}</Label>
            <Input
              id="bridge-token-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className="w-56"
            />
          </div>
          {knownBase == null && (
            <div className="space-y-1">
              <Label htmlFor="bridge-base-url">{t('bridge.baseLabel')}</Label>
              <Input
                id="bridge-base-url"
                value={baseUrl}
                placeholder={t('bridge.basePlaceholder')}
                onChange={(event) => setBaseUrl(event.target.value)}
                className="w-72"
              />
              <p className="text-xs text-text-dim">{t('bridge.baseHint')}</p>
            </div>
          )}
          <Button
            onClick={() => createToken.mutate()}
            disabled={createToken.isPending || !label.trim() || (knownBase == null && !baseUrl.trim())}
          >
            {t('bridge.tokenCreate')}
          </Button>
        </div>

        {issued && (
          <div className="space-y-3 rounded-lg border border-warning/40 bg-warning-bg p-3">
            <div>
              <h3 className="text-sm font-semibold">{t('bridge.onceTitle')}</h3>
              <p className="text-sm text-text-dim">{t('bridge.onceHint')}</p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="bridge-raw">{t('bridge.tokenRaw')}</Label>
                <Button type="button" size="sm" variant="outline" onClick={() => { void onCopy(issued.raw) }}>
                  {t('bridge.copy')}
                </Button>
              </div>
              <Input id="bridge-raw" readOnly value={issued.raw} />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="bridge-prompt">{t('bridge.promptTitle')}</Label>
                <Button type="button" size="sm" variant="outline" onClick={() => { void onCopy(issued.callerPrompt) }}>
                  {t('bridge.copy')}
                </Button>
              </div>
              <textarea
                id="bridge-prompt"
                readOnly
                value={issued.callerPrompt}
                rows={8}
                className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm"
              />
            </div>
          </div>
        )}

        {tokens.length === 0 ? (
          <p className="text-sm text-text-dim">{t('bridge.noTokens')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-dim">
                  <th className="py-1 pr-3 font-medium">{t('bridge.colId')}</th>
                  <th className="py-1 pr-3 font-medium">{t('bridge.colName')}</th>
                  <th className="py-1 pr-3 font-medium">{t('bridge.colStatus')}</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {tokens.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="py-2 pr-3 font-mono">{row.id}</td>
                    <td className="py-2 pr-3">{row.label}</td>
                    <td className="py-2 pr-3">{row.revoked ? t('bridge.revoked') : t('bridge.active')}</td>
                    <td className="py-2 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={row.revoked}
                        onClick={() => setRevokeId(row.id)}
                      >
                        {t('bridge.revoke')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold">{t('bridge.peersTitle')}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="bridge-peer-id">{t('bridge.peerId')}</Label>
            <Input id="bridge-peer-id" value={peerId} onChange={(event) => setPeerId(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bridge-peer-token">{t('bridge.tokenId')}</Label>
            <select
              id="bridge-peer-token"
              value={tokenId}
              onChange={(event) => setTokenId(event.target.value)}
              className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm"
            >
              <option value="" />
              {activeTokens.map((row) => (
                <option key={row.id} value={row.id}>{row.label} ({row.id})</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bridge-peer-agents">{t('bridge.agents')}</Label>
            <Input id="bridge-peer-agents" value={agents} onChange={(event) => setAgents(event.target.value)} />
            <p className="text-xs text-text-dim">{t('bridge.agentsHint')}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bridge-peer-max">{t('bridge.maxConcurrent')}</Label>
            <Input id="bridge-peer-max" value={maxConcurrent} onChange={(event) => setMaxConcurrent(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bridge-peer-workspace">{t('bridge.workspace')}</Label>
            <Input id="bridge-peer-workspace" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bridge-webhook-url">{t('bridge.webhookUrl')}</Label>
            <Input
              id="bridge-webhook-url"
              value={webhookUrl}
              onChange={(event) => setWebhookUrl(event.target.value)}
              placeholder="https://"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bridge-webhook-key">{t('bridge.webhookKey')}</Label>
            <Input
              id="bridge-webhook-key"
              type="password"
              autoComplete="new-password"
              value={webhookKey}
              onChange={(event) => setWebhookKey(event.target.value)}
            />
          </div>
        </div>
        <Button onClick={onAddPeer} disabled={savePeer.isPending || !peerId.trim() || !tokenId}>
          {t('bridge.addPeer')}
        </Button>

        {peers.length === 0 ? (
          <p className="text-sm text-text-dim">{t('bridge.noPeers')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-dim">
                  <th className="py-1 pr-3 font-medium">{t('bridge.peerId')}</th>
                  <th className="py-1 pr-3 font-medium">{t('bridge.agents')}</th>
                  <th className="py-1 pr-3 font-medium">{t('bridge.webhookUrl')}</th>
                  <th className="py-1 pr-3 font-medium">{t('bridge.webhookKey')}</th>
                  <th className="py-1 pr-3 font-medium">{t('bridge.enabled')}</th>
                  <th className="py-1 pr-3 font-medium">{t('bridge.maxConcurrent')}</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {peers.map((peer: Peer) => (
                  <tr key={peer.peerId} className="border-t border-border align-top">
                    <td className="py-2 pr-3 font-mono">{peer.peerId}</td>
                    <td className="py-2 pr-3">{peer.agents.join(', ') || '—'}</td>
                    <td className="py-2 pr-3">{peer.callbackUrl || t('bridge.callbackEmpty')}</td>
                    <td className="py-2 pr-3">{peer.webhookKeySet ? t('bridge.webhookKeySet') : t('bridge.webhookKeyEmpty')}</td>
                    <td className="py-2 pr-3">{peer.enabled ? t('bridge.active') : t('bridge.disable')}</td>
                    <td className="py-2 pr-3 tabular-nums">{peer.maxConcurrent}</td>
                    <td className="space-y-2 py-2 text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => patchPeer.mutate({ peerId: peer.peerId, enabled: !peer.enabled })}
                        >
                          {peer.enabled ? t('bridge.disable') : t('bridge.enable')}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditing(peer.peerId)
                            setAllowlist(peer.agents.join(', '))
                          }}
                        >
                          {t('bridge.allowlist')}
                        </Button>
                      </div>
                      {editing === peer.peerId && (
                        <div className="flex justify-end gap-2">
                          <Input
                            aria-label={t('bridge.allowlist')}
                            value={allowlist}
                            onChange={(event) => setAllowlist(event.target.value)}
                            className="max-w-xs"
                          />
                          <Button
                            size="sm"
                            onClick={() => patchPeer.mutate({
                              peerId: peer.peerId,
                              agents: splitAgents(allowlist),
                            })}
                          >
                            {t('bridge.saveAllowlist')}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={revokeId != null}
        onOpenChange={(open) => { if (!open) setRevokeId(null) }}
        title={t('bridge.revokeTitle')}
        description={t('bridge.revokeBody')}
        intent="danger"
        confirmLabel={t('bridge.revoke')}
        onConfirm={async () => {
          if (revokeId) await revokeToken.mutateAsync(revokeId)
        }}
      />
    </div>
  )
}
