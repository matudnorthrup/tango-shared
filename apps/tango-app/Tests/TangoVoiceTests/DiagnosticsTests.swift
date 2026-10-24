import XCTest
import TangoDeskKit
@testable import TangoVoice

@MainActor final class DiagnosticsTests: XCTestCase {
    private func target() throws -> VoiceTarget {
        try VoiceTarget.resolve(id: "loom:test", detail: Data(#"{"item":{"id":"loom:test","replyable":true}}"#.utf8))
    }
    func testStartupTimingsAreMonotonicFirstOnlyAndExcludedFromWire() throws {
        var time = 10.0
        let metrics = VoiceDiagnostics(now: { time })
        metrics.begin(UUID()); metrics.socketReady()
        time = 10.01; metrics.ready(nil); metrics.captureStarted()
        time = 10.5; metrics.modelReady()
        time = 10.6; metrics.firstAudio()
        time = 11; metrics.firstAudio(); metrics.socketReady()
        metrics.target("loom:test"); metrics.stop(.escape)
        let event = try XCTUnwrap(metrics.complete(.undone))
        XCTAssertEqual(event.pressToSocketReadyMs, 0); XCTAssertEqual(event.pressToCaptureMs, 10)
        XCTAssertEqual(event.pressToModelReadyMs, 500); XCTAssertEqual(event.pressToFirstAudioMs, 600)
        XCTAssertEqual(event.targetId, "loom:test")
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(event), as: UTF8.self).contains("pressTo"))
    }
    func testPostedTimingAndWireContainsNoTranscript() async throws {
        var time = 1.0; var events: [VoiceDiagnostic] = []
        let session = VoiceSession(clock: { time }); session.report = { events.append($0) }
        let pressed = Date(); let id = session.press(now: pressed)!
        XCTAssertTrue(session.ready(try target(), generation: id))
        time = 2; session.append("private dictated text")
        time = 3; session.release(now: pressed.addingTimeInterval(1), tick: .milliseconds(1))
        time = 4; session.append(" final words")
        session.send = { _ in time = 5 }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(events.count, 1)
        let event = try XCTUnwrap(events.first)
        XCTAssertEqual(event.endReason, .release); XCTAssertEqual(event.outcome, .posted)
        XCTAssertEqual(event.captureMs, 2000); XCTAssertEqual(event.stopToTranscriptMs, 1000)
        XCTAssertEqual(event.transcriptToPostMs, 1000)
        let address = try DeskAddress("https://desk.example.invalid")
        let request = try VoiceRequests.diagnostic(address, event: event)
        XCTAssertEqual(request.url?.path, "/api/desk/voice/events")
        XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
        let body = String(data: request.httpBody!, encoding: .utf8)!
        XCTAssertFalse(body.contains("private dictated")); XCTAssertFalse(body.contains("final words"))
        session.cancel(); session.fail("private error description")
        XCTAssertEqual(events.count, 1)
    }
    func testEscapeDuringCaptureAndUndoPreservesCaptureEnd() throws {
        for duringUndo in [false, true] {
            var events: [VoiceDiagnostic] = []
            let session = VoiceSession(); session.report = { events.append($0) }
            let date = Date(); let id = session.press(now: date)!
            XCTAssertTrue(session.ready(try target(), generation: id))
            if duringUndo { session.release(now: date.addingTimeInterval(1)) }
            session.cancel(reason: .escape); session.cancel()
            XCTAssertEqual(events.count, 1); XCTAssertEqual(events[0].outcome, .undone)
            XCTAssertEqual(events[0].endReason, duringUndo ? .release : .escape)
        }
    }
    func testTapLimitAndPreparationFailures() async throws {
        for limit in [false, true] {
            var events: [VoiceDiagnostic] = []
            let session = VoiceSession(listeningLimit: limit ? .milliseconds(1) : .seconds(120))
            session.report = { events.append($0) }
            let date = Date(); let id = session.press(now: date)!
            session.release(now: date.addingTimeInterval(0.1))
            XCTAssertTrue(session.ready(try target(), generation: id))
            if limit { try await Task.sleep(for: .milliseconds(30)) } else { session.press() }
            session.cancel()
            XCTAssertEqual(events.first?.endReason, limit ? .limit : .tap)
        }
        var events: [VoiceDiagnostic] = []; let session = VoiceSession(); session.report = { events.append($0) }
        session.press(); session.fail("private permission text", code: .preparation)
        XCTAssertEqual(events.first?.errorCode, .preparation); XCTAssertNil(events.first?.captureMs)
    }
    func testErrorsAndEmptyAttemptsReportExactlyOnce() async throws {
        for stage in ["finish", "post", "empty"] {
            var events: [VoiceDiagnostic] = []; let session = VoiceSession(); session.report = { events.append($0) }
            let now = Date(); let id = session.press(now: now)!
            XCTAssertTrue(session.ready(try target(), generation: id))
            if stage != "empty" { session.append("private input") }
            if stage == "finish" { session.finish = { throw DeskError.refused("private finish failure") } }
            if stage == "post" { session.send = { _ in throw DeskError.refused("private post failure") } }
            session.release(now: now.addingTimeInterval(1), tick: .milliseconds(1))
            for _ in 0..<100 where session.active { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertEqual(events.count, 1)
            XCTAssertEqual(events.first?.outcome, stage == "empty" ? .empty : .error)
            XCTAssertEqual(events.first?.errorCode, stage == "finish" ? .finish : stage == "post" ? .post : nil)
            XCTAssertFalse(String(data: try JSONEncoder().encode(events), encoding: .utf8)!.contains("private"))
            session.cancel(); XCTAssertEqual(events.count, 1)
        }
    }
    func testProviderEndUsesLastNonEmptyPartialAndOmitsUnknownTiming() throws {
        var time = 1.0; var events: [VoiceDiagnostic] = []
        let session = VoiceSession(clock: { time }); session.report = { events.append($0) }
        for hasPartial in [true, false] {
            let pressed = Date(); let id = session.press(now: pressed)!
            XCTAssertTrue(session.ready(try target(), generation: id))
            session.release(now: pressed.addingTimeInterval(0.1))
            if hasPartial {
                time += 1; session.append("first words")
                time += 1; session.append(" more words")
            }
            time += 1; session.append(""); session.append(" ")
            time += 1; session.speechEnded()
            time += 1; session.append(" late words")
            session.cancel()
            let event = try XCTUnwrap(events.last)
            XCTAssertEqual(event.endReason, .provider)
            XCTAssertEqual(event.speechEndToStopMs, hasPartial ? 2000 : nil)
            let wire = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(event)) as? [String: Any])
            XCTAssertEqual(wire["speechEndToStopMs"] as? Int, hasPartial ? 2000 : nil)
        }
        XCTAssertEqual(events.count, 2)
    }
    func testSilenceReportAndEarlierTranscriptTiming() throws {
        var time = 1.0; let metrics = VoiceDiagnostics(now: { time })
        metrics.begin(UUID()); metrics.ready("loom:test"); time = 2; metrics.transcript()
        time = 4; metrics.stop(.silence, quietMs: 1500)
        let report = try XCTUnwrap(metrics.complete(.undone))
        XCTAssertEqual(report.speechEndToStopMs, 1500); XCTAssertEqual(report.stopToTranscriptMs, -2000)
        XCTAssertNil(metrics.complete(.undone))
    }
}
