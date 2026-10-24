import Foundation

public enum DeskError: Error, LocalizedError, Sendable {
    case invalidURL, refused(String), inactiveSnooze, invalidResponse
    public var errorDescription: String? {
        switch self {
        case .invalidURL: "Enter a secure desk URL."
        case .refused(let reason): reason
        case .inactiveSnooze: "This item is no longer active. It was left unchanged."
        case .invalidResponse: "The desk returned an unreadable response."
        }
    }
}
public struct DeskAddress: Codable, Equatable, Sendable {
    public let base: URL
    public init(_ text: String) throws {
        guard var parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = parts.host, parts.user == nil, parts.password == nil,
              parts.scheme == "https" || (parts.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)) else { throw DeskError.invalidURL }
        parts.query = nil; parts.fragment = nil
        parts.path = parts.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if !parts.path.isEmpty { parts.path = "/" + parts.path }
        guard let url = parts.url else { throw DeskError.invalidURL }
        base = url
    }
    public func endpoint(_ path: String) -> URL { base.appendingPathComponent(path) }
    public func decision(_ id: String) -> URL? {
        guard id.range(of: #"^D-\d+$"#, options: .regularExpression) != nil else { return nil }
        return endpoint("decision/\(id)")
    }
    public func deepLink(_ url: URL) -> URL? {
        guard url.scheme == "tango", url.host == "decision" else { return nil }
        return decision(String(url.path.dropFirst()))
    }
    public func contains(_ url: URL) -> Bool {
        url.scheme == base.scheme && url.host == base.host && url.port == base.port &&
        (base.path.isEmpty || base.path == "/" || url.path == base.path || url.path.hasPrefix(base.path + "/"))
    }
}
public struct DecisionPush: Codable, Sendable {
    public struct Option: Codable, Sendable { public let key: String; public let label: String; public let answer: String }
    public let deskId: String
    public let itemId: String
    public let requestId: String
    public let decisionId: String
    public let revision: Int
    public let options: [Option]
    public func belongs(to address: DeskAddress?, registeredDeskID: String?, registeredAddress: String?) -> Bool {
        guard let address else { return false }
        return deskId == registeredDeskID && address.base.absoluteString == registeredAddress
    }
    public func command(option index: Int) throws -> DeskCommand {
        guard requestId == "decision:\(decisionId)", revision >= 0, options.indices.contains(index) else { throw DeskError.refused("This notification has no valid answer. Open the decision.") }
        return DeskCommand(itemId: itemId, type: "respond", args: .init(requestId: requestId, revision: revision, answers: ["decision": options[index].answer]))
    }
    public func snooze(now: Date = Date()) -> DeskCommand {
        DeskCommand(itemId: itemId, type: "snooze", args: .init(until: ISO8601DateFormatter().string(from: now.addingTimeInterval(3600)), onlyIfActive: true))
    }
}
public struct DeskCommand: Codable, Sendable, Identifiable {
    public struct Args: Codable, Sendable {
        public var text: String?; public var requestId: String?; public var revision: Int?; public var answers: [String: String]?; public var until: String?; public var onlyIfActive: Bool?
        public init(text: String? = nil, requestId: String? = nil, revision: Int? = nil, answers: [String: String]? = nil, until: String? = nil, onlyIfActive: Bool? = nil) {
            self.text = text; self.requestId = requestId; self.revision = revision; self.answers = answers; self.until = until; self.onlyIfActive = onlyIfActive
        }
    }
    public let commandId: UUID
    public var id: UUID { commandId }
    public let itemId: String
    public let type: String
    public let args: Args
    public init(itemId: String, type: String, args: Args) { commandId = UUID(); self.itemId = itemId; self.type = type; self.args = args }
}
public enum PushEnvironment {
    public static func registration(forEntitlement value: String) throws -> String {
        switch value {
        case "development": return "sandbox"
        case "production": return "production"
        default: throw DeskError.refused("Invalid push entitlement environment.")
        }
    }
}
public struct DeviceRegistration: Encodable, Sendable {
    public let token: String; public let platform = "ios"; public let bundleId: String; public let environment: String
    public init(token: String, bundleId: String, environment: String) { self.token = token; self.bundleId = bundleId; self.environment = environment }
}
private final class NativeSessionDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        // A configured desk must not redirect an answer body to another service.
        completionHandler(nil)
    }
}
public struct DeskClient: Sendable {
    public let address: DeskAddress
    private let session: URLSession
    private static let nativeSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        return URLSession(configuration: config, delegate: NativeSessionDelegate(), delegateQueue: nil)
    }()
    public init(address: DeskAddress, session: URLSession? = nil) {
        self.address = address
        self.session = session ?? Self.nativeSession
    }
    private func post<T: Encodable & Sendable>(_ value: T, path: String) async throws -> Data {
        var request = URLRequest(url: address.endpoint(path))
        request.httpMethod = "POST"; request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Native requests carry no browser Origin or Sec-Fetch headers. Identity is added by the tailnet proxy.
        request.httpBody = try JSONEncoder().encode(value)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw DeskError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let reason = (try? JSONDecoder().decode(ErrorBody.self, from: data).error) ?? "Desk returned HTTP \(http.statusCode)."
            if http.statusCode >= 500 || http.statusCode == 429 { throw URLError(.cannotConnectToHost) }
            throw DeskError.refused(reason)
        }
        return data
    }
    private struct ErrorBody: Decodable { let error: String }
    private struct Result: Decodable {
        struct Outcome: Decodable { let active: Bool? }
        let status: String; let error: String?; let outcome: Outcome?
    }
    public func send(_ command: DeskCommand) async throws {
        let data = try await post(command, path: "api/desk/commands")
        guard let result = try? JSONDecoder().decode(Result.self, from: data) else { throw DeskError.invalidResponse }
        if result.status == "failed" {
            if command.type == "snooze", command.args.onlyIfActive == true, result.outcome?.active == false { throw DeskError.inactiveSnooze }
            throw DeskError.refused(result.error ?? "The desk refused the answer.")
        }
        guard result.status == "applied" else { throw DeskError.invalidResponse }
    }
    public func register(_ device: DeviceRegistration) async throws -> String {
        struct Registration: Decodable { let deskId: String }
        let data = try await post(device, path: "api/desk/devices")
        guard let result = try? JSONDecoder().decode(Registration.self, from: data), UUID(uuidString: result.deskId) != nil else { throw DeskError.invalidResponse }
        return result.deskId
    }
}

/// The target address and UUID are frozen at tap time. Retrying can never answer on a different desk.
public actor AnswerQueue {
    public struct Entry: Codable, Sendable, Identifiable {
        public var id: UUID { command.commandId }
        public let address: DeskAddress; public let command: DeskCommand; public let decisionId: String
        public var failure: String?
    }
    private let file: URL
    private var entries: [Entry]
    private var draining = false
    public init(file: URL) throws {
        self.file = file
        entries = FileManager.default.fileExists(atPath: file.path) ? try JSONDecoder().decode([Entry].self, from: Data(contentsOf: file)) : []
    }
    private func save() throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(entries).write(to: file, options: .atomic)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: file.path)
        #endif
    }
    public func all() -> [Entry] { entries }
    public func enqueue(address: DeskAddress, command: DeskCommand, decisionId: String) throws {
        entries.append(Entry(address: address, command: command, decisionId: decisionId))
        do { try save() } catch { entries.removeLast(); throw error }
    }
    public func drain(send: @Sendable (Entry) async throws -> Void,
                      refused: @Sendable (Entry) async -> Void) async throws {
        guard !draining else { return }; draining = true; defer { draining = false }
        for entry in entries where entry.failure == nil {
            try Task.checkCancellation()
            do {
                try await send(entry)
                entries.removeAll { $0.id == entry.id }; try save()
            } catch let error as DeskError {
                let reason: String
                let notify: Bool
                switch error {
                case .refused(let message): reason = message; notify = true
                case .inactiveSnooze: reason = error.localizedDescription; notify = false
                default: continue
                }
                if let index = entries.firstIndex(where: { $0.id == entry.id }) {
                    entries[index].failure = reason; try save()
                    if notify { await refused(entries[index]) }
                }
            } catch { /* Durable entry remains for launch, refresh, or the next action. */ }
        }
    }
}
