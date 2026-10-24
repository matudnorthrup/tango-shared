import Foundation

public struct Health: Decodable, Sendable { public let ok: Bool; public let version: String; public let startedAt: String }
public struct ServiceHealth: Decodable, Sendable { public let ok: Bool; public let checkedAt: String?; public let detail: String? }
public struct Service: Decodable, Identifiable, Sendable {
    public let id: String; public let name: String; public let group: String; public let mode: String; public let state: String
    public let pid: Int?; public let since: String?; public let restarts: Int; public let health: ServiceHealth
    public let memoryBytes: Double?; public let cpuPct: Double?; public let budget: JSONValue?
}
public indirect enum JSONValue: Decodable, Sendable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
        else { self = .array(try c.decode([JSONValue].self)) }
    }
}
public struct Services: Decodable, Sendable { public let services: [Service] }
public struct Logs: Decodable, Sendable { public let lines: [String] }
public struct ActionResult: Decodable, Sendable { public let ok: Bool }
public struct Maintenance: Decodable, Sendable { public let on: Bool; public let reason: String?; public let since: String?; public let running: Int; public let queued: Int }
public struct Release: Decodable, Identifiable, Sendable { public let id: String; public let status: String; public let bytes: Double; public let buildTime: String }
public struct Releases: Decodable, Sendable { public let current: String?; public let previous: String?; public let releases: [Release] }
public struct Resources: Decodable, Sendable {
    public struct Memory: Decodable, Sendable {
        public struct Agent: Decodable, Sendable { public let name: String; public let threadId: String; public let processes: Int; public let bytes: Double }
        public let totalBytes: Double; public let freePct: Double; public let agents: [Agent]
    }
    public struct Disk: Decodable, Sendable { public let totalBytes: Double; public let freeBytes: Double }
    public let at: String; public let memory: Memory; public let disk: Disk; public let warm: Int?; public let cooled: Int?; public let limits: JSONValue?
}
public enum OverallStatus: Sendable { case healthy, degraded, unreachable
    public static func evaluate(reachable: Bool, healthOK: Bool, services: [Service]) -> Self {
        guard reachable else { return .unreachable }
        return healthOK && services.allSatisfy { $0.state == "running" && $0.health.ok } ? .healthy : .degraded
    }
}
public enum Polling { public static func interval(windowVisible: Bool, menuVisible: Bool) -> TimeInterval { windowVisible || menuVisible ? 5 : 30 } }
public enum APIError: Error, LocalizedError, Equatable {
    case observed, loomUnsupported, http(Int), invalidURL, emptyToken
    public var errorDescription: String? {
        switch self {
        case .observed: "This service is observed. Tango cannot control it."
        case .loomUnsupported: "Maintenance is unavailable: this server does not support Loom maintenance."
        case .http(let status): "Server returned HTTP \(status)."
        case .invalidURL: "Enter an http or https server URL."
        case .emptyToken: "The server token file is empty."
        }
    }
    public static func response(status: Int, data: Data) -> Self {
        let code = (try? JSONDecoder().decode([String: JSONValue].self, from: data))?["code"]
        if case .string("observe") = code, status == 409 { return .observed }
        if case .string("loom_unsupported") = code, status == 501 { return .loomUnsupported }
        return .http(status)
    }
}
public struct APIClient: Sendable {
    public let baseURL: String; public let tokenPath: String; private let session: URLSession
    public init(baseURL: String, tokenPath: String, session: URLSession = .shared) { self.baseURL = baseURL; self.tokenPath = tokenPath; self.session = session }
    public func request<T: Decodable & Sendable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> T {
        guard var components = URLComponents(string: baseURL), ["http", "https"].contains(components.scheme), components.host != nil else { throw APIError.invalidURL }
        let pieces = path.split(separator: "?", maxSplits: 1)
        let basePath = components.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.percentEncodedPath = "/" + (basePath.isEmpty ? "" : basePath + "/") + String(pieces[0])
        components.percentEncodedQuery = pieces.count > 1 ? String(pieces[1]) : nil
        components.fragment = nil
        guard let url = components.url else { throw APIError.invalidURL }
        let token = try String(contentsOfFile: NSString(string: tokenPath).expandingTildeInPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { throw APIError.emptyToken }
        var request = URLRequest(url: url); request.httpMethod = method; request.httpBody = body; request.timeoutInterval = 10
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw APIError.response(status: status, data: data) }
        return try JSONDecoder().decode(T.self, from: data)
    }
    public static func servicePath(_ id: String) -> String { "services/" + id.addingPercentEncoding(withAllowedCharacters: .alphanumerics)! }
}

/// The external launchd owner shared by the app switch and safe installer.
public enum LoginLauncher {
    public static let externalLabel = "com.tango.tango-server"
    public static func externalAgentURL(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        home.appending(path: "Library/LaunchAgents/\(externalLabel).plist")
    }
}
