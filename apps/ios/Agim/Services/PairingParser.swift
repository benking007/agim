import Foundation

/// Parse pairing payloads from Mobile QR / deep links / pasted URLs.
enum PairingParser {
    struct Result: Equatable {
        var host: String
        var token: String
    }

    static func parse(_ raw: String) -> Result? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let url = URL(string: trimmed), let fromURL = parseURL(url) {
            return fromURL
        }

        // Bare token — host must be supplied separately by the UI.
        if trimmed.hasPrefix("agim_") {
            return nil
        }
        return nil
    }

    static func parseURL(_ url: URL) -> Result? {
        let scheme = (url.scheme ?? "").lowercased()

        if scheme == "agim" {
            // agim://pair?t=…&host=https%3A%2F%2F…
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let token = items.first(where: { $0.name == "t" || $0.name == "token" })?.value
            let hostRaw = items.first(where: { $0.name == "host" })?.value
            guard let token, !token.isEmpty else { return nil }
            guard let hostRaw, let host = normalizeHost(hostRaw) else { return nil }
            return Result(host: host, token: token)
        }

        if scheme == "http" || scheme == "https" {
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let token = items.first(where: { $0.name == "t" || $0.name == "token" })?.value
            guard let token, !token.isEmpty else { return nil }
            guard let host = normalizeHost(url) else { return nil }
            return Result(host: host, token: token)
        }

        return nil
    }

    static func normalizeHost(_ raw: String) -> String? {
        if let url = URL(string: raw), url.scheme != nil {
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

    static func wsURL(host: String, token: String? = nil) -> URL? {
        guard var comps = URLComponents(string: host) else { return nil }
        comps.scheme = (comps.scheme?.lowercased() == "https") ? "wss" : "ws"
        comps.path = "/ws"
        comps.fragment = nil
        if let token, !token.isEmpty {
            comps.queryItems = [URLQueryItem(name: "token", value: token)]
        } else {
            comps.query = nil
        }
        return comps.url
    }
}
