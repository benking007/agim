import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// Native chrome on `/login` / `/register` so the user can switch hosts
/// without a token/QR pairing screen.
struct HostSwitcherBar: View {
    let host: String
    var onChangeHost: () -> Void
    @State private var confirm = false

    var body: some View {
        HStack(spacing: 8) {
            Text(host)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer()
            Button("更换主机") { confirm = true }
                .font(.footnote)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.regularMaterial)
        .confirmationDialog("更换主机将退出当前站点，需重新填写地址。", isPresented: $confirm, titleVisibility: .visible) {
            Button("更换主机", role: .destructive, action: onChangeHost)
            Button("取消", role: .cancel) {}
        }
    }
}

@MainActor
@Observable
final class ShellChrome {
    var currentPath: String = ""

    var showHostSwitcher: Bool {
        SessionProbe.isAuthPath(currentPath)
    }
}

/// Native shell: WKWebView loads Agim `/m/chat` (Agent Portal WebUI).
struct WebShellView: View {
    let credentials: HostCredentials
    @Environment(AppSession.self) private var session
    @Environment(\.scenePhase) private var scenePhase
    @State private var chrome = ShellChrome()

    var body: some View {
        VStack(spacing: 0) {
            if chrome.showHostSwitcher {
                HostSwitcherBar(host: credentials.host) {
                    session.logout()
                }
            }
            // Portal stays full-bleed — no native ellipsis overlay (it covered
            // the web theme toggle in the portal header).
            WebViewRepresentable(
                credentials: credentials,
                scenePhase: scenePhase,
                chrome: chrome
            )
            .ignoresSafeArea(edges: .bottom)
        }
    }
}

struct WebViewRepresentable: UIViewRepresentable {
    let credentials: HostCredentials
    var scenePhase: ScenePhase
    var chrome: ShellChrome

    func makeCoordinator() -> Coordinator {
        Coordinator(credentials: credentials, chrome: chrome)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = prefs

        // Identify this WKWebView as the Agim iOS shell so the SPA can
        // branch UX (Enter→newline, share sheet, …) without UA guessing.
        let shellMarker = "window.__AGIM_SHELL__='ios';"
        config.userContentController.addUserScript(
            WKUserScript(source: shellMarker, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        // Force CJK webfont before first paint. Some iOS locales resolve
        // -apple-system without a Han glyph fallback (tofu / [?]). Also
        // declare @font-face here so the face exists even if CSS arrives
        // late; /fonts/ is a public path (must not 302 to login).
        //
        // unicode-range is mandatory: without it Agim CJK claims emoji
        // code points it does not contain → 📋⭐ render as [?]. Keep in
        // sync with src/web-app/src/styles/cjk-font.css.
        let cjkCss = """
        (function(){
          var s=document.createElement('style');
          var ur='U+2E80-2EFF,U+2F00-2FDF,U+3000-303F,U+3040-309F,U+30A0-30FF,U+3100-312F,U+31A0-31BF,U+3400-4DBF,U+4E00-9FFF,U+F900-FAFF,U+FF00-FFEF';
          s.textContent=[
            '@font-face{font-family:"Agim CJK";font-style:normal;font-weight:400;font-display:swap;src:url("/fonts/noto-sans-sc-chinese-simplified-400-normal.woff2") format("woff2");unicode-range:'+ur+';}',
            '@font-face{font-family:"Agim CJK";font-style:normal;font-weight:700;font-display:swap;src:url("/fonts/noto-sans-sc-chinese-simplified-700-normal.woff2") format("woff2");unicode-range:'+ur+';}',
            'html,body,#root,button,input,textarea,[data-sonner-toaster],[data-sonner-toast]{font-family:"Agim CJK",-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif,"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji"!important;}'
          ].join('');
          document.documentElement.appendChild(s);
        })();
        """
        config.userContentController.addUserScript(
            WKUserScript(source: cjkCss, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        // Portal bridges: save-as Markdown + OS share sheet.
        let bridge = WeakScriptMessageHandler(context.coordinator)
        context.coordinator.scriptBridge = bridge
        config.userContentController.add(bridge, name: "agimSaveFile")
        config.userContentController.add(bridge, name: "agimShare")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // Chat list scrolls inside the page; disable WKWebView rubber-banding
        // so pull-down does not drag the whole portal chrome.
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.alwaysBounceHorizontal = false
        webView.isOpaque = false
        webView.backgroundColor = .black
        context.coordinator.webView = webView
        context.coordinator.startURLObservation(webView)
        context.coordinator.loadPortal()
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.credentials = credentials
        context.coordinator.chrome = chrome
        context.coordinator.noteScenePhase(scenePhase)
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        let ucc = uiView.configuration.userContentController
        ucc.removeScriptMessageHandler(forName: "agimSaveFile")
        ucc.removeScriptMessageHandler(forName: "agimShare")
        coordinator.stopURLObservation()
        coordinator.scriptBridge = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var credentials: HostCredentials
        var chrome: ShellChrome
        weak var webView: WKWebView?
        var scriptBridge: WeakScriptMessageHandler?
        private var lastScenePhase: ScenePhase?
        private var urlObservation: NSKeyValueObservation?

        init(credentials: HostCredentials, chrome: ShellChrome) {
            self.credentials = credentials
            self.chrome = chrome
        }

        func startURLObservation(_ webView: WKWebView) {
            urlObservation = webView.observe(\.url, options: [.new]) { [weak self] view, _ in
                self?.applyPath(view.url?.path)
            }
        }

        func stopURLObservation() {
            urlObservation?.invalidate()
            urlObservation = nil
        }

        /// WKWebView often keeps WebSocket.readyState=OPEN after a long
        /// background, while the TCP session is already dead. Tell the SPA
        /// to handshake again so get-history reloads the thread.
        func noteScenePhase(_ phase: ScenePhase) {
            let becameActive = phase == .active && lastScenePhase != .active
            lastScenePhase = phase
            guard becameActive else { return }
            webView?.evaluateJavaScript(
                "window.dispatchEvent(new Event('agim-resume'));",
                completionHandler: nil
            )
        }

        func loadPortal() {
            guard let webView else { return }
            let host = credentials.host
            let store = webView.configuration.websiteDataStore.httpCookieStore
            store.getAllCookies { [weak self] cookies in
                guard let self else { return }
                let hasSession = SessionProbe.hasSessionCookie(cookies, host: host)
                guard let url = PairingParser.entryURL(host: host, hasSession: hasSession) else { return }
                DispatchQueue.main.async {
                    self.webView?.load(URLRequest(url: url))
                }
            }
        }

        private func applyPath(_ path: String?) {
            let next = path ?? ""
            DispatchQueue.main.async { [weak self] in
                self?.chrome.currentPath = next
            }
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            applyPath(webView.url?.path)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            applyPath(webView.url?.path)
        }

        func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
            applyPath(webView.url?.path)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            // Keep navigation inside the paired host; open external links in Safari.
            if let url = navigationAction.request.url,
               let host = URL(string: credentials.host)?.host,
               let navHost = url.host,
               navHost != host,
               url.scheme == "http" || url.scheme == "https" {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
                webView.load(URLRequest(url: url))
            }
            return nil
        }

        /// Portal hold-to-talk: grant mic (and camera if asked) for the paired host.
        @available(iOS 15.0, *)
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(.grant)
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            switch message.name {
            case "agimSaveFile":
                handleSaveFile(message.body)
            case "agimShare":
                handleShare(message.body)
            default:
                break
            }
        }

        private func handleSaveFile(_ body: Any) {
            guard let dict = body as? [String: Any],
                  let content = dict["content"] as? String
            else { return }
            var filename = (dict["filename"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                ?? "agim-reply.md"
            if filename.isEmpty { filename = "agim-reply.md" }
            if !filename.lowercased().hasSuffix(".md") { filename += ".md" }

            do {
                let url = try writeTempMarkdown(filename: filename, content: content)
                presentExport(url: url)
            } catch {
                NSLog("agimSaveFile failed: %@", error.localizedDescription)
            }
        }

        private func handleShare(_ body: Any) {
            guard let dict = body as? [String: Any] else { return }
            let text = (dict["text"] as? String)
                ?? (dict["content"] as? String)
                ?? ""
            guard !text.isEmpty else { return }

            var items: [Any] = [text]
            if let content = dict["content"] as? String, !content.isEmpty {
                var filename = (dict["filename"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                    ?? "agim-reply.md"
                if filename.isEmpty { filename = "agim-reply.md" }
                if !filename.lowercased().hasSuffix(".md") { filename += ".md" }
                if let url = try? writeTempMarkdown(filename: filename, content: content) {
                    items.append(url)
                }
            }

            guard let presenter = topViewController() else { return }
            let activity = UIActivityViewController(activityItems: items, applicationActivities: nil)
            if let pop = activity.popoverPresentationController {
                pop.sourceView = webView
                pop.sourceRect = CGRect(
                    x: (webView?.bounds.midX ?? 0) - 1,
                    y: (webView?.bounds.maxY ?? 0) - 48,
                    width: 2,
                    height: 2
                )
                pop.permittedArrowDirections = [.down]
            }
            presenter.present(activity, animated: true)
        }

        private func writeTempMarkdown(filename: String, content: String) throws -> URL {
            let dir = FileManager.default.temporaryDirectory
                .appendingPathComponent("agim-exports", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(filename)
            try content.write(to: url, atomically: true, encoding: .utf8)
            return url
        }

        private func presentExport(url: URL) {
            guard let presenter = topViewController() else { return }
            let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
            picker.shouldShowFileExtensions = true
            presenter.present(picker, animated: true)
        }

        private func topViewController() -> UIViewController? {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let window = scenes
                .flatMap(\.windows)
                .first(where: \.isKeyWindow)
                ?? scenes.flatMap(\.windows).first
            var top = window?.rootViewController
            while let presented = top?.presentedViewController {
                top = presented
            }
            return top
        }
    }
}

/// Breaks the WKUserContentController ↔ Coordinator retain cycle.
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: (WKScriptMessageHandler & NSObjectProtocol)?

    init(_ target: WKScriptMessageHandler & NSObjectProtocol) {
        self.target = target
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
