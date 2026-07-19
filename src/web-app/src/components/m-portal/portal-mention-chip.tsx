/**
 * Blue mention chips for workspace / file / skill references (Cursor-style).
 */

import { Folder, File as FileIcon, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

export type MentionKind = 'workspace' | 'file' | 'dir' | 'skill'

export function MentionChip({
  kind,
  label,
  dark,
  onClick,
  className,
}: {
  kind: MentionKind
  label: string
  dark?: boolean
  onClick?: () => void
  className?: string
}): JSX.Element {
  const Icon = kind === 'skill'
    ? Sparkles
    : (kind === 'file' ? FileIcon : Folder)

  const inner = (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </>
  )

  const cls = cn(
    'inline-flex max-w-full items-center gap-1 align-middle text-[13px] font-medium text-sky-500',
    'underline-offset-2 hover:underline',
    dark ? 'text-sky-400' : 'text-sky-600',
    className,
  )

  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick}>
        {inner}
      </button>
    )
  }
  return <span className={cls}>{inner}</span>
}

export function mentionLabel(
  kind: MentionKind,
  pathOrName?: string,
): string {
  if (kind === 'workspace') return 'workspace'
  if (kind === 'skill') return pathOrName || 'skill'
  if (!pathOrName) return kind === 'dir' ? 'folder' : 'file'
  const parts = pathOrName.split(/[/\\]/)
  return parts[parts.length - 1] || pathOrName
}
