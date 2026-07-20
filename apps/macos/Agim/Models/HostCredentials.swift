import Foundation

/// Paired Agim host + access token, persisted in Keychain.
struct HostCredentials: Codable, Equatable, Hashable, Sendable {
    var host: String
    var token: String
}
