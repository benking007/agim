import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  appendPendingFiles,
  consumeClipboardImages,
  filesFromClipboard,
  isGenericClipboardName,
  MAX_PENDING_ATTACHMENTS,
  normalizeClipboardImage,
  screenshotFileName,
  type PendingAttachment,
} from './portal-composer-attachments'
import { AttachmentStrip } from './portal-composer-plus'

function pngFile(name: string, type = 'image/png'): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type })
}

function clipboard(opts: {
  items?: Array<{ kind: string; type: string; getAsFile: () => File | null }>
  files?: File[]
}): DataTransfer {
  const items = opts.items ?? []
  const files = opts.files ?? []
  return {
    items: items as unknown as DataTransferItemList,
    files: Object.assign(files.slice(), {
      item: (i: number) => files[i] ?? null,
    }) as unknown as FileList,
  } as DataTransfer
}

describe('screenshot naming', () => {
  it('treats empty and browser-default names as generic', () => {
    expect(isGenericClipboardName('')).toBe(true)
    expect(isGenericClipboardName('image.png')).toBe(true)
    expect(isGenericClipboardName('blob')).toBe(true)
    expect(isGenericClipboardName('photo-of-board.png')).toBe(false)
  })

  it('names a clipboard blob screenshot-<stamp>.png', () => {
    const now = new Date(2026, 7, 22, 14, 5, 9)
    expect(screenshotFileName(pngFile(''), now)).toBe('screenshot-20260822-140509.png')
    expect(screenshotFileName(pngFile('image.png', 'image/jpeg'), now)).toBe(
      'screenshot-20260822-140509.jpg',
    )
  })

  it('keeps a real filename from Finder / Photos', () => {
    const file = pngFile('board-review.png')
    expect(normalizeClipboardImage(file)).toBe(file)
  })
})

describe('filesFromClipboard', () => {
  it('returns [] for text-only paste', () => {
    const data = clipboard({
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
    })
    expect(filesFromClipboard(data)).toEqual([])
  })

  it('extracts image items and renames generic screenshot blobs', () => {
    const blob = pngFile('image.png')
    const files = filesFromClipboard(clipboard({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => blob }],
    }))
    expect(files).toHaveLength(1)
    expect(files[0]?.type).toBe('image/png')
    expect(files[0]?.name).toMatch(/^screenshot-\d{8}-\d{6}\.png$/)
  })

  it('ignores non-image files on the clipboard', () => {
    const pdf = new File([new Uint8Array([1, 2, 3])], 'notes.pdf', { type: 'application/pdf' })
    expect(filesFromClipboard(clipboard({
      items: [{ kind: 'file', type: 'application/pdf', getAsFile: () => pdf }],
    }))).toEqual([])
  })

  it('falls back to clipboard.files when items is empty', () => {
    const files = filesFromClipboard(clipboard({
      files: [pngFile('shot.webp', 'image/webp')],
    }))
    expect(files).toHaveLength(1)
    expect(files[0]?.name).toBe('shot.webp')
  })
})

describe('appendPendingFiles', () => {
  it('builds image attachments with object-URL previews', () => {
    const file = pngFile('a.png')
    const { next, overflowed } = appendPendingFiles([], [file], true)
    expect(overflowed).toBe(false)
    expect(next).toHaveLength(1)
    expect(next[0]?.kind).toBe('image')
    expect(next[0]?.name).toBe('a.png')
    expect(next[0]?.mime).toBe('image/png')
    expect(next[0]?.file).toBe(file)
    expect(next[0]?.previewUrl).toMatch(/^blob:/)
    if (next[0]?.previewUrl) URL.revokeObjectURL(next[0].previewUrl)
  })

  it('caps at 8 and reports overflow', () => {
    const existing = appendPendingFiles(
      [],
      Array.from({ length: MAX_PENDING_ATTACHMENTS }, (_, i) => pngFile(`n${i}.png`)),
      true,
    ).next
    const extra = pngFile('extra.png')
    const { next, overflowed } = appendPendingFiles(existing, [extra], true)
    expect(overflowed).toBe(true)
    expect(next).toHaveLength(MAX_PENDING_ATTACHMENTS)
    for (const a of next) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
    }
  })
})

describe('consumeClipboardImages', () => {
  it('does not consume text-only paste', () => {
    const { consumed, next } = consumeClipboardImages(
      clipboard({ items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] }),
      [],
    )
    expect(consumed).toBe(false)
    expect(next).toEqual([])
  })

  it('attaches a screenshot like the + photo picker', () => {
    const blob = pngFile('image.png')
    const { consumed, overflowed, next } = consumeClipboardImages(
      clipboard({
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => blob }],
      }),
      [],
    )
    expect(consumed).toBe(true)
    expect(overflowed).toBe(false)
    expect(next).toHaveLength(1)
    expect(next[0]?.kind).toBe('image')
    expect(next[0]?.name).toMatch(/^screenshot-\d{8}-\d{6}\.png$/)
    if (next[0]?.previewUrl) URL.revokeObjectURL(next[0].previewUrl)
  })
})

function PasteComposer(): JSX.Element {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  return (
    <form
      onPaste={(e) => {
        const { next, consumed } = consumeClipboardImages(e.clipboardData, attachments)
        if (!consumed) return
        e.preventDefault()
        setAttachments(next)
      }}
    >
      <textarea aria-label="message" />
      <AttachmentStrip dark={false} attachments={attachments} onRemove={() => {}} />
    </form>
  )
}

describe('composer paste → attachment strip', () => {
  it('shows a preview thumb after pasting a screenshot blob', () => {
    render(<PasteComposer />)
    const ta = screen.getByRole('textbox', { name: 'message' })
    fireEvent.paste(ta, {
      clipboardData: clipboard({
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => pngFile('image.png') }],
      }),
    })
    const img = screen.getByRole('img')
    expect(img.getAttribute('alt')).toMatch(/^screenshot-\d{8}-\d{6}\.png$/)
  })

  it('leaves the textarea empty when only an image is pasted', () => {
    render(<PasteComposer />)
    const ta = screen.getByRole('textbox', { name: 'message' }) as HTMLTextAreaElement
    fireEvent.paste(ta, {
      clipboardData: clipboard({
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => pngFile('image.png') }],
      }),
    })
    expect(ta.value).toBe('')
    expect(screen.getByRole('img')).toBeInTheDocument()
  })
})
