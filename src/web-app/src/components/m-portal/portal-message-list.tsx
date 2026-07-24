import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MarkdownView } from '@/components/chat/markdown-view'
import { MessageActions } from '@/components/chat/message-actions'
import { agentVisual, displayAgentName } from './agent-visuals'
import { PortalRunStatus } from './portal-run-status'
import { PortalUserContent } from './portal-user-content'
import type { ChatTurn } from './portal-chat-turns'

interface PortalMessageListProps {
  dark: boolean
  active: boolean
  chatTurns: ChatTurn[]
  isEmpty: boolean
  isTyping: boolean
  currentReplyId: string | null | undefined
  streamingFallback: boolean
  agentId: string
  agentColor: string
  AgentIcon: LucideIcon
  portalThreadId: string | null
  listRef: RefObject<HTMLDivElement>
  onFillComposer: (text: string) => void
  onStopSubagent?: (jobId: number) => boolean | undefined
  emptySlot?: React.ReactNode
}

export function PortalMessageList({
  dark,
  active,
  chatTurns,
  isEmpty,
  isTyping,
  currentReplyId,
  streamingFallback,
  agentId,
  agentColor,
  AgentIcon,
  portalThreadId,
  listRef,
  onFillComposer,
  onStopSubagent,
  emptySlot,
}: PortalMessageListProps): JSX.Element {
  const { t } = useTranslation()

  return (
    <div
      ref={listRef}
      className={cn(
        'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-0 pb-40 transition-colors duration-300 scrollbar-none',
        dark ? 'bg-zinc-950' : 'bg-zinc-100',
        !active && 'hidden',
      )}
      aria-hidden={!active}
    >
      <div className="mx-auto flex w-full max-w-[750px] flex-col space-y-4">
        {isEmpty && emptySlot}

        {chatTurns.map((turn) => (
          <div key={turn.id} className="flex w-full flex-col gap-3">
            {turn.user && (
              <div
                data-user-message
                className={cn(
                  'sticky top-0 z-10 w-full min-w-0 overflow-hidden rounded-xl border px-4 py-3 text-left text-base font-medium leading-relaxed',
                  'whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word]',
                  dark
                    ? 'border-zinc-700 bg-zinc-800 text-zinc-100'
                    : 'border-zinc-200 bg-white text-zinc-900',
                )}
                style={{ overflowWrap: 'anywhere', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}
              >
                <PortalUserContent
                  dark={dark}
                  content={turn.user.content}
                  messageId={turn.user.id}
                  threadId={portalThreadId || undefined}
                />
              </div>
            )}
            {turn.replies.map((msg) => (
              <div
                key={msg.id}
                className="mx-auto flex w-[95%] max-w-[95%] min-w-0 flex-col self-center overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300"
                data-testid="portal-ai-reply"
              >
                <div className="w-full min-w-0 space-y-1.5 overflow-x-auto">
                  {(() => {
                    const isCurrent = isTyping && msg.id === currentReplyId
                    const stamped = msg.agent
                    const msgVisual = stamped
                      ? agentVisual(stamped)
                      : { color: 'from-zinc-500 to-zinc-600', icon: Bot as LucideIcon, category: 'Featured', tagline: '' }
                    const MsgIcon = msgVisual.icon
                    const label = stamped ? displayAgentName(stamped) : 'Agent'
                    const showRun = !!msg.activity || isCurrent
                    if (showRun) {
                      return (
                        <PortalRunStatus
                          dark={dark}
                          agentName={label}
                          agentColor={msgVisual.color}
                          AgentIcon={MsgIcon}
                          activity={msg.activity}
                          streaming={isCurrent && (!msg.activity || msg.activity.status === 'running')}
                          onStopSubagent={onStopSubagent}
                        />
                      )
                    }
                    return (
                      <div className="flex items-center gap-2">
                        <div className={cn('rounded-md bg-gradient-to-tr p-1 text-white', msgVisual.color)}>
                          <MsgIcon className="h-3.5 w-3.5" />
                        </div>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                          {label}
                        </span>
                      </div>
                    )
                  })()}
                  {msg.content ? (
                    <div className={cn(
                      'min-w-0 select-text break-words text-base leading-relaxed',
                      dark ? 'text-zinc-200' : 'text-zinc-800',
                    )}>
                      <MarkdownView
                        content={msg.content}
                        className="break-words text-base leading-relaxed"
                      />
                      {!(isTyping && msg.id === currentReplyId) && (
                        <MessageActions
                          key={`${msg.id}:${msg.feedback ?? ''}`}
                          content={msg.content}
                          dark={dark}
                          threadId={portalThreadId || undefined}
                          messageId={msg.id}
                          messageIndex={msg.serverIndex}
                          initialVote={msg.feedback ?? null}
                          onDownvotePrefill={() => onFillComposer(t('chat.portal.feedbackPrefill'))}
                        />
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ))}

        {streamingFallback && (
          <div className="mx-auto w-[95%] max-w-[95%] min-w-0 self-center" data-testid="portal-ai-reply-streaming">
            <PortalRunStatus
              dark={dark}
              agentName={displayAgentName(agentId)}
              agentColor={agentColor}
              AgentIcon={AgentIcon}
              streaming
            />
          </div>
        )}
      </div>
    </div>
  )
}
