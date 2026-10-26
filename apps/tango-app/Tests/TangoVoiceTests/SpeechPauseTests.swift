import XCTest
@testable import TangoVoice

@MainActor final class SpeechPauseTests: XCTestCase {
    private func pcm(_ amplitude: Int16, windows: Int) -> Data {
        var result = Data()
        for i in 0..<(480 * windows) {
            var value = (i % 24 < 12 ? amplitude : -amplitude).littleEndian
            withUnsafeBytes(of: &value) { result.append(contentsOf: $0) }
        }
        return result
    }
    func testSpeechEntirelyDuringStartupStillEndsOnSilence() async throws {
        let session = VoiceSession(); defer { session.cancel() }
        let now = Date(); let id = session.press(now: now)!
        session.release(now: now.addingTimeInterval(0.1))
        session.bufferStartupAudio(pcm(0, windows: 15))
        session.bufferStartupAudio(pcm(2000, windows: 10))
        session.bufferStartupAudio(pcm(0, windows: 75))
        XCTAssertTrue(session.ready(nil, generation: id))
        for frame in session.takeStartupAudio() { session.observeAudio(frame) }
        XCTAssertTrue(session.takeStartupAudio().isEmpty)
        for _ in 0..<100 { if session.state == .undo { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(session.state, .undo)
    }
    func testInitialSilenceClicksAndLowNoiseDoNotEndInput() {
        var detector = SpeechPause()
        XCTAssertFalse(detector.append(pcm(0, windows: 200)))
        XCTAssertFalse(detector.append(pcm(8000, windows: 1)))
        XCTAssertFalse(detector.append(pcm(100, windows: 200)))
    }
    func testPauseResetsOnSpeechAndFiresOnceAcrossIrregularFrames() {
        var detector = SpeechPause()
        XCTAssertFalse(detector.append(pcm(0, windows: 15)))
        XCTAssertFalse(detector.append(pcm(2000, windows: 10)))
        XCTAssertFalse(detector.append(pcm(0, windows: 70)))
        XCTAssertFalse(detector.append(pcm(2000, windows: 3)))
        XCTAssertFalse(detector.append(pcm(0, windows: 74)))
        let final = pcm(0, windows: 1)
        XCTAssertFalse(detector.append(final.prefix(222)))
        XCTAssertTrue(detector.append(final.dropFirst(222)))
        XCTAssertFalse(detector.append(pcm(0, windows: 100)))
    }
    func testNoiseBedAndClicksDoNotExtendPause() {
        for _ in 0..<20 {
            var detector = SpeechPause()
            // 583 / 32768 is -35 dBFS: above the old fixed threshold.
            XCTAssertFalse(detector.append(pcm(583, windows: 15)))
            XCTAssertFalse(detector.append(pcm(8000, windows: 20)))
            XCTAssertFalse(detector.append(pcm(583, windows: 30)))
            XCTAssertFalse(detector.append(pcm(12000, windows: 1)))
            XCTAssertFalse(detector.append(pcm(583, windows: 30)))
            XCTAssertFalse(detector.append(pcm(12000, windows: 2)))
            XCTAssertFalse(detector.append(pcm(583, windows: 11)))
            XCTAssertTrue(detector.append(pcm(583, windows: 1)))
        }
    }
    func testSteadyNoiseAloneDoesNotStartSpeech() {
        var detector = SpeechPause()
        XCTAssertFalse(detector.append(pcm(583, windows: 300)))
    }
    func testHoldIgnoresSilenceAndNewTapResetsDetector() async throws {
        let s = VoiceSession(); defer { s.cancel() }
        let target = try VoiceTarget.resolve(id: "loom:test", detail: Data(#"{"item":{"id":"loom:test","replyable":true}}"#.utf8))
        let now = Date()
        let id = s.press(now: now)!
        XCTAssertTrue(s.ready(target, generation: id))
        s.observeAudio(pcm(0, windows: 15)); s.observeAudio(pcm(2000, windows: 10)); s.observeAudio(pcm(0, windows: 100))
        XCTAssertEqual(s.state, .listening)
        s.release(now: now.addingTimeInterval(1)); XCTAssertEqual(s.state, .undo)
        s.cancel()
        let next = s.press(now: now)!; s.release(now: now.addingTimeInterval(0.1))
        XCTAssertTrue(s.ready(target, generation: next))
        s.observeAudio(pcm(0, windows: 100)); XCTAssertEqual(s.state, .listening)
        s.observeAudio(pcm(2000, windows: 10)); s.observeAudio(pcm(0, windows: 75))
        XCTAssertEqual(s.state, .listening)
        for _ in 0..<100 { if s.state == .undo { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(s.state, .undo)
        s.cancel(); s.observeAudio(pcm(0, windows: 15)); s.observeAudio(pcm(2000, windows: 10)); s.observeAudio(pcm(0, windows: 100))
        XCTAssertEqual(s.state, .idle)
    }
}
