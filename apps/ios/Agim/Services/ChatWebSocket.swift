import Foundation

/// WebSocket client for `/ws` with Bearer auth + exponential backoff.
@MainActor
final class ChatWebSocket {
    typealias MessageHandler = (ChatIncoming) -> Void
    typealias StatusHandler = (ConnectionStatus) -> Void

    private let credentials: HostCredentials
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var closed = false
    private var attempt = 0
    private var reconnectWork: DispatchWorkItem?

    var onMessage: MessageHandler?
    var onStatus: StatusHandler?

    private let backoff: [TimeInterval] = [1, 2, 5, 10, 30]

    init(credentials: HostCredentials) {
        self.credentials = credentials
    }

    func connect() {
        closed = false
        open()
    }

    func disconnect() {
        closed = true
        reconnectWork?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        onStatus?(.closed)
    }

    /// Force a fresh handshake (call when returning to foreground).
    func reconnectNow() {
        guard !closed else { return }
        attempt = 0
        reconnectWork?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        open()
    }

    @discardableResult
    func send(_ message: ChatOutgoing) -> Bool {
        guard let task, task.state == .running else { return false }
        guard let data = try? JSONEncoder().encode(message),
              let text = String(data: data, encoding: .utf8)
        else { return false }
        task.send(.string(text)) { [weak self] error in
            if error != nil {
                Task { @MainActor in self?.onStatus?(.error) }
            }
        }
        return true
    }

    private func open() {
        guard let url = PairingParser.wsURL(host: credentials.host) else {
            onStatus?(.error)
            scheduleReconnect()
            return
        }
        onStatus?(.connecting)

        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        let session = URLSession(configuration: config)
        self.session = session

        var request = URLRequest(url: url)
        request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()
        onStatus?(.open)
        attempt = 0
        receiveLoop()
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            Task { @MainActor in
                switch result {
                case .failure:
                    self.onStatus?(.closed)
                    if !self.closed { self.scheduleReconnect() }
                case .success(let message):
                    self.handle(message)
                    if !self.closed { self.receiveLoop() }
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let text: String?
        switch message {
        case .string(let s): text = s
        case .data(let d): text = String(data: d, encoding: .utf8)
        @unknown default: text = nil
        }
        guard let text, let data = text.data(using: .utf8) else { return }
        do {
            let incoming = try JSONDecoder().decode(ChatIncoming.self, from: data)
            onMessage?(incoming)
        } catch {
            // Drop unknown / malformed frames — matches SPA behavior.
        }
    }

    private func scheduleReconnect() {
        guard !closed else { return }
        reconnectWork?.cancel()
        let delay = backoff[min(attempt, backoff.count - 1)]
        attempt += 1
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in self?.open() }
        }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }
}
