import Foundation
import TangoDeskKit

public struct SyncedDictation: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var capturedAt: Double
    public var text: String
    public var destination: String
    public var outcome: String
    public var revision: Int
    public var device: String?
    public var date: Date { Date(timeIntervalSince1970: capturedAt / 1000) }
    var upload: Self { var copy = self; copy.device = nil; return copy }
}
public struct DictationSnapshot: Codable, Sendable {
    public var generation: String
    public var entries: [SyncedDictation]
    public var deleted: [String]
    public init(generation: String, entries: [SyncedDictation], deleted: [String]) {
        self.generation = generation; self.entries = entries; self.deleted = deleted
    }
}
public enum DictationSyncError: Error { case status(Int), invalidResponse, invalidAddress }

private func isHistoryEndpoint(_ url: URL) -> Bool {
    url.scheme == "https" && (url.host?.lowercased().hasSuffix(".ts.net") ?? false)
}

/// No cookies, redirects, cache, diagnostics, or response-body error messages.
public struct DictationSyncTransport: Sendable {
    private let session: URLSession
    public init(session: URLSession? = nil) {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false; config.urlCache = nil
        self.session = session ?? URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }
    public func request(endpoint: URL, body: Data?) async throws -> Data {
        guard isHistoryEndpoint(endpoint) else { throw DictationSyncError.invalidAddress }
        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.setValue("native", forHTTPHeaderField: "X-History-Client")
        if let body {
            request.httpMethod = "POST"; request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw DictationSyncError.invalidResponse }
        guard response.statusCode == 200 else { throw DictationSyncError.status(response.statusCode) }
        guard data.count <= 12_000_000 else { throw DictationSyncError.invalidResponse }
        return data
    }
}

/// Independent of local recovery. Only explicit new capture callbacks enroll entries.
/// A generation change discards uploads, never the independent local safety net.
@MainActor @Observable public final class DictationSync {
    private struct State: Codable {
        var enabled = true
        var boundary: Date
        var address = ""
        var generation: String?
        var records: [SyncedDictation] = []
        var pending: Set<String> = []
        // Optional for compatibility with snapshots written before ID suppression.
        var deleted: Set<String>?
        var cached: [SyncedDictation] = []
        var refreshedAt: Date?
    }
    private struct Mutation: Encodable {
        var action: String
        var generation: String
        var entry: SyncedDictation?
        var id: String?
    }
    private var state: State
    public private(set) var error: String?
    public private(set) var busy = false
    public var enabled: Bool { state.enabled }
    public var entries: [SyncedDictation] { state.cached }
    public var refreshedAt: Date? { state.refreshedAt }
    public var pendingCount: Int { state.pending.count }
    public var address: String { state.address }
    private let directory: URL
    private let now: () -> Date
    private let send: @MainActor (URL, Data?) async throws -> Data
    private var readable = true
    private var epoch = UUID()
    private var task: Task<Void, Never>?
    private var file: URL { directory.appendingPathComponent("sync.json") }

    public init(directory: URL, now: @escaping () -> Date = Date.init,
                send: (@MainActor (URL, Data?) async throws -> Data)? = nil) {
        self.directory = directory; self.now = now
        let transport = DictationSyncTransport()
        self.send = send ?? { try await transport.request(endpoint: $0, body: $1) }
        state = State(boundary: now())
        do {
            try prepare()
            if FileManager.default.fileExists(atPath: file.path) {
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                state = try JSONDecoder().decode(State.self, from: Data(contentsOf: file))
            }
            prune(); try persist()
        } catch { readable = false; self.error = "Desk history storage unavailable. Local history is separate." }
    }
    /// Endpoint changes invalidate every upload/cache; text never follows a host change.
    public func configure(_ text: String) {
        guard readable else { return }
        let normalized = (try? DeskAddress(text)).flatMap { isHistoryEndpoint($0.base) ? $0.base.absoluteString : nil } ?? ""
        error = normalized.isEmpty ? "Use an HTTPS Tailscale desk URL whose host ends in .ts.net." : nil
        guard normalized != state.address else { return }
        invalidate(); state.address = normalized; resetEnrollment(); state.generation = nil; state.deleted = nil; state.cached = []; state.refreshedAt = nil
        save()
    }
    public func setEnabled(_ value: Bool) {
        guard readable, value != state.enabled else { return }
        invalidate(); state.enabled = value; resetEnrollment(); clearCache()
        save()
    }
    /// Cancel local pending text even when local recovery was disabled. Already uploaded text stays remote.
    public func clearPending() {
        guard readable else { return }
        invalidate(); resetEnrollment(); clearCache(); save()
    }
    private func clearCache() { state.cached = []; state.refreshedAt = nil }
    private func resetEnrollment() { state.boundary = now(); state.records = []; state.pending = [] }
    private func invalidate() { epoch = UUID(); task?.cancel(); task = nil; busy = false }
    public func capture(_ entry: DictationEntry) {
        // Pending snapshots can still receive final words during the undo countdown.
        // Keep those in local recovery; enroll immutable remote content only on completion.
        guard entry.outcome != .pending, readable, state.enabled, state.generation != nil,
              !(state.deleted?.contains(entry.id.uuidString.lowercased()) ?? false),
              (entry.capturedAt > state.boundary || state.records.contains { $0.id == entry.id.uuidString.lowercased() }),
              entry.capturedAt > now().addingTimeInterval(-7 * 86400), entry.text.utf8.count <= 16_384,
              !entry.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let id = entry.id.uuidString.lowercased()
        let outcome = entry.outcome == .pending ? "unknown" : entry.outcome.rawValue
        if let index = state.records.firstIndex(where: { $0.id == id }) {
            // The server freezes capture content. Later callbacks update delivery only.
            guard state.records[index].outcome != outcome else { return }
            state.records[index].outcome = outcome; state.records[index].revision += 1
        } else {
            state.records.append(SyncedDictation(id: id, capturedAt: floor(entry.capturedAt.timeIntervalSince1970 * 1000),
                text: entry.text, destination: String((entry.destination ?? "No conversation").prefix(256)),
                outcome: outcome, revision: 1))
        }
        state.pending.insert(id); prune(); save()

    }
    public func schedule() {
        guard task == nil else { return }
        task = Task { [weak self] in
            guard let self else { return }
            await self.refresh()
            self.task = nil
        }
    }
    public func sweep() { guard readable else { return }; prune(); save() }
    private func prune() {
        let cutoff = now().addingTimeInterval(-7 * 86400)
        state.records = Array(state.records.filter { $0.date > cutoff }.sorted { $0.capturedAt > $1.capturedAt }.prefix(200))
        state.pending.formIntersection(state.records.map(\.id))
        state.cached = Array(state.cached.filter { $0.date > cutoff }.sorted { $0.capturedAt > $1.capturedAt }.prefix(200))
    }
    /// Every drain reads deletion state first, including retries after a lost acknowledgement.
    public func refresh(action: String? = nil, id: String? = nil) async {
        guard readable, !busy, state.enabled else { return }
        sweep()
        guard readable else { return }
        guard let address = try? DeskAddress(state.address), isHistoryEndpoint(address.base) else {
            error = "Use an HTTPS Tailscale desk URL whose host ends in .ts.net."; return
        }
        busy = true
        let current = epoch
        defer { if epoch == current { busy = false } }
        let endpoint = address.endpoint("api/desk/dictation-history")
        do {
            let data = try await send(endpoint, nil)
            guard epoch == current, !Task.isCancelled else { return }
            let snapshot = try JSONDecoder().decode(DictationSnapshot.self, from: data)
            if snapshot.generation != state.generation { resetEnrollment() }
            state.generation = snapshot.generation
            suppressDeleted(snapshot.deleted)
            state.cached = snapshot.entries; state.refreshedAt = now(); prune()
            guard save() else { return }
            if let action, ["clear", "delete"].contains(action) {
                let body = try JSONEncoder().encode(Mutation(action: action, generation: snapshot.generation, id: id))
                let result = try await send(endpoint, body)
                guard epoch == current, !Task.isCancelled else { return }
                if action == "clear" {
                    let cleared = try JSONDecoder().decode(DictationSnapshot.self, from: result)
                    resetEnrollment(); state.generation = cleared.generation; state.deleted = Set(cleared.deleted); state.cached = []
                } else if let id {
                    state.cached.removeAll { $0.id == id }; state.records.removeAll { $0.id == id }; state.pending.remove(id)
                    state.deleted = (state.deleted ?? []).union([id])
                }
                if save() { error = nil }; return
            }
            for record in state.records where state.pending.contains(record.id) {
                guard epoch == current, !Task.isCancelled else { return }
                let body = try JSONEncoder().encode(Mutation(action: "put", generation: snapshot.generation, entry: record.upload))
                do { _ = try await send(endpoint, body) }
                catch DictationSyncError.status(let code) where code == 400 || code == 409 {
                    guard epoch == current else { return }
                    // A rejected capture is never retried under a new generation.
                    state.pending.remove(record.id); save()
                    throw DictationSyncError.status(code)
                }
                guard epoch == current, !Task.isCancelled else { return }
                if state.records.first(where: { $0.id == record.id })?.revision == record.revision { state.pending.remove(record.id) }
                guard save() else { return }
            }
            let latest = try await send(endpoint, nil)
            guard epoch == current, !Task.isCancelled else { return }
            let result = try JSONDecoder().decode(DictationSnapshot.self, from: latest)
            if result.generation != state.generation { resetEnrollment() }
            state.generation = result.generation; state.cached = result.entries; state.refreshedAt = now()
            suppressDeleted(result.deleted)
            prune(); if save() { error = nil }
        } catch {
            guard epoch == current, !Task.isCancelled else { return }
            if case DictationSyncError.status(403) = error {
                state.cached = []; save()
                self.error = "Desk history access denied. Check your Tailscale login."
            } else { self.error = "Desk history is offline or unavailable. Pending uploads will retry; local history is separate." }
        }
    }
    private func suppressDeleted(_ ids: [String]) {
        let deleted = Set(ids)
        state.deleted = deleted
        state.records.removeAll { deleted.contains($0.id) }
        state.pending.subtract(deleted)
    }
    private func prepare() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        var url = directory; var values = URLResourceValues(); values.isExcludedFromBackup = true; try url.setResourceValues(values)
        for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            let name = file.lastPathComponent
            if name.hasPrefix(".sync-"), UUID(uuidString: String(name.dropFirst(6))) != nil { try FileManager.default.removeItem(at: file) }
        }
    }
    @discardableResult private func save() -> Bool {
        do { try persist(); return true }
        catch { readable = false; invalidate(); self.error = "Desk history storage unavailable. Local history is separate."; return false }
    }
    private func persist() throws {
        try prepare()
        let temp = directory.appendingPathComponent(".sync-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: temp.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw CocoaError(.fileWriteUnknown) }
        defer { try? FileManager.default.removeItem(at: temp) }
        let handle = try FileHandle(forWritingTo: temp)
        do { try handle.write(contentsOf: JSONEncoder().encode(state)); try handle.synchronize(); try handle.close() }
        catch { try? handle.close(); throw error }
        var url = temp; var values = URLResourceValues(); values.isExcludedFromBackup = true; try url.setResourceValues(values)
        guard rename(temp.path, file.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }
}
