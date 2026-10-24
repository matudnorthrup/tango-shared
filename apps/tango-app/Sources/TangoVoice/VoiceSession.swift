import Foundation
import TangoDeskKit

public struct VoiceTarget: Equatable, Sendable {
    public let id: String
    public let title: String
    public static func presentation(_ data: Data) throws -> String {
        guard let id = try optionalPresentation(data) else { throw DeskError.refused("Open a thread on the desk first") }
        return id
    }
    public static func optionalPresentation(_ data: Data) throws -> String? {
        struct Presentation: Decodable { let view: String; let itemId: String? }
        let p = try JSONDecoder().decode(Presentation.self, from: data)
        guard p.view == "conversation", let id = p.itemId, !id.isEmpty else { return nil }
        return id
    }
    public static func resolve(id: String, detail: Data) throws -> VoiceTarget {
        guard let target = try optionalTarget(id: id, detail: detail) else { throw DeskError.refused("Open a thread on the desk first") }
        return target
    }
    public static func optionalTarget(id: String, detail: Data) throws -> VoiceTarget? {
        struct Detail: Decodable {
            struct Item: Decodable {
                struct Summary: Decodable { let title: String? }
                let id: String; let title: String?; let place: String?; let summary: Summary?; let replyable: Bool?; let disposition: String?
            }
            let item: Item
        }
        let i = try JSONDecoder().decode(Detail.self, from: detail).item
        guard i.id == id else { throw DeskError.invalidResponse }
        guard i.replyable == true, i.disposition == nil || i.disposition == "active" else { return nil }
        return VoiceTarget(id: id, title: i.title ?? i.summary?.title ?? i.place ?? id)
    }
}

/// All asynchronous work is tied to one generation. Late permission/network results cannot restart capture.
@MainActor @Observable public final class VoiceSession {
    public enum State: Equatable { case idle, preparing, listening, undo, resolving, fallback, posting, sent, failed }
    public private(set) var state: State = .idle
    public private(set) var transcript = ""
    public private(set) var target: VoiceTarget?
    public private(set) var message = ""
    public private(set) var seconds = 3
    public private(set) var generation = UUID()
    public private(set) var latched = false
    public private(set) var needsRecordingSocket = false
    public var saveHistory: (DictationEntry) -> Bool = { _ in false }
    public private(set) var historySaved = false
    public private(set) var historyID = UUID()
    private var capturedAt = Date()
    private var historyCommand = false
    private var historyDestination: String?
    private var historyFinished = false
    private func remember(_ outcome: DictationEntry.Outcome) {
        guard !historyFinished else { return }
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        historySaved = saveHistory(DictationEntry(id: historyID, capturedAt: capturedAt, text: text,
            destination: historyDestination ?? target?.title, outcome: outcome, isCommand: historyCommand))
    }
    private var fallbackOutcome: VoiceOutcome?
    public private(set) var holding = false
    public var captureLimit: Duration { holding ? .seconds(600) : listeningLimit }
    private let clock: () -> TimeInterval
    private var listeningStarted: TimeInterval = 0
    private var lastDelta: TimeInterval?
    private var finalTranscript: String?
    private var nextPauseMs = 1500
    private var pauseRequest: UUID?
    private var pauseFallback: Task<Void, Never>?
    public var requestPause: (Int, UUID) async throws -> Void = { _, _ in }
    private var pause = SpeechPause()
    private let diagnostics: VoiceDiagnostics
    public var report: (VoiceDiagnostic) -> Void = { _ in }
    private let listeningLimit: Duration
    private var listeningTimer: Task<Void, Never>?
    private var pressedAt: Date?
    private var timer: Task<Void, Never>?
    public var stopCapture: () throws -> Void = {}
    public var closeSocket: () -> Void = {}
    public var finish: () async throws -> Void = {}
    public var send: (DeskCommand) async throws -> Void = { _ in }
    public var resolveNavigation: (UUID, String) async throws -> NavigationResolution = { _, _ in NavigationResolution(status: .dictation) }
    public var commitNavigation: (UUID, String) async throws -> NavigationCommit = { _, _ in throw DeskError.invalidResponse }
    public var failure: (String) -> Void = { _ in }
    public init(listeningLimit: Duration = .seconds(120), clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.clock = clock; self.listeningLimit = listeningLimit; diagnostics = VoiceDiagnostics(now: clock)
    }
    public func resolveTarget(_ target: VoiceTarget?) { self.target = target; diagnostics.target(target?.id) }
    public func captureStarted() { diagnostics.captureStarted() }
    public func socketReady() { diagnostics.socketReady() }
    public func modelReady() { diagnostics.modelReady() }
    public func firstAudio() { diagnostics.firstAudio() }
    public var active: Bool { [.preparing, .listening, .undo, .resolving, .fallback, .posting].contains(state) }
    @discardableResult public func press(now: Date = Date()) -> UUID? {
        if latched, [.preparing, .listening].contains(state) {
            if state == .preparing { cancel() } else { endInput(reason: .tap) }
            return nil
        }
        guard !active else { return nil }
        timer?.cancel(); listeningTimer?.cancel(); latched = false; generation = UUID(); pressedAt = now; transcript = ""; target = nil
        pause = SpeechPause(); holding = false; finalTranscript = nil; lastDelta = nil; nextPauseMs = 1500; clearPauseRequest(); fallbackOutcome = nil; diagnostics.begin(generation)
        historyID = generation; capturedAt = now; historySaved = false; historyCommand = false; historyDestination = nil; historyFinished = false
        needsRecordingSocket = true
        state = .preparing; message = "Connecting…"; return generation
    }
    public func ready(_ target: VoiceTarget?, generation id: UUID) -> Bool {
        guard id == generation, state == .preparing else { return false }
        self.target = target; diagnostics.ready(target?.id); state = .listening; updateListeningMessage()
        listeningStarted = clock()
        scheduleLimit()
        return true
    }
    private func scheduleLimit() {
        listeningTimer?.cancel()
        let id = generation
        let elapsed = clock() - listeningStarted
        let remaining = captureLimit - .seconds(elapsed)
        listeningTimer = Task {
            do { try await Task.sleep(for: max(.zero, remaining)) } catch { return }
            guard generation == id, state == .listening else { return }
            endInput(reason: .limit)
        }
    }
    public func append(_ text: String) {
        guard [.listening, .undo].contains(state), !text.isEmpty else { return }
        if finalTranscript == nil { transcript += text }
        diagnostics.transcript()
        if state == .listening, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            diagnostics.partialTranscript()
        }
        lastDelta = clock()
        if state == .listening { clearPauseRequest(); nextPauseMs = 1500 }
    }
    public func replaceTranscript(_ text: String) {
        guard [.listening, .undo].contains(state) else { return }
        finalTranscript = text; transcript = text
    }
    private func clearPauseRequest() {
        pauseRequest = nil; pauseFallback?.cancel(); pauseFallback = nil
    }
    /// `id` names the pause request a desk answer is for; an answer to a request
    /// cleared by resumed speech is stale and must not end capture.
    public func turnStatus(_ status: String, untilMs: Int? = nil, id: String? = nil) {
        guard state == .listening, latched else { return }
        if let id, id != pauseRequest?.uuidString { return }
        switch status {
        case "speech_end": speechEnded()
        case "waiting":
            clearPauseRequest()
            nextPauseMs = max((pause.trailingQuietMs ?? 0) + 20, untilMs ?? 4000)
        case "holding", "holding_nudge":
            clearPauseRequest()
            if !holding { holding = true; scheduleLimit() }
            nextPauseMs = status == "holding_nudge" ? Int.max : max(90_000, (pause.trailingQuietMs ?? 0) + 20)
            message = status == "holding_nudge" ? "Still holding" : "Holding · say 'send it' when you're done"
        default: break
        }
    }
    public func release(now: Date = Date(), tick: Duration = .seconds(1)) {
        guard [.preparing, .listening].contains(state) else { return }
        guard let pressedAt else { return }
        self.pressedAt = nil
        if now < pressedAt.addingTimeInterval(0.3) {
            latched = true
            if state == .listening { updateListeningMessage() }
            return
        }
        guard state == .listening else { cancel(); return }
        endInput(reason: .release, tick: tick)
    }
    private func updateListeningMessage() {
        if holding { message = "Holding · say 'send it' when you're done"; return }
        message = latched ? "Listening, tap shortcut or pause to finish" : "Listening, release to finish"
    }
    /// Called only for post-press, unmuted frames queued for this exchange.
    public func observeAudio(_ pcm: Data) {
        guard state == .listening else { return }
        _ = pause.append(pcm)
        guard latched, let quiet = pause.trailingQuietMs else { return }
        if quiet < 1500 { clearPauseRequest(); nextPauseMs = 1500; return }
        guard quiet >= nextPauseMs, pauseRequest == nil,
              lastDelta.map({ clock() - $0 >= 0.6 }) ?? true else { return }
        let request = UUID(); let id = generation
        pauseRequest = request
        pauseFallback = Task {
            do {
                try await requestPause(quiet, request)
                guard generation == id, pauseRequest == request else { return }
                try await Task.sleep(for: .milliseconds(300))
                guard generation == id, pauseRequest == request, state == .listening else { return }
                endInput(reason: .silence)
            } catch is CancellationError { }
            catch { if generation == id, pauseRequest == request { fail(error.localizedDescription, code: .transport) } }
        }
    }
    public func speechEnded() {
        clearPauseRequest()
        if latched, state == .listening { endInput(reason: .provider) }
    }
    private func endInput(reason: CaptureEnd, tick: Duration = .seconds(1)) {
        guard state == .listening else { return }
        clearPauseRequest()
        listeningTimer?.cancel(); listeningTimer = nil
        latched = false; pressedAt = nil
        let captureGeneration = generation
        diagnostics.stop(reason, quietMs: pause.trailingQuietMs)
        do { try stopCapture() } catch { fail(error.localizedDescription, code: .capture); return }
        guard generation == captureGeneration, state == .listening else { return }
        state = .undo; seconds = 3; updateSettlingMessage()
        let id = generation
        timer = Task {
            do {
                do { try await finish() } catch {
                    if generation == id { fail(error.localizedDescription, code: .finish) }; return
                }
                remember(.pending)
                for remaining in [2, 1, 0] {
                    try await Task.sleep(for: tick)
                    guard generation == id, state == .undo else { return }
                    seconds = remaining
                    if remaining > 0 { updateSettlingMessage() }
                }
                releaseRecordingSocket()
                let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { complete(.empty); cancel(); return }
                remember(.pending)
                if NavigationResolution.isCandidate(text) {
                    state = .resolving; message = "Checking command…"
                    do {
                        let result = try await resolveNavigation(id, text)
                        guard generation == id, state == .resolving else { return }
                        if result.status != .dictation {
                            historyCommand = true; historyDestination = result.label
                            remember(.pending)
                            diagnostics.command(result.targetId)
                            guard result.status == .action, let ticket = result.ticket, let label = result.label,
                                  let window = result.window, !ticket.isEmpty, !label.isEmpty, !window.isEmpty else {
                                offerText("Could not choose a command destination", outcome: result.status == .ambiguous ? .commandAmbiguous : .commandRefused); return
                            }
                            state = .undo; seconds = 3
                            message = "Opening \(label) on \(window) · Undo (Esc)"
                            for remaining in [2, 1, 0] {
                                try await Task.sleep(for: tick)
                                guard generation == id, state == .undo else { return }
                                seconds = remaining
                            }
                            state = .posting; message = "Opening \(label)…"
                            let committed = try await commitNavigation(id, ticket)
                            guard generation == id else { return }
                            guard committed.ok else { offerText("Command did not complete", outcome: .commandRefused); return }
                            complete(.commandRun); state = .sent; message = "Opened \(label) on \(committed.window ?? window)"
                            return
                        }
                    } catch is CancellationError { return }
                    catch { if generation == id { diagnostics.command(); offerText("Command could not be completed", outcome: .commandRefused) }; return }
                }
                guard let target else { offerText("No reply thread was open when recording started"); return }
                state = .posting; message = "Sending…"
                // Never respond/answer: dictation has only the ordinary reply path.
                try await send(DeskCommand(itemId: target.id, type: "reply", args: .init(text: text)))
                guard id == generation else { return }
                complete(.posted)
                state = .sent; message = "Sent"
            } catch is CancellationError { }
            catch { if generation == id { fail(error.localizedDescription, code: .post) } }
        }
    }
    public var canSendAsText: Bool { state == .fallback && target != nil }
    private func updateSettlingMessage() {
        message = NavigationResolution.isCandidate(transcript)
            ? "Finishing transcript · Undo (Esc)"
            : "Sending in \(seconds)s · Undo (Esc)"
    }
    private func offerText(_ reason: String, outcome: VoiceOutcome? = nil) {
        fallbackOutcome = outcome
        remember(.failed)
        state = .fallback; message = reason + (target == nil ? " · Open a thread and record again" : " · Send as text?")
    }
    public func sendAsText() {
        guard canSendAsText, let target else { return }
        let id = generation; let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        historyCommand = false; historyDestination = nil; remember(.pending)
        fallbackOutcome = nil; diagnostics.dictation(target.id); state = .posting; message = "Sending…"
        timer = Task {
            do {
                try await send(DeskCommand(itemId: target.id, type: "reply", args: .init(text: text)))
                guard generation == id else { return }
                complete(.posted); state = .sent; message = "Sent"
            } catch { if generation == id { fail(error.localizedDescription, code: .post) } }
        }
    }
    private func releaseRecordingSocket() {
        needsRecordingSocket = false
        closeSocket()
    }
    private func complete(_ outcome: VoiceOutcome, error: VoiceErrorCode? = nil) {
        if let event = diagnostics.complete(outcome, error: error) {
            switch outcome {
            case .posted, .commandRun: remember(.sent)
            case .undone: remember(.undone)
            case .error, .commandAmbiguous, .commandRefused: remember(.failed)
            case .empty: break
            }
            historyFinished = true
            report(event)
        }
    }
    public func cancel(reason: CaptureEnd = .cancel) {
        guard state != .posting else { return }
        diagnostics.stop(reason); complete(fallbackOutcome ?? .undone)
        clearPauseRequest()
        timer?.cancel(); timer = nil; listeningTimer?.cancel(); listeningTimer = nil; latched = false; pressedAt = nil; generation = UUID(); try? stopCapture(); releaseRecordingSocket()
        state = .idle; message = ""; transcript = ""
    }
    public func fail(_ reason: String, code: VoiceErrorCode = .unknown) {
        diagnostics.stop(.error); complete(.error, error: code)
        let sendingFailed = state == .undo || state == .posting
        clearPauseRequest()
        timer?.cancel(); timer = nil; listeningTimer?.cancel(); listeningTimer = nil; latched = false; pressedAt = nil; generation = UUID(); try? stopCapture(); releaseRecordingSocket()
        state = .failed
        let recovery = transcript.isEmpty ? "" : (historySaved ? " Your text was saved on this Mac." : " Copy your text before closing.")
        message = reason + recovery; if sendingFailed { failure(reason) }
    }
}
