import Foundation
import Security

/// The App Group this helper was signed for, read back out of its own signature.
///
/// The helper reads `focus-filter.json` from the group container rather than
/// Application Support, because that is the container the App Intents extension
/// writes to.
///
/// The identifier is taken from the entitlements rather than assembled from a
/// team ID, so a build on any Apple ID asks for the group its signature can
/// actually back. It is nil on an ad-hoc or unsigned build, and the caller then
/// falls back to the pre-group location.
enum AppGroup {
    /// The App Group identifier, or nil when the process carries none.
    static var identifier: String? {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }

        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else {
            return nil
        }

        var information: CFDictionary?
        let flags = SecCSFlags(rawValue: kSecCSRequirementInformation | kSecCSSigningInformation)
        guard SecCodeCopySigningInformation(staticCode, flags, &information) == errSecSuccess,
              let info = information as? [String: Any],
              let entitlements = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any],
              let groups = entitlements["com.apple.security.application-groups"] as? [String],
              let group = groups.first
        else {
            return nil
        }
        return group
    }

    /// The group container, creating it on first call, or nil when not entitled.
    static func containerURL() -> URL? {
        guard let identifier else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
    }

    /// A named file in the group container, or nil when not entitled.
    static func fileURL(_ name: String) -> URL? {
        containerURL()?.appendingPathComponent(name)
    }
}
