import SwiftUI
import WebKit

@main
struct AgimApp: App {
    @State private var session = AppSession()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .onOpenURL { url in
                    session.handleDeepLink(url)
                }
        }
    }
}

@MainActor
@Observable
final class AppSession {
    var credentials: HostCredentials?
    var pairingError: String?

    init() {
        credentials = KeychainStore.load()
    }

    var isPaired: Bool { credentials != nil }

    func pair(_ result: PairingParser.Result) {
        let creds = HostCredentials(host: result.host, token: result.token)
        do {
            try KeychainStore.save(creds)
            credentials = creds
            pairingError = nil
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
        KeychainStore.clear()
        credentials = nil
    }
}
