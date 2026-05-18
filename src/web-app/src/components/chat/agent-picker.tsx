/**
 * AgentPicker — dropdown to switch the active agent in the chat
 * surface. Driven by the `agents` list the WS server pushes via
 * `init` / `agents` messages.
 */

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
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-36 text-xs">
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
