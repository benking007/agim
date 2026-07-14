/**
 * DEV-only visual playground for ApprovalDock / AskDock floating sheets.
 * Not linked from nav — open /dev/chat-docks directly.
 */

import { useState } from 'react'
import { ApprovalDock } from '@/components/chat/approval-dock'
import { AskDock } from '@/components/chat/ask-dock'
import { ChatComposer } from '@/components/chat/chat-composer'
import type { PendingApproval, PendingAsk } from '@/hooks/use-chat'

const sampleApproval: PendingApproval = {
  messageId: 'demo-apv',
  prompt: {
    reqId: 'demo-req',
    toolName: 'agim_exec',
    inputJson: JSON.stringify({
      command: 'npm test',
      cwd: '/workspace',
      timeoutMs: 120000,
    }),
    mode: 'explicit',
  },
}

const sampleAsk: PendingAsk = {
  messageId: 'demo-ask',
  prompt: {
    title: 'Deploy target',
    body: 'Which environment should we ship to?',
    choices: [
      { label: 'Staging', data: 'ask:demo:1' },
      { label: 'Production', data: 'ask:demo:2' },
    ],
    meta: {
      kind: 'ask-user',
      reqId: 'demo',
      selectionMode: 'single',
      minSelections: 1,
      maxSelections: 1,
      allowCustomInput: false,
      customInputLabel: '',
      timeoutSec: 90,
    },
  },
}

export default function ChatDocksPreviewRoute(): JSX.Element {
  const [input, setInput] = useState('')
  const [showAsk, setShowAsk] = useState(false)

  return (
    <div className="flex h-dvh flex-col bg-bg">
      <header className="border-b border-border bg-surface px-4 py-3">
        <h1 className="text-sm font-semibold">DEV · chat docks preview</h1>
        <p className="text-xs text-text-dim">
          Toggle ask sheet:{' '}
          <button
            type="button"
            className="underline"
            onClick={() => setShowAsk((v) => !v)}
          >
            {showAsk ? 'hide ask' : 'show ask'}
          </button>
        </p>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-6 text-sm text-text-dim">
        <p>Message list placeholder — docks float above the composer.</p>
      </div>
      <ApprovalDock
        approvals={showAsk ? [] : [sampleApproval]}
        onApprove={() => true}
      />
      <AskDock
        asks={showAsk ? [sampleAsk] : []}
        onSubmit={() => true}
      />
      <ChatComposer
        value={input}
        onChange={setInput}
        onSubmit={() => setInput('')}
        placeholder="Composer stays below the floating sheet…"
      />
    </div>
  )
}
