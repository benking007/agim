import Foundation

/// Paired Agim origin, persisted in Keychain.
/// Login is the WebView session cookie (`agim_session`), not an API token.
struct HostCredentials: Codable, Equatable, Hashable, Sendable {
    var host: String
}
