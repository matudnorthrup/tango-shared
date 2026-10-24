import XCTest
@testable import TangoDeskKit

final class DeskClientTests: XCTestCase {
    func payload() throws -> DecisionPush {
        try JSONDecoder().decode(DecisionPush.self, from: Data(#"{"deskId":"00000000-0000-0000-0000-000000000001","itemId":"loom:test","requestId":"decision:D-100","decisionId":"D-100","revision":3,"options":[{"key":"A","label":"Compact","answer":"A · Compact (Recommended)"}]}"#.utf8))
    }
    func testNotificationRequiresRegisteredDeskAndOrigin() throws {
        let push = try payload()
        let address = try DeskAddress("https://desk.example")
        XCTAssertTrue(push.belongs(to: address, registeredDeskID: push.deskId, registeredAddress: address.base.absoluteString))
        XCTAssertFalse(push.belongs(to: address, registeredDeskID: "other-desk", registeredAddress: address.base.absoluteString))
        XCTAssertFalse(push.belongs(to: address, registeredDeskID: push.deskId, registeredAddress: "https://old-desk.example"))
        XCTAssertFalse(push.belongs(to: address, registeredDeskID: nil, registeredAddress: nil))
        XCTAssertFalse(push.belongs(to: nil, registeredDeskID: push.deskId, registeredAddress: address.base.absoluteString))
    }
    func testPushEntitlementMapping() throws {
        XCTAssertEqual(try PushEnvironment.registration(forEntitlement: "development"), "sandbox")
        XCTAssertEqual(try PushEnvironment.registration(forEntitlement: "production"), "production")
        XCTAssertThrowsError(try PushEnvironment.registration(forEntitlement: "sandbox"))
        XCTAssertThrowsError(try PushEnvironment.registration(forEntitlement: ""))
    }
    func testAddressesAndDeepLinks() throws {
        let address = try DeskAddress("https://desk.example/desk/")
        XCTAssertEqual(address.endpoint("api/desk/commands").absoluteString, "https://desk.example/desk/api/desk/commands")
        XCTAssertEqual(address.deepLink(URL(string: "tango://decision/D-100")!)?.absoluteString, "https://desk.example/desk/decision/D-100")
        XCTAssertNil(address.deepLink(URL(string: "tango://decision/../settings")!))
        XCTAssertFalse(address.contains(URL(string: "https://desk.example/desk-other")!))
        XCTAssertFalse(address.contains(URL(string: "https://external.example/desk")!))
        XCTAssertThrowsError(try DeskAddress("http://desk.example"))
        XCTAssertThrowsError(try DeskAddress("https://name:secret@desk.example"))
        XCTAssertNoThrow(try DeskAddress("http://127.0.0.1:9431"))
    }
    func testAnswerMatchesWebContract() throws {
        let command = try payload().command(option: 0)
        XCTAssertEqual(command.type, "respond")
        XCTAssertEqual(command.args.requestId, "decision:D-100")
        XCTAssertEqual(command.args.revision, 3)
        XCTAssertEqual(command.args.answers, ["decision": "A · Compact (Recommended)"])
        XCTAssertThrowsError(try payload().command(option: 4))
        XCTAssertEqual(try payload().snooze(now: Date(timeIntervalSince1970: 0)).args.until, "1970-01-01T01:00:00Z")
    }
    func testSnoozeOnlyIfActiveAndQuietRefusal() async throws {
        let command = try payload().snooze()
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as? [String: Any])
        XCTAssertEqual((json["args"] as? [String: Any])?["onlyIfActive"] as? Bool, true)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let queue = try AnswerQueue(file: file)
        try await queue.enqueue(address: DeskAddress("https://desk.example"), command: command, decisionId: "D-100")
        try await queue.drain(send: { _ in throw DeskError.inactiveSnooze }, refused: { _ in XCTFail("Inactive Snooze is informational, not a failure alert") })
        let restored = try AnswerQueue(file: file)
        let entries = await restored.all()
        XCTAssertEqual(entries.first?.failure, DeskError.inactiveSnooze.localizedDescription)
        try await restored.drain(send: { _ in XCTFail("Inactive Snooze must not retry") }, refused: { _ in XCTFail() })
    }
    func testDurableQueueRetryRefusalAndFixedDestination() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("answers.json")
        let address = try DeskAddress("https://desk.example/desk")
        let command = try payload().command(option: 0)
        let queue = try AnswerQueue(file: file)
        try await queue.enqueue(address: address, command: command, decisionId: "D-100")
        try await queue.drain(send: { _ in throw URLError(.notConnectedToInternet) }, refused: { _ in XCTFail("Network failures remain queued") })
        let restored = try AnswerQueue(file: file)
        let entries = await restored.all()
        XCTAssertEqual(entries.count, 1); XCTAssertEqual(entries[0].command.commandId, command.commandId)
        XCTAssertEqual(entries[0].address, address)
        try await restored.drain(send: { _ in throw DeskError.refused("The question changed") }, refused: { entry in XCTAssertEqual(entry.failure, "The question changed") })
        let failed = try AnswerQueue(file: file)
        let failures = await failed.all()
        XCTAssertEqual(failures.first?.failure, "The question changed")
        try await failed.drain(send: { _ in XCTFail("Refusals must not retry") }, refused: { _ in XCTFail() })
        let success = try AnswerQueue(file: dir.appendingPathComponent("success.json"))
        try await success.enqueue(address: address, command: command, decisionId: "D-100")
        try await success.drain(send: { entry in XCTAssertEqual(entry.command.commandId, command.commandId) }, refused: { _ in XCTFail() })
        let remaining = await success.all(); XCTAssertTrue(remaining.isEmpty)
    }
    func testUnreadableQueueIsNotDiscarded() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        try Data("invalid".utf8).write(to: file)
        XCTAssertThrowsError(try AnswerQueue(file: file))
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "invalid")
    }
}
