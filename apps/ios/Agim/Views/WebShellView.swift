import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// Native shell: WKWebView loads Agim `/m/chat` (Agent Portal WebUI).
struct WebShellView: View {
    let credentials: HostCredentials

    var body: some View {
        // Full-bleed portal only — no native ellipsis overlay (it covered
        // the web theme toggle in the portal header).
        WebViewRepresentable(credentials: credentials)
            .ignoresSafeArea(edges: .bottom)
    }
}

struct WebViewRepresentable: UIViewRepresentable {
    let credentials: HostCredentials

    func makeCoordinator() -> Coordinator {
        Coordinator(credentials: credentials)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = prefs

        // Force CJK webfont before first paint. Some iOS locales resolve
        // -apple-system without a Han glyph fallback (tofu / [?]). Also
        // declare @font-face here so the face exists even if CSS arrives
        // late; /fonts/ is a public path (must not 302 to login).
        let cjkCss = """
        (function(){
          var s=document.createElement('style');
          s.textContent=[
            '@font-face{font-family:"Agim CJK";font-style:normal;font-weight:400;font-display:swap;src:url("/fonts/noto-sans-sc-chinese-simplified-400-normal.woff2") format("woff2");}',
            '@font-face{font-family:"Agim CJK";font-style:normal;font-weight:700;font-display:swap;src:url("/fonts/noto-sans-sc-chinese-simplified-700-normal.woff2") format("woff2");}',
            'html,body,#root,button,input,textarea{font-family:"Agim CJK",-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif!important;}'
          ].join('');
          document.documentElement.appendChild(s);
        })();
        """
        config.userContentController.addUserScript(
            WKUserScript(source: cjkCss, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        // Portal “另存为 Markdown” → Files / document picker (see save-text-file.ts).
        let bridge = WeakScriptMessageHandler(context.coordinator)
        context.coordinator.saveBridge = bridge
        config.userContentController.add(bridge, name: "agimSaveFile")

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
        context.coordinator.loadPortal()
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.credentials = credentials
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "agimSaveFile")
        coordinator.saveBridge = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var credentials: HostCredentials
        weak var webView: WKWebView?
        var saveBridge: WeakScriptMessageHandler?

        init(credentials: HostCredentials) {
            self.credentials = credentials
        }

        func loadPortal() {
            guard let webView else { return }
            // Reuse the existing mobile login bridge: sets cookie + localStorage, then /m/chat.
            var comps = URLComponents(string: credentials.host)
            comps?.path = "/m/login"
            comps?.queryItems = [
                URLQueryItem(name: "t", value: credentials.token),
                URLQueryItem(name: "next", value: "/m/chat"),
            ]
            guard let url = comps?.url else { return }
            webView.load(URLRequest(url: url))
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

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "agimSaveFile" else { return }
            guard let body = message.body as? [String: Any],
                  let content = body["content"] as? String
            else { return }
            var filename = (body["filename"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                ?? "agim-reply.md"
            if filename.isEmpty { filename = "agim-reply.md" }
            if !filename.lowercased().hasSuffix(".md") { filename += ".md" }

            do {
                let dir = FileManager.default.temporaryDirectory
                    .appendingPathComponent("agim-exports", isDirectory: true)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let url = dir.appendingPathComponent(filename)
                try content.write(to: url, atomically: true, encoding: .utf8)
                presentExport(url: url)
            } catch {
                // Best-effort: no web toast channel from native here.
                NSLog("agimSaveFile failed: %@", error.localizedDescription)
            }
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
