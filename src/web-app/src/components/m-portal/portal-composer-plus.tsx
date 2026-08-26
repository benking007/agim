/**
 * PortalComposerPlus — "+" menu for Plan / Memo / Focus / camera / photos / files,
 * plus a pending-attachment strip above the input.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  Bot, Camera, Crosshair, FileText, FolderOpen, Image as ImageIcon, ListTodo, MapPin,
  RefreshCw, StickyNote, X, Bell, Boxes, Sparkles,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { SUBAGENT_COMPOSER_FILL } from './portal-slash-commands'
import { appendPendingFiles, type PendingAttachment } from './portal-composer-attachments'
import { uploadPendingAttachments } from '@/lib/upload-chat-media'

export type { PendingAttachment }
export { uploadPendingAttachments }

interface PortalComposerPlusProps {
  dark: boolean
  planMode: boolean
  disabled?: boolean
  attachments: PendingAttachment[]
  onAttachmentsChange: (next: PendingAttachment[]) => void
  onFillInput: (text: string) => void
  onSendCommand: (text: string) => void
  onOpenChange?: (open: boolean) => void
}

export function PortalComposerPlus({
  dark,
  planMode,
  disabled,
  attachments,
  onAttachmentsChange,
  onFillInput,
  onSendCommand,
  onOpenChange,
}: PortalComposerPlusProps): JSX.Element {
  const { t } = useTranslation()
  const menuId = useId()
  const cameraInputId = useId()
  const photosInputId = useId()
  const filesInputId = useId()
  const [open, setOpen] = useState(false)
  const cameraRef = useRef<HTMLInputElement>(null)
  const photosRef = useRef<HTMLInputElement>(null)
  const filesRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments

  const setMenuOpen = useCallback((next: boolean): void => {
    setOpen(next)
    onOpenChange?.(next)
  }, [onOpenChange])

  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number; maxH: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null)
      return
    }
    const sync = (): void => {
      const el = rootRef.current
      if (!el) return
      // Anchor to composer form top — tight hug, ignores attachment strip height.
      const form = el.closest('form') ?? el
      const formRect = form.getBoundingClientRect()
      const btnRect = el.getBoundingClientRect()
      const gap = 4
      const bottom = Math.max(8, window.innerHeight - formRect.top + gap)
      const maxH = Math.max(120, window.innerHeight - bottom - 8)
      const left = Math.max(8, Math.min(btnRect.left, window.innerWidth - 216 - 8))
      setMenuPos({ left, bottom, maxH })
    }
    sync()
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (ev: MouseEvent): void => {
      const t = ev.target as Node
      if (rootRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, setMenuOpen])

  useEffect(() => () => {
    for (const a of attachmentsRef.current) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
    }
  }, [])

  function addFiles(list: FileList | null, preferImage: boolean): void {
    const { next, overflowed } = appendPendingFiles(attachments, list, preferImage)
    if (overflowed) {
      toast.error(t('chat.portal.attach.max'))
    }
    if (next === attachments) return
    onAttachmentsChange(next)
    setMenuOpen(false)
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
    <div ref={rootRef} className={cn('relative shrink-0 self-center', open && 'z-50')}>
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t('chat.portal.plusMenu', { defaultValue: '更多' })}
        onClick={() => setMenuOpen(!open)}
        className={cn(
          // Match send/mic/stop: fixed h-7 w-7 circle, no border ring.
          // Plus glyph: slightly larger than before, dark (not rose).
          'flex aspect-square h-7 w-7 shrink-0 items-center justify-center rounded-full border-0 text-[22px] font-medium leading-none outline-none ring-0 transition-colors',
          'disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-teal-500/50',
          dark
            ? 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700'
            : 'bg-zinc-200/90 text-zinc-800 hover:bg-zinc-300/90',
          open && (dark ? 'bg-zinc-700 text-white' : 'bg-zinc-300 text-zinc-900'),
        )}
      >
        <span aria-hidden className="translate-y-[-1px]">+</span>
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          style={menuPos
            ? {
                left: menuPos.left,
                bottom: menuPos.bottom,
                maxHeight: menuPos.maxH,
              }
            : { left: -9999, bottom: 0, visibility: 'hidden' }}
          className={cn(
            // bottom-anchored to form top — always tight; paints over attachments.
            'fixed z-[100] w-[13.5rem] overflow-y-auto origin-bottom-left animate-in fade-in zoom-in-95 rounded-2xl border p-1.5 shadow-xl duration-150 scrollbar-none',
            dark ? 'border-zinc-800 bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-800',
          )}
        >
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={planMode}
            className={itemCls}
            onClick={() => {
              setMenuOpen(false)
              onSendCommand(planMode ? '/plan off' : '/plan on')
            }}
          >
            <ListTodo className={cn('h-3.5 w-3.5', planMode ? 'text-rose-500' : 'text-zinc-400')} />
            <span className="flex-1">{t('chat.portal.menu.plan')}</span>
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
              setMenuOpen(false)
              onFillInput('/memo here')
            }}
          >
            <StickyNote className="h-3.5 w-3.5 text-amber-500" />
            <span>{t('chat.portal.menu.memo')}</span>
            <MapPin className="ml-auto h-3 w-3 text-zinc-400" />
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => {
              setMenuOpen(false)
              onFillInput('/focus ')
            }}
          >
            <Crosshair className="h-3.5 w-3.5 text-sky-500" />
            <span>{t('chat.portal.menu.focus')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => {
              setMenuOpen(false)
              onFillInput('/loop ')
            }}
          >
            <RefreshCw className="h-3.5 w-3.5 text-emerald-500" />
            <span>{t('chat.portal.menu.loop')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => {
              setMenuOpen(false)
              onFillInput(SUBAGENT_COMPOSER_FILL)
            }}
          >
            <Bot className="h-3.5 w-3.5 text-indigo-400" />
            <span>{t('chat.portal.menu.subagent')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => {
              setMenuOpen(false)
              onFillInput('/remind ')
            }}
          >
            <Bell className="h-3.5 w-3.5 text-rose-400" />
            <span>{t('chat.portal.menu.remember')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => {
              setMenuOpen(false)
              onSendCommand('/models')
            }}
          >
            <Boxes className="h-3.5 w-3.5 text-violet-400" />
            <span>{t('chat.portal.menu.models')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => {
              setMenuOpen(false)
              // Open the slash picker focused on skills.
              onFillInput('/')
            }}
          >
            <Sparkles className="h-3.5 w-3.5 text-teal-400" />
            <span>{t('chat.portal.menu.skills')}</span>
          </button>
          <div className={cn('my-1 border-t', dark ? 'border-zinc-800' : 'border-zinc-100')} />
          {/*
            Labels point at always-mounted inputs below (outside this portal).
            Avoid button→input.click() + display:none — flaky in WKWebView.
            Keep inputs mounted so closing the menu cannot abort the picker.
          */}
          <label htmlFor={cameraInputId} className={cn(itemCls, 'cursor-pointer')}>
            <Camera className="h-3.5 w-3.5 text-zinc-400" />
            <span>{t('chat.portal.menu.camera')}</span>
          </label>
          <label htmlFor={photosInputId} className={cn(itemCls, 'cursor-pointer')}>
            <ImageIcon className="h-3.5 w-3.5 text-zinc-400" />
            <span>{t('chat.portal.menu.photos')}</span>
          </label>
          <label htmlFor={filesInputId} className={cn(itemCls, 'cursor-pointer')}>
            <FolderOpen className="h-3.5 w-3.5 text-zinc-400" />
            <span>{t('chat.portal.menu.files')}</span>
          </label>
        </div>,
        document.body,
      )}

      <input
        id={cameraInputId}
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => onPick(e, true)}
      />
      <input
        id={photosInputId}
        ref={photosRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => onPick(e, true)}
      />
      <input
        id={filesInputId}
        ref={filesRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => onPick(e, false)}
      />
    </div>
  )
}

export function AttachmentStrip({
  dark,
  attachments,
  onRemove,
  className,
}: {
  dark: boolean
  attachments: PendingAttachment[]
  onRemove: (id: string) => void
  className?: string
}): JSX.Element | null {
  const { t } = useTranslation()
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [fadeLeft, setFadeLeft] = useState(false)
  const [fadeRight, setFadeRight] = useState(false)
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null)

  useEffect(() => {
    if (!scroller) {
      setFadeLeft(false)
      setFadeRight(false)
      return
    }
    const sync = (): void => {
      const { scrollLeft, scrollWidth, clientWidth } = scroller
      setFadeLeft(scrollLeft > 2)
      setFadeRight(scrollLeft + clientWidth < scrollWidth - 2)
    }
    sync()
    scroller.addEventListener('scroll', sync, { passive: true })
    const ro = new ResizeObserver(sync)
    ro.observe(scroller)
    const list = scroller.firstElementChild
    if (list) ro.observe(list)
    const mo = new MutationObserver(sync)
    if (list) mo.observe(list, { childList: true, subtree: true })
    return () => {
      scroller.removeEventListener('scroll', sync)
      ro.disconnect()
      mo.disconnect()
    }
  }, [scroller])

  useEffect(() => {
    if (!preview) return
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setPreview(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [preview])

  if (attachments.length === 0) return null

  return (
    <>
      {/* Cap width short of the perched pet; overflow scrolls horizontally. */}
      <div className={cn('pointer-events-auto relative', className)}>
        <div
          ref={setScroller}
          className="overflow-x-auto overscroll-x-contain scrollbar-none"
        >
          <ul className="flex w-max gap-2 pb-0.5">
            {attachments.map((a) => (
              <li
                key={a.id}
                className={cn(
                  'relative shrink-0 overflow-hidden rounded-xl border',
                  dark ? 'border-zinc-700 bg-zinc-900' : 'border-zinc-200 bg-white',
                  a.kind === 'image' ? 'h-14 w-14' : 'flex h-14 min-w-[6.5rem] max-w-[9rem] items-center gap-2 px-2',
                )}
              >
                {a.kind === 'image' && a.previewUrl ? (
                  <button
                    type="button"
                    className="h-full w-full"
                    aria-label={t('chat.portal.attach.preview', { defaultValue: '预览图片' })}
                    onClick={() => {
                      const url = a.previewUrl
                      if (url) setPreview({ url, name: a.name })
                    }}
                  >
                    <img src={a.previewUrl} alt={a.name} className="h-full w-full object-cover" />
                  </button>
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
                  className="absolute right-0.5 top-0.5 z-[1] flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
        {fadeLeft && (
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-y-0 left-0 w-9 bg-gradient-to-r to-transparent',
              dark ? 'from-zinc-950/95 via-zinc-950/55' : 'from-zinc-100/95 via-zinc-100/55',
            )}
          />
        )}
        {fadeRight && (
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-y-0 right-0 w-9 bg-gradient-to-l to-transparent',
              dark ? 'from-zinc-950/95 via-zinc-950/55' : 'from-zinc-100/95 via-zinc-100/55',
            )}
          />
        )}
      </div>

      {preview && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label={preview.name}
          tabIndex={-1}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/75 p-4"
          onClick={() => setPreview(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') setPreview(null)
          }}
        >
          <button
            type="button"
            aria-label={t('chat.portal.attach.closePreview', { defaultValue: '关闭预览' })}
            onClick={() => setPreview(null)}
            className="absolute right-4 top-4 z-[1] flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/75"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={preview.url}
            alt={preview.name}
            className="pointer-events-none max-h-[min(85vh,720px)] max-w-full rounded-lg object-contain shadow-2xl"
          />
        </div>,
        document.body,
      )}
    </>
  )
}
