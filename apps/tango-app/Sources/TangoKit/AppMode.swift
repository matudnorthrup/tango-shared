import Foundation

public enum AppMode: String, Sendable { case host, client }

/// Resolve capability before constructing anything that can read or manage the server.
/// A client bundle is permanently client-only, including when old preferences say host.
public enum AppStartup {
    /// Client live mic waits for remote transport and sleep validation.
    public static func allowsLiveMic(mode: AppMode) -> Bool { mode == .host }
    public static func mode(defaults: UserDefaults, clientOnly: Bool) -> AppMode {
        let mode = clientOnly ? .client : (AppMode(rawValue: defaults.string(forKey: "appMode") ?? "") ?? .host)
        defaults.set(mode.rawValue, forKey: "appMode")
        return mode
    }
    @MainActor public static func host<T>(mode: AppMode, retire: () -> Void, make: () -> T) -> T? {
        guard mode == .host else { return nil }
        retire()
        return make()
    }
}
