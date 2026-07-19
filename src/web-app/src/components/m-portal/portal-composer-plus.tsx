/**
 * PortalComposerPlus — "+" menu for Plan / Memo / Goal / camera / photos / files,
 * plus a pending-attachment strip above the input.
 */

import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react'
import {
  Camera, FileText, FolderOpen, Image as ImageIcon, ListTodo, MapPin,
  StickyNote, X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useAuth } from '@/stores/auth'

export interface PendingAttachment {
  id: string
  kind: 'image' | 'file'
  name: string
  mime: string
  previewUrl?: string
  /** Local File until uploaded at send time. */
  file: File
}

interface PortalComposerPlusProps {
  dark: boolean
  planMode: boolean
  disabled?: boolean
  attachments: PendingAttachment[]
  onAttachmentsChange: (next: PendingAttachment[]) => void
  onFillInput: (text: string) => void
  onSendCommand: (text: string) => void
}

async function uploadChatMedia(file: File, threadId: string): Promise<{ marker: string }> {
  const tok = useAuth.getState().token
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-Agim-Filename': encodeURIComponent(file.name || 'file'),
    'X-Agim-Mime': file.type || 'application/octet-stream',
  }
  if (tok) headers.Authorization = `Bearer ${tok}`
  const res = await fetch(`/api/chat/media?threadId=${encodeURIComponent(threadId)}`, {
    method: 'POST',
    headers,
    body: file,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(body.slice(0, 200) || `upload ${res.status}`)
  }
  return res.json() as Promise<{ marker: string }>
}

/** Upload all pending attachments; return marker lines for the chat text. */
export async function uploadPendingAttachments(
  items: PendingAttachment[],
  threadId: string,
): Promise<string[]> {
  const markers: string[] = []
  for (const item of items) {
    const { marker } = await uploadChatMedia(item.file, threadId)
    markers.push(marker)
  }
  return markers
}

export function PortalComposerPlus({
  dark,
  planMode,
  disabled,
  attachments,
  onAttachmentsChange,
  onFillInput,
  onSendCommand,
}: PortalComposerPlusProps): JSX.Element {
  const { t } = useTranslation()
  const menuId = useId()
  const [open, setOpen] = useState(false)
  const cameraRef = useRef<HTMLInputElement>(null)
  const photosRef = useRef<HTMLInputElement>(null)
  const filesRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (ev: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => () => {
    for (const a of attachments) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
    }
  // biome-ignore lint/correctness/useExhaustiveDependencies: only revoke object URLs on unmount
  }, [])

  function addFiles(list: FileList | null, preferImage: boolean): void {
    if (!list || list.length === 0) return
    const next = [...attachments]
    for (const file of Array.from(list)) {
      if (next.length >= 8) {
        toast.error(t('chat.portal.attach.max', { defaultValue: '最多 8 个附件' }))
        break
      }
      const isImage = preferImage || file.type.startsWith('image/')
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined
      next.push({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: isImage ? 'image' : 'file',
        name: file.name || (isImage ? 'image.jpg' : 'file'),
        mime: file.type || 'application/octet-stream',
        previewUrl,
        file,
      })
    }
    onAttachmentsChange(next)
    setOpen(false)
  }

  function removeAttachment(id: string): void {
    const target = attachments.find((a) => a.id === id)
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
    onAttachmentsChange(attachments.filter((a) => a.id !== id))
  }

  function onPick(e: ChangeEvent<HTMLInputElement>, preferImage: boolean): void {
    addFiles(e.target.files, preferImage)
    e.target.value = ''
  }

  const itemCls = cn(
    'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[12px] font-semibold transition',
    dark ? 'text-zinc-200 hover:bg-zinc-800' : 'text-zinc-700 hover:bg-zinc-100',
  )

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t('chat.portal.plusMenu', { defaultValue: '更多' })}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'rounded-full p-2 text-zinc-400 transition-colors disabled:opacity-40',
          dark ? 'hover:bg-zinc-800 hover:text-rose-400' : 'hover:bg-zinc-100 hover:text-rose-600',
          open && (dark ? 'bg-zinc-800 text-rose-400' : 'bg-zinc-100 text-rose-600'),
        )}
      >
        <span className="block text-lg leading-none">+</span>
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          className={cn(
            'absolute bottom-full left-0 z-40 mb-2 w-[13.5rem] origin-bottom-left animate-in fade-in slide-in-from-bottom-2 rounded-2xl border p-1.5 shadow-xl duration-150',
            dark ? 'border-zinc-800 bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-800',
          )}
        >
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={planMode}
            className={itemCls}
            onClick={() => {
              setOpen(false)
              onSendCommand(planMode ? '/plan off' : '/plan on')
            }}
          >
            <ListTodo className={cn('h-3.5 w-3.5', planMode ? 'text-rose-500' : 'text-zinc-400')} />
            <span className="flex-1">{t('chat.portal.menu.plan', { defaultValue: 'Plan 模式' })}</span>
            <span className={cn(
              'rounded-full px-1.5 py-0.5 text-[9px] font-bold',
              planMode
                ? (dark ? 'bg-rose-500/20 text-rose-300' : 'bg-rose-50 text-rose-700')
                : 'bg-zinc-500/10 text-zinc-400',
            )}>
              {planMode ? 'ON' : 'OFF'}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => {
              setOpen(false)
              onFillInput('/memo here')
            }}
          >
            <StickyNote className="h-3.5 w-3.5 text-amber-500" />
            <span>Memo</span>
            <MapPin className="ml-auto h-3 w-3 text-zinc-400" />
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => {
              setOpen(false)
              onFillInput('/goal')
            }}
          >
            <ListTodo className="h-3.5 w-3.5 text-sky-500" />
            <span>Goal</span>
          </button>
          <div className={cn('my-1 border-t', dark ? 'border-zinc-800' : 'border-zinc-100')} />
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => cameraRef.current?.click()}
          >
            <Camera className="h-3.5 w-3.5 text-zinc-400" />
            <span>{t('chat.portal.menu.camera', { defaultValue: '拍照' })}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => photosRef.current?.click()}
          >
            <ImageIcon className="h-3.5 w-3.5 text-zinc-400" />
            <span>{t('chat.portal.menu.photos', { defaultValue: '照片' })}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => filesRef.current?.click()}
          >
            <FolderOpen className="h-3.5 w-3.5 text-zinc-400" />
            <span>{t('chat.portal.menu.files', { defaultValue: '文件' })}</span>
          </button>
        </div>
      )}

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => onPick(e, true)}
      />
      <input
        ref={photosRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => onPick(e, true)}
      />
      <input
        ref={filesRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => onPick(e, false)}
      />
    </div>
  )
}

export function AttachmentStrip({
  dark,
  attachments,
  onRemove,
}: {
  dark: boolean
  attachments: PendingAttachment[]
  onRemove: (id: string) => void
}): JSX.Element | null {
  if (attachments.length === 0) return null
  return (
    <ul className="mb-2 flex gap-2 overflow-x-auto pb-0.5 scrollbar-none">
      {attachments.map((a) => (
        <li
          key={a.id}
          className={cn(
            'relative shrink-0 overflow-hidden rounded-xl border',
            dark ? 'border-zinc-700 bg-zinc-900' : 'border-zinc-200 bg-white',
            a.kind === 'image' ? 'h-16 w-16' : 'flex h-16 min-w-[7rem] max-w-[10rem] items-center gap-2 px-2',
          )}
        >
          {a.kind === 'image' && a.previewUrl ? (
            <img src={a.previewUrl} alt={a.name} className="h-full w-full object-cover" />
          ) : (
            <>
              <FileText className={cn('h-5 w-5 shrink-0', dark ? 'text-rose-300' : 'text-rose-500')} />
              <span className="truncate text-[10px] font-medium">{a.name}</span>
            </>
          )}
          <button
            type="button"
            aria-label="Remove"
            onClick={() => onRemove(a.id)}
            className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white"
          >
            <X className="h-3 w-3" />
          </button>
        </li>
      ))}
    </ul>
  )
}
