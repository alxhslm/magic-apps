import CryptoKit
import Foundation
import Security

/// Reads and writes the local cache files, which are encrypted at rest.
///
/// The layout is pinned, and `packages/core/src/secret-file.ts` writes the same
/// bytes on the Node side:
///
///     0    "MAGBOX"     6 bytes, ASCII
///     6    0x01         format version
///     7    nonce        12 random bytes
///     19   ciphertext   AES-256-GCM over the UTF-8 JSON
///     -16  tag          16 bytes
///
/// The file's basename is the additional authenticated data, so one file's
/// ciphertext cannot be swapped into another's.
///
/// A file that does not carry the header is legacy plaintext JSON and is
/// returned as it stands; reading it needs no key, so a build that cannot reach
/// the keychain still starts. Every write is encrypted, so each file converts
/// the first time it is written.
///
/// Reads fail closed. A file that carries the header and does not decrypt
/// throws; it is never handed back as plaintext.
public enum SecretFile {
    /// The parsed contents of `url`, or nil when there is no such file.
    ///
    /// Absent and unreadable are kept apart so that a caller holding a file it
    /// must not destroy, such as `settings.json` or `accounts.json`, can refuse
    /// to overwrite what it could not read.
    public static func read(at url: URL) throws -> Data? {
        try read(at: url, key: fileKey)
    }

    /// Encrypts `plaintext` into `url`, mode 0600.
    public static func write(_ plaintext: Data, to url: URL) throws {
        try write(plaintext, to: url, key: fileKey)
    }

    // MARK: - Format

    /// `MAGBOX\u{01}`. Seven bytes, so a legacy file beginning `{` or `[` is
    /// told apart from an encrypted one on the first byte.
    static let header = Data([0x4D, 0x41, 0x47, 0x42, 0x4F, 0x58, 0x01])

    /// Header, nonce and tag; the smallest a valid encrypted file can be.
    static let overhead = header.count + 12 + 16

    static func read(at url: URL, key provideKey: () throws -> SymmetricKey) throws -> Data? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }

        let raw: Data
        do {
            raw = try Data(contentsOf: url)
        } catch {
            throw SecretFileError.unreadable
        }

        guard raw.starts(with: header) else { return raw }
        return try open(raw, name: url.lastPathComponent, key: provideKey())
    }

    static func write(_ plaintext: Data, to url: URL, key provideKey: () throws -> SymmetricKey) throws {
        let sealed = try seal(plaintext, name: url.lastPathComponent, key: provideKey())
        // Atomic, so a write interrupted halfway leaves the old file rather
        // than a truncated one that would then refuse to decrypt. The rename
        // brings the temporary file's mode with it, hence the chmod after.
        try sealed.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    static func seal(_ plaintext: Data, name: String, key: SymmetricKey) throws -> Data {
        let box = try AES.GCM.seal(
            plaintext,
            using: key,
            nonce: AES.GCM.Nonce(),
            authenticating: Data(name.utf8)
        )
        return header + Data(box.nonce) + box.ciphertext + box.tag
    }

    static func open(_ file: Data, name: String, key: SymmetricKey) throws -> Data {
        guard file.count >= overhead else { throw SecretFileError.unreadable }
        // Re-based, because a Data slice keeps the index it had in the file and
        // CryptoKit reads the combined box from index zero.
        let body = Data(file.dropFirst(header.count))
        do {
            let box = try AES.GCM.SealedBox(combined: body)
            return try AES.GCM.open(box, using: key, authenticating: Data(name.utf8))
        } catch {
            throw SecretFileError.unreadable
        }
    }

    // MARK: - Key

    /// The one place the keychain item is described, so changing the access
    /// group is a one-line change. `native/Sources/KeychainBridge.swift`
    /// describes the same item for Node; every field has to match it exactly or
    /// each side creates a key of its own and neither reads the other's files.
    private enum KeyItem {
        static let service = "com.alexhaslam.magical.localcache"
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

    private static let keyLock = NSLock()
    private static var memoisedKey: SymmetricKey?

    /// The 32-byte file key, held for the life of the process.
    ///
    /// WidgetKit gives a timeline provider a few seconds in total, and the
    /// keychain is the slowest thing in a read, so the widget pays for it once
    /// rather than once per file.
    static func fileKey() throws -> SymmetricKey {
        keyLock.lock()
        defer { keyLock.unlock() }

        if let memoisedKey {
            return memoisedKey
        }
        let key = try fetchOrCreateKey()
        memoisedKey = key
        return key
    }

    private static func fetchOrCreateKey() throws -> SymmetricKey {
        if let existing = storedKey() {
            return existing
        }

        let fresh = SymmetricKey(size: .bits256)
        var attributes = KeyItem.query
        attributes[kSecValueData as String] = fresh.withUnsafeBytes { Data($0) }

        let status = SecItemAdd(attributes as CFDictionary, nil)
        switch status {
        case errSecSuccess:
            return fresh
        case errSecDuplicateItem:
            // Another process created the key between the read above and this
            // add. Theirs is the one on disk, so take it rather than the one
            // just made.
            guard let existing = storedKey() else { throw SecretFileError.keyUnavailable(status) }
            return existing
        default:
            throw SecretFileError.keyUnavailable(status)
        }
    }

    /// The stored key, or nil when there is none and when the keychain refuses.
    ///
    /// An ad-hoc signed build gets nil here, then
    /// fails to add and reports `keyUnavailable`.
    private static func storedKey() -> SymmetricKey? {
        var query = KeyItem.query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              data.count == KeyItem.byteCount
        else {
            return nil
        }
        return SymmetricKey(data: data)
    }
}

public enum SecretFileError: Error, Equatable {
    /// The file is there and could not be turned back into plaintext: the
    /// header is truncated, the tag does not verify, or it was sealed under
    /// another name or another key. The caller decides whether to rebuild it or
    /// to leave it alone.
    case unreadable
    /// The keychain would not give up the file key, so nothing can be read or
    /// written. Carries the `SecItem` status.
    case keyUnavailable(OSStatus)
}
