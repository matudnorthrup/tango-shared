import Foundation
import Testing
@testable import TangoKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try JSONDecoder().decode(type, from: Data(json.utf8)) }
private let minimalService = #"{"id":"bot","name":"Bot","group":"Agents","mode":"observe","state":"running","restarts":0,"health":{"ok":true}}"#

@Test func responseContracts() throws {
    let health = try decode(Health.self, #"{"ok":true,"version":"1","startedAt":"now","future":true}"#)
    #expect(health.ok && health.startedAt == "now")
    let services = try decode(Services.self, "{\"services\":[\(minimalService)],\"future\":{}}")
    #expect(services.services[0].pid == nil)
    #expect(services.services[0].since == nil)
    #expect(services.services[0].memoryBytes == nil)
    #expect(services.services[0].cpuPct == nil)
    #expect(services.services[0].budget == nil)
    #expect(services.services[0].health.checkedAt == nil)
    #expect(services.services[0].health.detail == nil)
    let full = try decode(Service.self, #"{"id":"server","name":"Server","group":"Core","mode":"managed","state":"starting","pid":12,"since":"now","restarts":2,"health":{"ok":false,"checkedAt":"now","detail":"warming","future":2},"memoryBytes":1024,"cpuPct":1.2,"budget":{"memoryBytes":2048},"future":[]}"#)
    #expect(full.pid == 12 && full.memoryBytes == 1024 && full.cpuPct == 1.2 && full.restarts == 2)
    #expect(full.health.detail == "warming")
    #expect(try decode(Logs.self, #"{"lines":["one","two"],"extra":0}"#).lines == ["one", "two"])
    #expect(try decode(ActionResult.self, #"{"ok":true,"extra":0}"#).ok)
    #expect(try decode(ActionResult.self, #"{"ok":false,"code":"observe"}"#).ok == false)
    let maintenance = try decode(Maintenance.self, #"{"on":false,"running":0,"queued":1,"extra":0}"#)
    #expect(maintenance.reason == nil && maintenance.since == nil)
    let fullMaintenance = try decode(Maintenance.self, #"{"on":true,"reason":"upgrade","since":"now","running":2,"queued":3}"#)
    #expect(fullMaintenance.reason == "upgrade" && fullMaintenance.running == 2)
    let releases = try decode(Releases.self, #"{"current":"a","previous":"b","releases":[{"id":"a","status":"ready","bytes":4096,"buildTime":"now","extra":0}],"extra":0}"#)
    #expect(releases.current == "a" && releases.previous == "b" && releases.releases[0].bytes == 4096)
    #expect(try decode(Releases.self, #"{"releases":[]}"#).previous == nil)
    #expect(try decode(Releases.self, #"{"current":null,"previous":null,"releases":[]}"#).current == nil)
    let resource = try decode(Resources.self, #"{"at":"now","memory":{"totalBytes":1000,"freePct":50,"agents":[{"name":"A","threadId":"t","processes":2,"bytes":100,"extra":true}]},"disk":{"totalBytes":2000,"freeBytes":1000},"extra":0}"#)
    #expect(resource.warm == nil && resource.cooled == nil && resource.limits == nil)
    #expect(resource.memory.agents[0].threadId == "t" && resource.disk.freeBytes == 1000)
    let fullResource = try decode(Resources.self, #"{"at":"now","memory":{"totalBytes":1000,"freePct":50,"agents":[]},"disk":{"totalBytes":2000,"freeBytes":1000},"warm":3,"cooled":2,"limits":{"count":4},"future":[]}"#)
    #expect(fullResource.warm == 3 && fullResource.cooled == 2)
}
@Test func statusRules() throws {
    let healthy = try decode(Service.self, minimalService)
    #expect(OverallStatus.evaluate(reachable: false, healthOK: true, services: [healthy]) == .unreachable)
    #expect(OverallStatus.evaluate(reachable: true, healthOK: true, services: [healthy]) == .healthy)
    #expect(OverallStatus.evaluate(reachable: true, healthOK: false, services: [healthy]) == .degraded)
    #expect(OverallStatus.evaluate(reachable: true, healthOK: true, services: []) == .healthy)
    for state in ["starting", "stopped", "failing", "down", "unknown", "future"] {
        let service = try decode(Service.self, minimalService.replacingOccurrences(of: "running", with: state))
        #expect(OverallStatus.evaluate(reachable: true, healthOK: true, services: [service]) == .degraded)
    }
    let unhealthy = try decode(Service.self, minimalService.replacingOccurrences(of: "true", with: "false"))
    #expect(OverallStatus.evaluate(reachable: true, healthOK: true, services: [unhealthy]) == .degraded)
}
@Test func errorMapping() {
    #expect(APIError.response(status: 409, data: Data(#"{"ok":false,"code":"observe"}"#.utf8)) == .observed)
    #expect(APIError.response(status: 501, data: Data(#"{"code":"loom_unsupported"}"#.utf8)) == .loomUnsupported)
    #expect(APIError.response(status: 409, data: Data(#"{"code":"other"}"#.utf8)) == .http(409))
    #expect(APIError.response(status: 500, data: Data("bad".utf8)) == .http(500))
}
@Test func pollingRules() {
    #expect(Polling.interval(windowVisible: false, menuVisible: false) == 30)
    #expect(Polling.interval(windowVisible: true, menuVisible: false) == 5)
    #expect(Polling.interval(windowVisible: false, menuVisible: true) == 5)
    #expect(Polling.interval(windowVisible: true, menuVisible: true) == 5)
}

private final class FakeProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let authorized = request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token"
        let url = request.url!
        if url.path.hasSuffix("logs") {
            #expect(url.absoluteString == "http://127.0.0.1:9440/services/a%2Fb/logs?lines=200")
            #expect(request.httpMethod == "GET")
        }
        let status = authorized ? (url.path.hasSuffix("stop") ? 409 : (url.path.hasSuffix("maintenance") ? 501 : 200)) : 401
        let json = status == 409 ? #"{"ok":false,"code":"observe"}"# : (status == 501 ? #"{"code":"loom_unsupported"}"# : #"{"lines":["fake log"]}"#)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
@Test func clientUsesFakeTransport() async throws {
    let token = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try Data("test-token\n".utf8).write(to: token)
    defer { try? FileManager.default.removeItem(at: token) }
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FakeProtocol.self]
    let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
    let api = APIClient(baseURL: "http://127.0.0.1:9440", tokenPath: token.path, session: session)
    let logs: Logs = try await api.request(APIClient.servicePath("a/b") + "/logs?lines=200")
    #expect(logs.lines == ["fake log"])
    do { let _: ActionResult = try await api.request("services/bot/stop", method: "POST"); Issue.record("Expected observe error") }
    catch { #expect(error as? APIError == .observed) }
    do { let _: Maintenance = try await api.request("maintenance"); Issue.record("Expected unsupported error") }
    catch { #expect(error as? APIError == .loomUnsupported) }
}
