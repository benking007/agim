/**
 * AgentPicker — dropdown to switch the active agent in the chat
 * surface. Driven by the `agents` list the WS server pushes via
 * `init` / `agents` messages.
 *
 * Switching confirms via an inline banner (not window.confirm) so the
 * flow stays inside the themed SPA chrome — closer to an iOS action sheet.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { agentDisplayName } from '@/lib/agent-label'

export interface AgentPickerProps {
  agents: string[]
  value: string
  onChange: (agent: string) => void
}

export function AgentPicker({ agents, value, onChange }: AgentPickerProps): JSX.Element {
  const { t } = useTranslation()
  const [pending, setPending] = useState<string | null>(null)

  function handleChange(next: string): void {
    if (!next || next === value) return
    setPending(next)
  }

  function confirmSwitch(): void {
    if (!pending) return
    onChange(pending)
    setPending(null)
  }

  return (
    <div className="flex flex-col gap-1">
      <Select value={value || undefined} onValueChange={handleChange}>
        <SelectTrigger className="h-7 w-28 whitespace-nowrap text-xs sm:w-36 [&>span]:whitespace-nowrap [&>svg]:shrink-0">
          <SelectValue placeholder={agentDisplayName(agents[0] ?? '—')} />
        </SelectTrigger>
        <SelectContent>
          {agents.map((a) => (
            <SelectItem key={a} value={a}>
              {agentDisplayName(a)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {pending && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-xs">
          <span className="text-text-dim">
            {t('chat.switchAgentConfirm', {
              agent: agentDisplayName(pending),
              defaultValue: 'Switch to {{agent}}?',
            })}
          </span>
          <Button size="sm" className="h-8" onClick={confirmSwitch}>
            {t('chat.switchAgentOk', { defaultValue: 'Switch' })}
          </Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => setPending(null)}>
            {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
          </Button>
        </div>
      )}
    </div>
  )
}
