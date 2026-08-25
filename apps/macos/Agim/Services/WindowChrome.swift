import AppKit
import SwiftUI

/// Hide the native window title string. SwiftUI's `WindowGroup` keeps
/// rewriting `NSWindow.title` to the app name ("Agim"); a one-shot
/// `titleVisibility = .hidden` in `DispatchQueue.main.async` loses that race.
enum AgimWindowChrome {
    static func hideNativeTitle(_ window: NSWindow) {
        if window.titleVisibility != .hidden {
            window.titleVisibility = .hidden
        }
        if !window.title.isEmpty {
            window.title = ""
        }
    }

    static func hideNativeTitleOnAllWindows() {
        for window in NSApp.windows {
            hideNativeTitle(window)
        }
    }
}

final class AgimAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        AgimWindowChrome.hideNativeTitleOnAllWindows()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        AgimWindowChrome.hideNativeTitleOnAllWindows()
    }
}

/// Zero-size view that binds to the hosting `NSWindow` and re-hides the
/// title whenever SwiftUI assigns it again.
final class NativeTitleHidingView: NSView {
    private var titleObservation: NSKeyValueObservation?
    private var visibilityObservation: NSKeyValueObservation?

    override var intrinsicContentSize: NSSize { .zero }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        titleObservation?.invalidate()
        visibilityObservation?.invalidate()
        guard let window else { return }
        AgimWindowChrome.hideNativeTitle(window)
        titleObservation = window.observe(\.title, options: [.new]) { win, _ in
            AgimWindowChrome.hideNativeTitle(win)
        }
        visibilityObservation = window.observe(\.titleVisibility, options: [.new]) { win, _ in
            AgimWindowChrome.hideNativeTitle(win)
        }
    }

    deinit {
        titleObservation?.invalidate()
        visibilityObservation?.invalidate()
    }
}

struct WindowTitleHider: NSViewRepresentable {
    func makeNSView(context: Context) -> NativeTitleHidingView {
        NativeTitleHidingView()
    }

    func updateNSView(_ view: NativeTitleHidingView, context: Context) {
        if let window = view.window {
            AgimWindowChrome.hideNativeTitle(window)
        }
    }
}
