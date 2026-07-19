/**
 * Portal composer text field with inline mention chips + `/` `@` triggers.
 *
 * Mentions are stored as markers in `value` (same format as the message
 * stream). Visually they render as Cursor-style blue chips; free text lives
 * in a trailing textarea.
 */

import {
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { cn } from '@/lib/utils'
import { parseUserMediaContent } from '@/lib/parse-user-media'
import { MentionChip, mentionLabel, type MentionKind } from './portal-mention-chip'
import {
  skillMarker,
  workspaceFileMarker,
  workspaceMarker,
} from './portal-slash-commands'

export interface ComposerChip {
  id: string
  kind: MentionKind
  /** Serialized marker embedded in the outgoing message. */
  marker: string
  label: string
  path?: string
}

export function chipsFromValue(value: string): { chips: ComposerChip[]; text: string } {
  const segs = parseUserMediaContent(value)
  const chips: ComposerChip[] = []
  const textParts: string[] = []
  let i = 0
  for (const seg of segs) {
    if (seg.kind === 'text') {
      textParts.push(seg.text)
      continue
    }
    if (seg.kind === 'workspace') {
      chips.push({
        id: `ws-${i++}`,
        kind: 'workspace',
        marker: workspaceMarker(),
        label: mentionLabel('workspace'),
      })
      continue
    }
    if (seg.kind === 'ws-file') {
      const kind: MentionKind = seg.isDir ? 'dir' : 'file'
      chips.push({
        id: `wf-${i++}`,
        kind,
        marker: workspaceFileMarker(seg.path, seg.isDir),
        label: mentionLabel(kind, seg.path),
        path: seg.path,
      })
      continue
    }
    if (seg.kind === 'skill') {
      chips.push({
        id: `sk-${i++}`,
        kind: 'skill',
        marker: skillMarker(seg.name),
        label: mentionLabel('skill', seg.name),
      })
      continue
    }
    // media markers stay in text so PortalUserContent can still render them
    // if the user pastes them; they are uncommon in the composer.
    if (seg.kind === 'image') {
      textParts.push(`[图片附件：${seg.path}]`)
    } else if (seg.kind === 'file') {
      textParts.push(
        seg.size
          ? `[文件附件：${seg.path} (${seg.name}, ${seg.size})]`
          : `[文件附件：${seg.path}]`,
      )
    }
  }
  return {
    chips,
    text: textParts.join('').replace(/^\n+/, ''),
  }
}

export function serializeComposer(chips: ComposerChip[], text: string): string {
  const head = chips.map((c) => c.marker).join('')
  const body = text
  if (!head) return body
  if (!body) return head
  // Keep a separating space/newline so markers don't glue to prose.
  const sep = body.startsWith('\n') || body.startsWith(' ') ? '' : ' '
  return `${head}${sep}${body}`
}

let chipSeq = 0
export function makeChip(partial: Omit<ComposerChip, 'id'>): ComposerChip {
  chipSeq += 1
  return { ...partial, id: `chip-${chipSeq}-${Date.now()}` }
}

interface PortalComposerInputProps {
  dark: boolean
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  placeholder?: string
  inputRef?: RefObject<HTMLTextAreaElement | null>
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  onCaretChange?: (caret: number, text: string) => void
  className?: string
}

export function PortalComposerInput({
  dark,
  value,
  onChange,
  disabled,
  placeholder,
  inputRef: externalRef,
  onKeyDown,
  onCaretChange,
  className,
}: PortalComposerInputProps): JSX.Element {
  const localRef = useRef<HTMLTextAreaElement>(null)
  const inputRef = externalRef ?? localRef
  const { chips, text } = useMemo(() => chipsFromValue(value), [value])

  useEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    // Keep single-line height tight (~28px) to match h-7 side buttons.
    const minH = 28
    const maxH = 28 * 6
    // Read `text` so height tracks typed content (auto-grow).
    const scroll = text.length >= 0 ? ta.scrollHeight : minH
    ta.style.height = `${Math.max(minH, Math.min(scroll, maxH))}px`
  }, [text, inputRef])

  function emit(nextChips: ComposerChip[], nextText: string): void {
    onChange(serializeComposer(nextChips, nextText))
  }

  function removeChip(id: string): void {
    emit(chips.filter((c) => c.id !== id), text)
  }

  function onTextChange(nextText: string): void {
    emit(chips, nextText)
    const ta = inputRef.current
    onCaretChange?.(ta?.selectionStart ?? nextText.length, nextText)
  }

  function reportCaret(): void {
    const ta = inputRef.current
    if (!ta) return
    onCaretChange?.(ta.selectionStart, text)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Backspace at caret 0 deletes the trailing mention chip (Cursor-style).
    if (e.key === 'Backspace' && chips.length > 0) {
      const ta = inputRef.current
      const atStart = (ta?.selectionStart ?? 0) === 0 && (ta?.selectionEnd ?? 0) === 0
      if (atStart) {
        e.preventDefault()
        const nextChips = chips.slice(0, -1)
        emit(nextChips, text)
        requestAnimationFrame(() => {
          const el = inputRef.current
          if (!el) return
          el.focus()
          el.setSelectionRange(0, 0)
          onCaretChange?.(0, text)
        })
        return
      }
    }
    onKeyDown?.(e)
  }

  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 flex-wrap items-center gap-1 px-1.5',
        className,
      )}
    >
      {chips.map((chip) => (
        <MentionChip
          key={chip.id}
          kind={chip.kind}
          label={chip.label}
          dark={dark}
          className={cn(
            'rounded-md px-1 py-0.5',
            dark ? 'bg-sky-500/10' : 'bg-sky-500/10',
          )}
          onClick={() => {
            if (disabled) return
            removeChip(chip.id)
          }}
        />
      ))}
      <textarea
        ref={inputRef as RefObject<HTMLTextAreaElement>}
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={chips.length === 0 ? placeholder : undefined}
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onSelect={reportCaret}
        onClick={reportCaret}
        onKeyUp={(e) => {
          // Arrow keys only move the popup highlight — skip caret sync
          // so we don't fight selection state on keyup.
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape') {
            return
          }
          reportCaret()
        }}
        // Prevent form submit on Enter — newline only; send via button.
        onKeyPress={(e) => {
          if (e.key === 'Enter') e.stopPropagation()
        }}
        className={cn(
          'min-h-7 min-w-[6rem] flex-1 resize-none bg-transparent py-0 text-md leading-7 focus:outline-none disabled:opacity-60',
          dark ? 'text-zinc-200 placeholder:text-zinc-500' : 'text-zinc-800 placeholder:text-zinc-400',
        )}
      />
    </div>
  )
}

/** Helper used by agent-portal when inserting a mention at an @ trigger. */
export function insertMentionAtTrigger(
  value: string,
  textCaret: number,
  triggerStartInText: number,
  chip: ComposerChip,
): string {
  const { chips, text } = chipsFromValue(value)
  const nextText = `${text.slice(0, triggerStartInText)}${text.slice(textCaret)}`
  return serializeComposer([...chips, chip], nextText)
}

export function replaceSlashTrigger(
  value: string,
  textCaret: number,
  triggerStartInText: number,
  replacement: string,
): string {
  const { chips, text } = chipsFromValue(value)
  const nextText = `${text.slice(0, triggerStartInText)}${replacement}${text.slice(textCaret)}`
  return serializeComposer(chips, nextText)
}
