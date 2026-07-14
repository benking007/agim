/**
 * MobileBottomSheet — iOS-ish bottom sheet for /m/chat menus.
 *
 * - Lifts above the soft keyboard via keyboardInset
 * - Locks body scroll while open
 * - Drag handle / downward swipe to dismiss
 * - Scrim tap to dismiss
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { useBodyScrollLock } from '@/hooks/use-body-scroll-lock'
import { cn } from '@/lib/utils'

const DISMISS_PX = 96

export interface MobileBottomSheetProps {
  open: boolean
  onClose: () => void
  keyboardInset?: number
  children: ReactNode
  className?: string
}

export function MobileBottomSheet({
  open,
  onClose,
  keyboardInset = 0,
  children,
  className,
}: MobileBottomSheetProps): JSX.Element | null {
  const { t } = useTranslation()
  useBodyScrollLock(open)
  const dragStartY = useRef<number | null>(null)
  const [dragY, setDragY] = useState(0)
  const [dragging, setDragging] = useState(false)

  if (!open) return null

  function onHandlePointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    dragStartY.current = e.clientY
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onHandlePointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    if (dragStartY.current == null) return
    const delta = Math.max(0, e.clientY - dragStartY.current)
    setDragY(delta)
  }

  function endDrag(): void {
    if (dragStartY.current == null) return
    const shouldClose = dragY >= DISMISS_PX
    dragStartY.current = null
    setDragging(false)
    setDragY(0)
    if (shouldClose) onClose()
  }

  return (
    <>
      <button
        type="button"
        aria-label={t('actions.close', { ns: 'common', defaultValue: 'Close' })}
        className="fixed inset-0 z-30 bg-black/35 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'fixed inset-x-0 bottom-0 z-40 max-h-[min(85dvh,720px)] overflow-y-auto',
          'rounded-t-2xl border border-border bg-surface px-4 pt-2 shadow-lg',
          !dragging && 'motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-200',
          className,
        )}
        style={{
          paddingBottom: `calc(env(safe-area-inset-bottom) + 0.75rem + ${keyboardInset}px)`,
          transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
          transition: dragging ? 'none' : 'transform 180ms ease-out',
        }}
      >
        <div
          className="mx-auto -mt-1 mb-2 flex w-full cursor-grab touch-none flex-col items-center py-2 active:cursor-grabbing"
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          aria-hidden
        >
          <div className="h-1.5 w-12 rounded-full bg-border" />
        </div>
        {children}
      </div>
    </>
  )
}
