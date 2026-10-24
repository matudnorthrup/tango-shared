import XCTest
import TangoDeskKit

private final class ReplyProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/desk/api/desk/commands")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(request.value(forHTTPHeaderField: "Tailscale-User-Login"))
        XCTAssertFalse((request.allHTTPHeaderFields ?? [:]).keys.contains { $0.lowercased().hasPrefix("sec-fetch-") })
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }; var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(contentsOf: buffer.prefix(n)) }
        }
        let body = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(body["type"] as? String, "reply")
        XCTAssertEqual(body["itemId"] as? String, "loom:fixture")
        XCTAssertEqual(body["args"] as? [String: String], ["text": "My dictated reply"])
        let result = request.url!.host == "refused.example" ? #"{"status":"failed","error":"thread closed"}"# : #"{"status":"applied"}"#
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(result.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
final class ReplyTransportTests: XCTestCase {
    func testReplyHeadersAndSemanticRefusal() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReplyProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let command = DeskCommand(itemId: "loom:fixture", type: "reply", args: .init(text: "My dictated reply"))
        try await DeskClient(address: DeskAddress("https://desk.example/desk"), session: session).send(command)
        do { try await DeskClient(address: DeskAddress("https://refused.example/desk"), session: session).send(command); XCTFail("Must surface refusal") }
        catch DeskError.refused(let message) { XCTAssertEqual(message, "thread closed") }
    }
}
