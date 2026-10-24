import Foundation
@testable import HelperRPC
import Testing

@Suite("HelperLog Tests")
struct HelperLogTests {
    @Test func formatsErrorLineCorrectly() {
        let line = HelperLog.formatRecord("E", "Notifications", "Failed to dispatch: boom")
        #expect(line == "E|Notifications|Failed to dispatch: boom\n")
    }

    @Test func formatsWarnLineCorrectly() {
        let line = HelperLog.formatRecord("W", "Notifications", "Permission denied")
        #expect(line == "W|Notifications|Permission denied\n")
    }

    @Test func formatsInfoLineCorrectly() {
        let line = HelperLog.formatRecord("I", "Settings", "Window shown")
        #expect(line == "I|Settings|Window shown\n")
    }

    @Test func flattensNewlinesIntoSpaces() {
        let multiline = "Line one\nLine two\r\nLine three"
        let line = HelperLog.formatRecord("E", "Test", multiline)
        #expect(line == "E|Test|Line one Line two Line three\n")
    }

    @Test func formatsWithEmptyCategory() {
        let line = HelperLog.formatRecord("E", "", "Something broke")
        #expect(line == "E||Something broke\n")
    }

    @Test func preservesPipeCharactersInMessage() {
        let line = HelperLog.formatRecord("I", "Sync", "status=ok | count=42 | duration=12ms")
        #expect(line == "I|Sync|status=ok | count=42 | duration=12ms\n")
    }
}

@Suite("Protocol Tests")
struct ProtocolTests {
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    @Test func rpcRequestRoundTrips() throws {
        let json = """
        {"id":42,"method":"tray.refresh","params":{"accountId":"acc_1","force":true,"limit":10,"ratio":1.5}}
        """
        let requestData = try #require(json.data(using: .utf8))
        let request = try decoder.decode(RPCRequest.self, from: requestData)

        #expect(request.id == 42)
        #expect(request.method == "tray.refresh")
        let params = try #require(request.params?.dict)
        #expect(params["accountId"] as? String == "acc_1")
        #expect(params["force"] as? Bool == true)
        #expect(params["limit"] as? Int == 10)
        #expect(params["ratio"] as? Double == 1.5)

        let encoded = try encoder.encode(request)
        let roundTripped = try decoder.decode(RPCRequest.self, from: encoded)
        #expect(roundTripped.id == 42)
        #expect(roundTripped.method == "tray.refresh")
        let roundTrippedParams = try #require(roundTripped.params?.dict)
        #expect(roundTrippedParams["accountId"] as? String == "acc_1")
        #expect(roundTrippedParams["force"] as? Bool == true)
    }

    @Test func rpcRequestWithNilParamsAndIdRoundTrips() throws {
        let json = """
        {"method":"tray.quit"}
        """
        let requestData = try #require(json.data(using: .utf8))
        let request = try decoder.decode(RPCRequest.self, from: requestData)

        #expect(request.id == nil)
        #expect(request.method == "tray.quit")
        #expect(request.params == nil)
    }

    @Test func rpcRequestWithNullParamsDecodesCorrectly() throws {
        let json = """
        {"id":1,"method":"tray.test","params":null}
        """
        let requestData = try #require(json.data(using: .utf8))
        let request = try decoder.decode(RPCRequest.self, from: requestData)

        #expect(request.id == 1)
        #expect(request.method == "tray.test")
        #expect(request.params == nil)
    }

    @Test func rpcRequestWithEmptyDictParamsDecodesCorrectly() throws {
        let json = """
        {"id":2,"method":"tray.empty","params":{}}
        """
        let requestData = try #require(json.data(using: .utf8))
        let request = try decoder.decode(RPCRequest.self, from: requestData)

        #expect(request.id == 2)
        #expect(request.method == "tray.empty")
        let dict = try #require(request.params?.dict)
        #expect(dict.isEmpty)
    }

    @Test func rpcResponseWithResultRoundTrips() throws {
        let response = RPCResponse(id: 7, result: AnyCodable(["status": "ok"]), error: nil)
        let data = try encoder.encode(response)
        let decoded = try decoder.decode(RPCResponse.self, from: data)

        #expect(decoded.id == 7)
        #expect(decoded.error == nil)
        let result = try #require(decoded.result?.dict)
        #expect(result["status"] as? String == "ok")
    }

    @Test func rpcResponseWithErrorRoundTrips() throws {
        let response = RPCResponse(id: 8, result: nil, error: "Something went wrong")
        let data = try encoder.encode(response)
        let decoded = try decoder.decode(RPCResponse.self, from: data)

        #expect(decoded.id == 8)
        #expect(decoded.error == "Something went wrong")
        #expect(decoded.result == nil)
    }

    @Test func rpcEventRoundTrips() throws {
        let event = RPCEvent(method: "notify.authorization", params: AnyCodable(["granted": true]))
        let data = try encoder.encode(event)
        let decoded = try decoder.decode(RPCEvent.self, from: data)

        #expect(decoded.method == "notify.authorization")
        let params = try #require(decoded.params?.dict)
        #expect(params["granted"] as? Bool == true)
    }

    @Test func anyCodableSupportsPrimitiveTypes() {
        let stringVal = AnyCodable("test")
        #expect(stringVal.string == "test")

        let intVal = AnyCodable(123)
        #expect(intVal.int == 123)

        let boolVal = AnyCodable(true)
        #expect(boolVal.bool == true)

        let arrayVal = AnyCodable(["a", "b"])
        let array = arrayVal.value as? [String]
        #expect(array == ["a", "b"])
    }
}

@Suite("StdioTransport Tests")
struct StdioTransportTests {
    @Test func dropsMalformedLinesSafely() throws {
        let transport = StdioTransport()
        var received = false
        transport.onMessage { _ in
            received = true
        }

        // Empty data
        #expect(transport.processLine(Data()) == false)
        #expect(received == false)

        // Invalid JSON string
        let badData = try #require("Not valid JSON at all\n".data(using: .utf8))
        #expect(transport.processLine(badData) == false)
        #expect(received == false)

        // JSON missing method field
        let missingMethod = try #require("{\"id\": 1}".data(using: .utf8))
        #expect(transport.processLine(missingMethod) == false)
        #expect(received == false)
    }

    @Test func parsesValidRequestAndDispatches() async throws {
        let transport = StdioTransport()
        let confirmation = TaskCompletionSource<RPCRequest>()

        transport.onMessage { request in
            confirmation.resolve(request)
        }

        let valid = try #require("{\"id\": 99, \"method\": \"test.ping\"}".data(using: .utf8))
        let processed = transport.processLine(valid)
        #expect(processed == true)

        let req = await confirmation.value
        #expect(req.id == 99)
        #expect(req.method == "test.ping")
    }

    @Test func sendResponseAppendsNewlineAndEncodesPayload() throws {
        var writtenData: Data?
        let transport = StdioTransport(outputWriter: { data in
            writtenData = data
        })

        transport.sendResponse(id: 12, result: ["active": true])

        let data = try #require(writtenData)
        #expect(data.last == 0x0A)

        let decoded = try JSONDecoder().decode(RPCResponse.self, from: data)
        #expect(decoded.id == 12)
        let result = try #require(decoded.result?.dict)
        #expect(result["active"] as? Bool == true)
    }

    @Test func sendErrorAppendsNewlineAndEncodesErrorPayload() throws {
        var writtenData: Data?
        let transport = StdioTransport(outputWriter: { data in
            writtenData = data
        })

        transport.sendResponse(id: 42, error: "Network timeout")

        let data = try #require(writtenData)
        #expect(data.last == 0x0A)

        let decoded = try JSONDecoder().decode(RPCResponse.self, from: data)
        #expect(decoded.id == 42)
        #expect(decoded.error == "Network timeout")
        #expect(decoded.result == nil)
    }

    @Test func processLineHandlesTrailingCarriageReturn() async throws {
        let transport = StdioTransport()
        let confirmation = TaskCompletionSource<RPCRequest>()

        transport.onMessage { request in
            confirmation.resolve(request)
        }

        let validWithCR = try #require("{\"id\": 101, \"method\": \"test.crlf\"}\r".data(using: .utf8))
        let processed = transport.processLine(validWithCR)
        #expect(processed == true)

        let req = await confirmation.value
        #expect(req.id == 101)
        #expect(req.method == "test.crlf")
    }

    @Test func sendEventAppendsNewlineAndEncodesPayload() throws {
        var writtenData: Data?
        let transport = StdioTransport(outputWriter: { data in
            writtenData = data
        })

        transport.sendEvent(method: "tray.refresh", params: ["accountId": "acc_xyz"])

        let data = try #require(writtenData)
        #expect(data.last == 0x0A)

        let decoded = try JSONDecoder().decode(RPCEvent.self, from: data)
        #expect(decoded.method == "tray.refresh")
        let params = try #require(decoded.params?.dict)
        #expect(params["accountId"] as? String == "acc_xyz")
    }
}

/// Helper to bridge async task completion in tests.
final class TaskCompletionSource<T>: @unchecked Sendable {
    private var result: T?
    private var continuation: CheckedContinuation<T, Never>?
    private let lock = NSLock()

    var value: T {
        get async {
            await withCheckedContinuation { cont in
                lock.lock()
                if let result {
                    lock.unlock()
                    cont.resume(returning: result)
                } else {
                    continuation = cont
                    lock.unlock()
                }
            }
        }
    }

    func resolve(_ value: T) {
        lock.lock()
        result = value
        let cont = continuation
        continuation = nil
        lock.unlock()
        cont?.resume(returning: value)
    }
}
