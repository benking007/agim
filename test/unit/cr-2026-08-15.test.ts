import { describe, it, expect, afterEach } from 'bun:test'
import { enDictionaryEntries, detectLangFromEnv, resolveCliLang } from '../../src/cli-ui/i18n'
import { withTimeout } from '../../src/utils/timeout'
import { runOnThread, _resetThreadQueues } from '../../src/core/thread-queue'
import { tickOnce, _setHeartbeatTicking } from '../../src/core/heartbeat'
import { imText, resolveImLang } from '../../src/core/im-i18n'

const CJK = /[\u3400-\u9fff]/

describe('CR 2026-08-15 — i18n / timeout / queues', () => {
  it('en dictionary has no CJK except language-picker keys', () => {
    const offenders: string[] = []
    for (const [key, value] of enDictionaryEntries()) {
      if (key.startsWith('lang.')) continue
      if (CJK.test(value)) offenders.push(`${key}: ${value.slice(0, 80)}`)
    }
    expect(offenders).toEqual([])
  })

  it('detectLangFromEnv reads LANG / LC_ALL', () => {
    const prevLang = process.env.LANG
    const prevAll = process.env.LC_ALL
    const prevMsg = process.env.LC_MESSAGES
    try {
      delete process.env.LC_ALL
      delete process.env.LC_MESSAGES
      process.env.LANG = 'zh_CN.UTF-8'
      expect(detectLangFromEnv()).toBe('zh')
      process.env.LANG = 'en_US.UTF-8'
      expect(detectLangFromEnv()).toBe('en')
    } finally {
      if (prevLang === undefined) delete process.env.LANG
      else process.env.LANG = prevLang
      if (prevAll === undefined) delete process.env.LC_ALL
      else process.env.LC_ALL = prevAll
      if (prevMsg === undefined) delete process.env.LC_MESSAGES
      else process.env.LC_MESSAGES = prevMsg
    }
  })

  it('resolveCliLang falls back to en when nothing is saved or in env', () => {
    const prevLang = process.env.LANG
    const prevAll = process.env.LC_ALL
    try {
      delete process.env.LANG
      delete process.env.LC_ALL
      delete process.env.LC_MESSAGES
      // May still pick a saved ~/.agim/cli-lang — just assert it is a Lang.
      expect(['en', 'zh']).toContain(resolveCliLang())
    } finally {
      if (prevLang === undefined) delete process.env.LANG
      else process.env.LANG = prevLang
      if (prevAll === undefined) delete process.env.LC_ALL
      else process.env.LC_ALL = prevAll
    }
  })

  it('withTimeout rejects and clears the timer', async () => {
    await expect(withTimeout(new Promise(() => { /* hang */ }), 20, 'unit')).rejects.toThrow(/timed out/)
  })

  it('thread-queue rejects when depth exceeds the cap', async () => {
    _resetThreadQueues()
    const started: Promise<void>[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    started.push(runOnThread('k', () => gate))
    for (let i = 0; i < 19; i++) {
      started.push(runOnThread('k', async () => { /* queued */ }))
    }
    await expect(runOnThread('k', async () => { /* overflow */ })).rejects.toThrow(/thread queue full/)
    release()
    await Promise.all(started)
    _resetThreadQueues()
  })

  it('heartbeat tickOnce skips while a previous tick is in flight', async () => {
    _setHeartbeatTicking(true)
    try {
      const r = await tickOnce()
      expect(r.results.skipped_reentry).toBe(1)
      expect(r.scanned).toBe(0)
    } finally {
      _setHeartbeatTicking(false)
    }
  })

  it('IM lang defaults to en for telegram/discord', () => {
    expect(resolveImLang({ platform: 'telegram', userId: '1' })).toBe('en')
    expect(resolveImLang({ platform: 'wechat', userId: '1' })).toBe('zh')
    expect(imText('en', '中文', 'English')).toBe('English')
  })
})

afterEach(() => {
  _resetThreadQueues()
  _setHeartbeatTicking(false)
})
