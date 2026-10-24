import Foundation
import TangoDeskKit

public struct NavigationResolution: Decodable, Sendable {
    public enum Status: String, Decodable, Sendable { case dictation, action, ambiguous, missing }
    public let status: Status
    public let ticket: String?
    public let label: String?
    public let window: String?
    public let targetId: String?
    public init(status: Status, ticket: String? = nil, label: String? = nil, window: String? = nil, targetId: String? = nil) {
        self.status = status; self.ticket = ticket; self.label = label; self.window = window; self.targetId = targetId
    }
    public static func isCandidate(_ text: String) -> Bool {
        var words = text.lowercased().split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        if words.hasPrefix("please ") { words = String(words.dropFirst(7)) }
        if ["back", "go back"].contains(where: { words == $0 || words == $0 + "." || words == $0 + "!" || words == $0 + "?" }) { return true }
        return ["go to", "show me", "switch to", "take me to"].contains { words.hasPrefix($0 + " ") }
    }
}
public struct NavigationCommit: Decodable, Sendable {
    public let ok: Bool
    public let window: String?
    public init(ok: Bool, window: String? = nil) { self.ok = ok; self.window = window }
}
extension VoiceRequests {
    public static func navigation(_ address: DeskAddress, exchangeId: UUID, transcript: String? = nil, ticket: String? = nil) throws -> URLRequest {
        var request = URLRequest(url: address.endpoint(ticket == nil ? "api/desk/navigator/resolve" : "api/desk/navigator/commit"))
        request.httpMethod = "POST"; request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body = ["exchangeId": exchangeId.uuidString]
        if let transcript { body["transcript"] = transcript }
        if let ticket { body["ticket"] = ticket }
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }
}
