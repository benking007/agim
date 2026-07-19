import SwiftUI
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
            'html,body,#root,button,input,textarea,[data-sonner-toaster],[data-sonner-toast]{font-family:"Agim CJK",-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif,"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji"!important;}',
            'html,body,#root{overflow-x:clip!important;max-width:100%!important;touch-action:pan-y!important;}'
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

        // Portal scrolls inside overflow-y:auto divs — disable the document
        // UIScrollView entirely. Otherwise wide tables inflate contentSize
        // and iOS pans the WHOLE page horizontally even with CSS
        // overflow-x:hidden (alwaysBounceHorizontal=false does not help
        // when contentSize.width > bounds.width).
        let sv = webView.scrollView
        sv.contentInsetAdjustmentBehavior = .never
        sv.isScrollEnabled = false
        sv.bounces = false
        sv.alwaysBounceVertical = false
        sv.alwaysBounceHorizontal = false
        sv.showsHorizontalScrollIndicator = false
        sv.isDirectionalLockEnabled = true
        sv.minimumZoomScale = 1
        sv.maximumZoomScale = 1
        // Belt-and-suspenders: if WebKit re-enables scrolling or widens
        // contentSize, pin offset.x / width (do NOT set sv.delegate —
        // WKWebView owns it internally).
        context.coordinator.lockDocumentHorizontalPan(sv)

        webView.isOpaque = false
        webView.backgroundColor = .black
        context.coordinator.webView = webView
        context.coordinator.loadPortal()
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.credentials = credentials
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var credentials: HostCredentials
        weak var webView: WKWebView?
        private var contentSizeObs: NSKeyValueObservation?
        private var contentOffsetObs: NSKeyValueObservation?
        private var boundsObs: NSKeyValueObservation?
        private var pinning = false

        init(credentials: HostCredentials) {
            self.credentials = credentials
        }

        /// Keep WKWebView's document scroll view from panning sideways.
        /// Inner HTML overflow-x:auto (tables/code) still scroll on their own.
        func lockDocumentHorizontalPan(_ scrollView: UIScrollView) {
            let pin: (UIScrollView) -> Void = { [weak self] sv in
                guard let self, !self.pinning else { return }
                self.pinning = true
                defer { self.pinning = false }
                let w = sv.bounds.width
                if w > 1, sv.contentSize.width > w + 0.5 {
                    sv.contentSize = CGSize(width: w, height: sv.contentSize.height)
                }
                if abs(sv.contentOffset.x) > 0.5 {
                    sv.contentOffset = CGPoint(x: 0, y: sv.contentOffset.y)
                }
                // Portal owns vertical scroll; keep document scroller off.
                if sv.isScrollEnabled {
                    sv.isScrollEnabled = false
                }
            }
            contentSizeObs = scrollView.observe(\.contentSize, options: [.new]) { sv, _ in
                pin(sv)
            }
            contentOffsetObs = scrollView.observe(\.contentOffset, options: [.new]) { sv, _ in
                pin(sv)
            }
            boundsObs = scrollView.observe(\.bounds, options: [.new]) { sv, _ in
                pin(sv)
            }
            pin(scrollView)
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
