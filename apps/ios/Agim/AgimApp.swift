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
        let creds = HostCredentials(host: result.host)
        do {
            try KeychainStore.save(creds)
            credentials = creds
            pairingError = nil
        } catch {
            pairingError = "无法保存主机地址：\(error.localizedDescription)"
        }
    }

    func pair(host: String) {
        guard let normalized = PairingParser.normalizeHost(host) else {
            pairingError = "主机地址无效"
            return
        }
        pair(PairingParser.Result(host: normalized))
    }

    func handleDeepLink(_ url: URL) {
        if let parsed = PairingParser.parseURL(url) {
            pair(parsed)
        } else {
            pairingError = "无法解析主机链接"
        }
    }

    func logout() {
        KeychainStore.clear()
        credentials = nil
        pairingError = nil
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        let since = Date(timeIntervalSince1970: 0)
        WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: since) {}
    }
}
