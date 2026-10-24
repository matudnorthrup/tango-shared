import Foundation
import Testing
@testable import TangoKit

private final class FakeLaunchctl: @unchecked Sendable {
    var loaded = false
    var running = false
    var failBootstrap = false
    var partialBootstrap = false
    var failBootout = false
    var unloadDespiteFailure = false
    var failPrint = false
    var calls: [[String]] = []
    var pendingUnload = false
    var unloadDelay = 0
    var pauses = 0
    func pause() {
        pauses += 1
        if pendingUnload {
            unloadDelay -= 1
            if unloadDelay <= 0 { loaded = false; running = false; pendingUnload = false }
        }
    }
    func run(_ args: [String]) -> LaunchctlResult {
        calls.append(args)
        switch args[0] {
        case "print":
            if failPrint { return .init(code: 1, output: "permission denied") }
            return loaded ? .init(code: 0, output: "\tstate = \(running ? "running" : "spawn scheduled")\n") : .init(code: 113)
        case "bootstrap":
            if failBootstrap { loaded = partialBootstrap; return .init(code: 5, output: "bootstrap failed") }
            loaded = true; running = true; return .init(code: 0)
        case "bootout":
            if failBootout { if unloadDespiteFailure { loaded = false }; return .init(code: 5, output: "bootout failed") }
            if unloadDelay > 0 { pendingUnload = true }
            else { loaded = false; running = false }
            return .init(code: 0)
        default: Issue.record("Unexpected launchctl command"); return .init(code: 1)
        }
    }
}

private struct Fixture {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let fake = FakeLaunchctl()
    var home: URL { root.appending(path: "home") }
    var bundle: URL { root.appending(path: "Installed Tango.app") }
    var plist: URL { LoginLauncher.externalAgentURL(home: home) }
    var template: URL { bundle.appending(path: "Contents/Library/LaunchAgents/com.tango.server.plist") }
    var agent: LaunchAgent { LaunchAgent(home: home, bundle: bundle, uid: 123, run: { [fake] in fake.run($0) }, pause: { [fake] in fake.pause() }) }
    func prepare() throws {
        try FileManager.default.createDirectory(at: template.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
        let node = bundle.appending(path: "Contents/MacOS/tango-server-node")
        try FileManager.default.createDirectory(at: node.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("fixture".utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        let values: [String: Any] = ["WorkingDirectory": "/fixture/repo", "Label": "com.tango.server", "BundleProgram": "Contents/MacOS/tango-server-node", "ProgramArguments": ["Contents/MacOS/tango-server-node", "/fixture/server.js", "run"], "EnvironmentVariables": ["PATH": "/fixture/bin:/usr/bin"]]
        try PropertyListSerialization.data(fromPropertyList: values, format: .xml, options: 0).write(to: template)
    }
    func clean() { try? FileManager.default.removeItem(at: root) }
}

@Test func externalPlistUsesInstalledBundleAndInstallerContract() throws {
    let f = Fixture(); try f.prepare(); defer { f.clean() }
    let data = try LaunchAgent.plistData(template: Data(contentsOf: f.template), bundle: f.bundle, home: f.home)
    let p = try #require(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    #expect(p["Label"] as? String == "com.tango.tango-server")
    #expect(p["BundleProgram"] == nil)
    #expect(p["ProgramArguments"] as? [String] == [f.bundle.appending(path: "Contents/MacOS/tango-server-node").path, "/fixture/server.js", "run"])
    #expect(p["ExitTimeOut"] as? Int == 30)
    #expect(p["KeepAlive"] as? Bool == true)
    #expect(p["RunAtLoad"] as? Bool == true)
    #expect(p["EnvironmentVariables"] as? [String: String] == ["PATH": "/fixture/bin:/usr/bin"])
    #expect((p["StandardOutPath"] as? String)?.hasPrefix(f.home.path) == true)
}

@Test func onThenOffUsesBootstrapAndBootout() async throws {
    let f = Fixture(); try f.prepare(); defer { f.clean() }
    let agent = f.agent
    #expect(try await agent.state() == .off)
    let on = try await agent.setEnabled(true)
    #expect(on.loaded && on.running)
    #expect(f.fake.calls.contains(["bootstrap", "gui/123", f.plist.path]))
    #expect(try await agent.setEnabled(false) == .off)
    #expect(f.fake.calls.contains(["bootout", "gui/123/com.tango.tango-server"]))
    #expect(!FileManager.default.fileExists(atPath: f.plist.path))
}

@Test func alreadyLoadedWithValidPlistIsNoOp() async throws {
    let f = Fixture(); try f.prepare(); defer { f.clean() }
    let agent = f.agent
    _ = try await agent.setEnabled(true)
    let old = try Data(contentsOf: f.plist)
    f.fake.calls.removeAll()
    let state = try await agent.setEnabled(true)
    #expect(state.loaded && state.loginConfigured && state.warning == nil)
    #expect(f.fake.calls.map { $0[0] } == ["print"])
    #expect(try Data(contentsOf: f.plist) == old)
}

@Test func loadedJobRepairsMissingCorruptAndMismatchedPlistWithoutRestart() async throws {
    for mode in ["missing", "corrupt", "other-bundle"] {
        let f = Fixture(); try f.prepare(); defer { f.clean() }
        let agent = f.agent
        if mode == "corrupt" { try Data("corrupt".utf8).write(to: f.plist) }
        if mode == "other-bundle" {
            let data = try LaunchAgent.plistData(template: Data(contentsOf: f.template), bundle: URL(filePath: "/missing/Other.app"), home: f.home)
            try data.write(to: f.plist)
        }
        f.fake.loaded = true
        let before = try await agent.state()
        #expect(before.loaded && !before.loginConfigured && before.warning != nil)
        let after = try await agent.setEnabled(true)
        #expect(after.loaded && after.loginConfigured && after.warning == nil)
        #expect(f.fake.calls.allSatisfy { $0[0] == "print" })
    }
}

@Test func missingBundleIsReportedAndCannotCreateBrokenLoginConfiguration() async throws {
    let f = Fixture(); try f.prepare(); defer { f.clean() }
    let agent = f.agent
    _ = try await agent.setEnabled(true)
    try FileManager.default.removeItem(at: f.bundle.appending(path: "Contents/MacOS/tango-server-node"))
    #expect(try await agent.state().warning != nil)
    f.fake.calls.removeAll()
    await #expect(throws: LaunchAgentError.self) { try await agent.setEnabled(true) }
    #expect(f.fake.calls.allSatisfy { $0[0] == "print" })
}

@Test func missingAndCorruptExternalPlistsCanBeEnabledOrDisabled() async throws {
    for corrupt in [false, true] {
        let f = Fixture(); try f.prepare(); defer { f.clean() }
        if corrupt { try Data("corrupt".utf8).write(to: f.plist) }
        #expect(try await f.agent.setEnabled(true).loaded)
        if corrupt { try Data("corrupt again".utf8).write(to: f.plist) }
        else { try FileManager.default.removeItem(at: f.plist) }
        #expect(try await f.agent.setEnabled(false) == .off)
    }
}

@Test func invalidBundleDoesNotChangeExistingPlist() async throws {
    for missing in [false, true] {
        let f = Fixture(); try f.prepare(); defer { f.clean() }
        let old = Data("old config".utf8); try old.write(to: f.plist)
        if missing { try FileManager.default.removeItem(at: f.template) }
        else { try Data("invalid".utf8).write(to: f.template) }
        await #expect(throws: (any Error).self) { try await f.agent.setEnabled(true) }
        #expect(try Data(contentsOf: f.plist) == old)
        #expect(f.fake.calls.map { $0[0] } == ["print"])
    }
}

@Test func failedBootstrapRollsBackDiskAndPartialRegistration() async throws {
    for partial in [false, true] {
        let f = Fixture(); try f.prepare(); defer { f.clean() }
        let old = Data("old config".utf8); try old.write(to: f.plist)
        f.fake.failBootstrap = true; f.fake.partialBootstrap = partial
        await #expect(throws: LaunchAgentError.self) { try await f.agent.setEnabled(true) }
        #expect(!f.fake.loaded)
        #expect(try Data(contentsOf: f.plist) == old)
        #expect(f.fake.calls.contains(["bootout", "gui/123/com.tango.tango-server"]) == partial)
    }
}

@Test func failedBootoutPreservesLoginConfiguration() async throws {
    let f = Fixture(); try f.prepare(); defer { f.clean() }
    let agent = f.agent
    _ = try await agent.setEnabled(true)
    let old = try Data(contentsOf: f.plist)
    f.fake.failBootout = true
    await #expect(throws: LaunchAgentError.self) { try await agent.setEnabled(false) }
    #expect(f.fake.loaded)
    #expect(try Data(contentsOf: f.plist) == old)
}

@Test func readFailureIsNotTreatedAsOff() async throws {
    let f = Fixture(); f.fake.failPrint = true
    await #expect(throws: LaunchAgentError.self) { try await f.agent.setEnabled(true) }
    #expect(f.fake.calls.map { $0[0] } == ["print"])
}

@Test func legacyRetirementRunsOnceAndRetriesFailure() throws {
    var registered = true
    var calls = 0
    #expect(throws: LaunchAgentError.self) {
        try LegacyLoginRetirement.retire(registered: { registered }, unregister: {
            calls += 1; throw LaunchAgentError(message: "fixture failure")
        })
    }
    #expect(registered)
    #expect(try LegacyLoginRetirement.retire(registered: { registered }, unregister: { calls += 1; registered = false }))
    #expect(!(try LegacyLoginRetirement.retire(registered: { registered }, unregister: { calls += 1 })))
    #expect(calls == 2)
}

@Test func failedBootstrapWithoutPreviousPlistRemovesPersistence() async throws {
    let f = Fixture(); try f.prepare(); defer { f.clean() }
    f.fake.failBootstrap = true
    await #expect(throws: LaunchAgentError.self) { try await f.agent.setEnabled(true) }
    #expect(!FileManager.default.fileExists(atPath: f.plist.path))
}

@Test func failedCleanupRetainsConfigAndReportsFailure() async throws {
    let f = Fixture(); try f.prepare(); defer { f.clean() }
    f.fake.failBootstrap = true; f.fake.partialBootstrap = true; f.fake.failBootout = true
    await #expect(throws: LaunchAgentError.self) { try await f.agent.setEnabled(true) }
    #expect(f.fake.loaded)
    #expect(FileManager.default.fileExists(atPath: f.plist.path))
}

@Test func bootoutErrorAfterUnloadDoesNotRestoreLoginPersistence() async throws {
    let f = Fixture(); try f.prepare(); defer { f.clean() }
    let agent = f.agent
    _ = try await agent.setEnabled(true)
    f.fake.failBootout = true; f.fake.unloadDespiteFailure = true
    await #expect(throws: LaunchAgentError.self) { try await agent.setEnabled(false) }
    #expect(try await agent.state() == .off)
    #expect(!FileManager.default.fileExists(atPath: f.plist.path))
}

@Test func workingDirectorySurvivesOffOn() async throws {
    let f = Fixture(); try f.prepare(); defer { f.clean() }
    let agent = f.agent
    _ = try await agent.setEnabled(true)
    _ = try await agent.setEnabled(false)
    _ = try await agent.setEnabled(true)
    let p = try #require(PropertyListSerialization.propertyList(from: Data(contentsOf: f.plist), format: nil) as? [String: Any])
    #expect(p["WorkingDirectory"] as? String == "/fixture/repo")
}

@Test func offWaitsForLaunchdToFinishDeregistering() async throws {
    let f = Fixture(); try f.prepare(); defer { f.clean() }
    let agent = f.agent
    _ = try await agent.setEnabled(true)
    f.fake.unloadDelay = 8
    #expect(try await agent.setEnabled(false) == .off)
    #expect(f.fake.pauses == 8)
    #expect(!FileManager.default.fileExists(atPath: f.plist.path))
    #expect(f.fake.calls.filter { $0[0] == "bootout" }.count == 1)
    #expect(try await agent.setEnabled(true).loaded)
}

@Test func offTimeoutRestoresPreviousPlist() async throws {
    let f = Fixture(); try f.prepare(); defer { f.clean() }
    let agent = f.agent
    _ = try await agent.setEnabled(true)
    let previous = try Data(contentsOf: f.plist)
    f.fake.unloadDelay = 1000
    await #expect(throws: LaunchAgentError.self) { try await agent.setEnabled(false) }
    #expect(f.fake.loaded)
    #expect(f.fake.pauses == 240)
    #expect(try Data(contentsOf: f.plist) == previous)
}

@Test func partialBootstrapCleanupWaitsBeforeRestoringPlist() async throws {
    let f = Fixture(); try f.prepare(); defer { f.clean() }
    let previous = Data("old configuration".utf8)
    try previous.write(to: f.plist)
    f.fake.failBootstrap = true; f.fake.partialBootstrap = true
    f.fake.unloadDelay = 8
    await #expect(throws: LaunchAgentError.self) { try await f.agent.setEnabled(true) }
    #expect(!f.fake.loaded)
    #expect(f.fake.pauses == 8)
    #expect(try Data(contentsOf: f.plist) == previous)
}

@Test func partialBootstrapCleanupTimeoutRetainsNewConfiguration() async throws {
    let f = Fixture(); try f.prepare(); defer { f.clean() }
    let previous = Data("old configuration".utf8)
    try previous.write(to: f.plist)
    f.fake.failBootstrap = true; f.fake.partialBootstrap = true
    f.fake.unloadDelay = 1000
    await #expect(throws: LaunchAgentError.self) { try await f.agent.setEnabled(true) }
    #expect(f.fake.loaded)
    #expect(f.fake.pauses == 240)
    #expect(try Data(contentsOf: f.plist) != previous)
}
