// Email messenger adapter — unit tests with a mocked transporter.

import { describe, it, expect, beforeEach } from 'bun:test'
import { EmailAdapter } from '../../src/plugins/messengers/email/email-adapter.js'
import type { Transporter } from 'nodemailer'

function mockTransporter(): {
  transporter: Transporter
  sent: Array<{ to: string; subject: string; text: string; from: string }>
  closed: boolean
} {
  const sent: Array<{ to: string; subject: string; text: string; from: string }> = []
  let closed = false
  const transporter = {
    verify: async () => true,
    sendMail: async (opts: { from: string; to: string; subject: string; text: string }) => {
      sent.push({ from: opts.from, to: opts.to, subject: opts.subject, text: opts.text })
      return { messageId: 'mock-id' }
    },
    close: () => { closed = true },
  } as unknown as Transporter
  return { transporter, sent, get closed() { return closed } } as unknown as {
    transporter: Transporter
    sent: typeof sent
    closed: boolean
  }
}

describe('EmailAdapter', () => {
  let adapter: EmailAdapter
  let mock: ReturnType<typeof mockTransporter>

  beforeEach(() => {
    adapter = new EmailAdapter()
    mock = mockTransporter()
    adapter._setTransporterForTest(mock.transporter, {
      host: 'smtp.test', port: 465, secure: true,
      user: 'u@test', pass: 'p',
      from: 'sender@test',
    })
  })

  it('sendMessage delivers via transporter', async () => {
    await adapter.sendMessage('alice@example.com', '🔔 提醒：喝水')
    expect(mock.sent).toHaveLength(1)
    expect(mock.sent[0].to).toBe('alice@example.com')
    expect(mock.sent[0].text).toBe('🔔 提醒：喝水')
    expect(mock.sent[0].from).toBe('sender@test')
  })

  it('subject = first line, icon stripped, length-capped', async () => {
    await adapter.sendMessage('a@b.com', '🔁 提醒：每日站会\n附加细节...')
    expect(mock.sent[0].subject).toBe('提醒：每日站会')
  })

  it('subject falls back to default when text empty', async () => {
    await adapter.sendMessage('a@b.com', '')
    expect(mock.sent[0].subject).toBe('im-hub 通知')
  })

  it('rejects invalid email', async () => {
    await expect(adapter.sendMessage('not-an-email', 'x')).rejects.toThrow(/Invalid email/)
  })

  it('rejects when transporter not configured', async () => {
    const a = new EmailAdapter()
    // Skip _setTransporterForTest → started=false
    await expect(a.sendMessage('a@b.com', 'x')).rejects.toThrow(/not started/)
  })
})

describe('EmailAdapter — env reading', () => {
  it('readSmtpConfig returns null when env vars missing', async () => {
    const saved = {
      h: process.env.IMHUB_SMTP_HOST,
      u: process.env.IMHUB_SMTP_USER,
      p: process.env.IMHUB_SMTP_PASS,
    }
    delete process.env.IMHUB_SMTP_HOST
    delete process.env.IMHUB_SMTP_USER
    delete process.env.IMHUB_SMTP_PASS
    try {
      const a = new EmailAdapter()
      await a.start()
      expect(a.getEffectiveConfig()).toBeNull()
      // sendMessage should now reject with a clear error
      await expect(a.sendMessage('x@y.com', 'hi')).rejects.toThrow(/not configured/)
    } finally {
      if (saved.h) process.env.IMHUB_SMTP_HOST = saved.h
      if (saved.u) process.env.IMHUB_SMTP_USER = saved.u
      if (saved.p) process.env.IMHUB_SMTP_PASS = saved.p
    }
  })
})
