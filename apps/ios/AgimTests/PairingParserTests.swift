import XCTest
@testable import Agim

final class PairingParserTests: XCTestCase {
    func testParseMobileLoginURL() {
        let url = URL(string: "https://agent.iclaw.host/m/login?t=agim_abc123&next=%2Fm%2Fchat")!
        let r = PairingParser.parseURL(url)
        XCTAssertEqual(r?.host, "https://agent.iclaw.host")
        XCTAssertEqual(r?.token, "agim_abc123")
    }

    func testParseMobileLoginURLWithPort() {
        let url = URL(string: "http://192.168.1.8:3000/m/login?t=agim_x")!
        let r = PairingParser.parseURL(url)
        XCTAssertEqual(r?.host, "http://192.168.1.8:3000")
        XCTAssertEqual(r?.token, "agim_x")
    }

    func testParseDeepLink() {
        let url = URL(string: "agim://pair?t=agim_tok&host=https%3A%2F%2Fexample.com")!
        let r = PairingParser.parseURL(url)
        XCTAssertEqual(r?.host, "https://example.com")
        XCTAssertEqual(r?.token, "agim_tok")
    }

    func testWsURL() {
        XCTAssertEqual(
            PairingParser.wsURL(host: "https://example.com")?.absoluteString,
            "wss://example.com/ws"
        )
        XCTAssertEqual(
            PairingParser.wsURL(host: "http://192.168.1.8:3000")?.absoluteString,
            "ws://192.168.1.8:3000/ws"
        )
    }

    func testNormalizeHostStripsPath() {
        XCTAssertEqual(
            PairingParser.normalizeHost("https://example.com/m/login"),
            "https://example.com"
        )
    }
}
