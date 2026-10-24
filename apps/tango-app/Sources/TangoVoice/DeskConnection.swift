import Foundation
import TangoDeskKit

public struct DeskConnection: Sendable {
    public struct Snapshot: Sendable {
        public let destination: String
        public let voiceAvailable: Bool
    }
    private let session: URLSession
    public init(session: URLSession? = nil) {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        self.session = session ?? URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }
    public func validate(_ text: String) async throws -> Snapshot {
        let address = try DeskAddress(text)
        do {
            let presentation = try await read(address.endpoint("api/desk/presentation"))
            guard let view = presentation["view"] as? String else { throw DeskError.invalidResponse }
            var metadata = URLComponents(url: address.endpoint("api/desk/voice"), resolvingAgainstBaseURL: false)!
            metadata.queryItems = [.init(name: "mode", value: "dictation")]
            let voice = try await read(metadata.url!)
            guard voice["voice"] != nil else { throw DeskError.invalidResponse }
            let destination = view == "conversation" ? (presentation["itemId"] as? String ?? "No conversation open") : "No conversation open"
            return Snapshot(destination: destination, voiceAvailable: true)
        } catch let error as URLError {
            switch error.code {
            case .cannotFindHost, .dnsLookupFailed:
                throw DeskError.refused("Desk host not found. Connect Tailscale and check the full desk URL.")
            case .notConnectedToInternet, .networkConnectionLost:
                throw DeskError.refused("Network disconnected. Check your connection and Tailscale.")
            case .timedOut, .cannotConnectToHost:
                throw DeskError.refused("Desk unreachable. Check Tailscale and whether the remote desk is running.")
            default: throw error
            }
        }
    }
    private func read(_ url: URL) async throws -> [String: Any] {
        var request = URLRequest(url: url); request.timeoutInterval = 10
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw DeskError.invalidResponse }
        switch http.statusCode {
        case 200: break
        case 403: throw DeskError.refused("Access denied (403). Your Tailscale login is not allowed to use this desk.")
        case 404: throw DeskError.refused("Desk not found (404). Enter the full base URL, including /tango-screen.")
        case 503: throw DeskError.refused("The desk is reachable but voice is unavailable.")
        default: throw DeskError.refused("Desk returned HTTP \(http.statusCode).")
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw DeskError.invalidResponse }
        return object
    }
}
