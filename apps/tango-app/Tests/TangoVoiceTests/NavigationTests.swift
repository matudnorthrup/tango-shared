import XCTest
import TangoDeskKit
@testable import TangoVoice

@MainActor final class NavigationTests: XCTestCase {
    func session(_ text: String, target: Bool = true) throws -> VoiceSession {
        let s = VoiceSession(); let id = s.press(now: .distantPast)!
        let destination = try VoiceTarget.resolve(id: "loom:test", detail: Data(#"{"item":{"id":"loom:test","replyable":true}}"#.utf8))
        XCTAssertTrue(s.ready(target ? destination : nil, generation: id)); s.append(text)
        return s
    }
    func settle(_ s: VoiceSession) async throws {
        for _ in 0..<100 {
            if [.sent, .failed, .fallback, .idle].contains(s.state) { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Session did not settle")
    }
    /// Opt-in against the isolated navigation desk, never the live service.
    func testSandboxNavigation() async throws {
        guard ProcessInfo.processInfo.environment["TANGO_TEST_NAVIGATION"] == "1" else { throw XCTSkip("Requires sandbox desk on 9451 with --voice and an owner browser window") }
        let address = try DeskAddress("http://127.0.0.1:9451")
        let transport = VoiceTransport()
        let s = try session("go to Ridge Loop loop", target: false)
        s.resolveNavigation = { id, text in try await transport.resolveNavigation(address, exchangeId: id, transcript: text) }
        s.commitNavigation = { id, ticket in try await transport.commitNavigation(address, exchangeId: id, ticket: ticket) }
        s.send = { _ in XCTFail("Navigation must not post a reply") }
        s.release()
        for _ in 0..<300 where s.active { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertEqual(s.state, .sent, s.message)
        XCTAssertTrue(s.message.contains("Ridge Loop loop"))
        let data = try await transport.get(address.endpoint("api/desk/presentation"))
        XCTAssertEqual(try VoiceTarget.presentation(data), "discord:thread:1500000000000000103")
    }
    func testGate() {
        for text in ["please go to inbox", "Please go back", "go back", "Go to inbox", "show me tasks", "switch to desk", "take me to home", "back", "back.", "Please go back?"] { XCTAssertTrue(NavigationResolution.isCandidate(text), text) }
        for text in ["I will open notes", "background", "opening thoughts", "Open notes", "mark done", "snooze this", "done", "pin it", "unpin it", "Back when we talked", "go today"] { XCTAssertFalse(NavigationResolution.isCandidate(text), text) }
    }
    func testOrdinaryRepliesSkipResolution() async throws {
        for text in ["open question about this", "done with that idea", "Open the PR and fix it", "Mark it as low priority", "Done, ship it", "Pin the version", "Back when we talked about it"] {
            let s = try session(text); var sent = 0; var resolutions = 0
            s.resolveNavigation = { _, value in resolutions += 1; XCTAssertEqual(value, text); return .init(status: .dictation) }
            s.send = { _ in sent += 1 }; s.release(tick: .milliseconds(5)); try await settle(s)
            XCTAssertEqual(sent, 1); XCTAssertEqual(resolutions, 0); XCTAssertEqual(s.state, .sent)
        }
    }
    func testResolvedRefusalFallsThroughAsReply() async throws {
        let s = try session("go to the next point in my reply"); var sent = 0; var resolutions = 0
        s.resolveNavigation = { _, _ in resolutions += 1; return .init(status: .dictation) }
        s.send = { _ in sent += 1 }; s.release(tick: .milliseconds(5)); try await settle(s)
        XCTAssertEqual(sent, 1); XCTAssertEqual(resolutions, 1); XCTAssertEqual(s.state, .sent)
    }
    func testActionWithoutReplyTargetAndSettledTranscript() async throws {
        let s = try session("go to", target: false); var committed = 0; var diagnostics: [VoiceDiagnostic] = []
        s.report = { diagnostics.append($0) }
        s.resolveNavigation = { id, text in
            XCTAssertEqual(id, s.generation); XCTAssertEqual(text, "go to inbox")
            return .init(status: .action, ticket: "ticket", label: "Inbox", window: "Laptop", targetId: "inbox")
        }
        s.commitNavigation = { id, ticket in XCTAssertEqual(id, s.generation); XCTAssertEqual(ticket, "ticket"); committed += 1; return .init(ok: true, window: "Laptop") }
        s.send = { _ in XCTFail("Command posted as text") }
        s.release(tick: .milliseconds(10)); s.append(" inbox"); try await settle(s)
        XCTAssertEqual(committed, 1); XCTAssertEqual(s.message, "Opened Inbox on Laptop")
        XCTAssertEqual(diagnostics.first?.targetId, "inbox"); XCTAssertEqual(diagnostics.first?.mode, "command"); XCTAssertEqual(diagnostics.first?.outcome, .commandRun)
    }
    func testAmbiguousMissingAndNetworkFailuresRequireExplicitText() async throws {
        for status in [NavigationResolution.Status.ambiguous, .missing, .action] {
            let s = try session("go to notes"); var sent = 0
            s.resolveNavigation = { _, _ in .init(status: status) }
            s.send = { _ in sent += 1 }; s.release(tick: .milliseconds(5)); try await settle(s)
            XCTAssertEqual(s.state, .fallback); XCTAssertEqual(sent, 0)
            s.sendAsText(); try await settle(s); XCTAssertEqual(sent, 1)
        }
        let s = try session("go to notes")
        s.resolveNavigation = { _, _ in throw DeskError.invalidResponse }
        s.send = { _ in XCTFail("Unexpected reply") }; s.release(tick: .milliseconds(5)); try await settle(s)
        XCTAssertEqual(s.state, .fallback); s.cancel()
    }
    func testReplacementSocketStaysDormantAndFailurePreservesFallback() async throws {
        let s = try session("go to notes")
        let live = LiveMic()
        var opens = 0
        live.openSocket = { opens += 1 }
        live.autoDisarmed = { trigger in
            if trigger != .socket || s.needsRecordingSocket { s.cancel() }
        }
        try live.arm(bluetooth: false, avoidBluetooth: true)
        XCTAssertTrue(s.needsRecordingSocket)
        s.closeSocket = {
            XCTAssertFalse(s.needsRecordingSocket)
            live.exchangeEnded()
        }
        s.resolveNavigation = { _, _ in
            XCTAssertFalse(s.needsRecordingSocket)
            live.socketFailed() // the replacement dormant socket, not the recording
            XCTAssertEqual(s.state, .resolving)
            return .init(status: .ambiguous)
        }
        s.release(tick: .milliseconds(5))
        XCTAssertTrue(s.needsRecordingSocket) // input ended but transcript still settling
        try await settle(s)
        XCTAssertEqual(s.state, .fallback); XCTAssertFalse(s.needsRecordingSocket)
        XCTAssertEqual(opens, 3) // initial, replacement, retry; none activates a model
        live.socketFailed()
        XCTAssertFalse(live.armed)
        XCTAssertEqual(s.state, .fallback); XCTAssertEqual(s.transcript, "go to notes")
        XCTAssertTrue(s.canSendAsText)
        var sent = false; s.send = { _ in XCTAssertFalse(s.needsRecordingSocket); sent = true }
        s.sendAsText(); try await settle(s)
        XCTAssertTrue(sent); XCTAssertEqual(s.state, .sent)
    }
    func testNoTargetCannotSendFallback() async throws {
        let s = try session("ordinary dictation", target: false)
        s.send = { _ in XCTFail("Unexpected reply") }; s.release(tick: .milliseconds(5)); try await settle(s)
        XCTAssertEqual(s.state, .fallback); XCTAssertFalse(s.canSendAsText); s.sendAsText(); XCTAssertEqual(s.state, .fallback); s.cancel()
    }
    func testUndoAfterResolvePreventsCommit() async throws {
        let s = try session("back")
        s.resolveNavigation = { _, _ in .init(status: .action, ticket: "ticket", label: "Back", window: "Desk") }
        s.commitNavigation = { _, _ in XCTFail("Undone command committed"); return .init(ok: true) }
        s.release(tick: .milliseconds(20))
        for _ in 0..<100 { if s.message.hasPrefix("Opening") { break }; try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(s.message.contains("Desk")); s.cancel(); try await Task.sleep(for: .milliseconds(100)); XCTAssertEqual(s.state, .idle)
    }
    func testCommitFailureNeverPostsAndStaleResolveCannotRestart() async throws {
        let s = try session("go to notes"); var sent = 0
        s.resolveNavigation = { _, _ in .init(status: .action, ticket: "ticket", label: "Notes", window: "Desk") }
        s.commitNavigation = { _, _ in throw DeskError.invalidResponse }
        s.send = { _ in sent += 1 }; s.release(tick: .milliseconds(5)); try await settle(s)
        XCTAssertEqual(s.state, .fallback); XCTAssertEqual(sent, 0); s.cancel()
        let pending = try session("back")
        pending.resolveNavigation = { _, _ in
            try? await Task.sleep(for: .milliseconds(80))
            return .init(status: .action, ticket: "ticket", label: "Back", window: "Desk")
        }
        pending.commitNavigation = { _, _ in XCTFail("Late result committed"); return .init(ok: true) }
        pending.release(tick: .milliseconds(5))
        for _ in 0..<100 { if pending.state == .resolving { break }; try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(pending.state, .resolving); pending.cancel()
        try await Task.sleep(for: .milliseconds(120)); XCTAssertEqual(pending.state, .idle)
    }
    func testCommandSettlingAndDismissedFallbackDiagnostics() async throws {
        for (status, outcome) in [(NavigationResolution.Status.ambiguous, VoiceOutcome.commandAmbiguous), (.missing, .commandRefused)] {
            let s = try session("please go back"); var events: [VoiceDiagnostic] = []
            s.report = { events.append($0) }
            s.resolveNavigation = { _, _ in .init(status: status) }
            s.release(tick: .milliseconds(5))
            XCTAssertEqual(s.message, "Finishing transcript · Undo (Esc)")
            try await settle(s); s.cancel()
            XCTAssertEqual(events.count, 1); XCTAssertEqual(events.first?.outcome, outcome)
            XCTAssertEqual(events.first?.mode, "command")
        }
        let s = try session("please go to notes"); var events: [VoiceDiagnostic] = []
        s.report = { events.append($0) }; s.resolveNavigation = { _, _ in .init(status: .ambiguous) }
        s.release(tick: .milliseconds(5)); try await settle(s); s.sendAsText(); try await settle(s)
        XCTAssertEqual(events.count, 1); XCTAssertEqual(events.first?.outcome, .posted)
        XCTAssertEqual(events.first?.mode, "dictation"); XCTAssertEqual(events.first?.targetId, "loom:test")
    }
    func testNavigationRequest() throws {
        let id = UUID(); let address = try DeskAddress("https://desk.example")
        let request = try VoiceRequests.navigation(address, exchangeId: id, ticket: "ticket")
        XCTAssertEqual(request.url?.path, "/api/desk/navigator/commit")
        let body = try JSONDecoder().decode([String: String].self, from: XCTUnwrap(request.httpBody))
        XCTAssertEqual(body, ["exchangeId": id.uuidString, "ticket": "ticket"])
    }
}
