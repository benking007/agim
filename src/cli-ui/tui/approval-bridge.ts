import type {
  ApprovalCardOutcome,
  ApprovalCardPrompt,
  ButtonCallback,
  MessageContext,
  MessengerAdapter,
} from '../../core/types.js'

export interface TuiApprovalView {
  messageId: string
  threadId: string
  prompt: ApprovalCardPrompt
  outcome?: ApprovalCardOutcome
}

export type TuiApprovalChoice = 'y' | 'n' | 'a'

type Listener = (approval: TuiApprovalView | null) => void

function choiceFromText(text: string): 'y' | 'n' | 'a' | null {
  const normalized = text.trim().toLowerCase()
  const stripped = normalized.startsWith('/') ? normalized.slice(1) : normalized
  if (['y', 'yes', 'ok', '1', '批准', '同意', '通过', '可以'].includes(stripped)) return 'y'
  if (['n', 'no', '0', '拒绝', '不同意', '不行', '不可以', '不'].includes(stripped)) return 'n'
  if (['all', 'a', '全部', '总是', '都同意', '都批准'].includes(stripped)) return 'a'
  return null
}

export class TuiApprovalBridge implements MessengerAdapter {
  readonly name = 'tui'

  private buttonHandler?: (cb: ButtonCallback) => Promise<void>
  private listeners = new Set<Listener>()
  private current: TuiApprovalView | null = null
  private sessionId: string
  private seq = 0

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  setSession(sessionId: string): void {
    this.sessionId = sessionId
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.current)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async start(): Promise<void> {
    // In-process bridge: no external transport to start.
  }

  async stop(): Promise<void> {
    this.current = null
    this.emit()
  }

  onMessage(_handler: (ctx: MessageContext) => Promise<void>): void {
    // TUI input is handled directly by the Ink app.
  }

  async sendMessage(_threadId: string, text: string): Promise<void> {
    if (!this.current) return
    this.current = {
      ...this.current,
      outcome: this.current.outcome ?? {
        decision: text.includes('撤销') ? 'denied-revoked' : 'allowed',
        atDate: new Date(),
      },
    }
    this.emit()
  }

  onButtonCallback(handler: (cb: ButtonCallback) => Promise<void>): void {
    this.buttonHandler = handler
  }

  async sendApprovalCard(threadId: string, prompt: ApprovalCardPrompt): Promise<{ messageId: string }> {
    this.seq += 1
    const messageId = `tui-approval-${Date.now().toString(36)}-${this.seq.toString(36)}`
    this.current = { messageId, threadId, prompt }
    this.emit()
    return { messageId }
  }

  async editApprovalCard(threadId: string, messageId: string, outcome: ApprovalCardOutcome): Promise<void> {
    if (!this.current || this.current.messageId !== messageId) return
    this.current = { ...this.current, threadId, outcome }
    this.emit()
  }

  async submitChoice(choice: TuiApprovalChoice): Promise<boolean> {
    if (!this.current || this.current.outcome || !this.buttonHandler) return false
    const approval = this.current
    await this.buttonHandler({
      data: `apv:${approval.prompt.reqId}:${choice}`,
      threadId: approval.threadId || this.sessionId,
      userId: process.env.USER || 'tui',
      userDisplay: process.env.USER || 'tui',
      messageId: approval.messageId,
      ack: async () => {},
    })
    return true
  }

  async submitText(text: string): Promise<boolean> {
    const choice = choiceFromText(text)
    if (!choice) return false
    return this.submitChoice(choice)
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current)
  }
}
