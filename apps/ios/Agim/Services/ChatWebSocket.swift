import Foundation
import OSLog

private let wsLog = Logger(subsystem: "host.iclaw.agim", category: "ws")

/// WebSocket client for `/ws` with token auth + ping-confirmed open + backoff.
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
    private var handshakeWork: DispatchWorkItem?
    private var didAnnounceOpen = false

    var onMessage: MessageHandler?
    var onStatus: StatusHandler?
    /// Last transport / handshake failure (shown in UI).
    private(set) var lastTransportError: String?

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
        handshakeWork?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        didAnnounceOpen = false
        onStatus?(.closed)
    }

    /// Force a fresh handshake (call when returning to foreground).
    func reconnectNow() {
        guard !closed else { return }
        attempt = 0
        reconnectWork?.cancel()
        handshakeWork?.cancel()
        didAnnounceOpen = false
        task?.cancel(with: .goingAway, reason: nil)
        open()
    }

    @discardableResult
    func send(_ message: ChatOutgoing) -> Bool {
        guard let task, didAnnounceOpen else {
            wsLog.error("send skipped — socket not ready")
            return false
        }
        guard let data = try? JSONEncoder().encode(message),
              let text = String(data: data, encoding: .utf8)
        else { return false }
        task.send(.string(text)) { [weak self] error in
            if let error {
                wsLog.error("send failed: \(error.localizedDescription, privacy: .public)")
                Task { @MainActor in
                    self?.lastTransportError = error.localizedDescription
                    self?.onStatus?(.error)
                }
            }
        }
        return true
    }

    private func open() {
        guard var url = PairingParser.wsURL(host: credentials.host, token: credentials.token) else {
            lastTransportError = "无效的主机地址"
            onStatus?(.error)
            scheduleReconnect()
            return
        }
        // Server accepts Bearer and ?token=; keep Bearer as defence-in-depth.

        didAnnounceOpen = false
        lastTransportError = nil
        onStatus?(.connecting)
        wsLog.info("connecting \(url.absoluteString, privacy: .public)")

        session?.invalidateAndCancel()
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        config.timeoutIntervalForRequest = 30
        let session = URLSession(configuration: config)
        self.session = session

        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()
        receiveLoop()
        confirmHandshake(task)
    }

    /// URLSessionWebSocketTask has no "open" event — confirm with ping
    /// (or fall back after first inbound frame via markOpen).
    private func confirmHandshake(_ task: URLSessionWebSocketTask) {
        handshakeWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                guard let self, !self.closed, !self.didAnnounceOpen else { return }
                self.lastTransportError = "连接超时，正在重试…"
                self.onStatus?(.error)
                self.scheduleReconnect()
            }
        }
        handshakeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: work)

        task.sendPing { [weak self] error in
            Task { @MainActor in
                guard let self, !self.closed else { return }
                if let error {
                    wsLog.error("ping failed: \(error.localizedDescription, privacy: .public)")
                    self.lastTransportError = error.localizedDescription
                    // Still wait for inbound frames; don't reconnect yet —
                    // some servers reject ping but send `init` anyway.
                    return
                }
                self.markOpen(reason: "ping")
            }
        }
    }

    private func markOpen(reason: String) {
        guard !closed, !didAnnounceOpen else { return }
        handshakeWork?.cancel()
        didAnnounceOpen = true
        attempt = 0
        lastTransportError = nil
        wsLog.info("open via \(reason, privacy: .public)")
        onStatus?(.open)
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            Task { @MainActor in
                switch result {
                case .failure(let error):
                    wsLog.error("receive failed: \(error.localizedDescription, privacy: .public)")
                    self.didAnnounceOpen = false
                    self.lastTransportError = error.localizedDescription
                    self.onStatus?(.closed)
                    if !self.closed { self.scheduleReconnect() }
                case .success(let message):
                    // First frame proves the upgrade succeeded.
                    self.markOpen(reason: "frame")
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
            wsLog.error("decode failed: \(error.localizedDescription, privacy: .public) raw=\(text.prefix(180), privacy: .public)")
            // Soft-decode: recover type so we don't drop everything silently.
            if let type = softType(data) {
                onMessage?(.unknown(type))
            }
        }
    }

    private func softType(_ data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String
        else { return nil }
        return type
    }

    private func scheduleReconnect() {
        guard !closed else { return }
        reconnectWork?.cancel()
        handshakeWork?.cancel()
        let delay = backoff[min(attempt, backoff.count - 1)]
        attempt += 1
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in self?.open() }
        }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }
}
