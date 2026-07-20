import AppKit
import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// Native macOS shell: WKWebView loads Agim `/m/chat` (Agent Portal WebUI).
struct WebShellView: View {
    let credentials: HostCredentials
    let reloadNonce: Int

    var body: some View {
        WebViewRepresentable(credentials: credentials, reloadNonce: reloadNonce)
            .background(Color.black)
    }
}

struct WebViewRepresentable: NSViewRepresentable {
    let credentials: HostCredentials
    let reloadNonce: Int

    func makeCoordinator() -> Coordinator {
        Coordinator(credentials: credentials)
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = prefs

        // Same CJK webfont inject as iOS — avoids tofu when system fonts
        // lack Han glyphs; /fonts/ must stay a public path on the host.
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

        // Portal bridges: save-as Markdown + OS share sheet (see save-text-file.ts / share-content.ts).
        let bridge = WeakScriptMessageHandler(context.coordinator)
        context.coordinator.scriptBridge = bridge
        config.userContentController.add(bridge, name: "agimSaveFile")
        config.userContentController.add(bridge, name: "agimShare")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.underPageBackgroundColor = .black
        context.coordinator.webView = webView
        context.coordinator.loadPortal()
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.credentials = credentials
        if context.coordinator.lastReloadNonce != reloadNonce {
            context.coordinator.lastReloadNonce = reloadNonce
            context.coordinator.loadPortal()
        }
    }

    static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
        let ucc = nsView.configuration.userContentController
        ucc.removeScriptMessageHandler(forName: "agimSaveFile")
        ucc.removeScriptMessageHandler(forName: "agimShare")
        coordinator.scriptBridge = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var credentials: HostCredentials
        var lastReloadNonce: Int = 0
        weak var webView: WKWebView?
        var scriptBridge: WeakScriptMessageHandler?

        init(credentials: HostCredentials) {
            self.credentials = credentials
        }

        func loadPortal() {
            guard let webView else { return }
            // Reuse the existing mobile login bridge: cookie + localStorage, then /m/chat.
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
            // Keep navigation inside the paired host; open external links in the browser.
            if let url = navigationAction.request.url,
               let host = URL(string: credentials.host)?.host,
               let navHost = url.host,
               navHost != host,
               url.scheme == "http" || url.scheme == "https" {
                NSWorkspace.shared.open(url)
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

        /// Required on macOS: without this, `<input type="file">` (拍照/照片/文件)
        /// is treated as Cancel and appears to do nothing.
        func webView(
            _ webView: WKWebView,
            runOpenPanelWith parameters: WKOpenPanelParameters,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping ([URL]?) -> Void
        ) {
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = parameters.allowsDirectories
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.begin { result in
                completionHandler(result == .OK ? panel.urls : nil)
            }
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

            let panel = NSSavePanel()
            panel.canCreateDirectories = true
            panel.isExtensionHidden = false
            panel.nameFieldStringValue = filename
            if let md = UTType(filenameExtension: "md") {
                panel.allowedContentTypes = [md, .plainText]
            } else {
                panel.allowedContentTypes = [.plainText]
            }

            panel.begin { result in
                guard result == .OK, let url = panel.url else { return }
                do {
                    try content.write(to: url, atomically: true, encoding: .utf8)
                } catch {
                    NSAlert(error: error).runModal()
                }
            }
        }

        private func handleShare(_ body: Any) {
            guard let dict = body as? [String: Any] else { return }
            let text = (dict["text"] as? String)
                ?? (dict["content"] as? String)
                ?? ""
            guard !text.isEmpty, let webView else { return }

            var items: [Any] = [text as NSString]
            if let content = dict["content"] as? String, !content.isEmpty {
                var filename = (dict["filename"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                    ?? "agim-reply.md"
                if filename.isEmpty { filename = "agim-reply.md" }
                if !filename.lowercased().hasSuffix(".md") { filename += ".md" }
                let dir = FileManager.default.temporaryDirectory
                    .appendingPathComponent("agim-share", isDirectory: true)
                do {
                    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    let url = dir.appendingPathComponent(filename)
                    try content.write(to: url, atomically: true, encoding: .utf8)
                    items.append(url)
                } catch {
                    // Text-only share still works.
                }
            }

            let picker = NSSharingServicePicker(items: items)
            // Anchor near the bottom-leading of the web view (composer / actions area).
            let anchor = NSRect(x: 24, y: 24, width: 1, height: 1)
            picker.show(relativeTo: anchor, of: webView, preferredEdge: .minY)
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
