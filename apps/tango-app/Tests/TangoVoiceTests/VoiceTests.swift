import XCTest
import AVFoundation
import TangoDeskKit
@testable import TangoVoice

@MainActor final class VoiceTests: XCTestCase {
    let detail = Data(#"{"item":{"id":"loom:test","title":"Scratch","replyable":true,"disposition":"active"}}"#.utf8)
    func ready(_ s: VoiceSession, at: Date = .distantPast) throws {
        let id = s.press(now: at)!
        XCTAssertTrue(s.ready(try VoiceTarget.resolve(id: "loom:test", detail: detail), generation: id))
    }
    func testTargetResolution() throws {
        XCTAssertEqual(try VoiceTarget.presentation(Data(#"{"view":"conversation","itemId":"loom:test"}"#.utf8)), "loom:test")
        for json in [#"{"view":"board","itemId":"loom:test"}"#, #"{"view":"conversation"}"#] { XCTAssertThrowsError(try VoiceTarget.presentation(Data(json.utf8))) }
        XCTAssertEqual(try VoiceTarget.resolve(id: "loom:test", detail: detail).title, "Scratch")
        for json in [#"{"item":{"id":"loom:test","replyable":false}}"#, #"{"item":{"id":"loom:test","replyable":true,"disposition":"done"}}"#, #"{"item":{"id":"loom:test"}}"#] { XCTAssertThrowsError(try VoiceTarget.resolve(id: "loom:test", detail: Data(json.utf8))) }
    }
    func testHoldReleasedDuringPreparationCannotRestart() throws {
        let s = VoiceSession(); let now = Date()
        let old = s.press(now: now)!
        s.release(now: now.addingTimeInterval(1))
        XCTAssertEqual(s.state, .idle)
        XCTAssertFalse(s.ready(try VoiceTarget.resolve(id: "loom:test", detail: detail), generation: old))

    }
    func testTapHoldThresholdAndSpeechEnd() throws {
        let now = Date(timeIntervalSince1970: 0)
        for (duration, latched) in [(0.299, true), (0.3, false), (0.301, false)] {
            let s = VoiceSession(); try ready(s, at: now)
            s.speechEnded(); XCTAssertEqual(s.state, .listening)
            s.release(now: now.addingTimeInterval(duration))
            XCTAssertEqual(s.latched, latched)
            XCTAssertEqual(s.state, latched ? .listening : .undo)
            if latched { s.speechEnded(); XCTAssertEqual(s.state, .undo) }
            s.cancel()
        }
    }
    func testTapDuringPreparationSurvivesReleaseAndSecondTapCancels() throws {
        let s = VoiceSession(); let now = Date(); let id = s.press(now: now)!
        s.release(now: now.addingTimeInterval(0.1))
        XCTAssertTrue(s.latched); XCTAssertEqual(s.state, .preparing)
        XCTAssertTrue(s.ready(try VoiceTarget.resolve(id: "loom:test", detail: detail), generation: id))
        XCTAssertEqual(s.state, .listening); s.cancel()
        let stale = s.press(now: now)!; s.release(now: now.addingTimeInterval(0.1))
        XCTAssertNil(s.press()); XCTAssertEqual(s.state, .idle)
        XCTAssertFalse(s.ready(try VoiceTarget.resolve(id: "loom:test", detail: detail), generation: stale))
    }
    func testSecondTapFinishesExactlyOnce() throws {
        let s = VoiceSession(); let now = Date(); var stops = 0
        s.stopCapture = { stops += 1 }; try ready(s, at: now)
        s.release(now: now.addingTimeInterval(0.1)); XCTAssertEqual(stops, 0)
        XCTAssertNil(s.press()); s.release(); s.speechEnded()
        XCTAssertEqual(s.state, .undo); XCTAssertEqual(stops, 1); s.cancel()
    }
    func testLatchedEscapeDiscardsAndIgnoresLateSpeechEnd() throws {
        let s = VoiceSession(); let now = Date(); try ready(s, at: now)
        s.release(now: now.addingTimeInterval(0.1)); s.append("Discard")
        s.cancel(); s.speechEnded()
        XCTAssertEqual(s.state, .idle); XCTAssertEqual(s.transcript, ""); XCTAssertFalse(s.latched)
    }
    func testListeningSafetyCapUsesSameUndoPath() async throws {
        let s = VoiceSession(listeningLimit: .milliseconds(30)); let now = Date()
        var finishes = 0; s.finish = { finishes += 1 }
        try ready(s, at: now); s.release(now: now.addingTimeInterval(0.1))
        for _ in 0..<100 { if finishes == 1 { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(s.state, .undo); XCTAssertEqual(finishes, 1); s.cancel()
    }
    func testHoldReleaseUndoAndRepeatedPress() async throws {
        let s = VoiceSession(); var sent = 0; var stops = 0; var finishes = 0
        s.send = { _ in sent += 1 }; s.stopCapture = { stops += 1 }; s.finish = { finishes += 1 }
        try ready(s); XCTAssertNil(s.press()); s.append("Hello")
        s.release(tick: .milliseconds(30)); XCTAssertEqual(stops, 1); XCTAssertEqual(s.state, .undo)
        XCTAssertNil(s.press()); try await Task.sleep(for: .milliseconds(40)); s.cancel()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(sent, 0); XCTAssertEqual(finishes, 1); XCTAssertEqual(s.state, .idle)
    }
    func testReleaseAcceptsLateTranscriptThenSendsExactReply() async throws {
        let s = VoiceSession(); var commands: [DeskCommand] = []
        s.send = { commands.append($0) }
        try ready(s); s.append("Hello"); s.release(tick: .milliseconds(20)); s.append(" world")
        for _ in 0..<100 { if s.state == .sent { break }; try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(s.state, .sent); XCTAssertEqual(commands.count, 1)
        let command = try XCTUnwrap(commands.first)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as! [String: Any]
        XCTAssertEqual(Set(json.keys), ["commandId", "itemId", "type", "args"])
        XCTAssertEqual(json["type"] as? String, "reply"); XCTAssertEqual(json["itemId"] as? String, "loom:test")
        XCTAssertEqual(json["args"] as? [String: String], ["text": "Hello world"])
        XCTAssertNotNil(UUID(uuidString: json["commandId"] as! String))
    }
    func testEmptyAndFailuresNeverClaimSent() async throws {
        let s = VoiceSession(); var sent = 0; var failure = ""
        s.send = { _ in sent += 1; throw DeskError.refused("Thread closed") }; s.failure = { failure = $0 }
        try ready(s); s.release(tick: .milliseconds(5)); for _ in 0..<100 { if !s.active { break }; try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(sent, 0); XCTAssertEqual(s.state, .idle)
        try ready(s); s.append("Message"); s.release(tick: .milliseconds(5)); for _ in 0..<100 { if !s.active { break }; try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(s.state, .failed); XCTAssertEqual(failure, "Thread closed")
    }
    func testEscapeDuringHoldStopsCaptureAndDiscardsText() throws {
        let s = VoiceSession(); var stopped = false; s.stopCapture = { stopped = true }
        try ready(s); s.append("Discard"); s.cancel(); s.release()
        XCTAssertTrue(stopped); XCTAssertEqual(s.transcript, ""); XCTAssertEqual(s.state, .idle)
    }
    func testPCMConversionRateChannelsSampleTypeAndFraming() throws {
        let input = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: false)!
        let converter = try PCMConverter(input: input)
        XCTAssertEqual(converter.format.sampleRate, 24000); XCTAssertEqual(converter.format.channelCount, 1); XCTAssertEqual(converter.format.commonFormat, .pcmFormatInt16)
        let buffer = AVAudioPCMBuffer(pcmFormat: input, frameCapacity: 24000)!
        buffer.frameLength = 24000
        for c in 0..<2 { for i in 0..<24000 { buffer.floatChannelData![c][i] = 0.25 } }
        let frames = try converter.convert(buffer) + converter.flush()
        XCTAssertGreaterThan(frames.count, 1)
        XCTAssertTrue(frames.allSatisfy { !$0.isEmpty && $0.count <= 9600 && $0.count % 2 == 0 })
        let data = frames.reduce(Data(), +)
        XCTAssertEqual(Double(data.count / 2), 12000, accuracy: 100)
        let sample = data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: data.count / 4 * 2, as: Int16.self) }
        XCTAssertEqual(Double(sample), 8192, accuracy: 10)
    }
    @MainActor func testMicrophoneTapRunsOffTheMainActor() async throws {
        let input = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false)!
        let capture = try CaptureBuffer(input)
        let tap = CaptureBuffer.tap(capture)
        let buffer = AVAudioPCMBuffer(pcmFormat: input, frameCapacity: 4800)!
        buffer.frameLength = 4800
        // AVAudioEngine delivers buffers on its realtime thread; a main-actor-isolated tap traps here.
        await withCheckedContinuation { done in
            DispatchQueue.global().async { tap(buffer, AVAudioTime(hostTime: mach_absolute_time())); done.resume() }
        }
        let (frames, error) = capture.drain(final: true)
        XCTAssertNil(error); XCTAssertFalse(frames.isEmpty)
    }
    func testSocketURLAndOriginPreserveDeploymentPath() throws {
        let r = VoiceRequests.socket(try DeskAddress("https://desk.example:8443/desk"))
        XCTAssertEqual(r.url?.absoluteString, "wss://desk.example:8443/desk/api/desk/voice?mode=dictation&manualFinish=1")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Origin"), "https://desk.example:8443")
        XCTAssertNil(r.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(VoiceRequests.socket(try DeskAddress("http://127.0.0.1:9431")).url?.scheme, "ws")
    }
}
