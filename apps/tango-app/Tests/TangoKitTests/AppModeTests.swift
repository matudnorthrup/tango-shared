import XCTest
@testable import TangoKit

final class AppModeTests: XCTestCase {
    func testOnlyHostCanArmLiveMic() {
        XCTAssertFalse(AppStartup.allowsLiveMic(mode: .client))
        XCTAssertTrue(AppStartup.allowsLiveMic(mode: .host))
    }
    @MainActor func testClientNeverConstructsHostOrRunsRetirementEvenWithOldHostPreference() {
        let name = "client-startup-\(UUID())"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("host", forKey: "appMode")
        var tokenReads = 0
        var launchctlMutations = 0
        let mode = AppStartup.mode(defaults: defaults, clientOnly: true)
        let host: String? = AppStartup.host(mode: mode, retire: { launchctlMutations += 1 }, make: {
            tokenReads += 1; return "host"
        })
        XCTAssertNil(host)
        XCTAssertEqual(tokenReads, 0); XCTAssertEqual(launchctlMutations, 0)
        XCTAssertEqual(defaults.string(forKey: "appMode"), "client")
        XCTAssertEqual(AppStartup.mode(defaults: defaults, clientOnly: false), .client)
    }
    @MainActor func testHostKeepsItsStartupAndSavedMode() {
        let name = "host-startup-\(UUID())"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        var operations: [String] = []
        let mode = AppStartup.mode(defaults: defaults, clientOnly: false)
        let host = AppStartup.host(mode: mode, retire: { operations.append("retire") }, make: { operations.append("store"); return true })
        XCTAssertEqual(host, true); XCTAssertEqual(operations, ["retire", "store"])
        XCTAssertEqual(defaults.string(forKey: "appMode"), "host")
    }
}
