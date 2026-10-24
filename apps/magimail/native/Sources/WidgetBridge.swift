import Foundation
import Security
import WidgetKit

// MARK: - C-callable bridge for the Node addon

/// Asks WidgetKit to re-read the snapshot the app just wrote.
///
/// This lives in the native dylib loaded into the Electron main process rather
/// than the Swift helper because `WidgetCenter` (via `chronod` and BaseBoard)
/// requires the calling process's executable path to match `CFBundleExecutable`
/// (`Magimail`) in the app bundle's Info.plist.
///
/// Even though `MagimailHelper` is located in `Contents/MacOS` and shares the app's
/// bundle ID, BaseBoard logs:
///   `Resolved bundle path <private> does not match executable <private>`
/// and `chronod` rejects the request with `ChronoCoreErrorDomain Code=10`.
/// Only the Electron main process matches `CFBundleExecutable`.
@_cdecl("widgets_reload_all")
public func widgetsReloadAll() {
    DispatchQueue.main.async {
        WidgetCenter.shared.reloadAllTimelines()
    }
}

/// The App Group container path, creating the container if it does not exist.
///
/// Unlike `widgets_reload_all` above, this carries no bundle-identity
/// requirement — the kernel checks the code signature's entitlements and team
/// prefix, not `CFBundleExecutable`. It lives here only because Node cannot
/// call `containerURL(forSecurityApplicationGroupIdentifier:)`, and that call is
/// what makes `containermanagerd` create and bless the directory. A plain
/// `mkdir` from Node would leave a directory the sandboxed extension cannot use.
///
/// Returns a malloc'd C string the caller frees, or null when the process is
/// not entitled for the group.
@_cdecl("widgets_group_container_path")
public func widgetsGroupContainerPath(_ groupId: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    let identifier = String(cString: groupId)
    guard let url = FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: identifier)
    else {
        return nil
    }
    return strdup(url.path)
}

/// The App Group this process is entitled for, or null when it carries none.
///
/// Read back out of the signature rather than assembled from a team ID, so a
/// build on any Apple ID asks for the group it can actually open. The team
/// prefix is fixed at signing time and only the certificate knows it; a
/// hardcoded one sends the app to a container it is not entitled for, and the
/// snapshot then lands where no extension can read it.
///
/// Null on an unsigned or ad-hoc build, which carries no entitlements at all.
/// That is the development case, and it is what sends the cache back to
/// Application Support.
///
/// Returns a malloc'd C string the caller frees.
@_cdecl("widgets_app_group_identifier")
public func widgetsAppGroupIdentifier() -> UnsafeMutablePointer<CChar>? {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }

    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }

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
    return strdup(group)
}
