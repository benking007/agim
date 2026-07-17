import SwiftUI
import WebKit

/// Native shell: WKWebView loads Agim `/m/chat` (Agent Portal WebUI).
struct WebShellView: View {
    let credentials: HostCredentials
    var onLogout: () -> Void

    @State private var reloadToken = UUID()
    @State private var showMenu = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            WebViewRepresentable(credentials: credentials, reloadToken: reloadToken)
                .ignoresSafeArea(edges: .bottom)

            Button {
                showMenu = true
            } label: {
                Image(systemName: "ellipsis.circle.fill")
                    .font(.title2)
                    .symbolRenderingMode(.hierarchical)
                    .padding(12)
            }
            .confirmationDialog("Agim", isPresented: $showMenu, titleVisibility: .visible) {
                Button("刷新") { reloadToken = UUID() }
                Button("退出登录", role: .destructive, action: onLogout)
                Button("取消", role: .cancel) {}
            }
        }
    }
}

struct WebViewRepresentable: UIViewRepresentable {
    let credentials: HostCredentials
    let reloadToken: UUID

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
        if context.coordinator.lastReloadToken != reloadToken {
            context.coordinator.lastReloadToken = reloadToken
            context.coordinator.credentials = credentials
            context.coordinator.loadPortal()
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var credentials: HostCredentials
        weak var webView: WKWebView?
        var lastReloadToken = UUID()

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
    }
}
