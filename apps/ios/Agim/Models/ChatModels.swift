import Foundation

/// UI / store models (not 1:1 wire DTOs).

struct ChatMessage: Identifiable, Hashable {
    let id: String
    let role: Role
    var content: String
    var agent: String?
    var timestamp: Date
    var activity: ChatActivity?

    enum Role: String, Hashable {
        case user
        case assistant
    }
}

struct ChatActivity: Hashable {
    var runId: String
    var status: Status
    var startedAt: Date
    var finishedAt: Date?
    var durationMs: Double?
    var error: String?
    var steps: [ChatActivityStep]

    enum Status: String, Hashable {
        case running, success, error
    }
}

struct ChatActivityStep: Identifiable, Hashable {
    let id: String
    var kind: String
    var label: String
    var status: String
    var startedAt: Date
    var finishedAt: Date?
    var preview: String?
}

struct PendingApproval: Identifiable, Hashable {
    let messageId: String
    let prompt: ApprovalCardPrompt
}

struct PendingAsk: Identifiable, Hashable {
    let messageId: String
    let prompt: ChoiceCardPrompt
}

enum ConnectionStatus: String {
    case connecting
    case open
    case closed
    case error
}

struct HostCredentials: Codable, Equatable {
    /// Absolute origin, e.g. `https://agent.example.com` (no trailing slash).
    var host: String
    var token: String
}
