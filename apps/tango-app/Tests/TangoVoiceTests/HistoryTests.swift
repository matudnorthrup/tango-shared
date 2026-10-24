import XCTest
import TangoDeskKit
@testable import TangoVoice

@MainActor final class HistoryTests: XCTestCase {
    func directory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }
    func entry(_ date: Date, id: UUID = UUID(), outcome: DictationEntry.Outcome = .pending) -> DictationEntry {
        .init(id: id, capturedAt: date, text: "A recoverable thought", destination: "Scratch", outcome: outcome)
    }
    func testRetentionCapPermissionsBackupAndReload() throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        var now = Date(); let store = DictationHistory(directory: dir, now: { now })
        XCTAssertFalse(store.save(entry(now.addingTimeInterval(-7 * 86400))))
        for i in 0..<205 { XCTAssertTrue(store.save(entry(now.addingTimeInterval(Double(i)))) ) }
        XCTAssertEqual(store.entries.count, 200)
        let file = dir.appendingPathComponent("history.json")
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: dir.path)[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        XCTAssertEqual(try dir.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        XCTAssertEqual(try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        XCTAssertEqual(DictationHistory(directory: dir, now: { now }).entries, store.entries)
        now = now.addingTimeInterval(8 * 86400); store.refresh()
        XCTAssertTrue(store.entries.isEmpty)
        XCTAssertTrue(DictationHistory(directory: dir, now: { now }).entries.isEmpty)
    }
    func testStableIdentityDisabledAndClear() {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let now = Date(); let id = UUID(); let store = DictationHistory(directory: dir)
        XCTAssertTrue(store.save(entry(now, id: id)))
        XCTAssertTrue(store.save(entry(now, id: id, outcome: .sent)))
        XCTAssertEqual(store.entries.count, 1); XCTAssertEqual(store.entries[0].id, id)
        XCTAssertEqual(store.entries[0].capturedAt, now); XCTAssertEqual(store.entries[0].outcome, .sent)
        store.enabled = false; XCTAssertFalse(store.save(entry(now)))
        XCTAssertEqual(store.entries.count, 1); store.clear()
        XCTAssertTrue(DictationHistory(directory: dir).entries.isEmpty)
        store.enabled = true; XCTAssertFalse(store.save(entry(now, id: id, outcome: .failed)))
    }
    func testInterruptedSnapshotsRemovedOnOpenRefreshAndClear() throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let now = Date(); let original = DictationHistory(directory: dir)
        XCTAssertTrue(original.save(entry(now)))
        func orphan() throws -> URL {
            let url = dir.appendingPathComponent(".history-\(UUID().uuidString)")
            try Data("Interrupted transcript snapshot".utf8).write(to: url)
            return url
        }
        let unrelated = dir.appendingPathComponent(".history-not-a-snapshot")
        try Data("Unrelated file".utf8).write(to: unrelated)
        let startupOrphan = try orphan()
        let store = DictationHistory(directory: dir, enabled: false)
        XCTAssertNil(store.error)
        XCTAssertEqual(store.entries, original.entries)
        XCTAssertFalse(FileManager.default.fileExists(atPath: startupOrphan.path))
        let refreshOrphan = try orphan()
        store.refresh() // Also clean when no entries have expired.
        XCTAssertNil(store.error)
        XCTAssertFalse(FileManager.default.fileExists(atPath: refreshOrphan.path))
        let clearOrphan = try orphan()
        store.clear()
        XCTAssertNil(store.error)
        XCTAssertFalse(FileManager.default.fileExists(atPath: clearOrphan.path))
        XCTAssertTrue(DictationHistory(directory: dir).entries.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
        let corruptOrphan = try orphan()
        try Data("broken".utf8).write(to: dir.appendingPathComponent("history.json"))
        XCTAssertNotNil(DictationHistory(directory: dir).error)
        XCTAssertFalse(FileManager.default.fileExists(atPath: corruptOrphan.path))
    }
    func testCorruptFileIsNotOverwrittenAndWriteFailureIsReported() throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("history.json"); let bad = Data("broken".utf8); try bad.write(to: file)
        let store = DictationHistory(directory: dir)
        XCTAssertNotNil(store.error); XCTAssertFalse(store.save(entry(Date())))
        XCTAssertEqual(try Data(contentsOf: file), bad)
        store.clear(); XCTAssertNil(store.error); XCTAssertTrue(store.save(entry(Date())))
        try FileManager.default.removeItem(at: dir); try Data().write(to: dir)
        XCTAssertFalse(store.save(entry(Date()))); XCTAssertNotNil(store.error)
    }
    func prepared(_ s: VoiceSession, text: String = "A recoverable thought") throws -> UUID {
        let id = s.press(now: Date().addingTimeInterval(-1))!
        XCTAssertTrue(s.ready(try VoiceTarget.resolve(id: "loom:test", detail: Data(#"{"item":{"id":"loom:test","title":"Scratch","replyable":true}}"#.utf8)), generation: id))
        s.append(text); return id
    }
    func settle(_ s: VoiceSession) async throws {
        for _ in 0..<100 { if !s.active || s.state == .fallback { return }; try await Task.sleep(for: .milliseconds(10)) }
        XCTFail("Did not settle")
    }
    func testSavedBeforeSendAndFailureKeepsSameIdentity() async throws {
        let s = VoiceSession(); var saved: [DictationEntry] = []
        s.saveHistory = { saved.append($0); return true }
        let id = try prepared(s)
        s.finish = { s.append(" with the final words") }
        s.send = { _ in
            XCTAssertEqual(saved.last?.outcome, .pending)
            XCTAssertEqual(saved.last?.text, "A recoverable thought with the final words")
            throw DeskError.invalidResponse
        }
        s.release(tick: .milliseconds(2)); try await settle(s)
        XCTAssertEqual(saved.last?.outcome, .failed); XCTAssertEqual(saved.last?.id, id)
        XCTAssertEqual(Set(saved.map(\.capturedAt)).count, 1)
        XCTAssertTrue(s.message.contains("saved on this Mac"))
        s.cancel(); XCTAssertEqual(saved.last?.outcome, .failed)
    }
    func testCancelAndSentAndDisabledFailure() async throws {
        let s = VoiceSession(); var saved: [DictationEntry] = []; s.saveHistory = { saved.append($0); return true }
        _ = try prepared(s); s.cancel(); XCTAssertEqual(saved.last?.outcome, .undone)
        _ = try prepared(s); s.release(tick: .milliseconds(2)); try await settle(s)
        XCTAssertEqual(saved.last?.outcome, .sent)
        s.saveHistory = { _ in false }; _ = try prepared(s); s.send = { _ in throw DeskError.invalidResponse }
        s.release(tick: .milliseconds(2)); try await settle(s)
        XCTAssertFalse(s.historySaved); XCTAssertFalse(s.message.contains("saved on this Mac")); XCTAssertTrue(s.message.contains("Copy your text"))
    }
    func testCommandAndFallbackAreRecoverable() async throws {
        let s = VoiceSession(); var saved: [DictationEntry] = []; s.saveHistory = { saved.append($0); return true }
        _ = try prepared(s, text: "go to inbox")
        s.resolveNavigation = { _, _ in .init(status: .action, ticket: "ticket", label: "Inbox", window: "Test", targetId: "inbox") }
        s.commitNavigation = { _, _ in .init(ok: true, window: "Test") }
        s.release(tick: .milliseconds(2)); try await settle(s)
        XCTAssertEqual(saved.last?.outcome, .sent); XCTAssertEqual(saved.last?.destination, "Inbox"); XCTAssertEqual(saved.last?.isCommand, true)
        _ = try prepared(s, text: "go to missing")
        s.resolveNavigation = { _, _ in .init(status: .missing) }
        s.release(tick: .milliseconds(2)); try await settle(s)
        XCTAssertEqual(saved.last?.outcome, .failed); XCTAssertEqual(saved.last?.text, "go to missing")
    }
    func testSocketTranscriptSurvivesFailedHTTPDeliveryAndRestart() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("voice-fixture.cjs")
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/env"); process.arguments = ["node", script.path]
        let stdout = Pipe(); process.standardOutput = stdout
        try process.run(); defer { if process.isRunning { process.terminate() }; process.waitUntilExit() }
        let port = try XCTUnwrap(Int(String(decoding: stdout.fileHandleForReading.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
        let address = try DeskAddress("http://127.0.0.1:\(port)")
        let store = DictationHistory(directory: dir); let transport = VoiceTransport(); defer { transport.close() }
        let session = VoiceSession(); let id = try prepared(session, text: "")
        session.saveHistory = { store.save($0) }
        session.finish = { try await transport.finish() }
        session.send = { try await DeskClient(address: address).send($0) }
        transport.event = { type, value in if type == "transcript" { session.append(value) } }
        transport.open(address)
        for _ in 0..<100 { if transport.modelReady { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(transport.modelReady)
        transport.audio(Data(repeating: 7, count: 9600)); transport.audio(Data(repeating: 8, count: 4800))
        session.release(tick: .milliseconds(2)); try await settle(session)
        XCTAssertEqual(session.state, .failed)
        let restored = DictationHistory(directory: dir)
        XCTAssertEqual(restored.entries.count, 1); XCTAssertEqual(restored.entries.first?.id, id)
        XCTAssertEqual(restored.entries.first?.text, "fixture transcript"); XCTAssertEqual(restored.entries.first?.outcome, .failed)
    }

}
