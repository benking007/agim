/**
 * /settings/messengers — per-IM-platform connection config.
 *
 * Layout: one card per platform (WeChat / Telegram / Feishu /
 * DingTalk / Discord). Each card has:
 *   * Title + hint
 *   * Enable / disable toggle (reads / writes config.messengers[])
 *   * When enabled, the platform's config fields (texted)
 *   * For WeChat: a "Scan QR" button → modal with QR + 2s polling
 *
 * Save All button at the top batches every dirty platform into one
 * PUT /api/config. The discard button reverts the local draft to
 * server-side values.
 *
 * The WeChat QR flow is special: enabling WeChat requires scanning
 * a QR code (the slot in config.messengers gets added by the
 * backend on `confirmed`, so we just open the modal and re-fetch
 * config after a successful scan).
 */

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  ArrowRight,
  CheckCircle2,
  Loader2,
  MessageSquare,
  Play,
  Plug,
  QrCode,
  RefreshCcw,
  RotateCcw,
  Save,
  X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  useConfig,
  useRestartService,
  useServiceStatus,
  useStartService,
  useUpdateConfig,
  useStartWechatQr,
  useWechatQrStatus,
} from '@/hooks/use-settings'
import { describeError } from '@/lib/api/errors'
import type { AppConfig } from '@/types/api'
import { cn } from '@/lib/utils'

/** Slot names match what `config.messengers[]` contains.
 *  WeChat uses 'wechat-ilink' (the iLink adapter ID). */
type Slot = 'wechat-ilink' | 'telegram' | 'feishu' | 'dingtalk' | 'discord'

interface PlatformDraft {
  enabled: boolean
  telegram?:  { botToken?: string; channelId?: string }
  feishu?:    { appId?: string; appSecret?: string; channelId?: string }
  dingtalk?:  {
    clientId?: string
    clientSecret?: string
    channelId?: string
    // v1.2.37 (batch 1)
    dmPolicy?: 'open' | 'pairing' | 'allowlist'
    groupPolicy?: 'open' | 'allowlist' | 'disabled'
    allowFrom?: string[]
    groupAllowFrom?: string[]
    ackReaction?: 'off' | 'emoji' | 'kaomoji'
    // v1.2.41 (batch 4 follow-up) — full multi-account editor
    accounts?: Record<string, DingTalkAccountDraft>
  }
  discord?:   { botToken?: string; channelId?: string }
}

type Draft = Record<Slot, PlatformDraft>

function buildDraft(cfg: AppConfig | undefined): Draft {
  const m = new Set(cfg?.messengers ?? [])
  return {
    'wechat-ilink': { enabled: m.has('wechat-ilink') },
    telegram:       { enabled: m.has('telegram'), telegram: { ...(cfg?.telegram ?? {}) } },
    feishu:         { enabled: m.has('feishu'),   feishu:   { ...(cfg?.feishu ?? {}) } },
    dingtalk:       { enabled: m.has('dingtalk'), dingtalk: { ...(cfg?.dingtalk ?? {}) } },
    discord:        { enabled: m.has('discord'),  discord:  { ...(cfg?.discord ?? {}) } },
  }
}

function buildPatch(draft: Draft, cfg: AppConfig): Partial<AppConfig> {
  const messengers: string[] = []
  for (const k of Object.keys(draft) as Slot[]) if (draft[k].enabled) messengers.push(k)
  const patch: Partial<AppConfig> = {
    messengers,
    // Preserve unknown extra fields the AppConfig type permits.
    ...Object.fromEntries(
      Object.entries(cfg).filter(([k]) => ![
        'messengers', 'telegram', 'feishu', 'dingtalk', 'discord',
      ].includes(k)),
    ),
  }
  // Only include platform blocks that are enabled. Omitting disabled
  // platforms avoids PUT /api/config merging `{}` and failing zod
  // (telegram.botToken / feishu.appSecret / discord.botToken require
  // min(1) when the key is present).
  if (draft.telegram.enabled && draft.telegram.telegram) {
    patch.telegram = draft.telegram.telegram
  }
  if (draft.feishu.enabled && draft.feishu.feishu) {
    patch.feishu = draft.feishu.feishu
  }
  if (draft.dingtalk.enabled && draft.dingtalk.dingtalk) {
    patch.dingtalk = draft.dingtalk.dingtalk
  }
  if (draft.discord.enabled && draft.discord.discord) {
    patch.discord = draft.discord.discord
  }
  return patch
}

export default function SettingsMessengersRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const cfgQuery = useConfig()
  const updateCfg = useUpdateConfig()
  const serviceQuery = useServiceStatus()
  const startService = useStartService()
  const restartService = useRestartService()

  const [draft, setDraft] = useState<Draft>(() => buildDraft(cfgQuery.data))
  // Sync the draft once cfg lands. We don't re-sync on every cfg
  // refetch — that would discard unsaved edits.
  const [synced, setSynced] = useState(false)
  useEffect(() => {
    if (synced) return
    if (!cfgQuery.data) return
    setDraft(buildDraft(cfgQuery.data))
    setSynced(true)
  }, [cfgQuery.data, synced])

  const cfg = cfgQuery.data
  const isDirty = useMemo(() => {
    if (!cfg) return false
    return JSON.stringify(buildDraft(cfg)) !== JSON.stringify(draft)
  }, [cfg, draft])

  // WeChat QR modal state
  const [qrOpen, setQrOpen] = useState(false)
  const [focusedSlot, setFocusedSlot] = useState<Slot | null>(null)
  const [needsApply, setNeedsApply] = useState(false)

  // v1.2.71 — AGIM_PLATFORM_BLACKLIST gate. Backend sends the
  // alias-expanded set in features.blacklistedPlatforms; we hide the
  // matching PlatformCard so blacklisted IMs disappear from the page
  // entirely (not just have empty data).
  const blockedPlatforms = new Set(cfg?.features?.blacklistedPlatforms ?? [])
  const isBlocked = (slot: Slot): boolean => blockedPlatforms.has(slot)

  function patchSlot(slot: Slot, partial: Partial<PlatformDraft>): void {
    setDraft((prev) => ({ ...prev, [slot]: { ...prev[slot], ...partial } }))
  }

  function pickPlatform(slot: Slot): void {
    patchSlot(slot, { enabled: true })
    setFocusedSlot(slot)
    requestAnimationFrame(() => {
      document.getElementById(`messenger-${slot}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    })
  }

  async function onSave(): Promise<void> {
    if (!cfg) return
    try {
      await updateCfg.mutateAsync(buildPatch(draft, cfg))
      toast.success(t('messengers.savedToast'))
      setNeedsApply(true)
      setSynced(false)  // rebuild draft from refreshed cfg on next paint
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  function onDiscard(): void {
    if (cfg) setDraft(buildDraft(cfg))
  }

  async function onApplyChanges(): Promise<void> {
    const service = serviceQuery.data
    const isRunning = Boolean(service && service.mode !== 'none')
    try {
      if (isRunning) {
        await restartService.mutateAsync()
      } else {
        await startService.mutateAsync()
      }
      toast.success(t('messengers.apply.appliedToast'))
      setNeedsApply(false)
    } catch (err) {
      toast.error(describeError(err, t).message)
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('messengers.title')}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => cfgQuery.refetch()}
            disabled={cfgQuery.isFetching}
            aria-label={t('actions.refresh', { ns: 'common' })}
          >
            {cfgQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            <span className="hidden sm:inline">{t('actions.refresh', { ns: 'common' })}</span>
          </Button>
        </div>
        <p className="text-sm text-text-dim">{t('messengers.subtitle')}</p>
      </header>

      {cfgQuery.isLoading ? null : cfg ? (
        <MessengerQuickStartCard
          cfg={cfg}
          isBlocked={isBlocked}
          onScanWechat={() => setQrOpen(true)}
          onPickPlatform={pickPlatform}
        />
      ) : null}

      {/* Save bar */}
      <div className="flex flex-wrap items-center gap-2">
        {isDirty ? (
          <>
            <Badge variant="info">{t('messengers.dirtyHint')}</Badge>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onDiscard}
              disabled={updateCfg.isPending}
            >
              <X className="h-4 w-4" />
              {t('messengers.discardAll')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void onSave()}
              disabled={updateCfg.isPending}
            >
              {updateCfg.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {updateCfg.isPending ? t('messengers.saving') : t('messengers.saveAll')}
            </Button>
          </>
        ) : (
          <span className="text-xs text-text-muted">{t('env.noChanges')}</span>
        )}
      </div>

      {needsApply ? (
        <ApplyChangesCard
          serviceMode={serviceQuery.data?.mode}
          isLoading={serviceQuery.isLoading}
          isPending={startService.isPending || restartService.isPending}
          onApply={() => void onApplyChanges()}
        />
      ) : null}

      {cfgQuery.isLoading ? (
        <div className="h-96 rounded-md bg-surface-2 animate-pulse" />
      ) : !cfg ? null : (
        <div className="flex flex-col gap-3">
          {!isBlocked('wechat-ilink') ? (
            <PlatformCard
              slot="wechat-ilink"
              label={t('messengers.platform.wechat')}
              hint={t('messengers.hint.wechat')}
              enabled={draft['wechat-ilink'].enabled}
              onToggle={(v) => patchSlot('wechat-ilink', { enabled: v })}
              focused={focusedSlot === 'wechat-ilink'}
            >
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setQrOpen(true)}
              >
                <QrCode className="h-4 w-4" />
                {t('messengers.scanQr')}
              </Button>
            </PlatformCard>
          ) : null}

          {cfg.features?.globalIm && !isBlocked('telegram') ? (
            <PlatformCard
              slot="telegram"
              label={t('messengers.platform.telegram')}
              hint={t('messengers.hint.telegram')}
              enabled={draft.telegram.enabled}
              onToggle={(v) => patchSlot('telegram', { enabled: v })}
              focused={focusedSlot === 'telegram'}
            >
              <FieldRow
                id="tg-token"  label={t('messengers.fields.botToken')}
                value={draft.telegram.telegram?.botToken ?? ''}
                type="password"
                onChange={(v) => patchSlot('telegram', { telegram: { ...draft.telegram.telegram, botToken: v } })}
              />
              <FieldRow
                id="tg-channel" label={t('messengers.fields.channelId')}
                value={draft.telegram.telegram?.channelId ?? ''}
                onChange={(v) => patchSlot('telegram', { telegram: { ...draft.telegram.telegram, channelId: v } })}
              />
            </PlatformCard>
          ) : null}

          {!isBlocked('feishu') ? (
          <PlatformCard
            slot="feishu"
            label={t('messengers.platform.feishu')}
            hint={t('messengers.hint.feishu')}
            enabled={draft.feishu.enabled}
            onToggle={(v) => patchSlot('feishu', { enabled: v })}
            focused={focusedSlot === 'feishu'}
          >
            <FieldRow
              id="fs-appid" label={t('messengers.fields.appId')}
              value={draft.feishu.feishu?.appId ?? ''}
              onChange={(v) => patchSlot('feishu', { feishu: { ...draft.feishu.feishu, appId: v } })}
            />
            <FieldRow
              id="fs-secret" label={t('messengers.fields.appSecret')}
              value={draft.feishu.feishu?.appSecret ?? ''}
              type="password"
              onChange={(v) => patchSlot('feishu', { feishu: { ...draft.feishu.feishu, appSecret: v } })}
            />
            <FieldRow
              id="fs-channel" label={t('messengers.fields.channelId')}
              value={draft.feishu.feishu?.channelId ?? ''}
              onChange={(v) => patchSlot('feishu', { feishu: { ...draft.feishu.feishu, channelId: v } })}
            />
          </PlatformCard>
          ) : null}

          {!isBlocked('dingtalk') ? (
          <PlatformCard
            slot="dingtalk"
            label={t('messengers.platform.dingtalk')}
            hint={t('messengers.hint.dingtalk')}
            enabled={draft.dingtalk.enabled}
            onToggle={(v) => patchSlot('dingtalk', { enabled: v })}
            focused={focusedSlot === 'dingtalk'}
          >
            <FieldRow
              id="dt-cid" label={t('messengers.fields.clientId')}
              value={draft.dingtalk.dingtalk?.clientId ?? ''}
              onChange={(v) => patchSlot('dingtalk', { dingtalk: { ...draft.dingtalk.dingtalk, clientId: v } })}
            />
            <FieldRow
              id="dt-secret" label={t('messengers.fields.clientSecret')}
              value={draft.dingtalk.dingtalk?.clientSecret ?? ''}
              type="password"
              onChange={(v) => patchSlot('dingtalk', { dingtalk: { ...draft.dingtalk.dingtalk, clientSecret: v } })}
            />
            <FieldRow
              id="dt-channel" label={t('messengers.fields.channelId')}
              value={draft.dingtalk.dingtalk?.channelId ?? ''}
              onChange={(v) => patchSlot('dingtalk', { dingtalk: { ...draft.dingtalk.dingtalk, channelId: v } })}
            />
            {/* v1.2.37 (batch 1) — access policy + ack-reaction */}
            <SelectRow<'open' | 'pairing' | 'allowlist'>
              id="dt-dm-policy" label={t('messengers.dingtalk.dmPolicy')}
              value={draft.dingtalk.dingtalk?.dmPolicy ?? 'open'}
              onChange={(v) => patchSlot('dingtalk', { dingtalk: { ...draft.dingtalk.dingtalk, dmPolicy: v } })}
              options={[
                { value: 'open',      label: t('messengers.dingtalk.policy.open') },
                { value: 'pairing',   label: t('messengers.dingtalk.policy.pairing') },
                { value: 'allowlist', label: t('messengers.dingtalk.policy.allowlist') },
              ]}
            />
            <SelectRow<'open' | 'allowlist' | 'disabled'>
              id="dt-group-policy" label={t('messengers.dingtalk.groupPolicy')}
              value={draft.dingtalk.dingtalk?.groupPolicy ?? 'open'}
              onChange={(v) => patchSlot('dingtalk', { dingtalk: { ...draft.dingtalk.dingtalk, groupPolicy: v } })}
              options={[
                { value: 'open',      label: t('messengers.dingtalk.policy.open') },
                { value: 'allowlist', label: t('messengers.dingtalk.policy.allowlist') },
                { value: 'disabled',  label: t('messengers.dingtalk.policy.disabled') },
              ]}
            />
            <FieldRow
              id="dt-allow-from" label={t('messengers.dingtalk.allowFrom')}
              value={(draft.dingtalk.dingtalk?.allowFrom ?? []).join(',')}
              onChange={(v) => patchSlot('dingtalk', {
                dingtalk: {
                  ...draft.dingtalk.dingtalk,
                  allowFrom: v.split(',').map((s) => s.trim()).filter(Boolean),
                },
              })}
            />
            <FieldRow
              id="dt-group-allow-from" label={t('messengers.dingtalk.groupAllowFrom')}
              value={(draft.dingtalk.dingtalk?.groupAllowFrom ?? []).join(',')}
              onChange={(v) => patchSlot('dingtalk', {
                dingtalk: {
                  ...draft.dingtalk.dingtalk,
                  groupAllowFrom: v.split(',').map((s) => s.trim()).filter(Boolean),
                },
              })}
            />
            <SelectRow<'off' | 'emoji' | 'kaomoji'>
              id="dt-ack" label={t('messengers.dingtalk.ackReaction')}
              value={draft.dingtalk.dingtalk?.ackReaction ?? 'off'}
              onChange={(v) => patchSlot('dingtalk', { dingtalk: { ...draft.dingtalk.dingtalk, ackReaction: v } })}
              options={[
                { value: 'off',     label: t('messengers.dingtalk.ack.off') },
                { value: 'emoji',   label: t('messengers.dingtalk.ack.emoji') },
                { value: 'kaomoji', label: t('messengers.dingtalk.ack.kaomoji') },
              ]}
            />
            {/* v1.2.41 (batch 4 follow-up) — multi-account CRUD editor. */}
            <DingTalkAccountsEditor
              accounts={draft.dingtalk.dingtalk?.accounts ?? {}}
              onChange={(next) => patchSlot('dingtalk', {
                dingtalk: { ...draft.dingtalk.dingtalk, accounts: next },
              })}
            />
          </PlatformCard>
          ) : null}

          {cfg.features?.globalIm && !isBlocked('discord') ? (
            <PlatformCard
              slot="discord"
              label={t('messengers.platform.discord')}
              hint={t('messengers.hint.discord')}
              enabled={draft.discord.enabled}
              onToggle={(v) => patchSlot('discord', { enabled: v })}
              focused={focusedSlot === 'discord'}
            >
              <FieldRow
                id="dc-token" label={t('messengers.fields.botToken')}
                value={draft.discord.discord?.botToken ?? ''}
                type="password"
                onChange={(v) => patchSlot('discord', { discord: { ...draft.discord.discord, botToken: v } })}
              />
              <FieldRow
                id="dc-channel" label={t('messengers.fields.channelId')}
                value={draft.discord.discord?.channelId ?? ''}
                onChange={(v) => patchSlot('discord', { discord: { ...draft.discord.discord, channelId: v } })}
              />
            </PlatformCard>
          ) : null}
        </div>
      )}

      <WechatQrDialog
        open={qrOpen}
        onOpenChange={setQrOpen}
        onConfirmed={() => {
          void cfgQuery.refetch()
          setSynced(false)
          setNeedsApply(true)
        }}
      />
    </div>
  )
}

interface ApplyChangesCardProps {
  serviceMode: string | undefined
  isLoading: boolean
  isPending: boolean
  onApply: () => void
}

function ApplyChangesCard({
  serviceMode,
  isLoading,
  isPending,
  onApply,
}: ApplyChangesCardProps): JSX.Element {
  const { t } = useTranslation('settings')
  const isRunning = serviceMode != null && serviceMode !== 'none'
  return (
    <section className="rounded-md border border-warning/40 bg-warning-bg p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface text-warning">
          {isRunning ? <RotateCcw className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{t('messengers.apply.title')}</h2>
            <Badge variant="warning">{t('messengers.apply.badge')}</Badge>
          </div>
          <p className="mt-1 text-sm text-text-dim">
            {isRunning ? t('messengers.apply.restartDetail') : t('messengers.apply.startDetail')}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={isLoading || isPending}
          onClick={onApply}
        >
          {isPending
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : isRunning
              ? <RotateCcw className="h-4 w-4" />
              : <Play className="h-4 w-4" />}
          <span>
            {isPending
              ? isRunning
                ? t('messengers.apply.restarting')
                : t('messengers.apply.starting')
              : isRunning
                ? t('messengers.apply.restart')
                : t('messengers.apply.start')}
          </span>
        </Button>
      </div>
    </section>
  )
}

interface MessengerQuickStartCardProps {
  cfg: AppConfig
  isBlocked: (slot: Slot) => boolean
  onScanWechat: () => void
  onPickPlatform: (slot: Slot) => void
}

function MessengerQuickStartCard({
  cfg,
  isBlocked,
  onScanWechat,
  onPickPlatform,
}: MessengerQuickStartCardProps): JSX.Element {
  const { t } = useTranslation('settings')
  const connected = cfg.messengers ?? []
  const hasConnected = connected.length > 0
  const showGlobalIm = cfg.features?.globalIm === true
  const options: Array<{
    slot: Slot
    label: string
    title: string
    detail: string
    kind: 'qr' | 'config'
  }> = []
  if (!isBlocked('wechat-ilink')) {
    options.push({
      slot: 'wechat-ilink',
      label: t('messengers.platform.wechat'),
      title: t('messengers.quick.option.wechat.title'),
      detail: t('messengers.quick.option.wechat.detail'),
      kind: 'qr',
    })
  }
  if (!isBlocked('feishu')) {
    options.push({
      slot: 'feishu',
      label: t('messengers.platform.feishu'),
      title: t('messengers.quick.option.feishu.title'),
      detail: t('messengers.quick.option.feishu.detail'),
      kind: 'config',
    })
  }
  if (!isBlocked('dingtalk')) {
    options.push({
      slot: 'dingtalk',
      label: t('messengers.platform.dingtalk'),
      title: t('messengers.quick.option.dingtalk.title'),
      detail: t('messengers.quick.option.dingtalk.detail'),
      kind: 'config',
    })
  }
  if (showGlobalIm && !isBlocked('telegram')) {
    options.push({
      slot: 'telegram',
      label: t('messengers.platform.telegram'),
      title: t('messengers.quick.option.telegram.title'),
      detail: t('messengers.quick.option.telegram.detail'),
      kind: 'config',
    })
  }
  if (showGlobalIm && !isBlocked('discord')) {
    options.push({
      slot: 'discord',
      label: t('messengers.platform.discord'),
      title: t('messengers.quick.option.discord.title'),
      detail: t('messengers.quick.option.discord.detail'),
      kind: 'config',
    })
  }

  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <span className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
          hasConnected ? 'bg-success-bg text-success' : 'bg-accent-bg text-accent',
        )}>
          {hasConnected ? <CheckCircle2 className="h-5 w-5" /> : <Plug className="h-5 w-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">
              {hasConnected ? t('messengers.quick.connectedTitle') : t('messengers.quick.title')}
            </h2>
            <Badge variant={hasConnected ? 'success' : 'info'}>
              {hasConnected ? t('messengers.quick.connectedBadge') : t('messengers.quick.nextBadge')}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-text-dim">
            {hasConnected
              ? t('messengers.quick.connectedDetail', {
                  platforms: connected.map((p) => platformLabel(p, t)).join(', '),
                })
              : t('messengers.quick.subtitle')}
          </p>

          {hasConnected ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link to="/?welcome=1">
                  <MessageSquare className="h-4 w-4" />
                  <span>{t('messengers.quick.webChat')}</span>
                </Link>
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  const first = options.find((option) => !connected.includes(option.slot)) ?? options[0]
                  if (!first) return
                  if (first.kind === 'qr') onScanWechat()
                  else onPickPlatform(first.slot)
                }}
              >
                <Plug className="h-4 w-4" />
                <span>{t('messengers.quick.addAnother')}</span>
              </Button>
            </div>
          ) : (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {options.map((option) => (
                <div key={option.slot} className="rounded-md border border-border bg-surface-2 p-3">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 text-text-dim">
                      {option.kind === 'qr' ? <QrCode className="h-4 w-4" /> : <Plug className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium">{option.title}</h3>
                      <p className="mt-1 text-xs text-text-dim">{option.detail}</p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant={option.kind === 'qr' ? 'default' : 'secondary'}
                    size="sm"
                    className="mt-3"
                    onClick={() => {
                      if (option.kind === 'qr') onScanWechat()
                      else onPickPlatform(option.slot)
                    }}
                  >
                    <span>
                      {option.kind === 'qr'
                        ? t('messengers.quick.scanWechat')
                        : t('messengers.quick.configurePlatform', { platform: option.label })}
                    </span>
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

interface PlatformCardProps {
  slot: Slot
  label: string
  hint: string
  enabled: boolean
  onToggle: (v: boolean) => void
  children?: React.ReactNode
  focused?: boolean
}

function PlatformCard({
  slot,
  label,
  hint,
  enabled,
  onToggle,
  children,
  focused = false,
}: PlatformCardProps): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <div
      id={`messenger-${slot}`}
      className={cn(
        'scroll-mt-20 rounded-md border border-border bg-surface p-4',
        focused && 'border-accent ring-2 ring-accent/30',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-text">{label}</span>
            <Badge variant={enabled ? 'success' : 'outline'}>
              {enabled ? t('messengers.enabled') : t('messengers.disabled')}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-text-dim">{hint}</p>
        </div>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
            className="h-4 w-4 accent-accent cursor-pointer"
          />
        </label>
      </div>
      {enabled && children && (
        <div className="mt-3 flex flex-col gap-2">
          {children}
        </div>
      )}
    </div>
  )
}

function platformLabel(id: string, t: ReturnType<typeof useTranslation>['t']): string {
  const labels: Record<string, string> = {
    'wechat-ilink': t('messengers.platform.wechat'),
    telegram:       t('messengers.platform.telegram'),
    feishu:         t('messengers.platform.feishu'),
    dingtalk:       t('messengers.platform.dingtalk'),
    discord:        t('messengers.platform.discord'),
  }
  return labels[id] ?? id
}

interface FieldRowProps {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  type?: 'text' | 'password'
}

function FieldRow({ id, label, value, onChange, type = 'text' }: FieldRowProps): JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-[180px_1fr] sm:items-center sm:gap-2">
      <Label htmlFor={id} className="text-xs text-text-dim">{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        className="font-mono text-xs"
      />
    </div>
  )
}

// v1.2.37 (batch 1) — dropdown sibling of FieldRow for enum settings.
interface SelectRowProps<T extends string> {
  id: string
  label: string
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string }>
}
function SelectRow<T extends string>({ id, label, value, onChange, options }: SelectRowProps<T>): JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-[180px_1fr] sm:items-center sm:gap-2">
      <Label htmlFor={id} className="text-xs text-text-dim">{label}</Label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-text"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}

interface WechatQrDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirmed: () => void
}

function WechatQrDialog({ open, onOpenChange, onConfirmed }: WechatQrDialogProps): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const start = useStartWechatQr()
  const [token, setToken] = useState<string | null>(null)
  const [qrImage, setQrImage] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  // Kick off the start mutation each time the dialog opens; reset on close.
  useEffect(() => {
    if (!open) {
      setToken(null)
      setQrImage(null)
      setStartError(null)
      return
    }
    let active = true
    start.mutateAsync().then((r) => {
      if (!active) return
      setQrImage(r.qrImage)
      setToken(r.qrToken)
    }).catch((err) => {
      if (!active) return
      setStartError(err instanceof Error ? err.message : String(err))
    })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const statusQuery = useWechatQrStatus(open ? token : null)
  const status = statusQuery.data?.status

  useEffect(() => {
    if (status === 'confirmed') {
      toast.success(t('messengers.qr.confirmed'))
      onConfirmed()
      onOpenChange(false)
    }
    if (status === 'expired') {
      toast.error(t('messengers.qr.expired'))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('messengers.qr.title')}</DialogTitle>
          <DialogDescription>{t('messengers.qr.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          {start.isPending && !qrImage ? (
            <>
              <Loader2 className="h-8 w-8 animate-spin text-text-dim" />
              <p className="text-sm text-text-dim">{t('messengers.qr.starting')}</p>
            </>
          ) : startError ? (
            <p className="text-sm text-danger">{t('messengers.qr.loadFailed')}: {startError}</p>
          ) : qrImage ? (
            <>
              <img
                src={qrImage}
                alt={t('messengers.qr.title')}
                className="rounded-md border border-border"
              />
              {status === 'expired'
                ? <p className="text-xs text-danger">{t('messengers.qr.expired')}</p>
                : <p className="text-xs text-text-dim">{status ? `· ${status} ·` : ''}</p>}
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── v1.2.41 — DingTalk multi-account CRUD editor ───────────────────
// Renders below the main DingTalk card. Owns the in-memory accounts
// dict and bubbles every change up via `onChange` so the page-level
// dirty/save logic notices and lights up the Save button.
//
// Each row shows: id (read-only after creation), name, clientId,
// clientSecret (password mode, masked on echo), dmPolicy / groupPolicy /
// ackReaction selectors, allowFrom / groupAllowFrom CSVs, enabled
// toggle, and a delete button. "Add account" appends a fresh row with
// a generated id the operator can rename inline.

export interface DingTalkAccountDraft {
  name?: string
  clientId?: string
  clientSecret?: string
  dmPolicy?: 'open' | 'pairing' | 'allowlist'
  groupPolicy?: 'open' | 'allowlist' | 'disabled'
  allowFrom?: string[]
  groupAllowFrom?: string[]
  ackReaction?: 'off' | 'emoji' | 'kaomoji'
  enabled?: boolean
}

interface DingTalkAccountsEditorProps {
  accounts: Record<string, DingTalkAccountDraft>
  onChange: (next: Record<string, DingTalkAccountDraft>) => void
}

function DingTalkAccountsEditor({ accounts, onChange }: DingTalkAccountsEditorProps): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const entries = Object.entries(accounts)

  const updateAccount = (id: string, patch: Partial<DingTalkAccountDraft>) => {
    onChange({ ...accounts, [id]: { ...accounts[id], ...patch } })
  }
  const deleteAccount = (id: string) => {
    const next = { ...accounts }
    delete next[id]
    onChange(next)
  }
  const renameAccount = (oldId: string, newId: string) => {
    if (!newId || newId === oldId) return
    if (accounts[newId]) {
      toast.error(t('messengers.dingtalk.accountRenameCollision', { id: newId }))
      return
    }
    const next: Record<string, DingTalkAccountDraft> = {}
    for (const [k, v] of Object.entries(accounts)) {
      next[k === oldId ? newId : k] = v
    }
    onChange(next)
  }
  const addAccount = () => {
    // Find an unused id of shape account-N.
    let n = entries.length + 1
    let candidate = `account-${n}`
    while (accounts[candidate]) { n += 1; candidate = `account-${n}` }
    onChange({ ...accounts, [candidate]: { enabled: true } })
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold text-text-dim">
          {t('messengers.dingtalk.accountsTitle')}
        </div>
        <Button type="button" size="sm" variant="outline" onClick={addAccount}>
          + {t('messengers.dingtalk.addAccount')}
        </Button>
      </div>

      {entries.length === 0 ? (
        <div className="text-xs text-text-dim italic">
          {t('messengers.dingtalk.accountsEmpty')}
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map(([id, acct]) => (
            <div key={id} className="rounded-md border border-border bg-surface-2/45 p-2">
              <div className="mb-2 flex items-center gap-2">
                <Input
                  id={`acct-id-${id}`}
                  defaultValue={id}
                  onBlur={(e) => renameAccount(id, e.target.value.trim())}
                  className="font-mono text-xs w-40"
                  placeholder="account-id"
                />
                <Input
                  id={`acct-name-${id}`}
                  value={acct.name ?? ''}
                  onChange={(e) => updateAccount(id, { name: e.target.value })}
                  className="text-xs flex-1"
                  placeholder={t('messengers.dingtalk.accountName')}
                />
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={acct.enabled !== false}
                    onChange={(e) => updateAccount(id, { enabled: e.target.checked })}
                  />
                  {t('messengers.enabled')}
                </label>
                <Button
                  type="button" size="sm" variant="ghost"
                  onClick={() => deleteAccount(id)}
                  className="text-danger"
                >
                  <X className="size-4" />
                </Button>
              </div>
              <div className="space-y-1">
                <FieldRow
                  id={`acct-cid-${id}`} label={t('messengers.fields.clientId')}
                  value={acct.clientId ?? ''}
                  onChange={(v) => updateAccount(id, { clientId: v })}
                />
                <FieldRow
                  id={`acct-secret-${id}`} label={t('messengers.fields.clientSecret')}
                  value={acct.clientSecret ?? ''}
                  type="password"
                  onChange={(v) => updateAccount(id, { clientSecret: v })}
                />
                <SelectRow<'open' | 'pairing' | 'allowlist'>
                  id={`acct-dm-${id}`} label={t('messengers.dingtalk.dmPolicy')}
                  value={acct.dmPolicy ?? 'open'}
                  onChange={(v) => updateAccount(id, { dmPolicy: v })}
                  options={[
                    { value: 'open',      label: t('messengers.dingtalk.policy.open') },
                    { value: 'pairing',   label: t('messengers.dingtalk.policy.pairing') },
                    { value: 'allowlist', label: t('messengers.dingtalk.policy.allowlist') },
                  ]}
                />
                <SelectRow<'open' | 'allowlist' | 'disabled'>
                  id={`acct-group-${id}`} label={t('messengers.dingtalk.groupPolicy')}
                  value={acct.groupPolicy ?? 'open'}
                  onChange={(v) => updateAccount(id, { groupPolicy: v })}
                  options={[
                    { value: 'open',      label: t('messengers.dingtalk.policy.open') },
                    { value: 'allowlist', label: t('messengers.dingtalk.policy.allowlist') },
                    { value: 'disabled',  label: t('messengers.dingtalk.policy.disabled') },
                  ]}
                />
                <FieldRow
                  id={`acct-allow-${id}`} label={t('messengers.dingtalk.allowFrom')}
                  value={(acct.allowFrom ?? []).join(',')}
                  onChange={(v) => updateAccount(id, {
                    allowFrom: v.split(',').map((s) => s.trim()).filter(Boolean),
                  })}
                />
                <FieldRow
                  id={`acct-gallow-${id}`} label={t('messengers.dingtalk.groupAllowFrom')}
                  value={(acct.groupAllowFrom ?? []).join(',')}
                  onChange={(v) => updateAccount(id, {
                    groupAllowFrom: v.split(',').map((s) => s.trim()).filter(Boolean),
                  })}
                />
                <SelectRow<'off' | 'emoji' | 'kaomoji'>
                  id={`acct-ack-${id}`} label={t('messengers.dingtalk.ackReaction')}
                  value={acct.ackReaction ?? 'off'}
                  onChange={(v) => updateAccount(id, { ackReaction: v })}
                  options={[
                    { value: 'off',     label: t('messengers.dingtalk.ack.off') },
                    { value: 'emoji',   label: t('messengers.dingtalk.ack.emoji') },
                    { value: 'kaomoji', label: t('messengers.dingtalk.ack.kaomoji') },
                  ]}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-1 text-xs text-text-dim">{t('messengers.dingtalk.accountsHint')}</div>
    </div>
  )
}
