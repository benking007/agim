import SwiftUI

@main
struct AgimApp: App {
    @State private var session = AppSession()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .onOpenURL { url in
                    session.handleDeepLink(url)
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        session.chat.handleForeground()
                    }
                }
        }
    }
}

/// App-wide session: credentials + chat store.
@MainActor
@Observable
final class AppSession {
    var credentials: HostCredentials?
    var chat = ChatStore()
    var pairingError: String?

    init() {
        if let saved = KeychainStore.load() {
            credentials = saved
            chat.start(with: saved)
        }
    }

    var isPaired: Bool { credentials != nil }

    func pair(_ result: PairingParser.Result) {
        let creds = HostCredentials(host: result.host, token: result.token)
        do {
            try KeychainStore.save(creds)
            credentials = creds
            pairingError = nil
            chat = ChatStore()
            chat.start(with: creds)
        } catch {
            pairingError = "无法保存凭证：\(error.localizedDescription)"
        }
    }

    func pair(host: String, token: String) {
        guard let normalized = PairingParser.normalizeHost(host) else {
            pairingError = "主机地址无效"
            return
        }
        let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else {
            pairingError = "请填写 Token"
            return
        }
        pair(PairingParser.Result(host: normalized, token: t))
    }

    func handleDeepLink(_ url: URL) {
        if let parsed = PairingParser.parseURL(url) {
            pair(parsed)
        } else {
            pairingError = "无法解析配对链接"
        }
    }

    func logout() {
        chat.logout()
        credentials = nil
    }
}
