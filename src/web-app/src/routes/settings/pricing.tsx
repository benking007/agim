/**
 * /settings/pricing — admin token-price table.
 *
 * Factory presets (DeepSeek official off-peak, typical CLI list prices)
 * ship in the binary. This page lets an operator override USD / 1M
 * input+output rates. Clearing an override restores the preset.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Plus, RotateCcw, Save } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, type ModelPriceRowDto } from '@/lib/api/endpoints'
import { describeError } from '@/lib/api/errors'

const PRICE_KEY = ['settings', 'model-prices'] as const

function per1m(per1k: number): string {
  const n = per1k * 1000
  if (!Number.isFinite(n)) return ''
  return String(Number(n.toFixed(6)))
}

function parsePer1m(raw: string): number | null {
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || n < 0) return null
  return n / 1000
}

export default function SettingsPricingRoute(): JSX.Element {
  const { t } = useTranslation('settings')
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: PRICE_KEY,
    queryFn: () => api.getModelPrices(),
  })
  const save = useMutation({
    mutationFn: (overrides: Record<string, { costPer1kIn: number; costPer1kOut: number } | null>) =>
      api.putModelPrices({ overrides }),
    onSuccess: (body) => {
      qc.setQueryData(PRICE_KEY, body)
      toast.success(t('pricing.saved'))
    },
    onError: (err) => toast.error(describeError(err, t).message),
  })

  const rows = query.data?.rows ?? []
  const llmRows = rows.filter((r) => r.kind === 'llm')
  const cliRows = rows.filter((r) => r.kind === 'cli')

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">{t('pricing.title')}</h1>
        <p className="text-sm text-text-muted">{t('pricing.hint')}</p>
      </header>
      {query.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('pricing.loading')}
        </div>
      ) : (
        <>
          <PriceTable
            title={t('pricing.llmTitle')}
            hint={t('pricing.llmHint')}
            rows={llmRows}
            busy={save.isPending}
            onSave={(key, inn, out) => save.mutate({ [key]: { costPer1kIn: inn, costPer1kOut: out } })}
            onReset={(key) => save.mutate({ [key]: null })}
          />
          <AddLlmRow
            busy={save.isPending}
            existing={new Set(llmRows.map((r) => r.id))}
            onAdd={(id, inn, out) => save.mutate({ [`llm:${id}`]: { costPer1kIn: inn, costPer1kOut: out } })}
          />
          <PriceTable
            title={t('pricing.cliTitle')}
            hint={t('pricing.cliHint')}
            rows={cliRows}
            busy={save.isPending}
            onSave={(key, inn, out) => save.mutate({ [key]: { costPer1kIn: inn, costPer1kOut: out } })}
            onReset={(key) => save.mutate({ [key]: null })}
          />
        </>
      )}
    </div>
  )
}

function PriceTable(props: {
  title: string
  hint: string
  rows: ModelPriceRowDto[]
  busy: boolean
  onSave: (key: string, inn: number, out: number) => void
  onReset: (key: string) => void
}): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <div>
        <h2 className="font-medium">{props.title}</h2>
        <p className="text-sm text-text-muted">{props.hint}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="text-xs text-text-muted">
            <tr>
              <th className="pb-2 pr-3 font-medium">{t('pricing.colId')}</th>
              <th className="pb-2 pr-3 font-medium">{t('pricing.colSource')}</th>
              <th className="pb-2 pr-3 font-medium">{t('pricing.colIn')}</th>
              <th className="pb-2 pr-3 font-medium">{t('pricing.colOut')}</th>
              <th className="pb-2 font-medium">{t('pricing.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <PriceRow
                key={`${row.key}:${row.source}:${row.current.costPer1kIn}:${row.current.costPer1kOut}`}
                row={row}
                busy={props.busy}
                onSave={props.onSave}
                onReset={props.onReset}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function PriceRow(props: {
  row: ModelPriceRowDto
  busy: boolean
  onSave: (key: string, inn: number, out: number) => void
  onReset: (key: string) => void
}): JSX.Element {
  const { t } = useTranslation('settings')
  const { row } = props
  const [inn, setInn] = useState(() => per1m(row.current.costPer1kIn))
  const [out, setOut] = useState(() => per1m(row.current.costPer1kOut))
  const currentIn = per1m(row.current.costPer1kIn)
  const currentOut = per1m(row.current.costPer1kOut)
  const dirty = inn !== currentIn || out !== currentOut
  const sourceLabel = useMemo(() => {
    if (row.source === 'override') return t('pricing.sourceOverride')
    if (row.source === 'fallback') return t('pricing.sourceFallback')
    if (row.source === 'unset') return t('pricing.sourceUnset')
    return t('pricing.sourcePreset')
  }, [row.source, t])

  return (
    <tr className="border-t border-border/60" data-testid={`price-row-${row.key}`}>
      <td className="py-2 pr-3 font-mono text-xs">{row.id}</td>
      <td className="py-2 pr-3">
        <Badge variant={row.source === 'override' ? 'warning' : 'secondary'} className="normal-case tracking-normal">
          {sourceLabel}
        </Badge>
      </td>
      <td className="py-2 pr-3">
        <Input
          value={inn}
          onChange={(e) => setInn(e.target.value)}
          className="h-8 w-28 font-mono text-xs"
          inputMode="decimal"
          aria-label={`${row.id} input`}
        />
      </td>
      <td className="py-2 pr-3">
        <Input
          value={out}
          onChange={(e) => setOut(e.target.value)}
          className="h-8 w-28 font-mono text-xs"
          inputMode="decimal"
          aria-label={`${row.id} output`}
        />
      </td>
      <td className="py-2">
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            size="sm"
            disabled={props.busy || !dirty}
            onClick={() => {
              const innN = parsePer1m(inn)
              const outN = parsePer1m(out)
              if (innN == null || outN == null || (innN === 0 && outN === 0)) {
                toast.error(t('pricing.invalid'))
                return
              }
              props.onSave(row.key, innN, outN)
            }}
          >
            <Save className="h-3.5 w-3.5" />
            {t('pricing.saveRow')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.busy || row.source !== 'override'}
            onClick={() => props.onReset(row.key)}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('pricing.reset')}
          </Button>
        </div>
      </td>
    </tr>
  )
}

function AddLlmRow(props: {
  busy: boolean
  existing: Set<string>
  onAdd: (id: string, inn: number, out: number) => void
}): JSX.Element {
  const { t } = useTranslation('settings')
  const [id, setId] = useState('')
  const [inn, setInn] = useState('0.22')
  const [out, setOut] = useState('0.66')
  return (
    <section className="space-y-3 rounded-xl border border-dashed border-border p-4">
      <h2 className="font-medium">{t('pricing.addTitle')}</h2>
      <p className="text-sm text-text-muted">{t('pricing.addHint')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1 text-xs">
          <span className="text-text-muted">{t('pricing.colId')}</span>
          <Input
            value={id}
            onChange={(e) => setId(e.target.value)}
            className="h-8 w-56 font-mono text-xs"
            placeholder="my-custom-model"
            aria-label={t('pricing.colId')}
          />
        </div>
        <div className="space-y-1 text-xs">
          <span className="text-text-muted">{t('pricing.colIn')}</span>
          <Input
            value={inn}
            onChange={(e) => setInn(e.target.value)}
            className="h-8 w-28 font-mono text-xs"
            aria-label={t('pricing.colIn')}
          />
        </div>
        <div className="space-y-1 text-xs">
          <span className="text-text-muted">{t('pricing.colOut')}</span>
          <Input
            value={out}
            onChange={(e) => setOut(e.target.value)}
            className="h-8 w-28 font-mono text-xs"
            aria-label={t('pricing.colOut')}
          />
        </div>
        <Button
          type="button"
          size="sm"
          disabled={props.busy}
          onClick={() => {
            const name = id.trim()
            if (!name) return
            if (props.existing.has(name)) {
              toast.error(t('pricing.addExists'))
              return
            }
            const innN = parsePer1m(inn)
            const outN = parsePer1m(out)
            if (innN == null || outN == null || (innN === 0 && outN === 0)) {
              toast.error(t('pricing.invalid'))
              return
            }
            props.onAdd(name, innN, outN)
            setId('')
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('pricing.add')}
        </Button>
      </div>
    </section>
  )
}
