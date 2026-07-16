import Foundation

/// Wire types for `/ws` — mirror `src/web-app/src/types/ws.ts`.

enum ChatOutgoing: Encodable {
    case message(text: String, agent: String?)
    case switchAgent(agent: String)
    case getAgents
    case getHistory(threadId: String?)
    case newConversation
    case approvalAction(data: String, messageId: String)
    case choiceAction(data: String, messageId: String)

    private enum CodingKeys: String, CodingKey {
        case type, text, agent, threadId, data, messageId
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .message(let text, let agent):
            try c.encode("message", forKey: .type)
            try c.encode(text, forKey: .text)
            try c.encodeIfPresent(agent, forKey: .agent)
        case .switchAgent(let agent):
            try c.encode("switch-agent", forKey: .type)
            try c.encode(agent, forKey: .agent)
        case .getAgents:
            try c.encode("get-agents", forKey: .type)
        case .getHistory(let threadId):
            try c.encode("get-history", forKey: .type)
            try c.encodeIfPresent(threadId, forKey: .threadId)
        case .newConversation:
            try c.encode("new-conversation", forKey: .type)
        case .approvalAction(let data, let messageId):
            try c.encode("approval-action", forKey: .type)
            try c.encode(data, forKey: .data)
            try c.encode(messageId, forKey: .messageId)
        case .choiceAction(let data, let messageId):
            try c.encode("choice-action", forKey: .type)
            try c.encode(data, forKey: .data)
            try c.encode(messageId, forKey: .messageId)
        }
    }
}

enum ChatIncoming: Decodable {
    case initSession(agents: [String], defaultAgent: String, clientId: String)
    case history(messages: [HistoryMessage], agent: String)
    case agents([String])
    case agentSwitched(String)
    case chunk(text: String, runId: String?)
    case done(text: String, runId: String?)
    case runStart(runId: String, agent: String, startedAt: String)
    case usage(runId: String, durationMs: Double, outputChars: Int)
    case runFinish(runId: String, status: String, finishedAt: String, durationMs: Double, error: String?)
    case activityStep(runId: String, step: ActivityStepDTO)
    case activeRun(ActiveRunDTO)
    case error(String)
    case approvalCard(messageId: String, prompt: ApprovalCardPrompt)
    case approvalCardEdit(messageId: String, outcome: ApprovalCardOutcome)
    case choiceCard(messageId: String, prompt: ChoiceCardPrompt)
    case choiceCardEdit(messageId: String, finalText: String)
    case metrics
    case unknown(String)

    private enum CodingKeys: String, CodingKey {
        case type, agents, defaultAgent, clientId, messages, agent
        case text, runId, startedAt, durationMs, outputChars, finishedAt
        case status, error, step, messageId, prompt, outcome, finalText, message
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "init":
            self = .initSession(
                agents: try c.decode([String].self, forKey: .agents),
                defaultAgent: try c.decode(String.self, forKey: .defaultAgent),
                clientId: try c.decode(String.self, forKey: .clientId)
            )
        case "history":
            self = .history(
                messages: try c.decodeIfPresent([HistoryMessage].self, forKey: .messages) ?? [],
                agent: try c.decodeIfPresent(String.self, forKey: .agent) ?? ""
            )
        case "agents":
            self = .agents(try c.decode([String].self, forKey: .agents))
        case "agent-switched":
            self = .agentSwitched(try c.decode(String.self, forKey: .agent))
        case "chunk":
            self = .chunk(
                text: try c.decode(String.self, forKey: .text),
                runId: try c.decodeIfPresent(String.self, forKey: .runId)
            )
        case "done":
            self = .done(
                text: try c.decode(String.self, forKey: .text),
                runId: try c.decodeIfPresent(String.self, forKey: .runId)
            )
        case "run-start":
            self = .runStart(
                runId: try c.decode(String.self, forKey: .runId),
                agent: try c.decode(String.self, forKey: .agent),
                startedAt: try c.decode(String.self, forKey: .startedAt)
            )
        case "usage":
            self = .usage(
                runId: try c.decode(String.self, forKey: .runId),
                durationMs: try c.decode(Double.self, forKey: .durationMs),
                outputChars: try c.decode(Int.self, forKey: .outputChars)
            )
        case "run-finish":
            self = .runFinish(
                runId: try c.decode(String.self, forKey: .runId),
                status: try c.decode(String.self, forKey: .status),
                finishedAt: try c.decode(String.self, forKey: .finishedAt),
                durationMs: try c.decode(Double.self, forKey: .durationMs),
                error: try c.decodeIfPresent(String.self, forKey: .error)
            )
        case "activity-step":
            self = .activityStep(
                runId: try c.decode(String.self, forKey: .runId),
                step: try c.decode(ActivityStepDTO.self, forKey: .step)
            )
        case "active-run":
            self = .activeRun(try ActiveRunDTO(from: decoder))
        case "error":
            if let message = try c.decodeIfPresent(String.self, forKey: .message), !message.isEmpty {
                self = .error(message)
            } else if let message = try c.decodeIfPresent(String.self, forKey: .text), !message.isEmpty {
                self = .error(message)
            } else if let message = try c.decodeIfPresent(String.self, forKey: .error), !message.isEmpty {
                self = .error(message)
            } else {
                self = .error("error")
            }
        case "approval-card":
            self = .approvalCard(
                messageId: try c.decode(String.self, forKey: .messageId),
                prompt: try c.decode(ApprovalCardPrompt.self, forKey: .prompt)
            )
        case "approval-card-edit":
            self = .approvalCardEdit(
                messageId: try c.decode(String.self, forKey: .messageId),
                outcome: try c.decode(ApprovalCardOutcome.self, forKey: .outcome)
            )
        case "choice-card":
            self = .choiceCard(
                messageId: try c.decode(String.self, forKey: .messageId),
                prompt: try c.decode(ChoiceCardPrompt.self, forKey: .prompt)
            )
        case "choice-card-edit":
            self = .choiceCardEdit(
                messageId: try c.decode(String.self, forKey: .messageId),
                finalText: try c.decode(String.self, forKey: .finalText)
            )
        case "metrics", "approval-text":
            self = .metrics
        default:
            self = .unknown(type)
        }
    }
}

struct HistoryMessage: Decodable {
    let role: String
    let content: String
    let timestamp: String?
    let agent: String?
    let activity: HistoryActivity?
}

struct HistoryActivity: Decodable {
    let runId: String
    let status: String
    let startedAt: Double
    let finishedAt: Double?
    let durationMs: Double?
    let error: String?
    let steps: [ActivityStepDTO]
}

struct ActivityStepDTO: Decodable, Hashable {
    let id: String
    let kind: String
    let label: String
    let status: String
    let startedAt: FlexibleDate
    let finishedAt: FlexibleDate?
    let preview: String?
}

struct ActiveRunDTO: Decodable {
    let type: String
    let runId: String
    let agent: String
    let startedAt: String
    let status: String
    let steps: [ActivityStepDTO]
    let partialText: String
    let finishedAt: String?
    let durationMs: Double?
    let error: String?
}

struct ApprovalCardPrompt: Decodable, Hashable {
    let reqId: String
    let toolName: String
    let inputJson: String
    let mode: String
    let graceSeconds: Double?
}

struct ApprovalCardOutcome: Decodable, Hashable {
    let decision: String
    let byUserDisplay: String?
    let atDate: String?
}

struct ChoiceCardPrompt: Decodable, Hashable {
    let title: String?
    let body: String
    let choices: [ChoiceItem]
    let links: [ChoiceLink]?
    let meta: ChoiceCardMeta?
}

struct ChoiceItem: Decodable, Hashable {
    let label: String
    let data: String
}

struct ChoiceLink: Decodable, Hashable {
    let label: String
    let url: String
}

struct ChoiceCardMeta: Decodable, Hashable {
    let kind: String
    let reqId: String
    let selectionMode: String
    let minSelections: Int
    let maxSelections: Int
    let allowCustomInput: Bool
    let customInputLabel: String
    let timeoutSec: Int
}

/// Accepts epoch ms (number) or ISO string from the server.
enum FlexibleDate: Decodable, Hashable {
    case millis(Double)
    case iso(String)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Double.self) {
            self = .millis(n)
            return
        }
        if let s = try? c.decode(String.self) {
            self = .iso(s)
            return
        }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "expected date")
    }

    var millis: Double {
        switch self {
        case .millis(let n): return n
        case .iso(let s):
            if let d = ISO8601DateFormatter().date(from: s) {
                return d.timeIntervalSince1970 * 1000
            }
            return Date().timeIntervalSince1970 * 1000
        }
    }
}
