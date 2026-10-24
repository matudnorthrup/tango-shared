import AVFoundation
import Foundation

/// One converter per capture preserves resampling history across input taps.
public final class PCMConverter: @unchecked Sendable {
    public let format: AVAudioFormat
    private let converter: AVAudioConverter
    public init(input: AVAudioFormat) throws {
        format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!
        guard let converter = AVAudioConverter(from: input, to: format) else { throw NSError(domain: "Microphone format unavailable", code: 1) }
        self.converter = converter
    }
    public func convert(_ input: AVAudioPCMBuffer) throws -> [Data] {
        let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * 24000 / input.format.sampleRate)) + 64
        let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity)!
        var supplied = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return input
        }
        if let error { throw error }
        return frames(output)
    }
    public func flush() throws -> [Data] {
        var result: [Data] = []
        while true {
            let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800)!
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, inputStatus in inputStatus.pointee = .endOfStream; return nil }
            if let error { throw error }
            result += frames(output)
            if status == .endOfStream || output.frameLength == 0 { return result }
        }
    }
    private func frames(_ output: AVAudioPCMBuffer) -> [Data] {
        guard let samples = output.int16ChannelData?[0] else { return [] }
        let data = Data(bytes: samples, count: Int(output.frameLength) * 2)
        return stride(from: 0, to: data.count, by: 9600).map { data.subdata(in: $0..<min($0 + 9600, data.count)) }
    }
}
/// Audio-thread conversion and buffering are serialized; stop drains the final resampler tail.
final class CaptureBuffer: @unchecked Sendable {
    let lock = NSLock()
    var converter: PCMConverter
    let format: AVAudioFormat
    var muted = false
    private var captureAfter = mach_absolute_time()
    var pending: [Data] = []
    var error: String?
    init(_ format: AVAudioFormat, muted: Bool = false) throws { self.format = format; self.muted = muted; converter = try PCMConverter(input: format) }
    func unmute(at hostTime: UInt64 = mach_absolute_time()) throws {
        lock.lock(); defer { lock.unlock() }
        converter = try PCMConverter(input: format); pending = []; error = nil; captureAfter = hostTime; muted = false
    }
    func mute() -> ([Data], String?) {
        lock.lock(); defer { lock.unlock() }
        guard !muted else { return ([], nil) }
        muted = true
        do { pending += try converter.flush() } catch { self.error = "Could not finish microphone audio." }
        let result = (pending, error); pending = []; return result
    }
    func append(_ buffer: AVAudioPCMBuffer, hostTime: UInt64 = mach_absolute_time()) {
        lock.lock(); defer { lock.unlock() }
        guard !muted else { return } // Drop before conversion, copying or buffering.
        do {
            // A tap delivered after unmute can straddle the press. Trim its older
            // samples using the hardware timestamp, before conversion or copying.
            var input = buffer
            if hostTime < captureAfter {
                let skip = ceil(AVAudioTime.seconds(forHostTime: captureAfter - hostTime) * buffer.format.sampleRate)
                guard skip < Double(buffer.frameLength) else { return }
                let offset = AVAudioFrameCount(skip)
                let count = buffer.frameLength - offset
                guard let trimmed = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: count) else { throw NSError(domain: "Microphone buffer unavailable", code: 1) }
                trimmed.frameLength = count
                let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
                let destination = UnsafeMutableAudioBufferListPointer(trimmed.mutableAudioBufferList)
                for index in source.indices {
                    let stride = Int(source[index].mDataByteSize) / Int(buffer.frameLength)
                    if let src = source[index].mData, let dst = destination[index].mData {
                        memcpy(dst, src.advanced(by: Int(offset) * stride), Int(count) * stride)
                    }
                }
                input = trimmed
            }
            pending += try converter.convert(input)
            if pending.reduce(0, { $0 + $1.count }) > 48000 { pending = []; error = "Microphone audio could not be sent fast enough." }
        } catch { self.error = "Could not convert microphone audio." }
    }
    /// AVAudioEngine calls the tap on its realtime thread. Built outside the main actor so Swift 6 does not
    /// infer main-actor isolation for the closure and trap on the first buffer.
    nonisolated static func tap(_ capture: CaptureBuffer) -> AVAudioNodeTapBlock { { buffer, time in capture.append(buffer, hostTime: time.isHostTimeValid ? time.hostTime : 0) } }
    func drain(final: Bool = false) -> ([Data], String?) {
        lock.lock(); defer { lock.unlock() }
        if final && !muted { do { pending += try converter.flush() } catch { self.error = "Could not finish microphone audio." } }
        let frames = pending; pending = []; return (frames, error)
    }
}
@MainActor public final class Microphone {
    private var engine: AVAudioEngine?
    private var capture: CaptureBuffer?
    public init() {}
    public static func permission() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }
    public var running: Bool { engine != nil }
    public func unmute() throws { try capture?.unmute() }
    public func mute() -> ([Data], String?) { capture?.mute() ?? ([], nil) }
    public func start(muted: Bool = false) throws {
        _ = stop()
        let engine = AVAudioEngine(); let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw NSError(domain: "No microphone is available", code: 1) }
        let capture = try CaptureBuffer(format, muted: muted)
        input.installTap(onBus: 0, bufferSize: 2048, format: format, block: CaptureBuffer.tap(capture))
        self.engine = engine; self.capture = capture
        do { engine.prepare(); try engine.start() } catch { _ = stop(); throw error }
    }
    public func drain() -> ([Data], String?) { capture?.drain() ?? ([], nil) }
    @discardableResult public func stop() -> ([Data], String?) {
        engine?.stop(); engine?.inputNode.removeTap(onBus: 0); engine = nil
        let result = capture?.drain(final: true) ?? ([], nil); capture = nil; return result
    }
}
