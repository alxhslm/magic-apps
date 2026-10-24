import AppKit
import os.log
import UniformTypeIdentifiers

private let logger = ShareExtensionLogger.shared

/// Creates a staging directory no other user can read.
///
/// The container is already owner-only, so this is defence in depth rather than the thing
/// keeping a shared attachment private.
private func createPrivateDirectory(at dir: URL) {
    try? FileManager.default.createDirectory(
        at: dir,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
}

/// Drops the permissions a copied file inherited from wherever it came from.
///
/// The failure is invisible by nature: the share still works, and the file is
/// simply left readable by more than its owner. Nothing else would ever say so.
private func restrictToOwner(_ file: URL) {
    do {
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    } catch {
        ShareExtensionLogger.shared.error("Could not restrict the staged file to its owner: \(error)")
    }
}

/// macOS Share Extension that receives files, URLs, and text from other apps
/// and forwards them to Magimail via the magimail://share URL scheme.
@objc(ShareViewController)
class ShareViewController: NSViewController {
    override func loadView() {
        // Minimal view — the extension closes immediately after processing
        view = NSView(frame: NSRect(x: 0, y: 0, width: 1, height: 1))
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        logger.info("viewDidLoad")
        processSharedItems()
    }

    private func processSharedItems() {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem], !items.isEmpty else {
            logger.info("No input items provided")
            done()
            return
        }

        logger.info("Processing \(items.count) shared item(s)")

        let group = DispatchGroup()
        var filePaths: [String] = []
        var sharedText: String?
        var sharedUrl: String?

        // Destination directory: shared App Group container if available, falling back to temp directory.
        // Magimail removes it once it has copied what is inside; see `share-staging.ts`.
        let shareDir: URL = {
            if let groupId = shareAppGroupId,
               let groupUrl = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupId)
            {
                let dir = groupUrl.appendingPathComponent("SharedFiles/\(UUID().uuidString)")
                createPrivateDirectory(at: dir)
                return dir
            }
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("MagimailShare-\(UUID().uuidString)")
            createPrivateDirectory(at: dir)
            return dir
        }()

        for item in items {
            guard let attachments = item.attachments else { continue }

            for provider in attachments {
                // 1. Files / items conforming to fileURL or data
                if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { data, error in
                        defer { group.leave() }
                        if let error = error {
                            logger.error("Error loading fileURL: \(error.localizedDescription)")
                            return
                        }
                        guard let url = data as? URL ?? (data as? Data).flatMap({ URL(dataRepresentation: $0, relativeTo: nil) }) else {
                            logger.warn("Failed to interpret item data as URL")
                            return
                        }
                        let dest = shareDir.appendingPathComponent(url.lastPathComponent)
                        do {
                            if FileManager.default.fileExists(atPath: dest.path) {
                                try FileManager.default.removeItem(at: dest)
                            }
                            try FileManager.default.copyItem(at: url, to: dest)
                            restrictToOwner(dest)
                            filePaths.append(dest.path)
                            let ext = dest.pathExtension.isEmpty ? "no extension" : ".\(dest.pathExtension)"
                            let size = (try? FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? NSNumber)?.intValue ?? 0
                            logger.info("Successfully staged file: \(ext), \(size) bytes")
                        } catch {
                            logger.error("Failed to copy file to share dir: \(error.localizedDescription)")
                        }
                    }
                }
                // 2. URLs (web URLs)
                else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { data, _ in
                        defer { group.leave() }
                        if let url = data as? URL {
                            sharedUrl = url.absoluteString
                            logger.info("Received URL: \(logger.redactUrl(url.absoluteString))")
                        }
                    }
                }
                // 3. Plain text
                else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { data, _ in
                        defer { group.leave() }
                        if let text = data as? String {
                            sharedText = text
                            logger.info("Received text (\(text.count) characters)")
                        }
                    }
                }
            }
        }

        group.notify(queue: .main) { [weak self] in
            self?.openMagimail(files: filePaths, text: sharedText, url: sharedUrl)
        }
    }

    private func openMagimail(files: [String], text: String?, url: String?) {
        var components = URLComponents()
        components.scheme = "magimail"
        components.host = "share"

        var queryItems: [URLQueryItem] = []
        for filePath in files {
            queryItems.append(URLQueryItem(name: "files", value: filePath))
        }
        if let text = text {
            queryItems.append(URLQueryItem(name: "text", value: text))
        }
        if let url = url {
            queryItems.append(URLQueryItem(name: "url", value: url))
        }
        components.queryItems = queryItems.isEmpty ? nil : queryItems

        guard let shareUrl = components.url else {
            logger.error("Failed to construct share URL")
            done()
            return
        }

        logger.info("Opening Magimail URL: \(logger.redactUrl(shareUrl.absoluteString)) (files: \(files.count), hasText: \(text != nil), hasUrl: \(url != nil))")

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true

        NSWorkspace.shared.open(shareUrl, configuration: configuration) { [weak self] _, error in
            if let error = error {
                logger.error("NSWorkspace.shared.open failed: \(error.localizedDescription)")
            } else {
                logger.info("NSWorkspace.shared.open succeeded")
            }
            DispatchQueue.main.async {
                self?.done()
            }
        }
    }

    private func done() {
        logger.info("Completing extension request")
        extensionContext?.completeRequest(returningItems: nil)
    }
}
