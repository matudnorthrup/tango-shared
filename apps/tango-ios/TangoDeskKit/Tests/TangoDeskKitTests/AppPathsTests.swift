import XCTest
@testable import TangoDeskKit

private final class CatalogProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/apps.json")
        let mode = request.value(forHTTPHeaderField: "Test-Mode") ?? "good"
        if mode == "offline" {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)); return
        }
        let body = mode == "malformed" ? "{}" : #"[{"name":"Food","path":"/tango-food/"},{"name":"Home","path":"/"}]"#
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: mode == "failure" ? 503 : 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
final class AppPathsTests: XCTestCase {
    func testOriginAndWholePathSegments() throws {
        let address = try DeskAddress("https://desk.example/tango-screen", appPaths: ["/tango-food/", "/"])
        for path in ["/", "/tango-screen", "/tango-screen/decision/D-1", "/tango-food", "/tango-food/", "/tango-food/log"] {
            XCTAssertTrue(address.contains(URL(string: "https://desk.example" + path)!), path)
        }
        for url in ["https://desk.example/tango-foodx", "https://desk.example/unlisted", "https://desk.example/tango-food/../unlisted", "https://desk.example:444/tango-food", "https://other.example/tango-food", "http://desk.example/tango-food"] {
            XCTAssertFalse(address.contains(URL(string: url)!), url)
        }
        XCTAssertTrue(address.contains(URL(string: "https://desk.example:443/tango-food")!))
        XCTAssertEqual(address.deepLink(URL(string: "tango://decision/D-12")!)?.path, "/tango-screen/decision/D-12")
    }
    func testSafePathsAndRootNeverWidensOrigin() throws {
        for path in ["/", "//host/path", "/bad\\path", "/bad path", "/bad\npath", "/bad\u{7f}path", "relative", "/../", "/%2e%2e/", "/%2fhost", "/foo?bar"] {
            XCTAssertNil(DeskAppPaths.safePath(path), path)
        }
        let address = try DeskAddress("https://desk.example/desk", appPaths: ["/"])
        XCTAssertFalse(address.contains(URL(string: "https://desk.example/private")!))
        XCTAssertEqual(try DeskAppPaths.decode(Data(#"[{"name":"Home","path":"/"}]"#.utf8)), [])
        XCTAssertThrowsError(try DeskAppPaths.decode(Data(#"[{"name":"Bad","path":"//foreign"}]"#.utf8)))
    }
    func testOldSavedAddressesStillDecode() throws {
        let address = try JSONDecoder().decode(DeskAddress.self, from: Data(#"{"base":"https://desk.example/desk"}"#.utf8))
        XCTAssertEqual(address.appPaths, [])
        XCTAssertEqual(try JSONDecoder().decode(DeskAddress.self, from: JSONEncoder().encode(address)), address)
    }
    @MainActor func testLastGoodCatalogSurvivesFailureAndRelaunch() async throws {
        let suite = "app-path-tests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let address = try DeskAddress("https://desk.example/desk")
        for mode in ["good", "malformed", "failure", "offline"] {
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [CatalogProtocol.self]
            config.httpAdditionalHeaders = ["Test-Mode": mode]
            let session = URLSession(configuration: config)
            let paths = await DeskAppPaths(defaults: defaults).refresh(using: DeskClient(address: address, session: session))
            session.invalidateAndCancel()
            XCTAssertEqual(paths, ["/tango-food"], mode)
            XCTAssertEqual(DeskAppPaths(defaults: defaults).cached(for: address), paths)
        }
        XCTAssertEqual(DeskAppPaths(defaults: defaults).cached(for: try DeskAddress("https://other.example/desk")), [])
        XCTAssertEqual(DeskAppPaths(defaults: defaults).cached(for: try DeskAddress("https://desk.example:444/desk")), [])
    }
}
