import Foundation

public enum DeskMediaPermission {
    /// WebKit uses port zero for an origin's default port.
    public static func allowsMicrophone(
        deskURL: URL, scheme: String, host: String, port: Int,
        frameScheme: String, frameHost: String, framePort: Int,
        microphoneOnly: Bool
    ) -> Bool {
        guard microphoneOnly, let deskScheme = deskURL.scheme?.lowercased(),
              let deskHost = deskURL.host?.lowercased(),
              ["https", "http"].contains(deskScheme) else { return false }
        func effectivePort(_ port: Int?, _ scheme: String) -> Int {
            if let port, port != 0 { return port }
            return scheme == "https" ? 443 : 80
        }
        func matches(_ scheme: String, _ host: String, _ port: Int) -> Bool {
            scheme.lowercased() == deskScheme && host.lowercased() == deskHost &&
            effectivePort(port, scheme.lowercased()) == effectivePort(deskURL.port, deskScheme)
        }
        return matches(scheme, host, port) && matches(frameScheme, frameHost, framePort)
    }
}
