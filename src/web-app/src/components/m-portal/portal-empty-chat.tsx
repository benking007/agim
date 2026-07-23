import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { displayAgentName } from './agent-visuals'

const STARTER_PROMPTS = [
  { title: 'Brand Palettes', hint: 'Aesthetic color schemes for dark and light views.', prompt: 'Recommend 3 premium mock palettes for our brand layout.' },
  { title: 'UI Architecture', hint: 'Configure viewport parameters across layout frameworks.', prompt: 'Structure a high performance responsive viewport architecture.' },
] as const

interface PortalEmptyChatProps {
  dark: boolean
  agentId: string
  visual: { color: string; tagline: string }
  AgentIcon: LucideIcon
  onFillPrompt: (text: string) => void
}

export function PortalEmptyChat({
  dark,
  agentId,
  visual,
  AgentIcon,
  onFillPrompt,
}: PortalEmptyChatProps): JSX.Element {
  return (
    <div className="flex animate-in fade-in flex-col items-center space-y-4 py-12 text-center duration-500">
      <div className={cn(
        'flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-tr text-white shadow-lg ring-4',
        dark ? 'ring-white/5' : 'ring-black/5',
        visual.color,
      )}>
        <AgentIcon className="h-7 w-7" />
      </div>
      <div>
        <h2 className={cn('text-lg font-bold tracking-tight', dark ? 'text-zinc-100' : 'text-zinc-800')}>
          {displayAgentName(agentId)}
        </h2>
        <p className="mx-auto mt-1 max-w-[260px] text-xs leading-normal text-zinc-400">{visual.tagline}</p>
      </div>
      <div className="mt-4 grid w-full max-w-sm grid-cols-2 gap-2 pt-2 text-left">
        {STARTER_PROMPTS.map((card) => (
          <button
            key={card.title}
            type="button"
            onClick={() => onFillPrompt(card.prompt)}
            className={cn(
              'cursor-pointer rounded-2xl border p-3.5 text-left transition-all',
              dark
                ? 'border-zinc-800 bg-zinc-900/70 hover:border-zinc-700 hover:bg-zinc-900'
                : 'border-zinc-200 bg-white shadow-sm hover:border-zinc-300 hover:bg-white',
            )}
          >
            <p className={cn('text-xs font-bold', dark ? 'text-zinc-300' : 'text-zinc-800')}>{card.title}</p>
            <p className="mt-1 line-clamp-2 text-[10px] text-zinc-400">{card.hint}</p>
          </button>
        ))}
      </div>
    </div>
  )
}
