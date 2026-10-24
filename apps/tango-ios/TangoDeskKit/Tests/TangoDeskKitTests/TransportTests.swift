import XCTest
@testable import TangoDeskKit

private final class StubProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
        XCTAssertFalse((request.allHTTPHeaderFields ?? [:]).keys.contains { $0.lowercased().hasPrefix("sec-fetch-") })
        let body: String
        if request.url!.host == "stale.example" { body = #"{"status":"failed","error":"the question changed"}"# }
        else if request.url!.host == "inactive.example" { body = #"{"status":"failed","error":"already out of the rotation","outcome":{"active":false}}"# }
        else if request.url!.path.hasSuffix("devices") { body = #"{"ok":true,"deskId":"00000000-0000-0000-0000-000000000001"}"# }
        else { body = #"{"status":"applied"}"# }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
final class TransportTests: XCTestCase {
    func testInactiveSnoozeResponseIsInformationalOnlyForGuardedSnooze() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let client = DeskClient(address: try DeskAddress("https://inactive.example"), session: session)
        do {
            try await client.send(DeskCommand(itemId: "loom:test", type: "snooze", args: .init(onlyIfActive: true)))
            XCTFail("Inactive snooze must be surfaced")
        } catch DeskError.inactiveSnooze { }
        do {
            try await client.send(DeskCommand(itemId: "loom:test", type: "respond", args: .init()))
            XCTFail("Other refusals remain errors")
        } catch DeskError.refused(let reason) { XCTAssertEqual(reason, "already out of the rotation") }
    }
    func testNativeJSONRequestsAndSemanticRefusal() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let command = DeskCommand(itemId: "loom:test", type: "respond", args: .init(requestId: "decision:D-1", revision: 2, answers: ["decision": "A · Compact"]))
        let client = DeskClient(address: try DeskAddress("https://desk.example"), session: session)
        try await client.send(command)
        _ = try await client.register(DeviceRegistration(token: "abcd", bundleId: "org.example.TangoDesk", environment: "sandbox"))
        do {
            try await DeskClient(address: DeskAddress("https://stale.example"), session: session).send(command)
            XCTFail("HTTP 200 with failed status must be refused")
        } catch DeskError.refused(let reason) { XCTAssertEqual(reason, "the question changed") }
    }
}
