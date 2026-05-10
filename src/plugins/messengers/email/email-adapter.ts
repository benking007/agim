// Email messenger adapter (push-only).
//
// Purpose: deliver reminders / notifications to an email address. This
// adapter never receives messages — onMessage is a no-op — so /remind etc.
// addressed to an email arrive as a one-way notification.
//
// SMTP config is read from env at start():
//   IMHUB_SMTP_HOST       SMTP server (required)
//   IMHUB_SMTP_PORT       Port (default: 465 if secure else 587)
//   IMHUB_SMTP_USER       Auth username (required)
//   IMHUB_SMTP_PASS       Auth password / app-password (required)
//   IMHUB_SMTP_FROM       From address (default: USER value)
//   IMHUB_SMTP_SECURE     '1'/'true' for TLS-from-start (port 465); else
//                         STARTTLS on port 587. Default: secure if port 465.
//
// If any of HOST/USER/PASS are missing, start() does NOT throw; the adapter
// stays "registered but disabled" and sendMessage will throw a clear error
// at call time. Same fail-soft model as wechat-credentials.

import nodemailer, { type Transporter } from 'nodemailer'
import type { MessengerAdapter, MessageContext } from '../../../core/types.js'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'email' })

interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  from: string
}

function readSmtpConfig(): SmtpConfig | null {
  const host = process.env.IMHUB_SMTP_HOST?.trim()
  const user = process.env.IMHUB_SMTP_USER?.trim()
  const pass = process.env.IMHUB_SMTP_PASS
  if (!host || !user || !pass) return null
  const portRaw = process.env.IMHUB_SMTP_PORT?.trim()
  const port = portRaw ? Number.parseInt(portRaw, 10) : 465
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    log.warn({ portRaw }, 'IMHUB_SMTP_PORT invalid, falling back to 465')
  }
  const validPort = Number.isFinite(port) && port > 0 && port <= 65535 ? port : 465
  // Default secure: yes for 465 (SMTPS), no for 587/25 (STARTTLS).
  const secureRaw = process.env.IMHUB_SMTP_SECURE?.trim().toLowerCase()
  const secure = secureRaw !== undefined
    ? (secureRaw === '1' || secureRaw === 'true' || secureRaw === 'yes')
    : validPort === 465
  const from = process.env.IMHUB_SMTP_FROM?.trim() || user
  return { host, port: validPort, secure, user, pass, from }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class EmailAdapter implements MessengerAdapter {
  readonly name = 'email'
  private transporter: Transporter | null = null
  private config: SmtpConfig | null = null
  private started = false

  async start(): Promise<void> {
    this.config = readSmtpConfig()
    if (!this.config) {
      log.warn({
        event: 'email.disabled',
        hint: 'set IMHUB_SMTP_HOST / IMHUB_SMTP_USER / IMHUB_SMTP_PASS to enable',
      }, 'Email adapter disabled — SMTP env vars not set')
      this.started = true
      return
    }

    this.transporter = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.pass },
    })

    // Verify connection eagerly so misconfig surfaces at startup instead of
    // at first send. Failure is logged but doesn't block startup — same
    // fail-soft contract as the wechat credentials check.
    try {
      await this.transporter.verify()
      log.info({
        event: 'email.ready',
        host: this.config.host,
        port: this.config.port,
        secure: this.config.secure,
        from: this.config.from,
      }, 'Email adapter ready')
    } catch (err) {
      log.warn({
        event: 'email.verify_failed',
        err: err instanceof Error ? err.message : String(err),
      }, 'SMTP verify failed — sends will likely fail until config is fixed')
    }
    this.started = true
  }

  async stop(): Promise<void> {
    if (this.transporter) {
      this.transporter.close()
      this.transporter = null
    }
    this.started = false
  }

  // onMessage is required by the MessengerAdapter interface, but email is a
  // push-only channel — we never poll an inbox, so the handler is intentionally
  // discarded. The signature is preserved for interface conformance.
  onMessage(_handler: (ctx: MessageContext) => Promise<void>): void {
    // no-op
  }

  /**
   * Send the message body to the email address in `threadId`. Subject is
   * derived from the first line (capped at 100 chars). When SMTP isn't
   * configured we throw a clear "not configured" error so the reminder
   * engine writes it as the failure reason.
   */
  async sendMessage(threadId: string, text: string): Promise<void> {
    if (!this.started) throw new Error('email adapter not started')
    if (!this.transporter || !this.config) {
      throw new Error('Email adapter not configured (set IMHUB_SMTP_HOST / USER / PASS)')
    }
    const to = threadId.trim()
    if (!EMAIL_RE.test(to)) {
      throw new Error(`Invalid email address: "${to}"`)
    }

    // Subject = first non-empty line, stripped of bot icon prefixes, capped.
    const firstLine = text.split('\n').map((s) => s.trim()).find((s) => s.length > 0) || 'im-hub 通知'
    const subject = firstLine.replace(/^(?:🔔|🔁|⏰)\s*/u, '').slice(0, 100)

    await this.transporter.sendMail({
      from: this.config.from,
      to,
      subject,
      text,
    })
    log.info({ event: 'email.sent', to, subjectLen: subject.length, bodyLen: text.length },
      'email delivered')
  }

  /** Test/inspection hook — used by unit tests to verify env reading. */
  getEffectiveConfig(): SmtpConfig | null {
    return this.config
  }

  /** Test hook — inject a mocked transporter to bypass SMTP. */
  _setTransporterForTest(t: Transporter, cfg: SmtpConfig): void {
    this.transporter = t
    this.config = cfg
    this.started = true
  }
}

export const emailAdapter = new EmailAdapter()
