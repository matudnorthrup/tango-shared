import Foundation

/// Local energy endpointing for 24 kHz mono signed little-endian PCM. Keeps only
/// counters, never audio. Initial silence and short clicks do not start a turn.
struct SpeechPause {
    private var samples = 0
    private var energy = 0.0
    private var noiseFloor: Double?
    private var voicedWindows = 0
    private var heardSpeech = false
    private var quietWindows = 0
    private var ended = false

    var trailingQuietMs: Int? { heardSpeech ? quietWindows * 20 : nil }

    mutating func append(_ pcm: Data) -> Bool {
        guard pcm.count % 2 == 0 else { return false }
        var fired = false
        pcm.withUnsafeBytes { bytes in
            for offset in stride(from: 0, to: bytes.count, by: 2) {
                let sample = Double(Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: offset, as: Int16.self))) / 32768
                energy += sample * sample; samples += 1
                guard samples == 480 else { continue } // 20 ms, independent of tap size.
                let power = energy / 480
                // Track the lowest energy, with a slow upward drift (1 dB/sec).
                // Seed from input, not an assumed room level. No PCM is retained.
                let floor = min(power, (noiseFloor ?? power) * pow(10, 0.02 / 10))
                noiseFloor = max(floor, 0.00000001)
                let voiced = power >= max(0.0001, noiseFloor! * 10) // -40 dBFS or floor + 10 dB.
                samples = 0; energy = 0
                // Brief impulses count toward the pause until speech is confirmed.
                if heardSpeech { quietWindows += 1 }
                if voiced {
                    voicedWindows += 1
                    if voicedWindows >= 6 { heardSpeech = true } // 120 ms starts a turn.
                    if voicedWindows >= 3 { quietWindows = 0; ended = false } // 60 ms resumes speech.
                } else {
                    voicedWindows = 0
                }
                if quietWindows >= 75, !ended { ended = true; fired = true } // 1.5 s of audio, not wall time.
            }
        }
        return fired
    }
}
