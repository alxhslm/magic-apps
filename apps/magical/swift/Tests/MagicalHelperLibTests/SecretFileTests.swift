import CryptoKit
import Foundation
@testable import MagicalHelperLib
import Testing

/// Every format test takes an explicit key, so none of them touches the
/// keychain: a test binary carries no access group and would be refused.
private let testKey = SymmetricKey(data: Data(repeating: 0xAB, count: 32))

private func temporaryFile(named name: String) -> URL {
    let directory = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent(name)
}

@Test func sealedFileCarriesTheHeaderAndThirtyFiveBytesOfOverhead() throws {
    let plaintext = Data(#"{"unread":3}"#.utf8)
    let sealed = try SecretFile.seal(plaintext, name: "widget-cache.json", key: testKey)

    #expect(Array(sealed.prefix(7)) == [0x4D, 0x41, 0x47, 0x42, 0x4F, 0x58, 0x01])
    #expect(sealed.count == plaintext.count + 35)
}

@Test func sealedFileOpensBackToWhatWentIn() throws {
    let plaintext = Data(#"{"accounts":[{"id":"personal"}]}"#.utf8)
    let sealed = try SecretFile.seal(plaintext, name: "accounts.json", key: testKey)

    #expect(try SecretFile.open(sealed, name: "accounts.json", key: testKey) == plaintext)
}

@Test func everyWriteDrawsAFreshNonce() throws {
    let plaintext = Data("{}".utf8)
    let first = try SecretFile.seal(plaintext, name: "settings.json", key: testKey)
    let second = try SecretFile.seal(plaintext, name: "settings.json", key: testKey)

    #expect(first != second)
}

@Test func anotherFilesCiphertextDoesNotOpen() throws {
    let sealed = try SecretFile.seal(Data("{}".utf8), name: "settings.json", key: testKey)

    #expect(throws: SecretFileError.unreadable) {
        try SecretFile.open(sealed, name: "accounts.json", key: testKey)
    }
}

@Test func anotherKeyDoesNotOpen() throws {
    let sealed = try SecretFile.seal(Data("{}".utf8), name: "settings.json", key: testKey)
    let other = SymmetricKey(data: Data(repeating: 0x01, count: 32))

    #expect(throws: SecretFileError.unreadable) {
        try SecretFile.open(sealed, name: "settings.json", key: other)
    }
}

@Test func aTamperedTagDoesNotOpen() throws {
    var sealed = try SecretFile.seal(Data("{}".utf8), name: "settings.json", key: testKey)
    sealed[sealed.count - 1] ^= 0xFF

    #expect(throws: SecretFileError.unreadable) {
        try SecretFile.open(sealed, name: "settings.json", key: testKey)
    }
}

@Test func aFileShorterThanTheOverheadDoesNotOpen() {
    let truncated = SecretFile.header + Data(repeating: 0, count: 27)

    #expect(truncated.count == SecretFile.overhead - 1)
    #expect(throws: SecretFileError.unreadable) {
        try SecretFile.open(truncated, name: "settings.json", key: testKey)
    }
}

/// Pinned so the Node side can assert that the same bytes come back as the same
/// JSON. A change here means the two implementations have stopped agreeing.
@Test func thePinnedVectorOpens() throws {
    let key = SymmetricKey(data: Data((0 ..< 32).map { UInt8($0) }))
    let vector = try #require(Data(base64Encoded: "TUFHQk9YAQABAgMEBQYHCAkKCzwgonOgiKc5t2Pz6sOCWhDP4p14pNZjfLFDfVHnxxXQ"))

    let plaintext = try SecretFile.open(vector, name: "settings.json", key: key)

    #expect(String(decoding: plaintext, as: UTF8.self) == #"{"theme":"dark"}"#)
}

@Test func anAbsentFileReadsAsNil() throws {
    let url = temporaryFile(named: "settings.json")

    #expect(try SecretFile.read(at: url, key: { testKey }) == nil)
}

@Test func legacyPlaintextIsReadAsItStands() throws {
    let url = temporaryFile(named: "settings.json")
    let plaintext = Data(#"{"theme":"dark"}"#.utf8)
    try plaintext.write(to: url)

    // The key provider throws, because a legacy file has to stay readable on a
    // build that cannot reach the keychain.
    #expect(try SecretFile.read(at: url, key: { throw SecretFileError.unreadable }) == plaintext)
}

@Test func anUnreadableFileIsNeverReadAsPlaintext() throws {
    let url = temporaryFile(named: "settings.json")
    var sealed = try SecretFile.seal(Data("{}".utf8), name: "settings.json", key: testKey)
    sealed[sealed.count - 1] ^= 0xFF
    try sealed.write(to: url)

    #expect(throws: SecretFileError.unreadable) {
        try SecretFile.read(at: url, key: { testKey })
    }
}

@Test func writtenFilesAreEncryptedAndReadableOnlyByTheirOwner() throws {
    let url = temporaryFile(named: "focus-filter.json")
    let plaintext = Data(#"{"activeAccountIds":[]}"#.utf8)

    try SecretFile.write(plaintext, to: url, key: { testKey })

    #expect(try Data(contentsOf: url).starts(with: SecretFile.header))
    #expect(try SecretFile.read(at: url, key: { testKey }) == plaintext)

    let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber
    #expect(mode?.intValue == 0o600)
}

/// The additional data is the basename, so the same file reached by a longer
/// path still opens.
@Test func theAdditionalDataIsTheBasenameNotThePath() throws {
    let url = temporaryFile(named: "settings.json")
    try SecretFile.write(Data("{}".utf8), to: url, key: { testKey })

    let viaAnotherPath = url.deletingLastPathComponent()
        .appendingPathComponent("./settings.json")

    #expect(try SecretFile.read(at: viaAnotherPath, key: { testKey }) == Data("{}".utf8))
}
