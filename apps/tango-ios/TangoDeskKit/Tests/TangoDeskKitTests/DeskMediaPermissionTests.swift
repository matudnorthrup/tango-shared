import XCTest
@testable import TangoDeskKit

final class DeskMediaPermissionTests: XCTestCase {
    func testOnlyConfiguredOriginAndMicrophoneAreAllowed() throws {
        let desk = try XCTUnwrap(URL(string: "https://desk.example:8443/desk"))
        func allowed(scheme: String = "https", host: String = "desk.example", port: Int = 8443,
                     frameHost: String = "desk.example", framePort: Int = 8443, microphone: Bool = true) -> Bool {
            DeskMediaPermission.allowsMicrophone(
                deskURL: desk, scheme: scheme, host: host, port: port,
                frameScheme: "https", frameHost: frameHost, framePort: framePort, microphoneOnly: microphone)
        }
        XCTAssertTrue(allowed())
        XCTAssertFalse(allowed(scheme: "http"))
        XCTAssertFalse(allowed(host: "other.example"))
        XCTAssertFalse(allowed(port: 443))
        XCTAssertFalse(allowed(frameHost: "other.example"))
        XCTAssertFalse(allowed(framePort: 443))
        XCTAssertFalse(allowed(microphone: false)) // Camera, combined capture, and future types.
    }

    func testDefaultPortsAreEquivalentAndFrameSchemeIsChecked() throws {
        for text in ["https://desk.example/desk", "https://desk.example:443/desk"] {
            let desk = try XCTUnwrap(URL(string: text))
            for port in [0, 443] {
                XCTAssertTrue(DeskMediaPermission.allowsMicrophone(
                    deskURL: desk, scheme: "https", host: "DESK.EXAMPLE", port: port,
                    frameScheme: "https", frameHost: "desk.example", framePort: 0, microphoneOnly: true))
            }
            XCTAssertFalse(DeskMediaPermission.allowsMicrophone(
                deskURL: desk, scheme: "https", host: "desk.example", port: 0,
                frameScheme: "http", frameHost: "desk.example", framePort: 443, microphoneOnly: true))
        }
    }
}
