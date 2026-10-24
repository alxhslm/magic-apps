import Foundation
import Security

// MARK: - C-callable bridge for the Node addon

/// The one place the local cache key's keychain item is described. The Swift
/// helper and the extensions describe the same item; every field here has to
/// match theirs exactly or each side creates a key of its own and neither reads
/// the other's files.
///
/// The item lives in the login keychain, where only this process reaches it.
/// Sharing one key with the widget and the App Intents extension needs a
/// keychain access group, and macOS refuses to launch a build claiming one
/// without a provisioning profile, so the files those two read stay plaintext.
private enum LocalCacheKeyItem {
    static let service = "com.alexhaslam.magimail.localcache"
    static let account = "v1"
    static let byteCount = 32

    static var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

/// The 32-byte key the local cache files are encrypted under, base64-encoded.
///
/// Creates the key on first use. Node cannot call `SecItem` itself, which is the
/// only reason this crosses the bridge.
///
/// Base64 rather than raw bytes because the result comes back as a C string and
/// a random key contains NUL bytes.
///
/// Returns a malloc'd C string the caller frees, or null when the keychain
/// refuses. An ad-hoc signed build gets null; that is the development case,
/// and it is what sends the files back to plaintext.
@_cdecl("localcache_key")
public func localCacheKey() -> UnsafeMutablePointer<CChar>? {
    if let existing = readLocalCacheKey() {
        return strdup(existing.base64EncodedString())
    }

    var fresh = Data(count: LocalCacheKeyItem.byteCount)
    let generated = fresh.withUnsafeMutableBytes { buffer -> Int32 in
        guard let base = buffer.baseAddress else { return errSecAllocate }
        return SecRandomCopyBytes(kSecRandomDefault, LocalCacheKeyItem.byteCount, base)
    }
    guard generated == errSecSuccess else { return nil }

    var attributes = LocalCacheKeyItem.query
    attributes[kSecValueData as String] = fresh

    switch SecItemAdd(attributes as CFDictionary, nil) {
    case errSecSuccess:
        return strdup(fresh.base64EncodedString())
    case errSecDuplicateItem:
        // Another process created the key between the read above and this add.
        // Theirs is the one on disk, so take it rather than the one just made.
        guard let existing = readLocalCacheKey() else { return nil }
        return strdup(existing.base64EncodedString())
    default:
        return nil
    }
}

/// The stored key, or nil when there is none and when the keychain refuses.
private func readLocalCacheKey() -> Data? {
    var query = LocalCacheKeyItem.query
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data,
          data.count == LocalCacheKeyItem.byteCount
    else {
        return nil
    }
    return data
}
