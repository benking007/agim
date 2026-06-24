// Mouse-wheel support for the TUI.
//
// Ink reads stdin via `readable`/`read()` and feeds every byte through its
// keypress parser. Xterm mouse reports (`\x1b[<b;x;yM`) don't match any key,
// so Ink leaks the raw bytes (e.g. `[<64;10;5M`) straight into the focused
// text input — corrupting it. There's also no way to add a second `data`
// listener without breaking Ink's read loop.
//
// So we hand Ink a *proxy* stdin: we read the real TTY ourselves (utf8, so
// CJK input is never split mid-character), strip the mouse sequences out,
// forward the remaining keystrokes to Ink unchanged, and surface wheel
// notches on a side EventEmitter the TUI subscribes to. Native text
// selection becomes Shift+drag while mouse reporting is on; disable the
// whole thing with IMHUB_TUI_NO_MOUSE=1.

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

// SGR mouse report: ESC [ < button ; col ; row (M=press | m=release).
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) is the literal lead byte of an xterm CSI mouse report.
const SGR_MOUSE_RE = /\x1b\[<(\d+);\d+;\d+[Mm]/g

/**
 * Strip SGR mouse reports from a decoded stdin chunk. Returns the clean
 * keystroke text (mouse bytes removed) plus one wheel delta per wheel
 * report: -1 = wheel up (scroll toward older), +1 = wheel down. Non-wheel
 * mouse events (clicks, moves, drags) are dropped without a delta. Pure, so
 * it's unit-tested directly.
 */
export function extractWheel(chunk: string): { clean: string; deltas: number[] } {
  const deltas: number[] = []
  const clean = chunk.replace(SGR_MOUSE_RE, (_match, button: string) => {
    const code = Number(button)
    // Wheel reports set bit 6 (64). Low bit picks direction: 64 = up,
    // 65 = down (modifier bits 4/8/16 are ignored).
    if ((code & 64) !== 0) deltas.push((code & 1) === 1 ? 1 : -1)
    return ''
  })
  return { clean, deltas }
}

export interface MouseStdin {
  /** Proxy stream to hand to Ink's `render({ stdin })`. */
  stdin: NodeJS.ReadStream
  /** Emits 'wheel' with a delta (-1 up / +1 down) per wheel notch. */
  wheel: EventEmitter
  /** Turn on xterm SGR mouse reporting (write to stdout). */
  enable(out: NodeJS.WriteStream): void
  /** Turn it back off (write to stdout). Idempotent. */
  disable(out: NodeJS.WriteStream): void
}

/**
 * Wrap the real stdin so Ink never sees mouse bytes. Read the TTY here,
 * split keystrokes from wheel reports, forward keystrokes to a PassThrough
 * that Ink consumes, and emit wheel notches separately.
 */
export function createMouseStdin(real: NodeJS.ReadStream): MouseStdin {
  const wheel = new EventEmitter()
  const pass = new PassThrough()
  // Ink needs these TTY bits; proxy them onto the PassThrough we hand it.
  const proxy = pass as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode: (mode: boolean) => NodeJS.ReadStream
  }
  proxy.isTTY = true
  proxy.setRawMode = (mode: boolean) => { real.setRawMode?.(mode); return proxy }
  ;(proxy as unknown as { ref: () => unknown }).ref = () => { real.ref?.(); return proxy }
  ;(proxy as unknown as { unref: () => unknown }).unref = () => { real.unref?.(); return proxy }

  // Read the real TTY ourselves. utf8 decoding keeps multi-byte (CJK) input
  // intact across chunk boundaries.
  real.setEncoding('utf8')
  const onReadable = (): void => {
    for (;;) {
      const chunk = real.read() as string | null
      if (chunk === null) break
      const { clean, deltas } = extractWheel(chunk)
      for (const d of deltas) wheel.emit('wheel', d)
      if (clean) pass.write(clean)
    }
  }
  real.on('readable', onReadable)

  return {
    stdin: proxy,
    wheel,
    enable(out) { out.write('\x1b[?1000h\x1b[?1006h') },
    disable(out) { out.write('\x1b[?1000l\x1b[?1006l') },
  }
}
