import Foundation

/// Non-persistent arming policy. Hardware and network effects are injected for deterministic tests.
@MainActor @Observable public final class LiveMic {
    public enum Trigger: String, CaseIterable { case idle = "30 minutes without dictation", sleep = "Mac went to sleep", lock = "screen locked", device = "input device changed", socket = "voice connection could not reconnect" }
    public private(set) var armed = false
    public private(set) var muted = true
    public private(set) var keepMicrophone = false
    public private(set) var generation = UUID()
    private var retrying = false
    private var timer: Task<Void, Never>?
    private let idleLimit: Duration
    public var idleDisarmEnabled = true { didSet { if armed && muted { resetIdle() } } }
    public var warmMicrophone: () throws -> Void = {}
    public var stopMicrophone: () -> Void = {}
    public var openSocket: () -> Void = {}
    public var closeSocket: () -> Void = {}
    public var autoDisarmed: (Trigger) -> Void = { _ in }
    public init(idleLimit: Duration = .seconds(1800)) { self.idleLimit = idleLimit }
    public func arm(bluetooth: Bool, avoidBluetooth: Bool) throws {
        guard !armed else { return }
        keepMicrophone = !(bluetooth && avoidBluetooth)
        do { if keepMicrophone { try warmMicrophone() } }
        catch { stopMicrophone(); keepMicrophone = false; throw error }
        generation = UUID(); armed = true; muted = true; retrying = false
        openSocket(); resetIdle()
    }
    public func begin() { guard armed else { return }; timer?.cancel(); muted = false }
    public func inputEnded() { guard armed else { return }; muted = true; resetIdle() }
    public func exchangeEnded() { guard armed else { return }; inputEnded(); retrying = false; openSocket() }
    public func socketFailed() {
        guard armed else { return }
        if retrying { disarm(.socket) }
        else { retrying = true; openSocket() }
    }
    public func socketReady() { retrying = false }
    public func disarm(_ trigger: Trigger? = nil) {
        guard armed else { return }
        armed = false; muted = true; keepMicrophone = false; generation = UUID()
        timer?.cancel(); timer = nil; stopMicrophone(); closeSocket()
        if let trigger { autoDisarmed(trigger) }
    }
    private func resetIdle() {
        timer?.cancel()
        guard idleDisarmEnabled else { return }
        timer = Task {
            do { try await Task.sleep(for: idleLimit) } catch { return }
            disarm(.idle)
        }
    }
}


/// Session-only intent: automatic recovery must never override a manual mute.
public struct LiveMicRecovery {
    public var enabled: Bool
    public var manuallyOff = false
    public var sleeping = false
    public var locked = false
    private var failures = 0
    public init(enabled: Bool = true) { self.enabled = enabled }
    public var eligible: Bool { enabled && !manuallyOff && !sleeping && !locked }
    public mutating func manual(_ on: Bool) { manuallyOff = !on; failures = 0 }
    public mutating func connected() { failures = 0 }
    public mutating func retryDelay() -> Int {
        let delay = min(60, 2 << min(failures, 5))
        failures += 1
        return delay
    }
}
