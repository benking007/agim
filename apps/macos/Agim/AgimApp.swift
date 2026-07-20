import SwiftUI
import WebKit

@main
struct AgimApp: App {
    @State private var session = AppSession()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .frame(minWidth: 380, minHeight: 640)
                .onOpenURL { url in
                    session.handleDeepLink(url)
                }
        }
        .defaultSize(width: 420, height: 780)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .sidebar) {
                Button("重新加载") {
                    session.reload()
                }
                .keyboardShortcut("r", modifiers: [.command])
                .disabled(!session.isPaired)

                Divider()

                Button("退出配对…") {
                    session.logout()
                }
                .disabled(!session.isPaired)
            }
        }
    }
}

@MainActor
@Observable
final class AppSession {
    var credentials: HostCredentials?
    var pairingError: String?
    /// Bumped to ask the WebView shell to reload `/m/login` → `/m/chat`.
    var reloadNonce: Int = 0

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

    func pair(pasted: String) {
        if let parsed = PairingParser.parse(pasted) {
            pair(parsed)
            return
        }
        pairingError = "无法识别配对内容。请粘贴 Settings → Mobile 的登录链接，或分别填写主机与 Token。"
    }

    func handleDeepLink(_ url: URL) {
        if let parsed = PairingParser.parseURL(url) {
            pair(parsed)
        } else {
            pairingError = "无法解析配对链接"
        }
    }

    func reload() {
        reloadNonce &+= 1
    }

    func logout() {
        KeychainStore.clear()
        credentials = nil
        pairingError = nil
        // Drop WKWebView session cookies so the next pair starts clean.
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        let since = Date(timeIntervalSince1970: 0)
        WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: since) {}
    }
}
