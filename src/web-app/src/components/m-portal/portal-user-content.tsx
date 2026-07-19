/**
 * PortalUserContent — render user bubble text with uploaded media markers
 * as in-bubble image thumbnails (5-up wrap grid) and @filename links.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

import { useAuth } from '@/stores/auth'
import { cn } from '@/lib/utils'
import {
  isPreviewableTextMime,
  mediaFileApiUrl,
  parseUserMediaContent,
  groupUserContentBlocks,
} from '@/lib/parse-user-media'

/** ~5 thumbs per row on a typical portal user chip (mobile ~358px content). */
const IMAGE_GRID_COLS = 5

async function fetchMediaBlob(path: string): Promise<{ blob: Blob; mime: string } | null> {
  const tok = useAuth.getState().token
  const headers: Record<string, string> = {}
  if (tok) headers.Authorization = `Bearer ${tok}`
  const res = await fetch(mediaFileApiUrl(path), {
    headers,
    credentials: 'same-origin',
  })
  if (!res.ok) return null
  const mime = res.headers.get('Content-Type') || 'application/octet-stream'
  const blob = await res.blob()
  return { blob, mime }
}

function useAuthedObjectUrl(path: string | null): {
  url: string | null
  mime: string | null
  error: boolean
  loading: boolean
} {
  const [url, setUrl] = useState<string | null>(null)
  const [mime, setMime] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(!!path)

  useEffect(() => {
    if (!path) {
      setUrl(null)
      setMime(null)
      setError(false)
      setLoading(false)
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    setLoading(true)
    setError(false)
    setUrl(null)
    void fetchMediaBlob(path).then((got) => {
      if (cancelled) return
      if (!got) {
        setError(true)
        setLoading(false)
        return
      }
      objectUrl = URL.createObjectURL(got.blob)
      setUrl(objectUrl)
      setMime(got.mime)
      setLoading(false)
    }).catch(() => {
      if (!cancelled) {
        setError(true)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path])

  return { url, mime, error, loading }
}

interface FileModalState {
  path: string
  name: string
}

function FilePreviewModal({
  dark,
  state,
  onClose,
}: {
  dark: boolean
  state: FileModalState
  onClose: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const [url, setUrl] = useState<string | null>(null)
  const [mime, setMime] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [unreadable, setUnreadable] = useState(false)

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    setLoading(true)
    setUnreadable(false)
    setUrl(null)
    setMime(null)
    setText(null)
    void fetchMediaBlob(state.path).then(async (got) => {
      if (cancelled) return
      if (!got) {
        setUnreadable(true)
        setLoading(false)
        return
      }
      setMime(got.mime)
      if (got.mime.startsWith('image/') || got.mime === 'application/pdf') {
        objectUrl = URL.createObjectURL(got.blob)
        setUrl(objectUrl)
        setLoading(false)
        return
      }
      if (isPreviewableTextMime(got.mime)) {
        try {
          const body = await got.blob.text()
          if (!cancelled) setText(body)
        } catch {
          if (!cancelled) setUnreadable(true)
        }
        if (!cancelled) setLoading(false)
        return
      }
      setUnreadable(true)
      setLoading(false)
    }).catch(() => {
      if (!cancelled) {
        setUnreadable(true)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [state.path])

  const title = state.name
  const cannotRead = unreadable || (!loading && !url && text == null)

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/75 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div
        className={cn(
          'relative flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl shadow-2xl',
          dark ? 'bg-zinc-950 text-zinc-100' : 'bg-white text-zinc-900',
        )}
      >
        <div className={cn(
          'flex items-center justify-between gap-2 border-b px-4 py-3',
          dark ? 'border-zinc-800' : 'border-zinc-200',
        )}>
          <p className="truncate text-sm font-semibold">@{title}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('chat.portal.attach.closePreview', { defaultValue: '关闭预览' })}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full',
              dark ? 'hover:bg-zinc-800' : 'hover:bg-zinc-100',
            )}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {loading && (
            <p className="text-sm text-zinc-400">
              {t('chat.portal.attach.loading', { defaultValue: '加载中…' })}
            </p>
          )}
          {!loading && cannotRead && (
            <p className="text-sm text-zinc-400">
              {t('chat.portal.attach.unreadable', { defaultValue: '无法读取该文件' })}
            </p>
          )}
          {!loading && url && mime?.startsWith('image/') && (
            <img src={url} alt={title} className="pointer-events-none mx-auto max-h-[70vh] max-w-full object-contain" />
          )}
          {!loading && url && mime === 'application/pdf' && (
            <iframe title={title} src={url} className="h-[70vh] w-full rounded-md border-0" />
          )}
          {!loading && text != null && (
            <pre className={cn(
              'agim-mono max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md p-3 text-[12px] leading-relaxed',
              dark ? 'bg-zinc-900 text-zinc-300' : 'bg-zinc-50 text-zinc-700',
            )}>
              {text}
            </pre>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ImageThumb({
  dark,
  path,
  onOpen,
}: {
  dark: boolean
  path: string
  onOpen: (url: string, name: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { url, error, loading } = useAuthedObjectUrl(path)
  const name = path.split(/[/\\]/).pop() || 'image'

  const shell = cn(
    'aspect-square w-full overflow-hidden rounded-md border',
    dark ? 'border-sky-500/40 bg-zinc-900' : 'border-sky-400/70 bg-zinc-50',
  )

  if (loading) {
    return <div className={cn(shell, 'animate-pulse', dark ? 'bg-zinc-800' : 'bg-zinc-200')} />
  }
  if (error || !url) {
    return (
      <div className={cn(shell, 'flex items-center justify-center p-1')}>
        <span className="text-center text-[9px] leading-tight text-zinc-400">
          {t('chat.portal.attach.unreadable', { defaultValue: '无法读取该文件' })}
        </span>
      </div>
    )
  }
  return (
    <button
      type="button"
      className={shell}
      aria-label={t('chat.portal.attach.preview', { defaultValue: '预览图片' })}
      onClick={() => onOpen(url, name)}
    >
      <img src={url} alt={name} className="h-full w-full object-cover" />
    </button>
  )
}

type RenderBlock = import('@/lib/parse-user-media').UserContentBlock

function blockKey(block: RenderBlock, index: number): string {
  if (block.kind === 'text') return `t:${index}:${block.text.length}`
  if (block.kind === 'images') return `i:${index}:${block.paths.join('|')}`
  return `f:${index}:${block.files.map((f) => f.path).join('|')}`
}

export function PortalUserContent({
  dark,
  content,
  className,
}: {
  dark: boolean
  content: string
  className?: string
}): JSX.Element {
  const { t } = useTranslation()
  const segments = parseUserMediaContent(content)
  const blocks = groupUserContentBlocks(segments)
  const [fileModal, setFileModal] = useState<FileModalState | null>(null)
  const [imagePreview, setImagePreview] = useState<{ url: string; name: string } | null>(null)

  const hasMedia = blocks.some((b) => b.kind !== 'text')

  return (
    <>
      <div className={cn(
        'min-w-0 max-w-full overflow-hidden',
        hasMedia ? 'flex flex-col items-stretch gap-2' : null,
        className,
      )}>
        {blocks.map((block, index) => {
          if (block.kind === 'text') {
            return (
              <span
                key={blockKey(block, index)}
                className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word]"
              >
                {block.text}
              </span>
            )
          }
          if (block.kind === 'images') {
            return (
              <div
                key={blockKey(block, index)}
                className="grid w-full gap-1.5"
                style={{ gridTemplateColumns: `repeat(${IMAGE_GRID_COLS}, minmax(0, 1fr))` }}
              >
                {block.paths.map((path) => (
                  <ImageThumb
                    key={path}
                    dark={dark}
                    path={path}
                    onOpen={(url, name) => setImagePreview({ url, name })}
                  />
                ))}
              </div>
            )
          }
          return (
            <div key={blockKey(block, index)} className="flex flex-wrap gap-x-3 gap-y-1">
              {block.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className="inline font-medium text-sky-500 underline-offset-2 hover:underline"
                  onClick={() => setFileModal({ path: file.path, name: file.name })}
                >
                  @{file.name}
                </button>
              ))}
            </div>
          )
        })}
      </div>

      {fileModal && (
        <FilePreviewModal
          dark={dark}
          state={fileModal}
          onClose={() => setFileModal(null)}
        />
      )}

      {imagePreview && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label={imagePreview.name}
          tabIndex={-1}
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setImagePreview(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') setImagePreview(null)
          }}
        >
          <button
            type="button"
            aria-label={t('chat.portal.attach.closePreview', { defaultValue: '关闭预览' })}
            className="absolute right-4 top-4 z-[1] flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white"
            onClick={() => setImagePreview(null)}
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={imagePreview.url}
            alt={imagePreview.name}
            className="pointer-events-none max-h-[90vh] max-w-full rounded-lg object-contain"
          />
        </div>,
        document.body,
      )}
    </>
  )
}
