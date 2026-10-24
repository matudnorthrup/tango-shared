import SwiftUI
import AppKit
import ServiceManagement
import TangoVoice
import TangoDeskKit

@MainActor @Observable final class ClientStore {
    var endpoint = UserDefaults.standard.string(forKey: "voiceDeskURL") ?? ""
    var connected = false
    var destination = "No conversation open"
    var message = "Connect to existing Tango"
    var checking = false
    var loginEnabled = false
    var loginError: String?
    private let connection = DeskConnection()
    func check(_ input: String, save: Bool = false) async {
        guard !checking else { return }
        checking = true; defer { checking = false }
        do {
            let address = try DeskAddress(input)
            let snapshot = try await connection.validate(input)
            if save {
                let voice = PushToTalk.shared
                guard !voice.session.active, !voice.arming else { throw DeskError.refused("Finish dictation before changing the desk.") }
                voice.save(url: address.base.absoluteString, code: voice.keyCode, modifiers: voice.modifiers)
                if let error = voice.settingsError { throw DeskError.refused(error) }
                endpoint = address.base.absoluteString
            }
            connected = true; destination = snapshot.destination
            message = "Desk connected · voice metadata available"
        } catch {
            connected = false; destination = "Unavailable"
            message = error.localizedDescription
        }
    }
    func refresh() async {
        guard !endpoint.isEmpty else { return }
        await check(endpoint)
    }
    func setLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            loginEnabled = SMAppService.mainApp.status == .enabled
            loginError = SMAppService.mainApp.status == .requiresApproval ? "Allow Tango in System Settings → Login Items." : nil
        } catch { loginError = error.localizedDescription }
    }
    func openDesk() {
        guard let address = try? DeskAddress(endpoint) else { return }
        NSWorkspace.shared.open(address.base)
    }
}

struct ClientSettings: View {
    @Bindable var store: ClientStore
    @State private var input = ""
    var body: some View {
        Form {
            Section("Connect to existing Tango") {
                Text("This Mac is a voice client. Tango runs on your other Mac.")
                TextField("Full desk base URL", text: $input, prompt: Text("https://your-host.example.ts.net/tango-screen"))
                Text("Connect Tailscale first. Include the /tango-screen prefix.").font(.caption)
                Button(store.checking ? "Checking…" : "Check and save desk") { Task { await store.check(input, save: true) } }.disabled(store.checking)
                Text(store.message).foregroundStyle(store.connected ? Color.primary : Color.orange)
                Text("Destination: \(store.destination)")
                Text("Uses the conversation open on the shared desk. The destination is frozen when dictation starts.").font(.caption)
                Button("Open remote desk") { store.openDesk() }.disabled(store.endpoint.isEmpty)
            }
            VoiceSettings(allowsEndpointEditing: false)
            Section("App") {
                Toggle("Open Tango at login", isOn: Binding(get: { store.loginEnabled }, set: { store.setLogin($0) }))
                Text("Starts this GUI client only.").font(.caption)
                if let error = store.loginError { Text(error).foregroundStyle(.orange) }
            }
        }.formStyle(.grouped)
        .onAppear { input = store.endpoint; store.loginEnabled = SMAppService.mainApp.status == .enabled }
        .task { await store.refresh() }
    }
}
struct ClientMenu: View {
    @Bindable var store: ClientStore
    @State private var voice = PushToTalk.shared
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Tango client").bold()
            Text(store.message).font(.caption)
            Text("Destination: \(voice.session.active ? (voice.session.target?.title ?? store.destination) : store.destination)")
            Text(store.endpoint.isEmpty ? "No desk configured" : store.endpoint).font(.caption).textSelection(.enabled)
            Text(voice.session.active ? voice.session.message : (voice.live.armed ? "Live mic armed" : "Microphone off")).font(.caption)
            Text("Live mic is unavailable until remote validation is complete.").font(.caption)
            if let error = voice.settingsError { Text(error).foregroundStyle(.orange).font(.caption) }
            Button("Refresh connection") { Task { await store.refresh() } }.disabled(store.checking)
            Divider()
            RecentDictations()
            Divider()
            Button("Voice and connection settings") { openWindow(id: "tango"); NSApp.activate(ignoringOtherApps: true) }
            Button("Open remote desk") { store.openDesk() }.disabled(store.endpoint.isEmpty)
            Button("Quit Tango") { NSApp.terminate(nil) }
        }.padding().frame(width: 360).task { await store.refresh() }
    }
}
