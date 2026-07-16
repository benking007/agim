import Foundation
import Observation

/// Chat session state — mirrors `src/web-app/src/hooks/use-chat.ts`.
@MainActor
@Observable
final class ChatStore {
    private(set) var status: ConnectionStatus = .connecting
    private(set) var messages: [ChatMessage] = []
    private(set) var agents: [String] = []
    private(set) var agent: String = ""
    private(set) var currentReplyId: String?
    private(set) var activeRunId: String?
    private(set) var pendingApprovals: [PendingApproval] = []
    private(set) var pendingAsks: [PendingAsk] = []
    private(set) var error: String?
    private(set) var hostLabel: String = ""

    private var socket: ChatWebSocket?
    private var credentials: HostCredentials?
    private var chunkBuffer: String = ""
    private var chunkFlushTask: Task<Void, Never>?

    init() {}

    var isBusy: Bool { currentReplyId != nil || activeRunId != nil }

    var activeActivity: ChatActivity? {
        guard let activeRunId else { return nil }
        return messages.last(where: { $0.activity?.runId == activeRunId })?.activity
            ?? messages.last?.activity
    }

    func start(with credentials: HostCredentials) {
        self.credentials = credentials
        hostLabel = credentials.host
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
        socket?.disconnect()
        let ws = ChatWebSocket(credentials: credentials)
        ws.onStatus = { [weak self] s in
            self?.status = s
            if s == .open {
                self?.bootstrap()
            }
        }
        ws.onMessage = { [weak self] msg in
            self?.handle(msg)
        }
        socket = ws
        ws.connect()
    }

    func handleForeground() {
        guard credentials != nil else { return }
        if status != .open {
            socket?.reconnectNow()
        }
    }

    func disconnect() {
        socket?.disconnect()
        socket = nil
    }

    func logout() {
        disconnect()
        KeychainStore.clear()
        ThreadIDStore.reset()
        messages = []
        pendingApprovals = []
        pendingAsks = []
        credentials = nil
    }

    // MARK: - Outgoing

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard status == .open else {
            error = "未连接，正在重连…"
            return
        }
        let user = ChatMessage(
            id: "u-\(UUID().uuidString)",
            role: .user,
            content: trimmed,
            agent: nil,
            timestamp: Date()
        )
        let placeholder = ChatMessage(
            id: "a-\(UUID().uuidString)",
            role: .assistant,
            content: "",
            agent: agent.isEmpty ? nil : agent,
            timestamp: Date()
        )
        messages.append(user)
        messages.append(placeholder)
        currentReplyId = placeholder.id
        error = nil
        _ = socket?.send(.message(text: trimmed, agent: agent.isEmpty ? nil : agent))
    }

    func switchAgent(_ name: String) {
        guard agents.contains(name) else { return }
        _ = socket?.send(.switchAgent(agent: name))
    }

    func newConversation() {
        messages = []
        currentReplyId = nil
        activeRunId = nil
        pendingApprovals = []
        pendingAsks = []
        error = nil
        ThreadIDStore.reset()
        _ = socket?.send(.newConversation)
        // Re-bind to a fresh thread id on next open bootstrap; also ask now.
        _ = socket?.send(.getHistory(threadId: ThreadIDStore.loadOrCreate()))
    }

    func approvalAction(messageId: String, choice: String) {
        // choice: y | n | a  → apv:<reqId>:<choice>
        guard let pending = pendingApprovals.first(where: { $0.messageId == messageId }) else { return }
        let data = "apv:\(pending.prompt.reqId):\(choice)"
        _ = socket?.send(.approvalAction(data: data, messageId: messageId))
    }

    func choiceAction(messageId: String, data: String) {
        _ = socket?.send(.choiceAction(data: data, messageId: messageId))
    }

    func clearError() { error = nil }

    // MARK: - Incoming

    private func bootstrap() {
        let tid = ThreadIDStore.loadOrCreate()
        _ = socket?.send(.getHistory(threadId: tid))
        _ = socket?.send(.getAgents)
    }

    private func handle(_ msg: ChatIncoming) {
        switch msg {
        case .initSession(let agents, let defaultAgent, _):
            self.agents = agents
            if agent.isEmpty { agent = defaultAgent }

        case .history(let hist, let agentName):
            if !hist.isEmpty {
                messages = hist.enumerated().map { idx, h in
                    mapHistory(h, index: idx)
                }
                currentReplyId = nil
                activeRunId = nil
            }
            if !agentName.isEmpty { agent = agentName }

        case .agents(let list):
            agents = list

        case .agentSwitched(let name):
            agent = name

        case .chunk(let text, _):
            bufferChunk(text)

        case .done(let text, _):
            flushChunks()
            finishReply(finalText: text)

        case .runStart(let runId, let agentName, let startedAt):
            activeRunId = runId
            if !agentName.isEmpty { agent = agentName }
            attachOrCreateActivity(
                runId: runId,
                status: .running,
                startedAt: parseISO(startedAt) ?? Date(),
                agent: agentName
            )

        case .usage:
            break

        case .runFinish(let runId, let status, let finishedAt, let durationMs, let errorText):
            let st: ChatActivity.Status = status == "success" ? .success : .error
            patchActivity(runId: runId) { act in
                act.status = st
                act.finishedAt = parseISO(finishedAt)
                act.durationMs = durationMs
                act.error = errorText
            }
            if activeRunId == runId { activeRunId = nil }

        case .activityStep(let runId, let step):
            let mapped = ChatActivityStep(
                id: step.id,
                kind: step.kind,
                label: step.label,
                status: step.status,
                startedAt: Date(timeIntervalSince1970: step.startedAt.millis / 1000),
                finishedAt: step.finishedAt.map { Date(timeIntervalSince1970: $0.millis / 1000) },
                preview: step.preview
            )
            patchActivity(runId: runId) { act in
                if let i = act.steps.firstIndex(where: { $0.id == mapped.id }) {
                    act.steps[i] = mapped
                } else {
                    act.steps.append(mapped)
                }
            }

        case .activeRun(let dto):
            applyActiveRun(dto)

        case .error(let message):
            flushChunks()
            error = message
            if let idx = activityIndex(replyId: currentReplyId, runId: activeRunId),
               var act = messages[idx].activity, act.status == .running {
                act.status = .error
                act.finishedAt = Date()
                act.error = message
                messages[idx].activity = act
            }
            currentReplyId = nil
            activeRunId = nil

        case .approvalCard(let messageId, let prompt):
            if !pendingApprovals.contains(where: { $0.messageId == messageId }) {
                pendingApprovals.append(PendingApproval(messageId: messageId, prompt: prompt))
            }

        case .approvalCardEdit(let messageId, _):
            pendingApprovals.removeAll { $0.messageId == messageId }

        case .choiceCard(let messageId, let prompt):
            if !pendingAsks.contains(where: { $0.messageId == messageId }) {
                pendingAsks.append(PendingAsk(messageId: messageId, prompt: prompt))
            }

        case .choiceCardEdit(let messageId, _):
            pendingAsks.removeAll { $0.messageId == messageId }

        case .metrics, .unknown:
            break
        }
    }

    // MARK: - Helpers

    private func bufferChunk(_ text: String) {
        chunkBuffer += text
        chunkFlushTask?.cancel()
        chunkFlushTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 40_000_000)
            flushChunks()
        }
    }

    private func flushChunks() {
        chunkFlushTask?.cancel()
        chunkFlushTask = nil
        guard !chunkBuffer.isEmpty, let replyId = currentReplyId,
              let idx = messages.firstIndex(where: { $0.id == replyId })
        else {
            chunkBuffer = ""
            return
        }
        messages[idx].content += chunkBuffer
        chunkBuffer = ""
    }

    private func finishReply(finalText: String) {
        guard let replyId = currentReplyId,
              let idx = messages.firstIndex(where: { $0.id == replyId })
        else {
            currentReplyId = nil
            return
        }
        if !finalText.isEmpty {
            messages[idx].content = finalText
        }
        currentReplyId = nil
    }

    private func mapHistory(_ h: HistoryMessage, index: Int) -> ChatMessage {
        let ts: Date
        if let raw = h.timestamp, let d = parseISO(raw) {
            ts = d
        } else {
            ts = Date().addingTimeInterval(TimeInterval(-index))
        }
        let activity: ChatActivity? = h.activity.map { a in
            ChatActivity(
                runId: a.runId,
                status: ChatActivity.Status(rawValue: a.status) ?? .success,
                startedAt: Date(timeIntervalSince1970: a.startedAt / 1000),
                finishedAt: a.finishedAt.map { Date(timeIntervalSince1970: $0 / 1000) },
                durationMs: a.durationMs,
                error: a.error,
                steps: a.steps.map {
                    ChatActivityStep(
                        id: $0.id,
                        kind: $0.kind,
                        label: $0.label,
                        status: $0.status,
                        startedAt: Date(timeIntervalSince1970: $0.startedAt.millis / 1000),
                        finishedAt: $0.finishedAt.map { Date(timeIntervalSince1970: $0.millis / 1000) },
                        preview: $0.preview
                    )
                }
            )
        }
        return ChatMessage(
            id: "hist-\(index)",
            role: h.role == "user" ? .user : .assistant,
            content: h.content,
            agent: h.agent,
            timestamp: ts,
            activity: activity
        )
    }

    private func applyActiveRun(_ dto: ActiveRunDTO) {
        let started = parseISO(dto.startedAt) ?? Date()
        let finished = dto.finishedAt.flatMap(parseISO)
        let st = ChatActivity.Status(rawValue: dto.status) ?? .running
        let activity = ChatActivity(
            runId: dto.runId,
            status: st,
            startedAt: started,
            finishedAt: finished,
            durationMs: dto.durationMs,
            error: dto.error,
            steps: dto.steps.map {
                ChatActivityStep(
                    id: $0.id,
                    kind: $0.kind,
                    label: $0.label,
                    status: $0.status,
                    startedAt: Date(timeIntervalSince1970: $0.startedAt.millis / 1000),
                    finishedAt: $0.finishedAt.map { Date(timeIntervalSince1970: $0.millis / 1000) },
                    preview: $0.preview
                )
            }
        )

        if let idx = messages.lastIndex(where: { $0.role == .assistant }) {
            messages[idx].activity = activity
            if !dto.partialText.isEmpty {
                messages[idx].content = dto.partialText
            }
            if st == .running {
                let id = "reply-restore-\(dto.runId)"
                messages[idx] = ChatMessage(
                    id: id,
                    role: .assistant,
                    content: messages[idx].content,
                    agent: messages[idx].agent ?? dto.agent,
                    timestamp: messages[idx].timestamp,
                    activity: activity
                )
                currentReplyId = id
                activeRunId = dto.runId
            } else {
                currentReplyId = nil
                activeRunId = nil
            }
        } else if st == .running || !dto.partialText.isEmpty {
            let id = "reply-restore-\(dto.runId)"
            messages.append(ChatMessage(
                id: id,
                role: .assistant,
                content: dto.partialText,
                agent: dto.agent,
                timestamp: started,
                activity: activity
            ))
            currentReplyId = st == .running ? id : nil
            activeRunId = st == .running ? dto.runId : nil
        }
        if !dto.agent.isEmpty { agent = dto.agent }
    }

    private func attachOrCreateActivity(runId: String, status: ChatActivity.Status, startedAt: Date, agent: String) {
        if let idx = activityIndex(replyId: currentReplyId, runId: runId) {
            messages[idx].activity = ChatActivity(
                runId: runId,
                status: status,
                startedAt: startedAt,
                finishedAt: nil,
                durationMs: nil,
                error: nil,
                steps: messages[idx].activity?.steps ?? []
            )
            return
        }
        if let idx = messages.lastIndex(where: { $0.id == currentReplyId }) {
            messages[idx].activity = ChatActivity(
                runId: runId, status: status, startedAt: startedAt,
                finishedAt: nil, durationMs: nil, error: nil, steps: []
            )
            if messages[idx].agent == nil { messages[idx].agent = agent }
        }
    }

    private func patchActivity(runId: String, _ body: (inout ChatActivity) -> Void) {
        guard let idx = activityIndex(replyId: currentReplyId, runId: runId),
              var act = messages[idx].activity
        else { return }
        body(&act)
        messages[idx].activity = act
    }

    private func activityIndex(replyId: String?, runId: String?) -> Int? {
        if let runId, let i = messages.firstIndex(where: { $0.activity?.runId == runId }) {
            return i
        }
        if let replyId, let i = messages.firstIndex(where: { $0.id == replyId }) {
            return i
        }
        return nil
    }

    private func parseISO(_ raw: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: raw) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: raw)
    }
}
