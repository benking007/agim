/**
 * /settings/mobile — admin generates a QR an operator scans on a
 * phone to land directly inside /m/chat (v1.2.129).
 *
 * Flow:
 *   1. Click "Generate QR" → POST /api/mobile/qr → fresh role=user
 *      token + QR PNG (data URL).
 *   2. Render QR, the embedded URL, and the token id.
 *   3. Phone scans → /m/login auto-submits the token cookie → /m/chat.
 *
 * Revoke: the link points the admin at /settings/security/tokens
 * where every token can be killed (the same UI works for the QR
 * tokens because they're stored in the same table with a
 * mobile-via-qr-* label).
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Copy, Eye, EyeOff, Loader2, QrCode, RefreshCcw, ShieldAlert, Smartphone,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api/endpoints'
import type { MobileQRResponse } from '@/types/api'

export default function SettingsMobileRoute(): JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const [result, setResult] = useState<MobileQRResponse | null>(null)
  const [showUrl, setShowUrl] = useState(false)
  const [host, setHost] = useState('')

  const generate = useMutation<MobileQRResponse, Error>({
    mutationFn: () =>
      api.generateMobileQR(host.trim() ? { host: host.trim() } : undefined),
    onSuccess: (r) => {
      setResult(r)
      setShowUrl(false)
      toast.success(t('mobile.generatedToast'))
    },
    onError: (e) => toast.error(e.message),
  })

  async function copyUrl(): Promise<void> {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.loginUrl)
      toast.success(t('mobile.copied'))
    } catch {
      toast.error(t('mobile.copyFailed'))
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{t('mobile.title')}</h1>
      </header>
      <p className="text-sm text-text-dim">{t('mobile.subtitle')}</p>

      <section className="rounded-md border border-border bg-surface p-4">
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-text-dim" />
          <h2 className="text-sm font-semibold">{t('mobile.generateCard')}</h2>
        </div>
        <p className="mt-1 text-xs text-text-dim">{t('mobile.generateDesc')}</p>

        <div className="mt-4 flex flex-col gap-2">
          <Label className="text-xs font-medium">{t('mobile.hostLabel')}</Label>
          <Input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder={t('mobile.hostPlaceholder', { defaultValue: 'auto-detect (leave blank)' })}
            className="font-mono text-xs"
          />
          <p className="text-[11px] text-text-dim">{t('mobile.hostHint')}</p>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <Button
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            size="sm"
          >
            {generate.isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : result ? <RefreshCcw className="h-4 w-4" /> : <QrCode className="h-4 w-4" />}
            <span className="ml-1">
              {result ? t('mobile.regenerate') : t('mobile.generate')}
            </span>
          </Button>
          {generate.isPending && (
            <Badge variant="info">{t('mobile.generating')}</Badge>
          )}
        </div>
      </section>

      {result && (
        <section className="rounded-md border border-border bg-surface p-4">
          <div className="flex items-center gap-2">
            <QrCode className="h-4 w-4 text-text-dim" />
            <h2 className="text-sm font-semibold">{t('mobile.scanCard')}</h2>
            <Badge variant="success" className="ml-auto">
              {t('mobile.tokenLabel')}: <span className="ml-1 font-mono">{result.label}</span>
            </Badge>
          </div>
          <p className="mt-1 text-xs text-text-dim">{t('mobile.scanDesc')}</p>

          <div className="mt-4 flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            <div className="shrink-0 rounded-md border border-border bg-white p-2">
              <img
                src={result.qrDataUrl}
                alt={t('mobile.qrAlt', { defaultValue: 'QR code for mobile chat' })}
                width={280}
                height={280}
                className="block h-[280px] w-[280px]"
              />
            </div>
            <div className="flex w-full flex-col gap-3">
              <div>
                <Label className="text-xs font-medium">{t('mobile.urlLabel')}</Label>
                <div className="mt-1 flex items-center gap-2">
                  <Input
                    type={showUrl ? 'text' : 'password'}
                    readOnly
                    value={result.loginUrl}
                    className="font-mono text-[11px]"
                  />
                  <Button
                    size="sm" variant="ghost"
                    onClick={() => setShowUrl((v) => !v)}
                    aria-label={showUrl
                      ? t('mobile.hideUrl', { defaultValue: 'Hide URL' })
                      : t('mobile.showUrl', { defaultValue: 'Show URL' })}
                  >
                    {showUrl ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                  <Button
                    size="sm" variant="ghost"
                    onClick={() => void copyUrl()}
                    aria-label={t('mobile.copyUrl', { defaultValue: 'Copy URL' })}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <p className="mt-1 text-[11px] text-text-dim">{t('mobile.urlHint')}</p>
              </div>
              <div>
                <Label className="text-xs font-medium">{t('mobile.tokenIdLabel')}</Label>
                <div className="mt-1 font-mono text-xs">{result.tokenId}</div>
                <p className="mt-1 text-[11px] text-text-dim">{t('mobile.tokenIdHint')}</p>
              </div>
            </div>
          </div>

          <div className="mt-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="text-xs">
              <div className="font-medium">{t('mobile.warningTitle')}</div>
              <p className="mt-1 text-text-dim">{t('mobile.warningBody')}</p>
              <a
                href={result.revokeHint}
                className="mt-1 inline-block underline text-accent"
              >
                {t('mobile.revokeLink')}
              </a>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
