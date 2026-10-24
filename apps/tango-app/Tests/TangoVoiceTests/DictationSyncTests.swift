import XCTest
@testable import TangoVoice

@MainActor final class DictationSyncTests: XCTestCase {
    @MainActor final class Server {
        var generation = UUID().uuidString.lowercased()
        var entries: [SyncedDictation] = []
        var deleted: [String] = []
        var offline = false
        var denied = false
        var posts = 0
        var onPost: (() -> Void)?
        func send(_ url: URL, _ body: Data?) async throws -> Data {
            if offline { throw URLError(.notConnectedToInternet) }
            if denied { throw DictationSyncError.status(403) }
            if let body {
                let object = try JSONSerialization.jsonObject(with: body) as! [String: Any]
                guard object["generation"] as? String == generation else { throw DictationSyncError.status(409) }
                posts += 1
                if object["action"] as? String == "put" {
                    let entry = try JSONDecoder().decode(SyncedDictation.self, from: JSONSerialization.data(withJSONObject: object["entry"]!))
                    guard !deleted.contains(entry.id) else { throw DictationSyncError.status(409) }
                    entries.removeAll { $0.id == entry.id }; entries.append(entry)
                    onPost?()
                } else if object["action"] as? String == "clear" { generation = UUID().uuidString.lowercased(); entries = []; deleted = [] }
                else if let id = object["id"] as? String { entries.removeAll { $0.id == id }; deleted.append(id) }
            }
            return try JSONEncoder().encode(DictationSnapshot(generation: generation, entries: entries, deleted: deleted))
        }
    }
    func dir() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("noindex") }
    func entry(_ time: Date, id: UUID = UUID(), outcome: DictationEntry.Outcome = .failed) -> DictationEntry {
        DictationEntry(id: id, capturedAt: time, text: "Synthetic recovery text", destination: "Test conversation", outcome: outcome)
    }
    func testNewOnlyOfflineRestartAndOutcomeRevision() async throws {
        let directory = dir(); defer { try? FileManager.default.removeItem(at: directory) }
        var time = Date(); let server = Server()
        let sync = DictationSync(directory: directory, now: { time }, send: server.send)
        sync.configure("https://desk.example.ts.net")
        let old = entry(time.addingTimeInterval(-1))
        await sync.refresh(); sync.capture(old)
        XCTAssertEqual(sync.pendingCount, 0)
        time += 1; let capture = entry(time, outcome: .failed)
        server.offline = true; sync.capture(capture); await sync.refresh()
        XCTAssertEqual(sync.pendingCount, 1)
        let restarted = DictationSync(directory: directory, now: { time }, send: server.send)
        XCTAssertEqual(restarted.pendingCount, 1)
        server.offline = false; await restarted.refresh()
        XCTAssertEqual(server.entries.count, 1); XCTAssertEqual(restarted.pendingCount, 0)
        restarted.capture(entry(time, id: capture.id, outcome: .sent)); await restarted.refresh()
        XCTAssertEqual(server.entries.first?.revision, 2); XCTAssertEqual(server.entries.first?.outcome, "sent")
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent("sync.json").path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertEqual(try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }
    func testOffAndLocalClearEraseDownloadedCacheOnDisk() async throws {
        for turnOff in [true, false] {
            let directory = dir(); defer { try? FileManager.default.removeItem(at: directory) }
            var time = Date(); let server = Server()
            let sync = DictationSync(directory: directory, now: { time }, send: server.send)
            sync.configure("https://desk.example.ts.net"); await sync.refresh()
            time += 1; sync.capture(entry(time)); await sync.refresh()
            XCTAssertEqual(sync.entries.count, 1); XCTAssertNotNil(sync.refreshedAt)
            if turnOff { sync.setEnabled(false) } else { sync.clearPending() }
            XCTAssertTrue(sync.entries.isEmpty); XCTAssertNil(sync.refreshedAt)
            let reopened = DictationSync(directory: directory, now: { time }, send: server.send)
            XCTAssertTrue(reopened.entries.isEmpty); XCTAssertNil(reopened.refreshedAt)
            let disk = try String(contentsOf: directory.appendingPathComponent("sync.json"), encoding: .utf8)
            XCTAssertFalse(disk.contains("Synthetic recovery text"))
            XCTAssertEqual(server.entries.count, 1) // Remote history has its own deletion control.
        }
    }
    func testRejectsNonTailnetEndpointsWithoutSending() async throws {
        let directory = dir(); defer { try? FileManager.default.removeItem(at: directory) }
        var requests = 0
        let sync = DictationSync(directory: directory, send: { _, _ in requests += 1; throw URLError(.badURL) })
        for address in ["https://example.com", "https://ts.net", "https://desk.ts.net.attacker.test", "http://desk.example.ts.net", "https://desk.example.ts.net@attacker.test"] {
            sync.configure(address); await sync.refresh()
            XCTAssertEqual(sync.address, ""); XCTAssertTrue(sync.error?.contains(".ts.net") == true)
        }
        XCTAssertEqual(requests, 0)
        sync.configure("https://desk.example.ts.net")
        XCTAssertEqual(sync.address, "https://desk.example.ts.net"); XCTAssertNil(sync.error)
        do {
            _ = try await DictationSyncTransport().request(endpoint: URL(string: "https://example.com")!, body: Data())
            XCTFail("Transport must also reject non-tailnet hosts")
        } catch DictationSyncError.invalidAddress {} catch { XCTFail("Unexpected error: \(error)") }
    }
    func testPendingTranscriptDoesNotFreezeRemoteContent() async {
        let directory = dir(); defer { try? FileManager.default.removeItem(at: directory) }
        var time = Date(); let server = Server()
        let sync = DictationSync(directory: directory, now: { time }, send: server.send)
        sync.configure("https://desk.example.ts.net"); await sync.refresh()
        time += 1
        var capture = entry(time, outcome: .pending)
        capture.text = "Partial"
        sync.capture(capture); await sync.refresh()
        XCTAssertEqual(sync.pendingCount, 0); XCTAssertTrue(server.entries.isEmpty)
        capture.text = "Final trailing words"; sync.capture(capture); await sync.refresh()
        XCTAssertTrue(server.entries.isEmpty)
        capture.outcome = .sent; sync.capture(capture); await sync.refresh()
        XCTAssertEqual(server.entries.first?.text, "Final trailing words")
        XCTAssertEqual(server.entries.first?.outcome, "sent")
    }
    func testClearGenerationDropsOfflineQueueWithoutTouchingLocal() async {
        let directory = dir(); defer { try? FileManager.default.removeItem(at: directory) }
        var time = Date(); let server = Server()
        let sync = DictationSync(directory: directory, now: { time }, send: server.send)
        let local = DictationHistory(directory: directory.appendingPathComponent("local"), now: { time })
        sync.configure("https://desk.example.ts.net"); await sync.refresh()
        time += 1; let capture = entry(time); local.save(capture); sync.capture(capture)
        server.generation = UUID().uuidString.lowercased()
        time += 1; await sync.refresh()
        XCTAssertEqual(server.posts, 0); XCTAssertEqual(sync.pendingCount, 0); XCTAssertEqual(local.entries.count, 1)
        sync.capture(entry(capture.capturedAt, id: capture.id, outcome: .sent)); await sync.refresh()
        XCTAssertEqual(server.posts, 0)
    }
    func testDisableDuringUploadAndReenableNeverBackfills() async {
        let directory = dir(); defer { try? FileManager.default.removeItem(at: directory) }
        var time = Date(); let server = Server()
        let sync = DictationSync(directory: directory, now: { time }, send: server.send)
        sync.configure("https://desk.example.ts.net"); await sync.refresh()
        time += 1; sync.capture(entry(time)); time += 1; sync.capture(entry(time))
        server.onPost = { sync.setEnabled(false) }
        await sync.refresh()
        XCTAssertEqual(server.posts, 1); XCTAssertEqual(sync.pendingCount, 0); XCTAssertFalse(sync.enabled)
        let reopened = DictationSync(directory: directory, now: { time }, send: server.send)
        XCTAssertFalse(reopened.enabled); XCTAssertEqual(reopened.pendingCount, 0)
        time += 1; let whileOff = entry(time); sync.capture(whileOff)
        time += 1; sync.setEnabled(true); sync.capture(whileOff)
        server.onPost = nil; await sync.refresh()
        XCTAssertEqual(server.posts, 1)
    }
    func testDeletionLocalClearHostChangeAndRevocation() async {
        let directory = dir(); defer { try? FileManager.default.removeItem(at: directory) }
        var time = Date(); let server = Server()
        let sync = DictationSync(directory: directory, now: { time }, send: server.send)
        sync.configure("https://desk.example.ts.net"); await sync.refresh()
        time += 1; let capture = entry(time); sync.capture(capture); await sync.refresh()
        XCTAssertEqual(sync.entries.count, 1)
        await sync.refresh(action: "delete", id: capture.id.uuidString.lowercased())
        XCTAssertTrue(sync.entries.isEmpty)
        sync.capture(entry(time, id: capture.id, outcome: .sent)); await sync.refresh()
        XCTAssertTrue(server.entries.isEmpty)
        time += 1; sync.capture(entry(time)); sync.clearPending(); await sync.refresh()
        XCTAssertTrue(server.entries.isEmpty)
        time += 1; sync.capture(entry(time)); await sync.refresh()
        server.denied = true; await sync.refresh(); XCTAssertTrue(sync.entries.isEmpty)
        sync.configure("https://another.example.ts.net"); XCTAssertEqual(sync.pendingCount, 0); XCTAssertTrue(sync.entries.isEmpty)
    }
    func testTombstonesDoNotExcludeRecordingSpanningRefresh() async throws {
        let directory = dir(); defer { try? FileManager.default.removeItem(at: directory) }
        var time = Date(); let server = Server()
        let sync = DictationSync(directory: directory, now: { time }, send: server.send)
        sync.configure("https://desk.example.ts.net"); await sync.refresh()
        time += 1; let deleted = entry(time); sync.capture(deleted); await sync.refresh()
        time += 1; let recording = entry(time)
        time += 1; await sync.refresh(action: "delete", id: deleted.id.uuidString.lowercased())
        time += 60; await sync.refresh()
        // Deletion suppression survives restart and rejects a late delivery callback.
        let restarted = DictationSync(directory: directory, now: { time }, send: server.send)
        restarted.capture(entry(deleted.capturedAt, id: deleted.id, outcome: .sent))
        XCTAssertEqual(restarted.pendingCount, 0)
        restarted.capture(recording)
        XCTAssertEqual(restarted.pendingCount, 1)
        await restarted.refresh()
        XCTAssertEqual(server.entries.map(\.id), [recording.id.uuidString.lowercased()])
        time += 1; let another = entry(time)
        time += 60; await restarted.refresh()
        restarted.capture(another); await restarted.refresh()
        XCTAssertEqual(Set(server.entries.map(\.id)), Set([recording.id, another.id].map { $0.uuidString.lowercased() }))
    }
    func testExpiryCapAndInterruptedSnapshots() async throws {
        let directory = dir(); defer { try? FileManager.default.removeItem(at: directory) }
        var time = Date(); let server = Server()
        let sync = DictationSync(directory: directory, now: { time }, send: server.send)
        sync.configure("https://desk.example.ts.net"); await sync.refresh()
        for _ in 0..<205 { time += 1; sync.capture(entry(time)) }
        XCTAssertEqual(sync.pendingCount, 200)
        let orphan = directory.appendingPathComponent(".sync-\(UUID().uuidString)")
        try Data("private interrupted snapshot".utf8).write(to: orphan)
        time += 8 * 86400; sync.sweep()
        XCTAssertEqual(sync.pendingCount, 0); XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
        let reopened = DictationSync(directory: directory, now: { time }, send: server.send)
        XCTAssertEqual(reopened.pendingCount, 0)
    }
    func testLiveSyntheticRecovery() async throws {
        guard let address = ProcessInfo.processInfo.environment["TANGO_HISTORY_LIVE_URL"] else { throw XCTSkip("Set a private authenticated test endpoint for the opt-in live check") }
        let firstDir = dir(), secondDir = dir()
        defer { try? FileManager.default.removeItem(at: firstDir); try? FileManager.default.removeItem(at: secondDir) }
        let first = DictationSync(directory: firstDir)
        let second = DictationSync(directory: secondDir)
        first.configure(address); second.configure(address)
        await first.refresh()
        XCTAssertNil(first.error)
        let id = UUID()
        let capture = DictationEntry(id: id, capturedAt: Date(), text: "Synthetic dictation sync QA — safe to delete", destination: "Synthetic QA", outcome: .failed)
        first.capture(capture); await first.refresh()
        await second.refresh()
        let recovered = second.entries.contains { $0.id == id.uuidString.lowercased() && $0.text == capture.text && $0.outcome == "failed" }
        // Delete only this test UUID, never clear an owner's history.
        await second.refresh(action: "delete", id: id.uuidString.lowercased())
        await first.refresh()
        XCTAssertTrue(recovered)
        XCTAssertFalse(first.entries.contains { $0.id == id.uuidString.lowercased() })
        XCTAssertNil(second.error)
    }

}
