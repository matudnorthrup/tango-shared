import SwiftUI
import AppKit
import Carbon
import AVFoundation
import CoreAudio
import UserNotifications
import TangoKit
import TangoVoice
import TangoDeskKit

@MainActor final class GlobalHotkey {
    private var handler: EventHandlerRef?
    private var key: EventHotKeyRef?
    private var escape: EventHotKeyRef?
    private var heldEscape: EventHotKeyRef?
    private let signature: OSType
    init(signature: OSType = 0x54414E47) {
        self.signature = signature
        install()
    }
    var down: () -> Void = {}
    var up: () -> Void = {}
    var cancel: () -> Void = {}
    private func install() {
        var types = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)), EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
            guard let event, let context else { return OSStatus(eventNotHandledErr) }
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            let owner = Unmanaged<GlobalHotkey>.fromOpaque(context).takeUnretainedValue()
            guard id.signature == owner.signature else { return OSStatus(eventNotHandledErr) }
            MainActor.assumeIsolated {
                if id.id == 2 { if GetEventKind(event) == kEventHotKeyPressed { owner.cancel() } }
                else if GetEventKind(event) == kEventHotKeyPressed { owner.down() }
                else { owner.up() }
            }
            return noErr
        }, types.count, &types, Unmanaged.passUnretained(self).toOpaque(), &handler)
    }
    func register(code: UInt32, modifiers: UInt32) throws {
        if let key { UnregisterEventHotKey(key); self.key = nil }
        let result = RegisterEventHotKey(code, modifiers, EventHotKeyID(signature: signature, id: 1), GetApplicationEventTarget(), 0, &key)
        guard result == noErr else { throw DeskError.refused("That shortcut is unavailable. Choose another shortcut in Settings.") }
    }
    func escapeEnabled(_ enabled: Bool, heldModifiers: UInt32 = 0) {
        if let escape { UnregisterEventHotKey(escape); self.escape = nil }
        if let heldEscape { UnregisterEventHotKey(heldEscape); self.heldEscape = nil }
        if enabled, heldModifiers != 0 {
            RegisterEventHotKey(UInt32(kVK_Escape), heldModifiers, EventHotKeyID(signature: signature, id: 2), GetApplicationEventTarget(), 0, &heldEscape)
        }
        if enabled { RegisterEventHotKey(UInt32(kVK_Escape), 0, EventHotKeyID(signature: signature, id: 2), GetApplicationEventTarget(), 0, &escape) }
    }
}

@MainActor @Observable final class PushToTalk {
    static let shared = PushToTalk()
    let session = VoiceSession()
    let live = LiveMic()
    var liveKeyCode = UInt32(UserDefaults.standard.object(forKey: "liveKeyCode") == nil ? kVK_Space : UserDefaults.standard.integer(forKey: "liveKeyCode"))
    var liveModifiers = UInt32(UserDefaults.standard.object(forKey: "liveModifiers") == nil ? (controlKey | optionKey | shiftKey) : UserDefaults.standard.integer(forKey: "liveModifiers"))
    var avoidBluetooth = UserDefaults.standard.object(forKey: "avoidBluetooth") as? Bool ?? true
    var armAtStartup = UserDefaults.standard.object(forKey: "armLiveMicAtStartup") as? Bool ?? true
    private var recovery = LiveMicRecovery(enabled: UserDefaults.standard.object(forKey: "armLiveMicAtStartup") as? Bool ?? true)
    private var recoveryTask: Task<Void, Never>?
    private let liveHotkey = GlobalHotkey(signature: 0x54414E48)
    private var armTask: Task<Void, Never>?
    private var warmWatchdog: Task<Void, Never>?
    private var armGeneration = UUID()
    private var activating = false
    private var liveHeld = false
    var arming = false

    var deskURL = UserDefaults.standard.string(forKey: "voiceDeskURL") ?? ""
    var keyCode = UInt32(UserDefaults.standard.object(forKey: "voiceKeyCode") == nil ? kVK_Space : UserDefaults.standard.integer(forKey: "voiceKeyCode"))
    var modifiers = UInt32(UserDefaults.standard.object(forKey: "voiceModifiers") == nil ? (controlKey | optionKey) : UserDefaults.standard.integer(forKey: "voiceModifiers"))
    var settingsError: String?
    var privacyDenied = false
    private let hotkey = GlobalHotkey()
    private let mic = Microphone()
    private let transport = VoiceTransport()
    private var panel: NSPanel?
    private var preparation: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var displayTask: Task<Void, Never>?
    private var capturePump: Task<Void, Never>?
    private var held = false
    private var prepared = false
    private var resolved: VoiceTarget?
    let allowsLiveMic = AppStartup.allowsLiveMic(mode: AppStartup.mode(defaults: .standard, clientOnly: Bundle.main.object(forInfoDictionaryKey: "TangoClientOnly") as? Bool == true))
    private init() {
        recovery.locked = (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool ?? false
        live.idleDisarmEnabled = !armAtStartup
        live.warmMicrophone = { [weak self] in try self?.mic.start(muted: true) }
        live.stopMicrophone = { [weak self] in self?.capturePump?.cancel(); self?.mic.stop() }
        live.closeSocket = { [weak self] in self?.warmWatchdog?.cancel(); self?.transport.close() }
        live.openSocket = { [weak self] in self?.openWarmSocket() }
        live.autoDisarmed = { [weak self] trigger in
            guard let self else { return }
            if trigger != .socket || self.session.needsRecordingSocket { self.cancel() }
            if trigger == .socket { self.retryLive() }
            self.notify("Live mic turned off: \(trigger.rawValue).", title: "Live mic turned off")
        }
        liveHotkey.down = { [weak self] in
            guard let self, !self.liveHeld else { return }; self.liveHeld = true; self.toggleLive()
        }
        liveHotkey.up = { [weak self] in self?.liveHeld = false }
        if allowsLiveMic {
            do { try liveHotkey.register(code: liveKeyCode, modifiers: liveModifiers) } catch { settingsError = error.localizedDescription }
        }
        hotkey.down = { [weak self] in self?.press() }
        hotkey.up = { [weak self] in self?.release() }
        hotkey.cancel = { [weak self] in self?.cancel(reason: .escape) }
        session.stopCapture = { [weak self] in
            guard let self else { return }
            self.capturePump?.cancel()
            let (frames, error) = self.live.armed && self.live.keepMicrophone ? self.mic.mute() : self.mic.stop()
            self.live.inputEnded()
            if let error { throw DeskError.refused(error) }
            if self.session.state == .listening { for frame in frames { self.transport.audio(frame) } }
        }
        session.closeSocket = { [weak self] in
            guard let self else { return }
            self.activating = false; self.transport.close(); self.live.exchangeEnded()
            if !self.live.armed { self.scheduleRecovery() }
        }
        // VoiceSession owns the capture deadline: 120 s normally, 10 min while holding.
        session.requestPause = { [weak self] quietMs, id in try await self?.transport.requestPause(quietMs, id: id) }
        transport.turnStatus = { [weak self] state, untilMs, id in self?.session.turnStatus(state, untilMs: untilMs, id: id) }
        session.finish = { [weak self] in try await self?.transport.finish() }
        let history = HistoryController.shared
        session.saveHistory = { history.save($0) }
        session.failure = { [weak self] _ in
            guard let self else { return }
            self.notify(self.session.message, historyID: self.session.transcript.isEmpty ? nil : self.session.historyID)
        }
        transport.audioSent = { [weak self] in self?.session.firstAudio() }
        transport.failed = { [weak self] reason in self?.connectionFailed(reason) }
        transport.event = { [weak self] type, value in self?.receive(type, value) }
        do { try hotkey.register(code: keyCode, modifiers: modifiers) } catch { settingsError = error.localizedDescription }
        if UserDefaults.standard.object(forKey: "voiceDeskURL") == nil {
            Task {
                let address = try! DeskAddress("http://127.0.0.1:9410")
                if (try? await transport.get(address.endpoint("api/desk/presentation"))) != nil,
                   UserDefaults.standard.object(forKey: "voiceDeskURL") == nil { deskURL = address.base.absoluteString; scheduleRecovery() }
            }
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.recovery.sleeping = true; self?.stopLive(.sleep) } }
        DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.recovery.locked = true; self?.stopLive(.lock) } }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.recovery.sleeping = false; self?.scheduleRecovery() } }
        DistributedNotificationCenter.default().addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.recovery.locked = false; self?.scheduleRecovery() } }
        scheduleRecovery()
        var inputProperty = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &inputProperty, .main) { [weak self] _, _ in
            Task { @MainActor in self?.stopLive(.device); self?.scheduleRecovery() }
        }

    }
    private static func inputDevice() -> (id: AudioDeviceID, bluetooth: Bool) {
        var id = AudioDeviceID(0); var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr else { return (0, true) }
        var transport: UInt32 = 0
        address.mSelector = kAudioDevicePropertyTransportType
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &transport) == noErr else { return (id, true) }
        return (id, transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE || transport == kAudioDeviceTransportTypeUnknown || transport == kAudioDeviceTransportTypeAggregate)
    }
    private func stopLive(_ trigger: LiveMic.Trigger? = nil) {
        recoveryTask?.cancel(); recoveryTask = nil
        armGeneration = UUID(); armTask?.cancel(); arming = false
        live.disarm(trigger); cancel()
    }
    private func scheduleRecovery(after seconds: Int = 2) {
        recoveryTask?.cancel()
        guard allowsLiveMic, recovery.eligible else { return }
        recoveryTask = Task {
            do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            guard recovery.eligible, !live.armed, !arming else { return }
            guard !session.active else { scheduleRecovery(); return }
            // Automatic arming never invokes the permission prompt.
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
                  (try? DeskAddress(deskURL)) != nil else { return }
            armLive(automatic: true)
        }
    }
    private func retryLive() { scheduleRecovery(after: recovery.retryDelay()) }
    func toggleLive() {
        guard allowsLiveMic else { return }
        if live.armed || arming {
            recovery.manual(false); stopLive(); return
        }
        recovery.manual(true); recoveryTask?.cancel()
        armLive(automatic: false)
    }
    private func armLive(automatic: Bool) {
        guard !session.active, !arming else { settingsError = "Finish dictation before arming live mic."; return }
        arming = true; armGeneration = UUID(); let id = armGeneration
        armTask = Task {
            defer { if armGeneration == id { arming = false } }
            do {
                _ = try DeskAddress(deskURL)
                let permitted: Bool
                if automatic { permitted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }
                else { permitted = await Microphone.permission() }
                guard !Task.isCancelled, armGeneration == id else { return }
                guard permitted else { settingsError = "Microphone access is denied. Enable Tango in Privacy Settings."; return }
                let device = Self.inputDevice()
                guard device.id != 0 else { throw DeskError.refused("No microphone is available.") }
                try live.arm(bluetooth: device.bluetooth, avoidBluetooth: avoidBluetooth)
                settingsError = nil
            } catch {
                settingsError = error.localizedDescription
                if automatic { retryLive() }
            }
        }
    }
    private func openWarmSocket() {
        guard live.armed, let address = try? DeskAddress(deskURL) else { return }
        warmWatchdog?.cancel(); transport.open(address, warm: true)
        warmWatchdog = Task {
            do { try await Task.sleep(for: .seconds(15)) } catch { return }
            connectionFailed("Voice connection timed out.")
        }
    }
    private func connectionFailed(_ reason: String) {
        warmWatchdog?.cancel()
        if live.armed {
            if session.needsRecordingSocket {
                session.fail(reason, code: .transport); live.disarm(.socket)
            } else { live.socketFailed() }
            return
        }
        session.fail(reason, code: .transport)
    }
    private func activateWarm() {
        guard live.armed, transport.warmReady, prepared, session.needsRecordingSocket, !activating else { return }
        activating = true
        watchConnection(session.generation)
        let id = session.generation
        Task {
            do { try await transport.activate() }
            catch { if session.generation == id { connectionFailed(error.localizedDescription) } }
        }
    }
    func saveLive(code: UInt32, modifiers: UInt32, avoidBluetooth: Bool, armAtStartup: Bool) {
        guard allowsLiveMic else { return }
        guard !session.active, !arming else { return }
        do {
            guard modifiers != 0, code != kVK_Escape, code != keyCode || modifiers != self.modifiers else { throw DeskError.refused("Choose a different live mic shortcut with a modifier.") }
            do { try liveHotkey.register(code: code, modifiers: modifiers) }
            catch { try? liveHotkey.register(code: liveKeyCode, modifiers: liveModifiers); throw error }
            live.disarm()
            self.armAtStartup = armAtStartup; recovery.enabled = armAtStartup
            live.idleDisarmEnabled = !armAtStartup
            UserDefaults.standard.set(armAtStartup, forKey: "armLiveMicAtStartup")
            scheduleRecovery()
            liveKeyCode = code; liveModifiers = modifiers; self.avoidBluetooth = avoidBluetooth
            UserDefaults.standard.set(Int(code), forKey: "liveKeyCode")
            UserDefaults.standard.set(Int(modifiers), forKey: "liveModifiers")
            UserDefaults.standard.set(avoidBluetooth, forKey: "avoidBluetooth")
            settingsError = nil
        } catch { settingsError = error.localizedDescription }
    }
    func save(url: String, code: UInt32, modifiers: UInt32) {
        guard !session.active, !arming else { settingsError = "Finish or cancel dictation before changing settings."; return }
        do {
            let address = try DeskAddress(url)
            guard modifiers != 0, code != kVK_Escape, code != liveKeyCode || modifiers != liveModifiers else { throw DeskError.refused("Choose a key with at least one modifier.") }
            do { try hotkey.register(code: code, modifiers: modifiers) }
            catch { try? hotkey.register(code: keyCode, modifiers: self.modifiers); throw error }
            live.disarm()
            deskURL = address.base.absoluteString; keyCode = code; self.modifiers = modifiers
            UserDefaults.standard.set(deskURL, forKey: "voiceDeskURL")
            HistoryController.shared.voiceConnectionSaved(deskURL)
            scheduleRecovery()
            UserDefaults.standard.set(Int(code), forKey: "voiceKeyCode")
            UserDefaults.standard.set(Int(modifiers), forKey: "voiceModifiers")
            settingsError = nil
        } catch { settingsError = error.localizedDescription }
    }
    private func press() {
        guard !held, !arming else { return }
        held = true
        guard let id = session.press() else { return }
        // Freeze destination and source for this attempt, including preparation failures.
        let reportAddress = try? DeskAddress(deskURL)
        let role = allowsLiveMic ? "host" : "client"
        let version = String((Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown").prefix(80))
        let device = String(ProcessInfo.processInfo.hostName.prefix(128))
        session.report = { [weak self] event in
            guard let self, let reportAddress else { return }
            var report = event; report.clientRole = role; report.version = version; report.deviceName = device
            Task { try? await self.transport.report(report, to: reportAddress) }
        }
        if transport.warmReady { session.socketReady() }
        live.begin(); activating = false
        privacyDenied = false; resolved = nil; prepared = false
        if live.armed {
            transport.beginBuffering()
            _ = session.ready(nil, generation: id)
            startCapture(id)
        }
        show(); hotkey.escapeEnabled(true, heldModifiers: modifiers)
        preparation = Task {
            do {
                let address = try DeskAddress(deskURL)
                let target = try await transport.prepareCapture(address) {
                    guard session.generation == id, session.active else { throw CancellationError() }
                    let permitted = await Microphone.permission()
                    guard session.generation == id, session.active else { throw CancellationError() }
                    if !permitted { privacyDenied = true }
                    return permitted
                }
                guard session.generation == id, session.active else { return }
                resolved = target; session.resolveTarget(target); prepared = true
                session.resolveNavigation = { [transport] id, text in try await transport.resolveNavigation(address, exchangeId: id, transcript: text) }
                session.commitNavigation = { [transport] id, ticket in try await transport.commitNavigation(address, exchangeId: id, ticket: ticket) }
                session.send = { command in try await DeskClient(address: address).send(command) }
                if live.armed {
                    if transport.warmReady { activateWarm() }
                } else { transport.open(address) }
                watchConnection(id)
            } catch { if session.generation == id { session.fail(error.localizedDescription, code: .preparation) } }
        }
    }
    private func watchConnection(_ id: UUID) {
        watchdog?.cancel()
        watchdog = Task {
            do { try await Task.sleep(for: .seconds(15)) } catch { return }
            if session.generation == id, session.needsRecordingSocket, !transport.modelReady { connectionFailed("Voice connection timed out.") }
        }
    }
    private func receive(_ type: String, _ value: String) {
        if type == "status", value == "armed" { warmWatchdog?.cancel(); live.socketReady(); recovery.connected(); if session.needsRecordingSocket { session.socketReady() }; activateWarm(); return }
        if type == "error" { connectionFailed(value); return }
        if type == "cancel" { cancel(); return }
        if type == "transcript_final" { session.replaceTranscript(value); return }
        if type == "transcript" { session.append(value); return }
        if type == "status", value == "listening", prepared, session.active {
            session.modelReady()
            watchdog?.cancel()
            if session.state == .preparing {
                let id = session.generation
                guard session.ready(resolved, generation: id) else { return }
                startCapture(id)
            }
        } else if type == "status", value == "ended", session.active { connectionFailed("Voice connection ended before the reply was sent.") }
    }
    private func startCapture(_ id: UUID) {
        do {
            if mic.running { try mic.unmute() } else { try mic.start() }
            session.captureStarted()
            capturePump = Task {
                while session.generation == id, session.state == .listening, !Task.isCancelled {
                    let (frames, error) = mic.drain()
                    if let error { session.fail(error, code: .capture); return }
                    for frame in frames {
                        guard session.state == .listening else { break }
                        transport.audio(frame)
                        session.observeAudio(frame)
                    }
                    do { try await Task.sleep(for: .milliseconds(20)) } catch { return }
                }
            }
        } catch { session.fail(error.localizedDescription, code: .capture) }
    }
    private func release() {
        held = false
        session.release()
        hotkey.escapeEnabled(session.active)
        if session.state == .idle { cancel() }
    }
    func cancel(reason: CaptureEnd = .cancel) { held = false; preparation?.cancel(); watchdog?.cancel(); session.cancel(reason: reason); if session.state == .idle { panel?.orderOut(nil); hotkey.escapeEnabled(false) } }
    private func show() {
        if panel == nil {
            let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 540, height: 60), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.level = .floating; panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]; panel.isFloatingPanel = true; panel.hidesOnDeactivate = false
            panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = true
            panel.contentView = NSHostingView(rootView: VoiceStrip(voice: self)); self.panel = panel
        }
        fitStrip()
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) ?? NSScreen.main {
            panel?.setFrameOrigin(NSPoint(x: screen.visibleFrame.midX - 270, y: screen.visibleFrame.maxY - 15 - (panel?.frame.height ?? 60)))
        }
        panel?.orderFrontRegardless()
        displayTask?.cancel()
        displayTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard !Task.isCancelled else { return }
                fitStrip()
                if !session.active {
                    hotkey.escapeEnabled(false)
                    if session.state == .sent { try? await Task.sleep(for: .seconds(2)); if !Task.isCancelled { panel?.orderOut(nil) } }
                    return
                }
            }
        }
    }
    private func fitStrip() {
        guard let panel, let content = panel.contentView else { return }
        let height = ceil(content.fittingSize.height)
        guard height > 0, height != panel.frame.height else { return }
        let top = panel.frame.maxY
        panel.setFrame(NSRect(x: panel.frame.minX, y: top - height, width: 540, height: height), display: true)
    }
    private func notify(_ reason: String, title: String = "Dictation was not sent", historyID: UUID? = nil) {
        Task {
            let center = UNUserNotificationCenter.current()
            guard (try? await center.requestAuthorization(options: [.alert])) == true else { return }
            let content = UNMutableNotificationContent(); content.title = title; content.body = reason
            if let historyID {
                content.categoryIdentifier = "dictation-recovery"
                content.userInfo = ["historyID": historyID.uuidString]
            }
            try? await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }
}
private struct VoiceStrip: View {
    @Bindable var voice: PushToTalk
    var body: some View {
        VoiceStripContent(state: voice.session.state, message: voice.session.message,
                          transcript: voice.session.transcript, target: voice.session.target?.title,
                          seconds: voice.session.seconds, canSendAsText: voice.session.canSendAsText,
                          privacyDenied: voice.privacyDenied, cancel: { voice.cancel() },
                          sendAsText: { voice.session.sendAsText() })
    }
}

/// Presentation only: the session remains the authority for actions and countdown ticks.
struct VoiceStripContent: View {
    var state: VoiceSession.State
    var message: String
    var transcript: String
    var target: String?
    var seconds = 3
    var canSendAsText = false
    var privacyDenied = false
    var cancel: () -> Void = {}
    var sendAsText: () -> Void = {}
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var colors: VoiceStripColors { VoiceStripColors(dark: scheme == .dark) }
    private var opening: Bool { message.hasPrefix("Opening ") || message.hasPrefix("Opened ") }
    private var active: Bool { [.preparing, .listening, .undo, .resolving, .fallback].contains(state) }
    private var statusColor: Color {
        switch state {
        case .sent: colors.ok
        case .failed, .fallback: colors.amber
        case .resolving: colors.watching
        default: opening ? colors.watching : colors.working
        }
    }
    private var symbol: String {
        switch state {
        case .sent: "checkmark"
        case .failed, .fallback: "exclamationmark.circle.fill"
        default: opening || state == .resolving ? "arrow.right" : "mic.fill"
        }
    }
    private var destination: String? {
        guard opening else { return target }
        return String(message.dropFirst(state == .sent ? 7 : 8))
            .replacingOccurrences(of: " · Undo (Esc)", with: "")
    }
    private var heading: String {
        if opening { return state == .sent ? "Opened" : "Opening" }
        if state == .listening { return message.hasPrefix("Holding") || message == "Still holding" ? message : "Listening" }
        if state == .undo, !opening { return message.hasPrefix("Finishing") ? "Finishing transcript" : "Sending" }
        return message.isEmpty ? "Ready" : message
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                badge
                Text(heading).font(.system(size: 14, weight: .semibold))
                    .fixedSize(horizontal: false, vertical: true).help(message)
                if state == .listening { waveform }
                if let destination, state != .fallback, state != .failed { chip(destination) }
                Spacer(minLength: 0)
                if state == .undo { action("Undo", primary: false, cancel) }
                if active {
                    Button(action: cancel) {
                        Text("esc").font(.system(size: 11, design: .monospaced)).foregroundStyle(colors.muted)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(colors.line, lineWidth: 1))
                    }.buttonStyle(.plain).accessibilityLabel("Cancel (Escape)")
                }
            }.padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 10)
            if !transcript.isEmpty, state != .sent {
                Text(transcript).font(.system(size: 14.5)).foregroundStyle(colors.secondary)
                    .lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 52).padding(.trailing, 14).padding(.bottom, 14)
            }
            if state == .fallback || state == .failed || privacyDenied {
                HStack(spacing: 8) {
                    if !transcript.isEmpty { DictationCopyButton(text: transcript, label: "Copy text") }
                    if canSendAsText { action("Send as text", primary: true, sendAsText) }
                    action("Dismiss", primary: false, cancel)
                    if privacyDenied {
                        action("Open Privacy Settings", primary: false) {
                            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!)
                        }
                    }
                }.padding(.leading, 52).padding(.trailing, 14).padding(.bottom, 12)
            }
            if state == .undo {
                GeometryReader { geometry in
                    Rectangle().fill(statusColor).frame(width: geometry.size.width * CGFloat(max(0, min(3, seconds))) / 3)
                        .animation(reduceMotion ? nil : .linear(duration: 1), value: seconds)
                }.frame(height: 3).background(colors.line)
                    .accessibilityLabel("Undo available for \(seconds) seconds")
            }
        }
        .foregroundStyle(colors.foreground).frame(width: 540)
        .background(colors.panel)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(colors.line, lineWidth: 1))
        .fixedSize(horizontal: false, vertical: true)
    }
    private var badge: some View {
        TimelineView(.animation(minimumInterval: 0.05, paused: state != .listening || reduceMotion)) { context in
            let phase = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.4) / 1.4
            Image(systemName: symbol).font(.system(size: 14, weight: .semibold))
                .foregroundStyle(statusColor).frame(width: 28, height: 28)
                .background(statusColor.opacity(0.18), in: Circle())
                .overlay {
                    if state == .listening {
                        Circle().stroke(statusColor.opacity(reduceMotion ? 0.35 : 0.6 * (1 - phase)), lineWidth: 2)
                            .scaleEffect(reduceMotion ? 1.15 : 1 + phase * 0.4)
                    }
                }
        }.accessibilityHidden(true)
    }
    // The capture session exposes no audio level. These bars indicate listening, not loudness.
    private var waveform: some View {
        TimelineView(.animation(minimumInterval: 0.1, paused: reduceMotion)) { context in
            HStack(spacing: 3) {
                ForEach(0..<5) { index in
                    Capsule().fill(statusColor).frame(width: 3, height: reduceMotion ? 8 : 4 + 12 * abs(sin(context.date.timeIntervalSinceReferenceDate * 3 + Double(index) * 0.7)))
                }
            }.frame(height: 18)
        }.accessibilityHidden(true)
    }
    private func chip(_ title: String) -> some View {
        HStack(spacing: 6) {
            Circle().fill(opening ? colors.watching : colors.coord).frame(width: 7, height: 7)
            Text(title).font(.system(size: 11.5, weight: .semibold)).lineLimit(1).truncationMode(.tail)
        }.foregroundStyle(colors.secondary).padding(.horizontal, 9).padding(.vertical, 3)
            .background(colors.card, in: Capsule()).overlay(Capsule().stroke(colors.line, lineWidth: 1))
            .frame(maxWidth: 220).help(title).accessibilityLabel("\(opening ? "Destination" : "Thread"): \(title)")
    }
    private func action(_ title: String, primary: Bool, _ perform: @escaping () -> Void) -> some View {
        Button(action: perform) {
            Text(title).font(.system(size: 12, weight: .semibold))
                .foregroundStyle(primary ? colors.primaryText : colors.foreground)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(primary ? colors.watching : colors.card, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(primary ? .clear : colors.line, lineWidth: 1))
        }.buttonStyle(.plain)
    }
}
struct VoiceSettings: View {
    var allowsEndpointEditing = true
    @State private var voice = PushToTalk.shared
    @State private var url = ""
    @State private var code = UInt32(kVK_Space)
    @State private var control = true
    @State private var option = true
    @State private var shift = false
    @State private var command = false
    @State private var liveCode = UInt32(kVK_Space)
    @State private var liveControl = true
    @State private var liveOption = true
    @State private var liveShift = true
    @State private var liveCommand = false
    @State private var avoidBluetooth = true
    @State private var armAtStartup = true
    var body: some View {
        Section("Dictation history") { HistoryControls() }
        Section("Push to talk") {
            if allowsEndpointEditing { TextField("Desk URL", text: $url) }
            Picker("Dictation shortcut", selection: $code) {
                Text("Space").tag(UInt32(kVK_Space))
                Text("D").tag(UInt32(kVK_ANSI_D))
                Text("V").tag(UInt32(kVK_ANSI_V))
                Text("F8").tag(UInt32(kVK_F8))
            }
            HStack { Toggle("Control", isOn: $control); Toggle("Option", isOn: $option); Toggle("Shift", isOn: $shift); Toggle("Command", isOn: $command) }
            Button("Save voice settings") {
                let modifiers = (control ? controlKey : 0) | (option ? optionKey : 0) | (shift ? shiftKey : 0) | (command ? cmdKey : 0)
                voice.save(url: allowsEndpointEditing ? url : voice.deskURL, code: code, modifiers: UInt32(modifiers))
            }.disabled(voice.session.active)
            if let error = voice.settingsError { Text(error).foregroundStyle(.red) }
            if voice.allowsLiveMic {
                Picker("Live mic shortcut", selection: $liveCode) {
                    Text("Space").tag(UInt32(kVK_Space)); Text("D").tag(UInt32(kVK_ANSI_D))
                    Text("V").tag(UInt32(kVK_ANSI_V)); Text("F8").tag(UInt32(kVK_F8))
                }
                HStack { Toggle("Control", isOn: $liveControl); Toggle("Option", isOn: $liveOption); Toggle("Shift", isOn: $liveShift); Toggle("Command", isOn: $liveCommand) }
                Toggle("Arm Live mic when Tango starts", isOn: $armAtStartup)
                Toggle("Don't keep the mic armed on Bluetooth headsets", isOn: $avoidBluetooth)
                Button("Save live mic settings") {
                    let mods = (liveControl ? controlKey : 0) | (liveOption ? optionKey : 0) | (liveShift ? shiftKey : 0) | (liveCommand ? cmdKey : 0)
                    voice.saveLive(code: liveCode, modifiers: UInt32(mods), avoidBluetooth: avoidBluetooth, armAtStartup: armAtStartup)
                }.disabled(voice.session.active || voice.arming)
                Text("Automatically arms with existing microphone permission and recovers after wake, unlock or device changes. Turning Live mic off holds until the next launch. While armed, the orange microphone indicator stays on; muted audio is discarded.").font(.caption)
            }
            Text("Tap to dictate until a pause or second tap. Hold to dictate until release. Sending follows a 3-second undo; Esc cancels.").font(.caption)
        }.onAppear {
            liveCode = voice.liveKeyCode; avoidBluetooth = voice.avoidBluetooth; armAtStartup = voice.armAtStartup
            liveControl = voice.liveModifiers & UInt32(controlKey) != 0; liveOption = voice.liveModifiers & UInt32(optionKey) != 0
            liveShift = voice.liveModifiers & UInt32(shiftKey) != 0; liveCommand = voice.liveModifiers & UInt32(cmdKey) != 0
            url = voice.deskURL; code = voice.keyCode
            control = voice.modifiers & UInt32(controlKey) != 0; option = voice.modifiers & UInt32(optionKey) != 0
            shift = voice.modifiers & UInt32(shiftKey) != 0; command = voice.modifiers & UInt32(cmdKey) != 0
        }
    }
}
