import XCTest
import TangoDeskKit
@testable import TangoVoice

private final class DeskStub: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(request.value(forHTTPHeaderField: "Tailscale-User-Login"))
        XCTAssertNil(request.httpBody)
        let url = request.url!
        let status = url.host == "denied.example" ? 403 : (url.path.hasPrefix("/tango-screen/") ? 200 : 404)
        let data = url.path.hasSuffix("/presentation") ? #"{"view":"conversation","itemId":"loom:fixture"}"# : #"{"voice":"test"}"#
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(data.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
final class DeskConnectionTests: XCTestCase {
    func testReadOnlyOnboardingSuccessMissingPrefixAndDenied() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [DeskStub.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let connection = DeskConnection(session: session)
        let result = try await connection.validate("https://desk.example/tango-screen")
        XCTAssertEqual(result.destination, "loom:fixture")
        XCTAssertTrue(result.voiceAvailable)
        for (url, message) in [("https://desk.example", "404"), ("https://denied.example/tango-screen", "403")] {
            do { _ = try await connection.validate(url); XCTFail("Expected refusal") }
            catch { XCTAssertTrue(error.localizedDescription.contains(message)) }
        }
    }
}
