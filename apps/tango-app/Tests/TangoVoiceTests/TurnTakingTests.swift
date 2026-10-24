import XCTest
import TangoDeskKit
@testable import TangoVoice

@MainActor final class TurnTakingTests: XCTestCase {
    private func pcm(_ amplitude: Int16, windows: Int) -> Data {
        var data = Data()
        for _ in 0..<(windows * 480) {
            var value = amplitude.littleEndian
            withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
        }
        return data
    }
    private func start(_ session: VoiceSession) throws {
        let now = Date(); let id = session.press(now: now)!
        session.release(now: now.addingTimeInterval(0.1))
        let target = try VoiceTarget.resolve(id: "fixture", detail: Data(#"{"item":{"id":"fixture","replyable":true}}"#.utf8))
        XCTAssertTrue(session.ready(target, generation: id))
        session.observeAudio(pcm(0, windows: 10))
        session.observeAudio(pcm(4000, windows: 10))
    }
    func testLateDeltaDefersPauseAndResumedSpeechCancelsFallback() async throws {
        var time = 0.0
        let session = VoiceSession(clock: { time }); defer { session.cancel() }
        var requests = 0
        session.requestPause = { _, _ in requests += 1 }
        try start(session)
        session.append("Cancel")
        session.observeAudio(pcm(0, windows: 75))
        await Task.yield(); XCTAssertEqual(requests, 0)
        time = 0.59; session.observeAudio(pcm(0, windows: 1))
        await Task.yield(); XCTAssertEqual(requests, 0)
        session.append(" the meeting tomorrow")
        time = 1.18; session.observeAudio(pcm(0, windows: 1))
        await Task.yield(); XCTAssertEqual(requests, 0)
        time = 1.20; session.observeAudio(pcm(0, windows: 1))
        try await Task.sleep(for: .milliseconds(20)); XCTAssertEqual(requests, 1)
        session.observeAudio(pcm(4000, windows: 3))
        try await Task.sleep(for: .milliseconds(350)); XCTAssertEqual(session.state, .listening)
        session.observeAudio(pcm(0, windows: 75))
        for _ in 0..<100 { if session.state == .undo { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(session.state, .undo)
    }
    func testStaleSpeechEndAfterResumedSpeechIsIgnored() async throws {
        var time = 0.0
        let session = VoiceSession(clock: { time }); defer { session.cancel() }
        var ids: [UUID] = []
        session.requestPause = { _, id in ids.append(id) }
        try start(session)
        session.append("Book the room")
        time = 2; session.observeAudio(pcm(0, windows: 75))
        try await Task.sleep(for: .milliseconds(20)); XCTAssertEqual(ids.count, 1)
        session.observeAudio(pcm(4000, windows: 6))
        session.turnStatus("speech_end", id: ids[0].uuidString)
        XCTAssertEqual(session.state, .listening)
        time = 4; session.observeAudio(pcm(0, windows: 75))
        try await Task.sleep(for: .milliseconds(20)); XCTAssertEqual(ids.count, 2)
        session.turnStatus("speech_end", id: ids[0].uuidString)
        XCTAssertEqual(session.state, .listening)
        session.turnStatus("speech_end", id: ids[1].uuidString)
        XCTAssertEqual(session.state, .undo)
    }
    func testHoldingCapAndNudgeAreAnchoredToCaptureStart() async throws {
        var time = 0.0
        let session = VoiceSession(clock: { time }); defer { session.cancel() }
        try start(session)
        XCTAssertEqual(session.captureLimit, .seconds(120))
        time = 599.95
        session.turnStatus("holding")
        XCTAssertEqual(session.captureLimit, .seconds(600))
        XCTAssertEqual(session.message, "Holding · say 'send it' when you're done")
        session.turnStatus("holding_nudge")
        XCTAssertEqual(session.message, "Still holding")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(session.state, .undo)
    }
    func testPauseSpeechEndAndRepeatedFinalTranscript() async throws { try await socket("finish") }
    func testPauseWaitingReasksAtFourSeconds() async throws { try await socket("waiting") }
    func testPauseHoldingKeepsListening() async throws { try await socket("holding") }
    func testPauseCancelSendsNothing() async throws { try await socket("cancel") }
    func testOldServerFallsBackAfter300Milliseconds() async throws { try await socket("fallback") }

    private func socket(_ answer: String) async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("voice-fixture.cjs")
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", script.path, "--turn=" + answer]
        let stdout = Pipe(); process.standardOutput = stdout; process.standardError = FileHandle.standardError
        try process.run(); defer { if process.isRunning { process.terminate() }; process.waitUntilExit() }
        let port = try XCTUnwrap(Int(String(decoding: stdout.fileHandleForReading.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
        let address = try DeskAddress("http://127.0.0.1:\(port)")
        let transport = VoiceTransport(); defer { transport.close() }
        let session = VoiceSession(); defer { session.cancel() }
        let historyDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: historyDirectory) }
        let historyServer = DictationSyncTests.Server()
        let historySync = DictationSync(directory: historyDirectory, send: historyServer.send)
        historySync.configure("https://desk.example.ts.net"); await historySync.refresh()
        session.saveHistory = { historySync.capture($0); return true }
        var sent: [DeskCommand] = []; var failure = ""; var requests: [Int] = []
        session.send = { sent.append($0) }
        session.finish = { try await transport.finish() }
        session.closeSocket = { transport.close() }
        session.requestPause = { requests.append($0); try await transport.requestPause($0, id: $1) }
        transport.turnStatus = { session.turnStatus($0, untilMs: $1, id: $2) }
        transport.failed = { failure = $0 }
        transport.event = { type, text in
            if type == "transcript" { session.append(text) }
            if type == "transcript_final" { session.replaceTranscript(text) }
            if type == "cancel" { session.cancel() }
        }
        transport.open(address)
        for _ in 0..<100 { if transport.modelReady { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(transport.modelReady)
        try start(session)
        session.observeAudio(pcm(0, windows: 75))
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(requests, [1500])
        if answer == "waiting" {
            XCTAssertEqual(session.state, .listening)
            session.observeAudio(pcm(0, windows: 124))
            try await Task.sleep(for: .milliseconds(20)); XCTAssertEqual(requests.count, 1)
            session.observeAudio(pcm(0, windows: 1))
            try await Task.sleep(for: .milliseconds(100)); XCTAssertEqual(requests, [1500, 4000])
        }
        if answer == "fallback" {
            XCTAssertEqual(session.state, .listening)
            try await Task.sleep(for: .milliseconds(220))
        }
        if answer == "holding" {
            try await Task.sleep(for: .milliseconds(350))
            XCTAssertEqual(session.state, .listening); XCTAssertTrue(session.holding)
            XCTAssertTrue(sent.isEmpty)
        } else if answer == "cancel" {
            XCTAssertEqual(session.state, .idle); XCTAssertTrue(sent.isEmpty)
        } else {
            XCTAssertEqual(session.state, .undo)
            for _ in 0..<180 { if session.state == .sent { break }; try await Task.sleep(for: .milliseconds(20)) }
            XCTAssertEqual(session.state, .sent)
            XCTAssertEqual(session.transcript, "Clean late")
            let command = try XCTUnwrap(sent.first)
            let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as! [String: Any]
            XCTAssertEqual(json["args"] as? [String: String], ["text": "Clean late"])
            XCTAssertEqual(sent.count, 1)
            await historySync.refresh()
            XCTAssertEqual(historyServer.entries.first?.text, "Clean late")
            XCTAssertEqual(historyServer.entries.first?.outcome, "sent")
        }
        XCTAssertEqual(failure, "")
    }
}
