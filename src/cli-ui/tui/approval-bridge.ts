import type {
  ApprovalCardOutcome,
  ApprovalCardPrompt,
  ChoiceCardPrompt,
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
export type TuiAskSelectionMode = 'single' | 'multi'

export interface TuiAskView {
  messageId: string
  threadId: string
  prompt: ChoiceCardPrompt
  reqId: string
  selectionMode: TuiAskSelectionMode
  minSelections: number
  maxSelections: number
  allowCustomInput: boolean
  customInputLabel: string
  finalText?: string
}

type ApprovalListener = (approval: TuiApprovalView | null) => void
type AskListener = (ask: TuiAskView | null) => void

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
  private listeners = new Set<ApprovalListener>()
  private askListeners = new Set<AskListener>()
  private current: TuiApprovalView | null = null
  private currentAsk: TuiAskView | null = null
  private sessionId: string
  private seq = 0

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  setSession(sessionId: string): void {
    this.sessionId = sessionId
  }

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener)
    listener(this.current)
    return () => {
      this.listeners.delete(listener)
    }
  }

  subscribeAsk(listener: AskListener): () => void {
    this.askListeners.add(listener)
    listener(this.currentAsk)
    return () => {
      this.askListeners.delete(listener)
    }
  }

  async start(): Promise<void> {
    // In-process bridge: no external transport to start.
  }

  async stop(): Promise<void> {
    this.current = null
    this.currentAsk = null
    this.emit()
    this.emitAsk()
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

  async sendChoiceCard(threadId: string, prompt: ChoiceCardPrompt): Promise<{ messageId: string }> {
    this.seq += 1
    const messageId = `tui-choice-${Date.now().toString(36)}-${this.seq.toString(36)}`
    const ask = toTuiAskView(prompt, messageId, threadId)
    if (ask) {
      this.currentAsk = ask
      this.emitAsk()
    }
    return { messageId }
  }

  async editChoiceCard(threadId: string, messageId: string, finalText: string): Promise<void> {
    if (!this.currentAsk || this.currentAsk.messageId !== messageId) return
    this.currentAsk = { ...this.currentAsk, threadId, finalText }
    this.emitAsk()
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

  async submitAskSingle(index: number): Promise<boolean> {
    if (!this.currentAsk || index < 1) return false
    const choice = this.currentAsk.prompt.choices[index - 1]
    if (!choice || choice.data.endsWith(':custom')) return false
    return this.submitAskCallback(`ask:${this.currentAsk.reqId}:${index}`)
  }

  async submitAskMulti(indexes: number[]): Promise<boolean> {
    if (this.currentAsk?.selectionMode !== 'multi') return false
    const normalized = Array.from(new Set(indexes.filter((n) => Number.isInteger(n) && n >= 1))).sort((a, b) => a - b)
    const invalid = normalized.some((index) => {
      const choice = this.currentAsk?.prompt.choices[index - 1]
      return !choice || choice.data.endsWith(':custom')
    })
    if (invalid) return false
    if (normalized.length === 0) return false
    return this.submitAskCallback(`ask:${this.currentAsk.reqId}:multi:${normalized.join(',')}`)
  }

  async submitAskCustom(text: string): Promise<boolean> {
    if (!this.currentAsk?.allowCustomInput) return false
    const trimmed = text.trim()
    if (!trimmed) return false
    const encoded = Buffer.from(trimmed, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
    return this.submitAskCallback(`ask:${this.currentAsk.reqId}:custom:${encoded}`)
  }

  async submitAskText(text: string): Promise<boolean> {
    if (!this.currentAsk) return false
    const trimmed = text.trim()
    if (!trimmed) return false
    const selectableChoices = this.currentAsk.prompt.choices.filter((choice) => !choice.data.endsWith(':custom'))
    const indexes = parseChoiceIndexesFromText(trimmed, selectableChoices.length)
    if (this.currentAsk.selectionMode === 'multi') {
      if (indexes.length > 0) return this.submitAskMulti(indexes)
      if (this.currentAsk.allowCustomInput) return this.submitAskCustom(trimmed)
      return false
    }
    if (indexes.length > 0) return this.submitAskSingle(indexes[0])
    const byLabel = findChoiceByLabel(trimmed, this.currentAsk.prompt.choices)
    if (byLabel) return this.submitAskSingle(byLabel)
    if (this.currentAsk.allowCustomInput) return this.submitAskCustom(trimmed)
    return false
  }

  private async submitAskCallback(data: string): Promise<boolean> {
    if (!this.currentAsk || !this.buttonHandler) return false
    const ask = this.currentAsk
    await this.buttonHandler({
      data,
      threadId: ask.threadId || this.sessionId,
      userId: process.env.USER || 'tui',
      userDisplay: process.env.USER || 'tui',
      messageId: ask.messageId,
      ack: async () => {},
    })
    // Keep TUI responsive: once submitted, close the ask panel locally.
    this.currentAsk = null
    this.emitAsk()
    return true
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current)
  }

  private emitAsk(): void {
    for (const listener of this.askListeners) listener(this.currentAsk)
  }
}

function toTuiAskView(prompt: ChoiceCardPrompt, messageId: string, threadId: string): TuiAskView | null {
  const meta = (prompt.meta && typeof prompt.meta === 'object')
    ? prompt.meta as Record<string, unknown>
    : {}
  const reqIdFromMeta = typeof meta.reqId === 'string' ? meta.reqId : ''
  const reqIdFromData = extractReqIdFromChoices(prompt.choices)
  const reqId = reqIdFromMeta || reqIdFromData
  if (!reqId) return null
  const selectionMode: TuiAskSelectionMode = meta.selectionMode === 'multi' ? 'multi' : 'single'
  const maxFromMeta = typeof meta.maxSelections === 'number' && Number.isFinite(meta.maxSelections)
    ? Math.floor(meta.maxSelections)
    : prompt.choices.length
  const minFromMeta = typeof meta.minSelections === 'number' && Number.isFinite(meta.minSelections)
    ? Math.floor(meta.minSelections)
    : 1
  const maxSelections = maxFromMeta < 1 ? 1 : maxFromMeta
  const minSelections = minFromMeta < 1 ? 1 : Math.min(minFromMeta, maxSelections)
  const customInputLabel = typeof meta.customInputLabel === 'string' && meta.customInputLabel.trim().length > 0
    ? meta.customInputLabel.trim()
    : '其他（自定义输入）'
  return {
    messageId,
    threadId,
    prompt,
    reqId,
    selectionMode,
    minSelections,
    maxSelections,
    allowCustomInput: meta.allowCustomInput === true,
    customInputLabel,
  }
}

function extractReqIdFromChoices(choices: Array<{ label: string; data: string }>): string {
  for (const c of choices) {
    const m = /^ask:([^:]+):/.exec(c.data)
    if (m?.[1]) return m[1]
  }
  return ''
}

function parseChoiceIndexesFromText(text: string, choiceCount: number): number[] {
  const lower = text.toLowerCase()
  const picked = new Set<number>()
  const nums = lower.match(/\d+/g) ?? []
  for (const n of nums) {
    const idx = Number.parseInt(n, 10)
    if (idx >= 1 && idx <= choiceCount) picked.add(idx)
  }
  const letters = lower.match(/\b[a-z]\b/g) ?? []
  for (const token of letters) {
    const i = token.charCodeAt(0) - 'a'.charCodeAt(0)
    if (i >= 0 && i < choiceCount) picked.add(i + 1)
  }
  return Array.from(picked.values()).sort((a, b) => a - b)
}

function normalizeChoiceLabel(label: string): string {
  return label.replace(/^\d+\.\s*/, '').trim()
}

function findChoiceByLabel(input: string, choices: Array<{ label: string; data: string }>): number | null {
  const lower = input.toLowerCase()
  const normalized = choices.map((choice, i) => ({ i, label: normalizeChoiceLabel(choice.label).toLowerCase() }))
  const exact = normalized.find((entry) => entry.label === lower)
  if (exact) return exact.i + 1
  const bySubstring = normalized.find((entry) => lower.includes(entry.label))
  if (bySubstring) return bySubstring.i + 1
  return null
}
