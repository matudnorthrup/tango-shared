import XCTest
import TangoDeskKit
@testable import TangoVoice

@MainActor final class SandboxTests: XCTestCase {
    func testSandboxDiagnosticRoundTrip() async throws {
        guard ProcessInfo.processInfo.environment["TANGO_TEST_DESK"] == "1" else { throw XCTSkip("Requires sandbox desk on 9431 with --voice") }
        let address = try DeskAddress("http://127.0.0.1:9431")
        let transport = VoiceTransport()
        let session = VoiceSession()
        var delivery: Task<Void, Error>?
        session.report = { event in delivery = Task { try await transport.report(event, to: address) } }
        let id = session.press()!
        let target = try VoiceTarget.resolve(id: "loom:diagnostic-test", detail: Data(#"{"item":{"id":"loom:diagnostic-test","replyable":true}}"#.utf8))
        XCTAssertTrue(session.ready(target, generation: id))
        session.append("SENSITIVE TEST TRANSCRIPT MUST NOT BE LOGGED")
        session.cancel(reason: .escape)
        try await XCTUnwrap(delivery).value
        let data = try await transport.get(address.endpoint("api/desk/voice/events"))
        let rows = try XCTUnwrap((JSONSerialization.jsonObject(with: data) as? [String: Any])?["events"] as? [[String: Any]])
        let row = try XCTUnwrap(rows.first { ($0["exchangeId"] as? String) == id.uuidString })
        XCTAssertEqual(row["outcome"] as? String, "undone")
        XCTAssertEqual(row["endReason"] as? String, "escape")
        XCTAssertFalse(String(data: data, encoding: .utf8)!.contains("SENSITIVE TEST TRANSCRIPT"))
        let now = Date(); let postedID = session.press(now: now)!
        let postedTarget = try VoiceTarget.resolve(id: "discord:thread:1500000000000000103", detail: Data(#"{"item":{"id":"discord:thread:1500000000000000103","replyable":true}}"#.utf8))
        XCTAssertTrue(session.ready(postedTarget, generation: postedID))
        session.send = { command in try await DeskClient(address: address).send(command) }
        session.append("Native diagnostic sandbox reply")
        session.release(now: now.addingTimeInterval(1), tick: .milliseconds(1))
        for _ in 0..<100 where session.active { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(session.state, .sent)
        try await XCTUnwrap(delivery).value
        let postedData = try await transport.get(address.endpoint("api/desk/voice/events"))
        let postedRows = try XCTUnwrap((JSONSerialization.jsonObject(with: postedData) as? [String: Any])?["events"] as? [[String: Any]])
        let posted = try XCTUnwrap(postedRows.first { ($0["exchangeId"] as? String) == postedID.uuidString })
        XCTAssertEqual(posted["outcome"] as? String, "posted")
        XCTAssertNotNil(posted["transcriptToPostMs"])
        XCTAssertFalse(String(data: postedData, encoding: .utf8)!.contains("Native diagnostic sandbox reply"))
    }
    /// Opt-in integration; deliberately fixed to the repository's sandbox port.
    func testSandboxReply() async throws {
        guard ProcessInfo.processInfo.environment["TANGO_TEST_DESK"] == "1" else { throw XCTSkip("Run with TANGO_TEST_DESK=1 and the sandbox desk on 9431") }
        let address = try DeskAddress("http://127.0.0.1:9431")
        let transport = VoiceTransport()
        let target = try await transport.target(address)
        XCTAssertEqual(target.id, "discord:thread:1500000000000000103")
        XCTAssertFalse(target.title.hasPrefix("discord:"))
        try await DeskClient(address: address).send(DeskCommand(itemId: target.id, type: "reply", args: .init(text: "Native push-to-talk transport smoke")))
    }
}
