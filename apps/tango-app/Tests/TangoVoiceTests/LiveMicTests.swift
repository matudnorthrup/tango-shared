import XCTest
import AVFoundation
import TangoDeskKit
@testable import TangoVoice

@MainActor final class LiveMicTests: XCTestCase {
    func testOffAtLaunchBluetoothPolicyAndManualDisarm() throws {
        for bluetooth in [false, true] { for avoid in [false, true] {
            let live = LiveMic(); var starts = 0; var stops = 0; var sockets = 0; var notices = 0
            live.warmMicrophone = { starts += 1 }; live.stopMicrophone = { stops += 1 }
            live.openSocket = { sockets += 1 }; live.autoDisarmed = { _ in notices += 1 }
            XCTAssertFalse(live.armed)
            try live.arm(bluetooth: bluetooth, avoidBluetooth: avoid)
            XCTAssertTrue(live.armed); XCTAssertTrue(live.muted)
            XCTAssertEqual(starts, bluetooth && avoid ? 0 : 1); XCTAssertEqual(sockets, 1)
            live.disarm(); XCTAssertFalse(live.armed); XCTAssertEqual(stops, 1); XCTAssertEqual(notices, 0)
        } }
    }
    func testAutomaticRecoveryHonorsManualOffSleepLockAndBackoff() {
        var recovery = LiveMicRecovery()
        XCTAssertTrue(recovery.eligible)
        recovery.manual(false); XCTAssertFalse(recovery.eligible)
        recovery.sleeping = true; recovery.sleeping = false
        recovery.locked = true; recovery.locked = false
        XCTAssertFalse(recovery.eligible)
        recovery.manual(true); XCTAssertTrue(recovery.eligible)
        recovery.sleeping = true; XCTAssertFalse(recovery.eligible)
        recovery.locked = true; recovery.sleeping = false; XCTAssertFalse(recovery.eligible)
        recovery.locked = false; XCTAssertTrue(recovery.eligible)
        XCTAssertEqual((0..<8).map { _ in recovery.retryDelay() }, [2, 4, 8, 16, 32, 60, 60, 60])
        recovery.connected(); XCTAssertEqual(recovery.retryDelay(), 2)
        recovery.enabled = false; XCTAssertFalse(recovery.eligible)
        XCTAssertTrue(LiveMicRecovery().eligible) // next launch clears manual-off intent
    }
    func testAutomaticArmingDisablesIdleTimeoutButSettingOffRestoresIt() async throws {
        let live = LiveMic(idleLimit: .milliseconds(20))
        live.idleDisarmEnabled = false
        try live.arm(bluetooth: false, avoidBluetooth: true)
        try await Task.sleep(for: .milliseconds(60)); XCTAssertTrue(live.armed)
        live.begin(); live.inputEnded()
        try await Task.sleep(for: .milliseconds(60)); XCTAssertTrue(live.armed)
        live.idleDisarmEnabled = true
        for _ in 0..<100 { if !live.armed { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(live.armed)
    }
    func testEveryAutoDisarmClosesResourcesAndNotifiesOnlyOnce() throws {
        for trigger in LiveMic.Trigger.allCases {
            let live = LiveMic(); var closed = 0; var stopped = 0; var notices: [LiveMic.Trigger] = []
            live.closeSocket = { closed += 1 }; live.stopMicrophone = { stopped += 1 }; live.autoDisarmed = { notices.append($0) }
            try live.arm(bluetooth: false, avoidBluetooth: true)
            live.disarm(trigger); live.disarm(trigger)
            XCTAssertFalse(live.armed); XCTAssertTrue(live.muted)
            XCTAssertEqual(closed, 1); XCTAssertEqual(stopped, 1); XCTAssertEqual(notices, [trigger])
        }
    }
    func testIdleTimerPausesForDictationAndRestartsAfterInput() async throws {
        let live = LiveMic(idleLimit: .milliseconds(25))
        try live.arm(bluetooth: false, avoidBluetooth: true); live.begin()
        try await Task.sleep(for: .milliseconds(60)); XCTAssertTrue(live.armed); XCTAssertFalse(live.muted)
        live.inputEnded(); XCTAssertTrue(live.muted)
        for _ in 0..<100 { if !live.armed { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(live.armed)
    }
    func testOneReconnectThenAutoDisarmAndRecoveryResetsRetry() throws {
        let live = LiveMic(); var opens = 0; var notices = 0
        live.openSocket = { opens += 1 }; live.autoDisarmed = { _ in notices += 1 }
        try live.arm(bluetooth: false, avoidBluetooth: true)
        live.socketFailed(); XCTAssertEqual(opens, 2); XCTAssertTrue(live.armed)
        live.socketReady(); live.socketFailed(); XCTAssertEqual(opens, 3)
        live.socketFailed(); XCTAssertFalse(live.armed); XCTAssertEqual(notices, 1)
    }
    func testSendAndCancelReturnToArmedMuted() async throws {
        for cancel in [false, true] {
            let live = LiveMic(); let session = VoiceSession(); var opens = 0; var sends = 0
            live.openSocket = { opens += 1 }
            session.stopCapture = { live.inputEnded() }; session.closeSocket = { live.exchangeEnded() }
            session.send = { _ in sends += 1 }
            try live.arm(bluetooth: false, avoidBluetooth: true); live.begin()
            let id = session.press(now: .distantPast)!
            let target = try VoiceTarget.resolve(id: "fixture", detail: Data(#"{"item":{"id":"fixture","replyable":true}}"#.utf8))
            XCTAssertTrue(session.ready(target, generation: id)); session.append("fixture")
            if cancel { session.cancel() } else {
                session.release(tick: .milliseconds(1))
                for _ in 0..<100 { if session.state == .sent { break }; try await Task.sleep(for: .milliseconds(5)) }
                XCTAssertEqual(session.state, .sent)
            }
            XCTAssertEqual(sends, cancel ? 0 : 1); XCTAssertEqual(opens, 2)
            XCTAssertTrue(live.armed); XCTAssertTrue(live.muted); live.disarm()
        }
    }
    func testDelayedCallbackDropsSamplesFromBeforePress() throws {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2048)!; buffer.frameLength = 2048
        for i in 0..<2048 { buffer.floatChannelData![0][i] = 0.5 }
        let beforePress = mach_absolute_time() - AVAudioTime.hostTime(forSeconds: 1)
        let capture = try CaptureBuffer(format, muted: true)
        try capture.unmute()
        capture.append(buffer, hostTime: beforePress)
        XCTAssertTrue(capture.drain().0.isEmpty)
        capture.append(buffer)
        XCTAssertFalse(capture.drain().0.isEmpty)
    }
    func testCallbackStraddlingPressTrimsOnlyOlderSamples() throws {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800)!; buffer.frameLength = 4800
        for i in 0..<4800 { buffer.floatChannelData![0][i] = i < 2400 ? 0.5 : 0 }
        let boundary = mach_absolute_time()
        let capture = try CaptureBuffer(format, muted: true)
        try capture.unmute(at: boundary)
        capture.append(buffer, hostTime: boundary - AVAudioTime.hostTime(forSeconds: 0.05))
        let audio = capture.drain(final: true).0.reduce(Data(), +)
        XCTAssertFalse(audio.isEmpty)
        XCTAssertTrue(audio.allSatisfy { $0 == 0 })
        XCTAssertLessThanOrEqual(audio.count, 2400)
    }
    func testMutedFramesNeverReachTransportAndNoPreRollSurvivesUnmute() throws {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2048)!; buffer.frameLength = 2048
        for i in 0..<2048 { buffer.floatChannelData![0][i] = 0.5 }
        let capture = try CaptureBuffer(format, muted: true)
        var sent: [Data] = []
        for _ in 0..<200 { capture.append(buffer); sent += capture.drain().0 }
        XCTAssertTrue(sent.isEmpty); XCTAssertNil(capture.drain().1)
        try capture.unmute()
        XCTAssertTrue(capture.drain().0.isEmpty)
        capture.append(buffer); sent += capture.drain().0
        XCTAssertFalse(sent.isEmpty)
        _ = capture.mute(); sent = []
        for _ in 0..<200 { capture.append(buffer); sent += capture.drain().0 }
        sent += capture.drain(final: true).0
        XCTAssertTrue(sent.isEmpty)
        try capture.unmute(); XCTAssertTrue(capture.drain().0.isEmpty)
    }
}
