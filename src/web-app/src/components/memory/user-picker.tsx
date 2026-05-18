/**
 * MemoryUserPicker — Select for the user_key the /memory route
 * targets. Sources the option list from useMemoryUsers, shows the
 * per-user fact_count + persona-presence as inline metadata so the
 * operator can tell which users are interesting at a glance.
 *
 * Loading: while users fetch, the trigger shows the placeholder so
 * the page doesn't jump.
 *
 * Empty bank: no users → the dropdown is disabled with a tooltip
 * explaining there's nothing to pick. Avoids a confusing "no items"
 * dropdown state.
 */

import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useMemoryUsers } from '@/hooks/use-memory'

export interface MemoryUserPickerProps {
  value: string
  onChange: (next: string) => void
  className?: string
}

export function MemoryUserPicker({ value, onChange, className }: MemoryUserPickerProps): JSX.Element {
  const { t } = useTranslation('memory')
  const { data, isLoading } = useMemoryUsers()
  const users = data?.users ?? []

  return (
    <Select
      value={value || '__placeholder__'}
      onValueChange={(v) => onChange(v === '__placeholder__' ? '' : v)}
      disabled={isLoading || users.length === 0}
    >
      <SelectTrigger className={className ?? 'h-9 w-72 max-w-full'}>
        <SelectValue placeholder={t('userPicker.placeholder')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__placeholder__" disabled>
          {t('userPicker.placeholder')}
        </SelectItem>
        {users.map((u) => (
          <SelectItem key={u.user_key} value={u.user_key}>
            <span className="flex items-center gap-2">
              <span className="font-mono text-xs">{u.user_key}</span>
              <span className="text-text-dim text-xs">
                {t('userPicker.factsLabel', { count: u.fact_count })}
              </span>
              {u.has_persona && (
                <span className="text-accent text-xs">·{t('userPicker.personaTag')}·</span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
