import AppKit

public final class SearchDelegate: NSObject, NSSearchFieldDelegate {
    public static let shared = SearchDelegate()

    public func control(_ control: NSControl, textView _: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.insertNewline(_:)) {
            let query = control.stringValue.trimmingCharacters(in: .whitespaces)
            if !query.isEmpty {
                ActionBridge.emit("search", query)
            }
            return true
        }
        return false
    }
}
