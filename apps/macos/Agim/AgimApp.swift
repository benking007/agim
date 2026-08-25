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
    /// Bumped to ask the WebView shell to re-probe `agim_session` and load
    /// `/m/chat` or `/login`.
    var reloadNonce: Int = 0

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

    func pair(pasted: String) {
        if let parsed = PairingParser.parse(pasted) {
            pair(parsed)
            return
        }
        pairingError = "无法识别主机地址。请粘贴 https:// 链接，或填写主机名。"
    }

    func handleDeepLink(_ url: URL) {
        if let parsed = PairingParser.parseURL(url) {
            pair(parsed)
        } else {
            pairingError = "无法解析主机链接"
        }
    }

    func reload() {
        reloadNonce &+= 1
    }

    func logout() {
        KeychainStore.clear()
        credentials = nil
        pairingError = nil
        // Drop WKWebView session cookies so the next host starts clean.
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        let since = Date(timeIntervalSince1970: 0)
        WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: since) {}
    }
}
