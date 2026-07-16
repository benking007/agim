/**
 * Visual metadata for agents in the mobile Agent Portal.
 * Maps stable agent ids → gradient + lucide icon (design-system look).
 */

import type { LucideIcon } from 'lucide-react'
import {
  BookOpen, Code, Cpu, Dumbbell, Palette, Sparkles, Bot, Terminal, Brain,
} from 'lucide-react'

export interface AgentVisual {
  color: string
  icon: LucideIcon
  category: string
  tagline: string
}

const PALETTE: Array<{ color: string; icon: LucideIcon; category: string }> = [
  { color: 'from-emerald-500 to-teal-600', icon: Sparkles, category: 'Featured' },
  { color: 'from-purple-500 to-indigo-600', icon: Cpu, category: 'Featured' },
  { color: 'from-blue-500 to-cyan-600', icon: Code, category: 'Programming' },
  { color: 'from-amber-500 to-orange-600', icon: BookOpen, category: 'Writing' },
  { color: 'from-pink-500 to-rose-600', icon: Palette, category: 'Design' },
  { color: 'from-red-500 to-orange-500', icon: Dumbbell, category: 'Lifestyle' },
  { color: 'from-sky-500 to-blue-600', icon: Brain, category: 'Featured' },
  { color: 'from-violet-500 to-fuchsia-600', icon: Terminal, category: 'Programming' },
  { color: 'from-teal-500 to-emerald-600', icon: Bot, category: 'Featured' },
]

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

const TAGLINES: Record<string, string> = {
  agim: 'Agim native agent — tools, memory, and multi-step work.',
  'claude-code': 'Coding agent optimized for repository edits and shell.',
  cursor: 'IDE-oriented agent for project-scoped tasks.',
}

export function agentVisual(agentId: string): AgentVisual {
  const base = PALETTE[hash(agentId) % PALETTE.length] ?? PALETTE[0]
  if (!base) {
    return {
      color: 'from-emerald-500 to-teal-600',
      icon: Sparkles,
      category: 'Featured',
      tagline: TAGLINES[agentId] ?? `Agent “${agentId}” — ready for your next request.`,
    }
  }
  return {
    color: base.color,
    icon: base.icon,
    category: base.category,
    tagline: TAGLINES[agentId] ?? `Agent “${agentId}” — ready for your next request.`,
  }
}

export function displayAgentName(agentId: string): string {
  return agentId
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
}
