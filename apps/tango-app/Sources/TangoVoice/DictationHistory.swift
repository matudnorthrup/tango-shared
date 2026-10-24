import Foundation

public struct DictationEntry: Codable, Identifiable, Equatable, Sendable {
    public enum Outcome: String, Codable, Sendable { case pending, sent, undone, failed }
    public let id: UUID
    public let capturedAt: Date
    public var text: String
    public var destination: String?
    public var outcome: Outcome
    public var isCommand: Bool
    public init(id: UUID, capturedAt: Date, text: String, destination: String?, outcome: Outcome, isCommand: Bool = false) {
        self.id = id; self.capturedAt = capturedAt; self.text = text; self.destination = destination
        self.outcome = outcome; self.isCommand = isCommand
    }
}

/// Local recovery only. This type is never passed to diagnostics or a transport.
@MainActor @Observable public final class DictationHistory {
    public private(set) var entries: [DictationEntry] = []
    public private(set) var error: String?
    public var enabled: Bool
    public let directory: URL
    private let now: () -> Date
    private var readable = true
    private var clearedIDs: Set<UUID> = []
    private var file: URL { directory.appendingPathComponent("history.json") }
    public init(directory: URL, enabled: Bool = true, now: @escaping () -> Date = Date.init) {
        self.directory = directory; self.enabled = enabled; self.now = now
        do {
            try prepareDirectory()
            if FileManager.default.fileExists(atPath: file.path) {
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                entries = try JSONDecoder().decode([DictationEntry].self, from: Data(contentsOf: file))
            }
            try persist(retained(entries))
        } catch { readable = false; self.error = "History could not be opened. Existing text has not been replaced." }
    }
    @discardableResult public func save(_ entry: DictationEntry) -> Bool {
        guard enabled, readable, !clearedIDs.contains(entry.id), !entry.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        var next = entries.filter { $0.id != entry.id }; next.append(entry)
        do { try persist(retained(next)); error = nil; return entries.contains { $0.id == entry.id } }
        catch { self.error = "History could not be saved. Copy your text before closing."; return false }
    }
    public func refresh() {
        guard readable else { return }
        let next = retained(entries)
        do {
            try removeInterruptedWrites()
            if next != entries { try persist(next); error = nil }
        } catch { self.error = "Expired history could not be removed." }
    }
    public func clear() {
        do { let ids = entries.map(\.id); try persist([]); clearedIDs.formUnion(ids); readable = true; error = nil }
        catch { self.error = "History could not be cleared." }
    }
    private func retained(_ values: [DictationEntry]) -> [DictationEntry] {
        Array(values.filter { $0.capturedAt > now().addingTimeInterval(-7 * 24 * 3600) }
            .sorted { $0.capturedAt > $1.capturedAt }.prefix(200))
    }
    private func prepareDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        var url = directory; var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
        try removeInterruptedWrites()
    }
    private func removeInterruptedWrites() throws {
        // A crash skips persist's defer. Never let those plaintext snapshots
        // outlive retention or Clear history. MainActor serializes our writes.
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            let name = url.lastPathComponent
            guard name.hasPrefix(".history-"), UUID(uuidString: String(name.dropFirst(9))) != nil else { continue }
            try FileManager.default.removeItem(at: url)
        }
    }
    private func persist(_ next: [DictationEntry]) throws {
        try prepareDirectory()
        let data = try JSONEncoder().encode(next)
        let temp = directory.appendingPathComponent(".history-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: temp.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        defer { try? FileManager.default.removeItem(at: temp) }
        let handle = try FileHandle(forWritingTo: temp)
        do { try handle.write(contentsOf: data); try handle.synchronize(); try handle.close() }
        catch { try? handle.close(); throw error }
        var url = temp; var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
        guard rename(temp.path, file.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
        entries = next
    }
}
