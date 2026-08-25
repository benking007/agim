import AppKit
import XCTest
@testable import Agim

final class WindowChromeTests: XCTestCase {
    func testHideNativeTitleClearsBundleName() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: true
        )
        window.title = "Agim"
        XCTAssertEqual(window.title, "Agim")
        XCTAssertEqual(window.titleVisibility, .visible)

        AgimWindowChrome.hideNativeTitle(window)

        XCTAssertEqual(window.titleVisibility, .hidden)
        XCTAssertEqual(window.title, "")
    }

    func testHideNativeTitleIsIdempotent() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: true
        )
        window.title = "Agim"
        AgimWindowChrome.hideNativeTitle(window)
        AgimWindowChrome.hideNativeTitle(window)
        XCTAssertEqual(window.titleVisibility, .hidden)
        XCTAssertEqual(window.title, "")
    }

    func testHideNativeTitleClearsSwiftUIRewrite() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: true
        )
        AgimWindowChrome.hideNativeTitle(window)
        window.title = "Agim"
        AgimWindowChrome.hideNativeTitle(window)
        XCTAssertEqual(window.title, "")
        XCTAssertEqual(window.titleVisibility, .hidden)
    }
}
