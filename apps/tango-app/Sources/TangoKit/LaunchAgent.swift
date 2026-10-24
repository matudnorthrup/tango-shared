import Foundation

public struct LaunchctlResult: Sendable {
    public let code: Int32
    public let output: String
    public init(code: Int32, output: String = "") { self.code = code; self.output = output }
}

public struct LaunchAgentState: Sendable, Equatable {
    public let loaded: Bool
    public let running: Bool
    public var loginConfigured: Bool = false
    public var warning: String? { loaded && !loginConfigured ? "Login configuration is missing or mismatched. Repair it to start this app’s server at the next login." : nil }
    public static let off = Self(loaded: false, running: false)
    public var description: String { running ? "Loaded and running" : loaded ? "Loaded; waiting to run" : "Not loaded" }
}

public struct LaunchAgentError: LocalizedError {
    public let message: String
    public init(message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// All launchctl and filesystem boundaries are injectable. No work occurs at initialization.
public actor LaunchAgent {
    public typealias Runner = @Sendable ([String]) throws -> LaunchctlResult
    private let home: URL
    private let bundle: URL
    private let domain: String
    private let run: Runner
    private let pause: @Sendable () -> Void
    private var plist: URL { LoginLauncher.externalAgentURL(home: home) }
    private var job: String { "\(domain)/\(LoginLauncher.externalLabel)" }

    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser,
                bundle: URL = Bundle.main.bundleURL, uid: UInt32 = getuid(),
                run: @escaping Runner = LaunchAgent.launchctl,
                pause: @escaping @Sendable () -> Void = { Thread.sleep(forTimeInterval: 0.25) }) {
        self.home = home; self.bundle = bundle; self.domain = "gui/\(uid)"; self.run = run; self.pause = pause
    }

    public static func launchctl(_ arguments: [String]) throws -> LaunchctlResult {
        let process = Process(), pipe = Pipe()
        process.executableURL = URL(filePath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = pipe; process.standardError = pipe
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return LaunchctlResult(code: process.terminationStatus, output: String(decoding: data, as: UTF8.self))
    }

    public func state() throws -> LaunchAgentState {
        let result = try run(["print", job])
        if result.code == 113 { return .off } // launchctl: service not found
        guard result.code == 0 else { throw LaunchAgentError(message: "Cannot read server registration: \(result.output)") }
        let running = result.output.split(separator: "\n").contains { $0.trimmingCharacters(in: .whitespaces) == "state = running" }
        return LaunchAgentState(loaded: true, running: running, loginConfigured: loginConfigurationMatches())
    }

    private func loginConfigurationMatches() -> Bool {
        guard let data = try? Data(contentsOf: plist),
              let values = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
              let args = values["ProgramArguments"] as? [String], args.count == 3 else { return false }
        let node = bundle.appending(path: "Contents/MacOS/tango-server-node").path
        return values["Label"] as? String == LoginLauncher.externalLabel
            && args[0] == node && FileManager.default.isExecutableFile(atPath: node)
            && args[1].hasPrefix("/") && args[2] == "run"
            && (values["Program"] == nil || values["Program"] as? String == node)
            && values["RunAtLoad"] as? Bool == true
            && (values["ExitTimeOut"] as? Int ?? 0) >= 30
    }

    public static func plistData(template: Data, bundle: URL, home: URL) throws -> Data {
        guard var values = try PropertyListSerialization.propertyList(from: template, format: nil) as? [String: Any],
              let args = values["ProgramArguments"] as? [String], args.count == 3,
              args[1].hasPrefix("/"), args[2] == "run" else {
            throw LaunchAgentError(message: "Invalid bundled server configuration; use a built Tango.app.")
        }
        values.removeValue(forKey: "BundleProgram")
        values.removeValue(forKey: "Program")
        values["Label"] = LoginLauncher.externalLabel
        values["ProgramArguments"] = [bundle.appending(path: "Contents/MacOS/tango-server-node").path, args[1], "run"]
        values["RunAtLoad"] = true; values["KeepAlive"] = true
        values["ExitTimeOut"] = max(values["ExitTimeOut"] as? Int ?? 0, 30)
        let logs = home.appending(path: ".tango/server")
        values["StandardOutPath"] = logs.appending(path: "launchd.out.log").path
        values["StandardErrorPath"] = logs.appending(path: "launchd.err.log").path
        return try PropertyListSerialization.data(fromPropertyList: values, format: .xml, options: 0)
    }

    /// bootout returns before launchd finishes deregistering a terminating job.
    /// Allow 60 seconds of settling, beyond the generated 30-second ExitTimeOut.
    /// Keep this transition actor-isolated (no suspension/reentrant On request).
    private func waitUntilUnloaded() throws -> LaunchAgentState {
        for attempt in 0...240 {
            let current = try state()
            if !current.loaded { return current }
            if attempt < 240 { pause() }
        }
        throw LaunchAgentError(message: "Server is still registered after waiting for shutdown.")
    }

    public func setEnabled(_ enabled: Bool) throws -> LaunchAgentState {
        let before = try state()
        if enabled && before.loaded && before.loginConfigured { return before }
        let files = FileManager.default
        // Preserve even a corrupt plist on failure. Off never needs to parse it.
        let previous = files.fileExists(atPath: plist.path) ? try Data(contentsOf: plist) : nil
        if enabled {
            guard files.isExecutableFile(atPath: bundle.appending(path: "Contents/MacOS/tango-server-node").path) else {
                throw LaunchAgentError(message: "Bundled Node is missing or not executable; use a built Tango.app.")
            }
            let template = try Data(contentsOf: bundle.appending(path: "Contents/Library/LaunchAgents/com.tango.server.plist"))
            let data = try Self.plistData(template: template, bundle: bundle, home: home)
            try files.createDirectory(at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
            try files.createDirectory(at: home.appending(path: ".tango/server"), withIntermediateDirectories: true)
            try data.write(to: plist, options: .atomic)
            // Repair next-login persistence without restarting the already loaded server.
            if before.loaded { return try state() }
            do {
                let result = try run(["bootstrap", domain, plist.path])
                guard result.code == 0 else {
                    let hint = result.code == 119 ? " The service is disabled in launchd; its disabled override must be cleared before retrying." : ""
                    throw LaunchAgentError(message: "Cannot start server: \(result.output)\(hint)")
                }
                let after = try state()
                guard after.loaded else { throw LaunchAgentError(message: "Server registration did not load.") }
                return after
            } catch {
                // A failed bootstrap may have registered the job: remove it before restoring disk state.
                if try state().loaded {
                    let cleanup = try run(["bootout", job])
                    guard cleanup.code == 0 else {
                        throw LaunchAgentError(message: "Start failed and registration cleanup failed; configuration retained. \(cleanup.output)")
                    }
                    _ = try waitUntilUnloaded()
                }
                if let previous { try previous.write(to: plist, options: .atomic) }
                else { try files.removeItem(at: plist) }
                throw error
            }
        }
        // Remove login persistence first, restoring it if bootout fails.
        if previous != nil { try files.removeItem(at: plist) }
        do {
            if before.loaded {
                let result = try run(["bootout", job])
                guard result.code == 0 else { throw LaunchAgentError(message: "Cannot stop server: \(result.output)") }
            }
            let after = try waitUntilUnloaded()
            return after
        } catch {
            // launchctl can report failure after unloading. Never resurrect login
            // persistence for a job that actually stopped.
            if try state().loaded, let previous { try previous.write(to: plist, options: .atomic) }
            throw error
        }
    }
}

/// Status, rather than a preferences marker, makes retirement idempotent and retryable.
public enum LegacyLoginRetirement {
    @discardableResult public static func retire(registered: () -> Bool, unregister: () throws -> Void) throws -> Bool {
        guard registered() else { return false }
        try unregister()
        guard !registered() else { throw LaunchAgentError(message: "The old login item is still registered.") }
        return true
    }
}
