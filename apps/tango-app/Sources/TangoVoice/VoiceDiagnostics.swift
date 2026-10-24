import Foundation

public enum CaptureEnd: String, Encodable, Sendable {
    case silence, tap, release, escape, cancel, limit, provider, error, notStarted = "not_started"
}
public enum VoiceOutcome: String, Encodable, Sendable { case posted, undone, empty, error
    case commandRun = "command_run", commandAmbiguous = "command_ambiguous", commandRefused = "command_refused" }
public enum VoiceErrorCode: String, Encodable, Sendable { case preparation, capture, transport, finish, post, unknown }
/// An explicit, text-free wire type. Never attach error descriptions or transcript text.
public struct VoiceDiagnostic: Encodable, Sendable {
    // Startup measurements are opt-in local QA only, excluded from the event API.
    enum CodingKeys: String, CodingKey {
        case exchangeId, clientApp, clientRole, version, deviceName, mode, endReason, outcome, errorCode, targetId
        case captureMs, speechEndToStopMs, stopToTranscriptMs, transcriptToPostMs
    }
    public let exchangeId: UUID
    public var clientApp = "tango-mac"
    public var clientRole = "host"
    public var version = "unknown"
    public var deviceName: String?
    public var mode = "dictation"
    public var endReason: CaptureEnd = .notStarted
    public var outcome: VoiceOutcome = .undone
    public var errorCode: VoiceErrorCode?
    public var targetId: String?
    public var pressToSocketReadyMs: Int?
    public var pressToModelReadyMs: Int?
    public var pressToFirstAudioMs: Int?
    public var pressToCaptureMs: Int?
    public var captureMs: Int?
    public var speechEndToStopMs: Int?
    public var stopToTranscriptMs: Int?
    public var transcriptToPostMs: Int?
}

/// Monotonic, session-local timestamps; one terminal report, even when cleanup repeats.
@MainActor final class VoiceDiagnostics {
    private var event: VoiceDiagnostic?
    private var pressAt: TimeInterval = 0
    private var captureAt: TimeInterval?
    private var stopAt: TimeInterval?
    private var transcriptAt: TimeInterval?
    private var lastPartialAt: TimeInterval?
    private let now: () -> TimeInterval
    init(now: @escaping () -> TimeInterval) { self.now = now }
    func begin(_ id: UUID) { event = VoiceDiagnostic(exchangeId: id); pressAt = now(); captureAt = nil; stopAt = nil; transcriptAt = nil; lastPartialAt = nil }
    func ready(_ target: String?) { event?.targetId = target; captureAt = now(); event?.pressToCaptureMs = ms(now() - pressAt) }
    func socketReady() { if event?.pressToSocketReadyMs == nil { event?.pressToSocketReadyMs = ms(now() - pressAt) } }
    func modelReady() { if event?.pressToModelReadyMs == nil { event?.pressToModelReadyMs = ms(now() - pressAt) } }
    func firstAudio() { if event?.pressToFirstAudioMs == nil { event?.pressToFirstAudioMs = ms(now() - pressAt) } }
    func target(_ target: String?) { event?.targetId = target }
    func captureStarted() { captureAt = now(); event?.pressToCaptureMs = ms(now() - pressAt) }
    func command(_ target: String? = nil) { event?.mode = "command"; event?.targetId = target }
    func dictation(_ target: String) { event?.mode = "dictation"; event?.targetId = target }
    func transcript() { transcriptAt = now() }
    // The last non-empty partial is a speech-end proxy, not the provider end signal.
    func partialTranscript() { lastPartialAt = now() }
    func stop(_ reason: CaptureEnd, quietMs: Int? = nil) {
        guard event != nil, stopAt == nil else { return }
        let time = now(); stopAt = time; event?.endReason = reason
        if let captureAt { event?.captureMs = ms(time - captureAt) }
        if reason == .silence { event?.speechEndToStopMs = quietMs }
        else if reason == .provider, let lastPartialAt { event?.speechEndToStopMs = ms(time - lastPartialAt) }
    }
    func complete(_ outcome: VoiceOutcome, error: VoiceErrorCode? = nil) -> VoiceDiagnostic? {
        guard var result = event else { return nil }
        event = nil; result.outcome = outcome; result.errorCode = error
        if let transcriptAt, let stopAt { result.stopToTranscriptMs = ms(transcriptAt - stopAt) }
        if outcome == .posted || outcome == .commandRun, let transcriptAt { result.transcriptToPostMs = ms(now() - transcriptAt) }
        if ProcessInfo.processInfo.environment["TANGO_VOICE_TIMINGS"] == "1" {
            var fields: [String: Any] = ["exchangeId": result.exchangeId.uuidString]
            fields["pressToSocketReadyMs"] = result.pressToSocketReadyMs
            fields["pressToModelReadyMs"] = result.pressToModelReadyMs
            fields["pressToCaptureMs"] = result.pressToCaptureMs
            fields["pressToFirstAudioMs"] = result.pressToFirstAudioMs
            if let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) {
                FileHandle.standardError.write(data + Data("\n".utf8))
            }
        }
        return result
    }
    private func ms(_ seconds: TimeInterval) -> Int { Int((seconds * 1000).rounded()) }
}
