import Foundation
import Security

enum KeychainStore {
    /// Payload is `{ "host": "https://…" }` (legacy `token` is ignored on load).
    private static let service = "host.iclaw.agim.credentials"
    private static let account = "default"

    static func save(_ credentials: HostCredentials) throws {
        let data = try JSONEncoder().encode(credentials)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.unhandled(status)
        }
    }

    static func load() -> HostCredentials? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(HostCredentials.self, from: data)
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    enum KeychainError: Error {
        case unhandled(OSStatus)
    }
}

enum ThreadIDStore {
    private static let key = "agim-web-thread-id"

    /// Matches SPA: `/^web-[A-Za-z0-9_-]{4,64}$/`
    static func loadOrCreate() -> String {
        if let existing = UserDefaults.standard.string(forKey: key),
           existing.range(of: #"^web-[A-Za-z0-9_-]{4,64}$"#, options: .regularExpression) != nil {
            return existing
        }
        let fresh = "web-\(String(Int(Date().timeIntervalSince1970 * 1000), radix: 36))-\(randomSuffix())"
        UserDefaults.standard.set(fresh, forKey: key)
        return fresh
    }

    static func reset() {
        UserDefaults.standard.removeObject(forKey: key)
    }

    private static func randomSuffix() -> String {
        let chars = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        return String((0..<6).map { _ in chars.randomElement()! })
    }
}
