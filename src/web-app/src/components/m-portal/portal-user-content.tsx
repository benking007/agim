/**
 * PortalUserContent — render user bubble text with uploaded media markers
 * as in-bubble image thumbnails and @filename links (modal preview).
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
  type UserContentSegment,
} from '@/lib/parse-user-media'

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
  const { url, mime, error, loading } = useAuthedObjectUrl(state.path)
  const [text, setText] = useState<string | null>(null)
  const [unreadable, setUnreadable] = useState(false)

  useEffect(() => {
    setText(null)
    setUnreadable(false)
    if (!url || !mime) return
    if (mime.startsWith('image/') || mime === 'application/pdf') return
    if (!isPreviewableTextMime(mime)) {
      setUnreadable(true)
      return
    }
    let cancelled = false
    void fetch(url).then((r) => r.text()).then((body) => {
      if (!cancelled) setText(body)
    }).catch(() => {
      if (!cancelled) setUnreadable(true)
    })
    return () => { cancelled = true }
  }, [url, mime])

  const title = state.name
  const cannotRead = error || unreadable || (!loading && !url)

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

  if (loading) {
    return (
      <div className={cn(
        'h-28 w-28 animate-pulse rounded-xl',
        dark ? 'bg-zinc-800' : 'bg-zinc-200',
      )}
      />
    )
  }
  if (error || !url) {
    return (
      <span className="text-xs text-zinc-400">
        {t('chat.portal.attach.unreadable', { defaultValue: '无法读取该文件' })}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={cn(
        'block overflow-hidden rounded-xl border',
        dark ? 'border-zinc-700' : 'border-zinc-200',
      )}
      aria-label={t('chat.portal.attach.preview', { defaultValue: '预览图片' })}
      onClick={() => onOpen(url, name)}
    >
      <img src={url} alt={name} className="max-h-48 max-w-full object-contain" />
    </button>
  )
}

function SegmentView({
  dark,
  segment,
  onFileOpen,
  onImageOpen,
}: {
  dark: boolean
  segment: UserContentSegment
  onFileOpen: (path: string, name: string) => void
  onImageOpen: (url: string, name: string) => void
}): JSX.Element {
  if (segment.kind === 'text') {
    return (
      <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word]">
        {segment.text}
      </span>
    )
  }
  if (segment.kind === 'image') {
    return <ImageThumb dark={dark} path={segment.path} onOpen={onImageOpen} />
  }
  return (
    <button
      type="button"
      className="inline font-medium text-sky-500 underline-offset-2 hover:underline"
      onClick={() => onFileOpen(segment.path, segment.name)}
    >
      @{segment.name}
    </button>
  )
}

function segmentKey(seg: UserContentSegment): string {
  if (seg.kind === 'text') return `t:${seg.text.slice(0, 48)}:${seg.text.length}`
  if (seg.kind === 'image') return `i:${seg.path}`
  return `f:${seg.path}:${seg.name}`
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
  const [fileModal, setFileModal] = useState<FileModalState | null>(null)
  const [imagePreview, setImagePreview] = useState<{ url: string; name: string } | null>(null)

  const hasMedia = segments.some((s) => s.kind !== 'text')

  return (
    <>
      <div className={cn(
        'min-w-0 max-w-full overflow-hidden',
        hasMedia ? 'flex flex-col items-start gap-2' : null,
        className,
      )}>
        {segments.map((seg) => (
          <SegmentView
            key={segmentKey(seg)}
            dark={dark}
            segment={seg}
            onFileOpen={(path, name) => setFileModal({ path, name })}
            onImageOpen={(url, name) => setImagePreview({ url, name })}
          />
        ))}
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
