import Foundation

/// Reads line-delimited JSON from stdin, writes line-delimited JSON to stdout.
public final class StdioTransport {
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let outputWriter: (Data) -> Void
    private var onRequest: (@MainActor (RPCRequest) -> Void)?

    public init(outputWriter: @escaping (Data) -> Void = { FileHandle.standardOutput.write($0) }) {
        self.outputWriter = outputWriter
        encoder.outputFormatting = [.sortedKeys]
    }

    /// Register a handler for incoming requests from Electron.
    public func onMessage(_ handler: @escaping @MainActor (RPCRequest) -> Void) {
        onRequest = handler
    }

    /// Process a single complete line of JSON-RPC data from stdin.
    ///
    /// Malformed JSON is logged and dropped without throwing, keeping the helper
    /// alive if Electron sends something unexpected.
    @discardableResult
    public func processLine(_ lineData: Data) -> Bool {
        guard !lineData.isEmpty else { return false }
        guard let request = try? decoder.decode(RPCRequest.self, from: lineData) else {
            HelperLog.warn("RPC", "Failed to decode RPC request from stdin")
            return false
        }

        HelperLog.info("RPC", "Dispatching request: \(request.method)")
        let handler = onRequest
        Task { @MainActor in
            handler?(request)
        }
        return true
    }

    /// Start reading from stdin on a background thread.
    /// Dispatches parsed messages to the main thread.
    public func startReading() {
        HelperLog.info("RPC", "Started reading from stdin")
        Thread.detachNewThread { [weak self] in
            let handle = FileHandle.standardInput
            var buffer = Data()

            while true {
                let chunk = handle.availableData
                if chunk.isEmpty {
                    // stdin closed — Electron exited
                    HelperLog.info("RPC", "stdin closed — exiting helper process")
                    DispatchQueue.main.async { exit(0) }
                    return
                }
                buffer.append(chunk)

                // Process complete lines
                while let newlineRange = buffer.range(of: Data([0x0A])) {
                    let lineData = buffer.subdata(in: buffer.startIndex ..< newlineRange.lowerBound)
                    buffer.removeSubrange(buffer.startIndex ... newlineRange.lowerBound)
                    self?.processLine(lineData)
                }
            }
        }
    }

    /// Send a response back to Electron.
    public func sendResponse(id: Int, result: Any? = nil, error: String? = nil) {
        let response = RPCResponse(
            id: id,
            result: result.map { AnyCodable($0) },
            error: error
        )
        writeJSON(response)
    }

    /// Send an event to Electron (no id, no response expected).
    public func sendEvent(method: String, params: [String: Any]? = nil) {
        let event = RPCEvent(
            method: method,
            params: params.map { AnyCodable($0) }
        )
        writeJSON(event)
    }

    private func writeJSON(_ value: some Encodable) {
        guard let data = try? encoder.encode(value) else { return }
        var output = data
        output.append(0x0A) // newline delimiter
        outputWriter(output)
    }
}
