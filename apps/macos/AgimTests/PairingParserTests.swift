import XCTest
@testable import Agim

final class PairingParserTests: XCTestCase {
    func testParseHostOnlyURL() {
        let url = URL(string: "https://agent.iclaw.host/m/chat")!
        let r = PairingParser.parseURL(url)
        XCTAssertEqual(r?.host, "https://agent.iclaw.host")
    }

    func testParseLegacyMobileLoginURLIgnoresToken() {
        let url = URL(string: "https://agent.iclaw.host/m/login?t=agim_abc123&next=%2Fm%2Fchat")!
        let r = PairingParser.parseURL(url)
        XCTAssertEqual(r?.host, "https://agent.iclaw.host")
    }

    func testParseHostWithPort() {
        let url = URL(string: "http://192.168.1.8:3000/login")!
        let r = PairingParser.parseURL(url)
        XCTAssertEqual(r?.host, "http://192.168.1.8:3000")
    }

    func testParseDeepLinkHostOnly() {
        let url = URL(string: "agim://pair?host=https%3A%2F%2Fexample.com")!
        let r = PairingParser.parseURL(url)
        XCTAssertEqual(r?.host, "https://example.com")
    }

    func testParseDeepLinkIgnoresLegacyToken() {
        let url = URL(string: "agim://pair?t=agim_tok&host=https%3A%2F%2Fexample.com")!
        let r = PairingParser.parseURL(url)
        XCTAssertEqual(r?.host, "https://example.com")
    }

    func testParseBareHostname() {
        let r = PairingParser.parse("agent.example.com")
        XCTAssertEqual(r?.host, "https://agent.example.com")
    }

    func testParseRejectsBareToken() {
        XCTAssertNil(PairingParser.parse("agim_abc123"))
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

    func testEntryURLUsesSession() {
        XCTAssertEqual(
            PairingParser.entryURL(host: "https://example.com", hasSession: true)?.absoluteString,
            "https://example.com/m/chat"
        )
        let login = PairingParser.entryURL(host: "https://example.com", hasSession: false)
        XCTAssertEqual(login?.path, "/login")
        let items = URLComponents(url: login!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.first(where: { $0.name == "next" })?.value, "/m/chat")
    }

    func testLegacyKeychainJSONDropsToken() throws {
        let data = #"{"host":"https://example.com","token":"agim_old"}"#.data(using: .utf8)!
        let creds = try JSONDecoder().decode(HostCredentials.self, from: data)
        XCTAssertEqual(creds.host, "https://example.com")
    }

    func testSessionCookieMatch() {
        let cookie = HTTPCookie(properties: [
            .domain: "example.com",
            .path: "/",
            .name: "agim_session",
            .value: "abc",
        ])!
        XCTAssertTrue(SessionProbe.cookieBelongs(cookie, toHost: "https://example.com"))
        XCTAssertFalse(SessionProbe.cookieBelongs(cookie, toHost: "https://other.com"))

        let tokenCookie = HTTPCookie(properties: [
            .domain: "example.com",
            .path: "/",
            .name: "agim_token",
            .value: "abc",
        ])!
        XCTAssertFalse(SessionProbe.cookieBelongs(tokenCookie, toHost: "https://example.com"))
    }

    func testAuthPath() {
        XCTAssertTrue(SessionProbe.isAuthPath("/login"))
        XCTAssertTrue(SessionProbe.isAuthPath("/register"))
        XCTAssertFalse(SessionProbe.isAuthPath("/m/chat"))
    }
}
