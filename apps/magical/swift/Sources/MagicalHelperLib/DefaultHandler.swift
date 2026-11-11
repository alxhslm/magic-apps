import AppKit
import HelperRPC
import UniformTypeIdentifiers

/// Which app macOS opens calendar documents with, and the call that claims one.
///
/// This lives in the helper because Electron cannot reach it.
/// `app.setAsDefaultProtocolClient` claims a URL *scheme*, which is why Magimail's
/// `mailto:` one-liner works; a `.ics` file is a *content type*, and LaunchServices has no
/// scheme for it. The helper is the process carrying the app's bundle identity, so it is
/// the one that can name `Magical.app` as the handler.
///
/// macOS exposes no "default calendar app" role, unlike mail and the browser. It models
/// this as one claim per type, which is why `.ics`, `webcal:` and `ical:` can be owned by
/// three different apps at once. `Target` mirrors that rather than papering over it: a
/// single switch would widen silently the day Magical learns to handle a `webcal:` feed,
/// redirecting links for someone who only ever agreed to `.ics`.
@MainActor
public enum DefaultHandler {
    /// A claim Magical can make. Supports `.ics` calendar files and `webcal`/`ical` feeds.
    public enum Target: String, CaseIterable {
        case ics
        case webcal

        var contentType: UTType? {
            switch self {
            case .ics: UTType("com.apple.ical.ics")
            case .webcal: nil
            }
        }

        var urlSchemes: [String] {
            switch self {
            case .ics: []
            case .webcal: ["webcal", "ical"]
            }
        }

        /// What the settings row calls it.
        var label: String {
            switch self {
            case .ics: String(localized: "Calendar files (.ics)")
            case .webcal: String(localized: "Calendar feeds (webcal://, ical://)")
            }
        }
    }

    /// Magical's own bundle, or nil when the helper is running outside one.
    ///
    /// Under `pnpm dev` the helper is a bare executable in `.build/`, and there is no app
    /// to register. Claiming must fail quietly there rather than registering the Swift
    /// binary itself as the handler for every invite on the machine.
    private static var appBundle: URL? {
        let url = Bundle.main.bundleURL
        return url.pathExtension == "app" ? url : nil
    }

    /// The app that currently opens this type, and whether it is Magical.
    ///
    /// Read from LaunchServices every time rather than remembered. The user can change the
    /// handler in Finder's Get Info panel whenever they like, and a settings row showing
    /// what Magical last set would be a row that lies.
    public static func current(_ target: Target) -> (name: String, isMagical: Bool)? {
        if let type = target.contentType {
            guard let handler = NSWorkspace.shared.urlsForApplications(toOpen: type).first else {
                return nil
            }
            let name = FileManager.default.displayName(atPath: handler.path)
            return (name, handler == appBundle)
        } else if !target.urlSchemes.isEmpty {
            var lastName: String?
            var allMagical = true
            for scheme in target.urlSchemes {
                guard let dummyUrl = URL(string: "\(scheme):"),
                      let handler = NSWorkspace.shared.urlForApplication(toOpen: dummyUrl)
                else {
                    return nil
                }
                lastName = FileManager.default.displayName(atPath: handler.path)
                if handler != appBundle {
                    allMagical = false
                }
            }
            guard let name = lastName else { return nil }
            return (name, allMagical)
        }
        return nil
    }

    /// Whether claiming could work at all, so the settings row can say why it cannot.
    public static var canClaim: Bool {
        appBundle != nil
    }

    /// Names Magical as the handler for one type.
    ///
    /// There is no matching release. LaunchServices has no way for an app to stop being
    /// the handler for a type — the only way back is to name a different app — so nothing
    /// here offers to undo it, and the settings row is a button rather than a switch.
    public static func claim(_ target: Target, completion: @escaping (String?) -> Void) {
        guard let bundle = appBundle else {
            completion(String(localized: "Magical is not running from an app bundle"))
            return
        }

        if let type = target.contentType {
            HelperLog.info("Defaults", "Claiming \(target.rawValue) for \(bundle.lastPathComponent)")
            NSWorkspace.shared.setDefaultApplication(at: bundle, toOpen: type) { error in
                Task { @MainActor in
                    if let error {
                        HelperLog.warn("Defaults", "Claim failed: \(error.localizedDescription)")
                        completion(error.localizedDescription)
                    } else {
                        completion(nil)
                    }
                }
            }
        } else if !target.urlSchemes.isEmpty {
            HelperLog.info("Defaults", "Claiming schemes \(target.urlSchemes.joined(separator: ", ")) for \(bundle.lastPathComponent)")
            let schemes = target.urlSchemes
            let group = DispatchGroup()
            var firstError: String?

            for scheme in schemes {
                group.enter()
                NSWorkspace.shared.setDefaultApplication(at: bundle, toOpenURLsWithScheme: scheme) { error in
                    Task { @MainActor in
                        if let error, firstError == nil {
                            HelperLog.warn("Defaults", "Claim for \(scheme) failed: \(error.localizedDescription)")
                            firstError = error.localizedDescription
                        }
                        group.leave()
                    }
                }
            }

            group.notify(queue: .main) {
                completion(firstError)
            }
        } else {
            completion(String(localized: "macOS does not recognize that type"))
        }
    }

    /// The payload the settings window and the launch prompt both read.
    public static func report() -> [String: Any] {
        var handlers: [[String: Any]] = []
        for target in Target.allCases {
            let state = current(target)
            handlers.append([
                "target": target.rawValue,
                "label": target.label,
                "handler": state?.name ?? "",
                "isMagical": state?.isMagical ?? false,
            ])
        }
        return ["canClaim": canClaim, "handlers": handlers]
    }
}
