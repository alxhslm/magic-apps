import AppKit
import HelperRPC

/// Which app macOS opens `mailto:` links with, and the call that claims the scheme.
///
/// The main process can already claim it — `app.setAsDefaultProtocolClient('mailto')` in
/// `default-client.ts` — but Electron only answers whether Magimail holds the scheme, never
/// which app does instead. LaunchServices knows, so the settings row asks it here and names
/// the app it finds.
///
/// macOS exposes a "default mail reader" role, but it is a role over the `mailto:` scheme:
/// naming an app there and claiming the scheme here are the same write. `Target` mirrors
/// LaunchServices' one-claim-per-scheme shape rather than papering over it, so the day
/// Magimail claims a second scheme it appears as its own row rather than widening this one.
@MainActor
public enum DefaultHandler {
    /// A claim Magimail can make. `mailto:` is the only one worth showing: `magimail:` is
    /// the app's own deep-link scheme, which nothing else competes for.
    public enum Target: String, CaseIterable {
        case mailto

        /// The URL LaunchServices is asked about, and the scheme a claim writes.
        var scheme: String {
            rawValue
        }

        /// What the settings row calls it.
        var label: String {
            switch self {
            case .mailto: String(localized: "Email links (mailto:)")
            }
        }
    }

    /// Magimail's own bundle, or nil when the helper is running outside one.
    ///
    /// Under `pnpm dev` the helper is a bare executable in `.build/`, and there is no app to
    /// register. Claiming must fail quietly there rather than registering the Swift binary
    /// itself as the reader for every `mailto:` link on the machine.
    private static var appBundle: URL? {
        let url = Bundle.main.bundleURL
        return url.pathExtension == "app" ? url : nil
    }

    /// The app that currently opens this scheme, and whether it is Magimail.
    ///
    /// Read from LaunchServices every time rather than remembered. The user can change the
    /// reader in System Settings whenever they like, and a settings row showing what
    /// Magimail last set would be a row that lies.
    public static func current(_ target: Target) -> (name: String, isMagimail: Bool)? {
        guard let url = URL(string: "\(target.scheme):"), let handler = NSWorkspace.shared.urlForApplication(toOpen: url) else { return nil }

        let name = FileManager.default.displayName(atPath: handler.path)
        return (name, handler == appBundle)
    }

    /// Whether claiming could work at all, so the settings row can say why it cannot.
    public static var canClaim: Bool {
        appBundle != nil
    }

    /// Names Magimail as the reader for one scheme.
    ///
    /// There is no matching release. LaunchServices has no way for an app to stop being the
    /// handler for a scheme — the only way back is to name a different app — so nothing here
    /// offers to undo it, and the settings row is a button rather than a switch.
    public static func claim(_ target: Target, completion: @escaping (String?) -> Void) {
        guard let bundle = appBundle else {
            completion(String(localized: "Magimail is not running from an app bundle"))
            return
        }

        HelperLog.info("Defaults", "Claiming \(target.scheme): for \(bundle.lastPathComponent)")
        NSWorkspace.shared.setDefaultApplication(at: bundle, toOpenURLsWithScheme: target.scheme) { error in
            Task { @MainActor in
                if let error {
                    HelperLog.warn("Defaults", "Claim failed: \(error.localizedDescription)")
                    completion(error.localizedDescription)
                } else {
                    completion(nil)
                }
            }
        }
    }
}
