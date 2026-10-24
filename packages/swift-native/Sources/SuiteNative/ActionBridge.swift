import Foundation

/// C-callable callback type for events sent back to JavaScript.
public typealias NativeActionCallback = @convention(c) (UnsafePointer<CChar>, UnsafePointer<CChar>) -> Void

/// Dispatches native AppKit events across the C bridge into Electron's Node event loop.
public enum ActionBridge {
    public static var callback: NativeActionCallback?

    public static func emit(_ action: String, _ value: String = "") {
        action.withCString { actionPtr in
            value.withCString { valuePtr in
                callback?(actionPtr, valuePtr)
            }
        }
    }
}
