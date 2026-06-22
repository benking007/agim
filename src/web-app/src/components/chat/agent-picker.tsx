/**
 * AgentPicker — dropdown to switch the active agent in the chat
 * surface. Driven by the `agents` list the WS server pushes via
 * `init` / `agents` messages.
 */

import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export interface AgentPickerProps {
  agents: string[]
  value: string
  onChange: (agent: string) => void
}

export function AgentPicker({ agents, value, onChange }: AgentPickerProps): JSX.Element {
  const { t } = useTranslation()
  // Confirm before switching so an accidental tap doesn't move the
  // conversation to a different agent. Picking the current agent is a no-op.
  function handleChange(next: string): void {
    if (!next || next === value) return
    const ok = window.confirm(
      t('chat.switchAgentConfirm', { agent: next }),
    )
    if (ok) onChange(next)
    // On cancel we do nothing — the Select is controlled by `value`, so it
    // re-renders back to the current agent automatically.
  }
  return (
    <Select value={value || undefined} onValueChange={handleChange}>
      <SelectTrigger className="h-7 w-28 sm:w-36 text-xs">
        <SelectValue placeholder={agents[0] ?? '—'} />
      </SelectTrigger>
      <SelectContent>
        {agents.map((a) => (
          <SelectItem key={a} value={a}>
            {a}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
