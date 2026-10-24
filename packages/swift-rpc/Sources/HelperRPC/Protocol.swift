import Foundation

// MARK: - JSON-RPC Messages

/// Request from Electron → Swift
public struct RPCRequest: Codable {
    public let id: Int?
    public let method: String
    public let params: AnyCodable?
}

/// Response from Swift → Electron
public struct RPCResponse: Codable {
    public let id: Int
    public let result: AnyCodable?
    public let error: String?
}

/// Event from Swift → Electron (no id)
public struct RPCEvent: Codable {
    public let method: String
    public let params: AnyCodable?
}

// MARK: - AnyCodable (type-erased JSON value)

public struct AnyCodable: Codable {
    public let value: Any

    public init(_ value: Any) {
        self.value = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map(\.value)
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues(\.value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported type")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull:
            try container.encodeNil()
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            try container.encodeNil()
        }
    }
}

// MARK: - Helpers

public extension AnyCodable {
    var dict: [String: Any]? {
        value as? [String: Any]
    }

    var string: String? {
        value as? String
    }

    var int: Int? {
        value as? Int
    }

    var bool: Bool? {
        value as? Bool
    }
}
