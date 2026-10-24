import XCTest
import AVFoundation
import TangoDeskKit
@testable import TangoVoice

/// Real URLSession WebSocket handshake, binary frames, finish ordering and transcript events.
@MainActor final class SocketTests: XCTestCase {
    func testLocalFakeSocket() async throws { try await runSocket(warm: false) }
    func testWarmSocketDropsMutedAudioUntilActivation() async throws { try await runSocket(warm: true) }
    // Synthetic spoken audio followed by silence, over a real socket that never sends speech_end.
    func testSpokenPauseFinishesWithoutModelDelegation() async throws {
        let wav = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
        defer { try? FileManager.default.removeItem(at: wav) }
        let say = Process(); say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = ["-o", wav.path, "--file-format=WAVE", "--data-format=LEI16@24000", "This is a synthetic dictation test."]
        try say.run(); say.waitUntilExit(); XCTAssertEqual(say.terminationStatus, 0)
        let file = try AVAudioFile(forReading: wav)
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
        try file.read(into: buffer)
        let converter = try PCMConverter(input: buffer.format)
        let spoken = try (converter.convert(buffer) + converter.flush()).reduce(Data(), +)
        let audio = spoken + Data(repeating: 0, count: 24000 * 2 * 2)
        // Repeat the real spoken PCM endpoint twenty times, independently reset.
        for _ in 0..<20 {
            var detector = SpeechPause()
            var endpoints = 0
            for offset in stride(from: 0, to: audio.count, by: 960) {
                if detector.append(audio.subdata(in: offset..<min(offset + 960, audio.count))) { endpoints += 1 }
            }
            XCTAssertEqual(endpoints, 1)
        }
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("voice-fixture.cjs")
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/env"); process.arguments = ["node", script.path, "--pause"]
        let stdout = Pipe(); process.standardOutput = stdout; process.standardError = FileHandle.standardError
        try process.run(); defer { if process.isRunning { process.terminate() }; process.waitUntilExit() }
        let port = try XCTUnwrap(Int(String(decoding: stdout.fileHandleForReading.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
        let transport = VoiceTransport(); defer { transport.close() }
        let session = VoiceSession(); defer { session.cancel() }
        let now = Date(); let id = session.press(now: now)!; session.release(now: now.addingTimeInterval(0.1))
        let detail = Data(#"{"item":{"id":"loom:test","replyable":true}}"#.utf8)
        let target = try VoiceTarget.resolve(id: "loom:test", detail: detail)
        var finishes = 0; var failures = ""; var modelEnd = false
        session.requestPause = { try await transport.requestPause($0, id: $1) }
        session.finish = { finishes += 1; try await transport.finish() }
        transport.failed = { failures = $0 }
        transport.event = { type, value in
            if type == "status", value == "listening" { _ = session.ready(target, generation: id) }
            if type == "status", value == "speech_end" { modelEnd = true; session.speechEnded() }
            if type == "transcript" { session.append(value) }
        }
        transport.open(try DeskAddress("http://127.0.0.1:\(port)"))
        for _ in 0..<100 { if session.state == .listening { break }; try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(session.state, .listening)
        for offset in stride(from: 0, to: audio.count, by: 960) {
            guard session.state == .listening else { break }
            let frame = audio.subdata(in: offset..<min(offset + 960, audio.count))
            transport.audio(frame)
            session.observeAudio(frame)
            try await Task.sleep(for: .milliseconds(20))
        }
        for _ in 0..<50 { if !session.transcript.isEmpty { break }; try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(failures, ""); XCTAssertFalse(modelEnd)
        XCTAssertEqual(session.state, .undo)
        XCTAssertEqual(finishes, 1)
        XCTAssertEqual(session.transcript, "fixture transcript")
    }
    func testPostPressAudioWaitsForModelAndFinishPreservesFrameOrder() async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("voice-fixture.cjs")
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/env"); process.arguments = ["node", script.path, "--delayed"]
        let stdout = Pipe(); process.standardOutput = stdout
        try process.run(); defer { if process.isRunning { process.terminate() }; process.waitUntilExit() }
        let port = try XCTUnwrap(Int(String(decoding: stdout.fileHandleForReading.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
        let transport = VoiceTransport(); defer { transport.close() }
        var sent = 0; var failure = ""; var transcript = ""
        transport.audioSent = { sent += 1 }; transport.failed = { failure = $0 }
        transport.event = { if $0 == "transcript" { transcript += $1 } }
        let address = try DeskAddress("http://127.0.0.1:\(port)")
        transport.open(address, warm: true)
        for _ in 0..<100 { if transport.warmReady { break }; try await Task.sleep(for: .milliseconds(10)) }
        transport.beginBuffering()
        transport.audio(Data(repeating: 7, count: 9600)); transport.audio(Data(repeating: 8, count: 4800))
        try await transport.activate()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertFalse(transport.modelReady); XCTAssertEqual(sent, 0)
        // A release before model readiness still flushes all post-press audio before finish.
        try await transport.finish()
        for _ in 0..<100 { if !transcript.isEmpty { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(sent, 2); XCTAssertEqual(failure, ""); XCTAssertEqual(transcript, "fixture transcript")
        // Cancel a second buffered attempt before readiness: no old audio leaks into the next socket.
        transport.open(address, warm: true)
        for _ in 0..<100 { if transport.warmReady { break }; try await Task.sleep(for: .milliseconds(10)) }
        transport.beginBuffering(); transport.audio(Data(repeating: 9, count: 9600))
        try await transport.activate(); transport.close()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(sent, 2); XCTAssertEqual(failure, "")
        // A stalled model cannot accumulate more than 15 seconds of PCM.
        transport.open(address, warm: true)
        for _ in 0..<100 { if transport.warmReady { break }; try await Task.sleep(for: .milliseconds(10)) }
        transport.beginBuffering()
        for _ in 0..<75 { transport.audio(Data(repeating: 7, count: 9600)) }
        XCTAssertEqual(failure, "")
        transport.audio(Data(repeating: 7, count: 9600))
        XCTAssertFalse(failure.isEmpty)
    }
    func testPreparationFailuresDiscardBufferedAudioWithoutStartingModel() async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("voice-fixture.cjs")
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/env"); process.arguments = ["node", script.path]
        let stdout = Pipe(); process.standardOutput = stdout
        try process.run(); defer { if process.isRunning { process.terminate() }; process.waitUntilExit() }
        let port = try XCTUnwrap(Int(String(decoding: stdout.fileHandleForReading.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
        let address = try DeskAddress("http://127.0.0.1:\(port)")
        let transport = VoiceTransport(); defer { transport.close() }
        var sent = 0; transport.audioSent = { sent += 1 }
        for lookupFails in [true, false] {
            transport.open(address, warm: true)
            for _ in 0..<100 { if transport.warmReady { break }; try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertTrue(transport.warmReady)
            transport.beginBuffering(); transport.audio(Data(repeating: 7, count: 9600))
            do {
                let lookupAddress = lookupFails ? try DeskAddress("http://127.0.0.1:\(port)/unavailable") : address
                _ = try await transport.prepareCapture(lookupAddress, permission: { false })
                try await transport.activate()
                XCTFail("Failed preparation must not activate")
            } catch { }
            XCTAssertFalse(transport.warmReady); XCTAssertFalse(transport.modelReady)
        }
        try await Task.sleep(for: .milliseconds(100))
        let counts = try JSONSerialization.jsonObject(with: await transport.get(address.endpoint("counts"))) as! [String: Int]
        XCTAssertEqual(counts["starts"], 0); XCTAssertEqual(counts["audioFrames"], 0)
        XCTAssertEqual(counts["closed"], 2); XCTAssertEqual(sent, 0)
    }
    private func runSocket(warm: Bool) async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("voice-fixture.cjs")
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/env"); process.arguments = ["node", script.path]
        let stdout = Pipe(); process.standardOutput = stdout; process.standardError = FileHandle.standardError
        try process.run(); defer { if process.isRunning { process.terminate() }; process.waitUntilExit() }
        let portData = stdout.fileHandleForReading.availableData
        let port = try XCTUnwrap(Int(String(decoding: portData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
        let transport = VoiceTransport(); defer { transport.close() }
        var speechEnded = false; var listening = false; var transcript = ""; var status = ""; var failure = ""
        transport.event = { type, value in
            if type == "status" { if value == "speech_end" { speechEnded = true }; status = value; if value == "listening" { listening = true } }
            if type == "transcript" { transcript += value }
        }
        transport.failed = { failure = $0 }
        transport.open(try DeskAddress("http://127.0.0.1:\(port)"), warm: warm)
        if warm {
            for _ in 0..<100 { if transport.warmReady || !failure.isEmpty { break }; try await Task.sleep(for: .milliseconds(20)) }
            XCTAssertTrue(transport.warmReady, failure); XCTAssertFalse(listening)
            let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false)!
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2048)!; buffer.frameLength = 2048
            let capture = try CaptureBuffer(format, muted: true)
            for _ in 0..<100 {
                capture.append(buffer)
                for frame in capture.drain().0 { transport.audio(frame) }
            }
            // The socket fixture rejects any binary frame before activation.
            try await Task.sleep(for: .milliseconds(50))
            try await transport.activate(); XCTAssertFalse(transport.warmReady)
        }
        for _ in 0..<100 { if listening || !failure.isEmpty { break }; try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(listening, failure)
        transport.audio(Data(repeating: 7, count: 9600)); transport.audio(Data(repeating: 8, count: 4800))
        for _ in 0..<100 { if speechEnded || !failure.isEmpty { break }; try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(speechEnded, failure)
        try await transport.finish()
        for _ in 0..<100 { if status == "sending" || !failure.isEmpty { break }; try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(failure, ""); XCTAssertEqual(status, "sending"); XCTAssertEqual(transcript, "fixture transcript")
    }
}
