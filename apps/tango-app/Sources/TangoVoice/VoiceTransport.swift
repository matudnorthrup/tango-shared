import Foundation
import TangoDeskKit

final class NoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
public enum VoiceRequests {
    public static func diagnostic(_ address: DeskAddress, event: VoiceDiagnostic) throws -> URLRequest {
        var request = URLRequest(url: address.endpoint("api/desk/voice/events"))
        request.httpMethod = "POST"; request.timeoutInterval = 5
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(event)
        return request
    }
    public static func socket(_ address: DeskAddress, warm: Bool = false) -> URLRequest {
        var parts = URLComponents(url: address.endpoint("api/desk/voice"), resolvingAgainstBaseURL: false)!
        parts.scheme = address.base.scheme == "https" ? "wss" : "ws"
        parts.queryItems = [.init(name: "mode", value: "dictation"), .init(name: "manualFinish", value: "1")]
        if warm { parts.queryItems?.append(.init(name: "warm", value: "1")) }
        var origin = URLComponents(url: address.base, resolvingAgainstBaseURL: false)!
        origin.path = ""; origin.query = nil; origin.fragment = nil
        var request = URLRequest(url: parts.url!); request.timeoutInterval = 15
        request.setValue(origin.string!, forHTTPHeaderField: "Origin")
        return request
    }
}
@MainActor public final class VoiceTransport {
    private let session: URLSession
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var sender: Task<Void, Never>?
    private var pendingBytes = 0
    private var heartbeat: Task<Void, Never>?
    private var pingDeadline: Task<Void, Never>?
    public private(set) var modelReady = false
    private var buffering = false
    /// Post-press only; no model session is opened until activate().
    public func beginBuffering() { buffering = true }
    public private(set) var warmReady = false
    public var event: (String, String) -> Void = { _, _ in }
    public var turnStatus: (String, Int?, String?) -> Void = { _, _, _ in }
    public var audioSent: () -> Void = {}
    public var failed: (String) -> Void = { _ in }
    public init() {
        let config = URLSessionConfiguration.ephemeral; config.httpShouldSetCookies = false
        session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }
    public func get(_ url: URL) async throws -> Data {
        var request = URLRequest(url: url); request.timeoutInterval = 10
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw DeskError.refused("Could not read the open desk thread.") }
        return data
    }
    /// Best effort telemetry, independent of the socket and reply path. No disk queue of personal metadata.
    public func report(_ event: VoiceDiagnostic, to address: DeskAddress) async throws {
        let (_, response) = try await session.data(for: VoiceRequests.diagnostic(address, event: event))
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else { throw DeskError.invalidResponse }
    }
    public func resolveNavigation(_ address: DeskAddress, exchangeId: UUID, transcript: String) async throws -> NavigationResolution {
        let (data, response) = try await session.data(for: VoiceRequests.navigation(address, exchangeId: exchangeId, transcript: transcript))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw DeskError.invalidResponse }
        return try JSONDecoder().decode(NavigationResolution.self, from: data)
    }
    public func commitNavigation(_ address: DeskAddress, exchangeId: UUID, ticket: String) async throws -> NavigationCommit {
        let (data, response) = try await session.data(for: VoiceRequests.navigation(address, exchangeId: exchangeId, ticket: ticket))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw DeskError.invalidResponse }
        return try JSONDecoder().decode(NavigationCommit.self, from: data)
    }
    public func target(_ address: DeskAddress) async throws -> VoiceTarget {
        let id = try VoiceTarget.presentation(await get(address.endpoint("api/desk/presentation")))
        return try VoiceTarget.resolve(id: id, detail: await get(address.endpoint("api/desk/items").appendingPathComponent(id)))
    }
    /// A known non-replyable view permits navigation. Failed lookups and denied
    /// permission discard queued post-press audio without activating a model.
    public func prepareCapture(_ address: DeskAddress, permission: () async throws -> Bool) async throws -> VoiceTarget? {
        let expected = socket
        do {
            guard try await permission() else { throw DeskError.refused("Microphone access is denied. Open Privacy Settings to enable it.") }

            let id = try VoiceTarget.optionalPresentation(await get(address.endpoint("api/desk/presentation")))
            let target: VoiceTarget?
            if let id {
                target = try VoiceTarget.optionalTarget(id: id, detail: await get(address.endpoint("api/desk/items").appendingPathComponent(id)))
            } else { target = nil }
            return target
        } catch {
            // A late failure from an older attempt must not close its replacement.
            if socket === expected { close() }
            throw error
        }
    }
    public func open(_ address: DeskAddress, warm: Bool = false) {
        close()
        let socket = session.webSocketTask(with: VoiceRequests.socket(address, warm: warm)); self.socket = socket; socket.resume()
        heartbeat = Task {
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(25))
                    pingDeadline = Task {
                        do { try await Task.sleep(for: .seconds(10)) } catch { return }
                        if self.socket === socket { failed("Voice connection stopped responding.") }
                    }
                    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                        socket.sendPing { error in
                            if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                        }
                    }
                    guard self.socket === socket else { return }
                    pingDeadline?.cancel(); pingDeadline = nil
                } catch { if self.socket === socket { failed("Voice connection lost.") }; return }
            }
        }
        receiver = Task {
            do {
                while !Task.isCancelled {
                    let frame = try await socket.receive()
                    guard self.socket === socket else { return }
                    guard case .string(let text) = frame,
                          let data = text.data(using: .utf8),
                          let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let type = json["type"] as? String else { continue }
                    if type == "status", json["state"] as? String == "armed" { warmReady = true }
                    if type == "status", json["state"] as? String == "listening" { modelReady = true }
                    if type == "status", let state = json["state"] as? String { turnStatus(state, json["untilMs"] as? Int, json["id"] as? String) }
                    event(type, (json["text"] ?? json["delta"] ?? json["state"] ?? json["message"]) as? String ?? "")
                }
            } catch { if self.socket === socket { failed("Voice connection failed: \(error.localizedDescription)") } }
        }
    }
    public func activate() async throws {
        guard let socket, warmReady else { throw DeskError.refused("Voice connection is not ready.") }
        warmReady = false
        try await socket.send(.string("{\"type\":\"start\"}"))
    }
    public func audio(_ data: Data) {
        guard let socket, !data.isEmpty, data.count <= 9600, data.count % 2 == 0 else { return }
        guard pendingBytes + data.count <= (buffering ? 720000 : 48000) else { failed("Voice connection is too slow. Nothing was sent."); return }
        pendingBytes += data.count
        let previous = sender
        sender = Task {
            await previous?.value
            guard self.socket === socket else { return }
            do {
                try await waitForModel(socket)
                try Task.checkCancellation()
                try await socket.send(.data(data))
                guard self.socket === socket else { return }
                pendingBytes -= data.count; audioSent()
            }
            catch { if self.socket === socket { failed("Could not send microphone audio.") } }
        }
    }
    private func waitForModel(_ expected: URLSessionWebSocketTask) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(15))
        while !modelReady {
            guard socket === expected, ContinuousClock.now < deadline else { throw DeskError.refused("Voice connection closed or timed out.") }
            try await Task.sleep(for: .milliseconds(10))
        }
        guard socket === expected else { throw DeskError.refused("Voice connection closed.") }
    }
    public func requestPause(_ quietMs: Int, id: UUID? = nil) async throws {
        let current = socket
        if let current { try await waitForModel(current) }
        await sender?.value
        try Task.checkCancellation()
        guard let current, socket === current else { throw DeskError.refused("Voice connection closed before pause.") }
        var body: [String: Any] = ["type": "pause", "quietMs": quietMs]
        if let id { body["id"] = id.uuidString }
        let data = try JSONSerialization.data(withJSONObject: body)
        try await current.send(.string(String(decoding: data, as: UTF8.self)))
    }
    public func finish() async throws {
        let current = socket
        if let current { try await waitForModel(current) }
        await sender?.value
        guard let current, socket === current else { throw DeskError.refused("Voice connection closed before finishing.") }
        try await current.send(.string("{\"type\":\"finish\"}"))
    }
    public func close() {
        modelReady = false; buffering = false
        heartbeat?.cancel(); heartbeat = nil; pingDeadline?.cancel(); pingDeadline = nil; warmReady = false
        let old = socket; socket = nil; receiver?.cancel(); receiver = nil; sender?.cancel(); sender = nil; pendingBytes = 0
        old?.cancel(with: .normalClosure, reason: nil)
    }
}
