import Foundation

/// Parse a host URL for the native WKWebView shell.
/// Token / QR pairing is retired: the shell stores the origin only and
/// follows `agim_session` (or `/login` when the cookie is missing).
enum PairingParser {
    struct Result: Equatable {
        var host: String
    }

    static func parse(_ raw: String) -> Result? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // Bare API tokens are no longer a pairing method.
        if trimmed.hasPrefix("agim_") {
            return nil
        }

        if let url = URL(string: trimmed), let fromURL = parseURL(url) {
            return fromURL
        }

        if let host = normalizeHost(trimmed) {
            return Result(host: host)
        }
        return nil
    }

    static func parseURL(_ url: URL) -> Result? {
        let scheme = (url.scheme ?? "").lowercased()

        if scheme == "agim" {
            // agim://pair?host=https%3A%2F%2F…  (legacy t=/c= ignored)
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let hostRaw = items.first(where: { $0.name == "host" })?.value
            guard let hostRaw, let host = normalizeHost(hostRaw) else { return nil }
            return Result(host: host)
        }

        if scheme == "http" || scheme == "https" {
            guard let host = normalizeHost(url) else { return nil }
            return Result(host: host)
        }

        return nil
    }

    static func normalizeHost(_ raw: String) -> String? {
        if let url = URL(string: raw), url.scheme != nil, url.host != nil {
            return normalizeHost(url)
        }
        if let url = URL(string: "https://\(raw)") {
            return normalizeHost(url)
        }
        return nil
    }

    static func normalizeHost(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty
        else { return nil }
        var out = "\(scheme)://\(host)"
        if let port = url.port {
            let isDefault = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
            if !isDefault { out += ":\(port)" }
        }
        return out
    }

    /// Portal vs login entry. Missing `agim_session` → `/login?next=/m/chat`.
    static func entryURL(host: String, hasSession: Bool) -> URL? {
        guard var comps = URLComponents(string: host) else { return nil }
        comps.fragment = nil
        if hasSession {
            comps.path = "/m/chat"
            comps.query = nil
        } else {
            comps.path = "/login"
            comps.queryItems = [URLQueryItem(name: "next", value: "/m/chat")]
        }
        return comps.url
    }

    static func wsURL(host: String) -> URL? {
        guard var comps = URLComponents(string: host) else { return nil }
        comps.scheme = (comps.scheme?.lowercased() == "https") ? "wss" : "ws"
        comps.path = "/ws"
        comps.fragment = nil
        comps.query = nil
        return comps.url
    }
}

enum SessionProbe {
    static let cookieName = "agim_session"

    static func isAuthPath(_ path: String) -> Bool {
        path == "/login" || path == "/register"
            || path.hasPrefix("/login/") || path.hasPrefix("/register/")
    }

    static func cookieBelongs(_ cookie: HTTPCookie, toHost host: String) -> Bool {
        guard cookie.name == cookieName else { return false }
        guard let hostName = URL(string: host)?.host?.lowercased() else { return false }
        var domain = cookie.domain.lowercased()
        if domain.hasPrefix(".") { domain.removeFirst() }
        return hostName == domain || hostName.hasSuffix(".\(domain)")
    }

    static func hasSessionCookie(_ cookies: [HTTPCookie], host: String) -> Bool {
        cookies.contains { cookieBelongs($0, toHost: host) }
    }
}
