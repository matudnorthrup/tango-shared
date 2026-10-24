import SwiftUI
import AppKit
import ServiceManagement
import TangoKit

@MainActor @Observable final class Store {
    init() { Task { await poll() } }
    var services: [Service] = []
    var health: Health?
    var maintenance: Maintenance?
    var releases: Releases?
    var resources: Resources?
    var connectionError: String?
    var actionError: String?
    var windowVisible = false
    var menuVisible = false
    var refreshing = false
    var busy = false
    var serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? "http://127.0.0.1:9440"
    var tokenPath = UserDefaults.standard.string(forKey: "tokenPath") ?? "~/.tango/server/token"
    var client: APIClient { APIClient(baseURL: serverURL, tokenPath: tokenPath) }
    var status: OverallStatus { .evaluate(reachable: connectionError == nil && health != nil, healthOK: health?.ok == true, services: services) }
    var color: Color { switch status { case .healthy: .green; case .degraded: .orange; case .unreachable: .red } }
    /// A new endpoint starts clean: nothing from the old server (above all its releases and rollback) may act on the new one.
    func save(serverURL url: String, tokenPath path: String) {
        serverURL = url; tokenPath = path
        UserDefaults.standard.set(url, forKey: "serverURL"); UserDefaults.standard.set(path, forKey: "tokenPath")
        health = nil; services = []; maintenance = nil; releases = nil; resources = nil; connectionError = nil; actionError = nil
        Task { await refresh() }
    }
    func refresh() async {
        guard !refreshing else { return }; refreshing = true; defer { refreshing = false }
        let api = client
        do {
            let h: Health = try await api.request("health")
            let s: Services = try await api.request("services")
            health = h; services = s.services; connectionError = nil
        } catch { connectionError = error.localizedDescription; return }
        do { maintenance = try await api.request("maintenance") } catch { maintenance = nil; actionError = error.localizedDescription }
        do { releases = try await api.request("releases") } catch { releases = nil; actionError = error.localizedDescription }
        do { resources = try await api.request("resources") } catch { actionError = error.localizedDescription }
    }
    func act(_ path: String, body: Data? = nil) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do { let result: ActionResult = try await client.request(path, method: "POST", body: body); actionError = result.ok ? nil : "The server did not complete the action."; await refresh() }
        catch { actionError = error.localizedDescription }
    }
    func setMaintenance(_ on: Bool, reason: String = "") async {
        let body = try? JSONSerialization.data(withJSONObject: ["on": on, "reason": reason] as [String: Any])
        await act("maintenance", body: body)
    }
    func poll() async {
        await refresh()
        var elapsed = 0.0
        while !Task.isCancelled {
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
            elapsed += 1
            if elapsed >= Polling.interval(windowVisible: windowVisible, menuVisible: menuVisible) { await refresh(); elapsed = 0 }
        }
    }
}

/// The app's own login item (com.tango.server) must never run beside the external com.tango.tango-server agent.
enum OwnLoginItem {
    static var service: SMAppService { .agent(plistName: "com.tango.server.plist") }
    static var registered: Bool { service.status == .enabled || service.status == .requiresApproval }
    /// Retire the obsolete registration once; subsequent launches are no-ops.
    @discardableResult static func retireIfNeeded() -> Bool {
        do { return try LegacyLoginRetirement.retire(registered: { registered }, unregister: { try service.unregister() }) }
        catch { return false }
    }
}

@main struct TangoApp: App {
    @State private var store: Store?
    @State private var client: ClientStore?
    @State private var voice = PushToTalk.shared
    init() {
        // Retention must run even when no menu, window, or dictation is opened.
        _ = HistoryController.shared
        let mode = AppStartup.mode(defaults: .standard, clientOnly: Bundle.main.object(forInfoDictionaryKey: "TangoClientOnly") as? Bool == true)
        let host = AppStartup.host(mode: mode, retire: { OwnLoginItem.retireIfNeeded() }, make: { Store() })
        _store = State(initialValue: host)
        _client = State(initialValue: mode == .client ? ClientStore() : nil)
        if CommandLine.arguments.contains("--retire-login-item") {
            if mode == .host { print(OwnLoginItem.registered ? "com.tango.server: still registered" : "com.tango.server: not registered") }
            else { print("Client mode: no server login item operation") }
            exit(0)
        }
    }
    var body: some Scene {
        Window("Tango", id: "tango") {
            if let store { MainView(store: store).frame(minWidth: 1000, minHeight: 650) }
            else if let client { ClientSettings(store: client).frame(minWidth: 620, minHeight: 500) }
        }.defaultSize(width: store == nil ? 700 : 1150, height: store == nil ? 650 : 760)
        Window("Dictation history", id: "dictation-history") { DictationHistoryView() }.defaultSize(width: 760, height: 700)
        MenuBarExtra {
            if let store { MenuPanel(store: store) }
            else if let client { ClientMenu(store: client) }
        } label: {
            Image(systemName: voice.session.state == .listening ? "mic.fill" : (voice.live.armed ? "mic.slash" : "circle.fill"))
                .foregroundStyle(store?.color ?? (client?.connected == true ? Color.green : Color.orange))
                .accessibilityLabel(store.map { "Tango: \(String(describing: $0.status))" } ?? "Tango client")
        }.menuBarExtraStyle(.window)
    }
}

struct MaintenanceControl: View {
    @Bindable var store: Store
    @State private var confirming = false
    @State private var reason = ""
    var body: some View {
        Toggle("Maintenance", isOn: Binding(get: { store.maintenance?.on == true }, set: { on in
            if on { confirming = true } else { Task { await store.setMaintenance(false) } }
        })).disabled(store.maintenance == nil || store.busy)
        if let m = store.maintenance, m.on {
            Text("\(m.running) turns finishing, \(m.queued) waiting").font(.caption)
            if let reason = m.reason, !reason.isEmpty { Text(reason).font(.caption).foregroundStyle(.secondary) }
        }
        Color.clear.frame(height: 0).alert("Turn on maintenance?", isPresented: $confirming) {
            TextField("Reason (optional)", text: $reason)
            Button("Cancel", role: .cancel) { reason = "" }
            Button("Turn on") { let value = reason; reason = ""; Task { await store.setMaintenance(true, reason: value) } }
        } message: { Text("Current turns will finish. New turns will wait.") }
    }
}
struct MenuPanel: View {
    @State private var voice = PushToTalk.shared
    @Bindable var store: Store
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Tango", systemImage: "circle.fill").foregroundStyle(store.color)
            if let error = store.connectionError { Text("Server unreachable").bold(); Text(error).font(.caption).textSelection(.enabled) }
            ForEach(["running", "starting", "stopped", "failing", "down", "unknown"], id: \.self) { state in
                Text("\(store.services.filter { $0.state == state }.count) \(state)")
            }
            Toggle("Live mic", isOn: Binding(get: { voice.live.armed || voice.arming }, set: { _ in voice.toggleLive() }))
            if voice.live.armed { Text(voice.live.keepMicrophone ? "Armed · muted until you dictate" : "Armed · Bluetooth mic opens on dictation").font(.caption) }
            MaintenanceControl(store: store)
            if let error = store.actionError { Text(error).font(.caption).foregroundStyle(.red); Button("Dismiss error") { store.actionError = nil } }
            Divider()
            RecentDictations()
            Divider()
            Button("Open Tango") { openWindow(id: "tango"); NSApp.activate(ignoringOtherApps: true) }
            Button("Quit Tango.app — agents keep running") { NSApp.terminate(nil) }
        }.padding().frame(width: 330)
            .background(WindowVisibility { store.menuVisible = $0 })
            .onAppear { Task { await store.refresh() } }
    }
}
private struct WindowVisibility: NSViewRepresentable {
    let update: (Bool) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(update: update) }
    func makeNSView(context: Context) -> NSView { let view = NSView(); context.coordinator.view = view; context.coordinator.start(); return view }
    func updateNSView(_ nsView: NSView, context: Context) {}
    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) { coordinator.stop() }
    @MainActor final class Coordinator {
        weak var view: NSView?
        let update: (Bool) -> Void
        var timer: Timer?
        init(update: @escaping (Bool) -> Void) { self.update = update }
        func start() { timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { guard let self else { return }; self.update(self.view?.window.map { $0.isVisible && !$0.isMiniaturized && NSApp.isHidden == false } ?? false) }
        } }
        func stop() { timer?.invalidate(); update(false) }
    }
}
struct MainView: View {
    @Bindable var store: Store
    @State private var page: String? = "Services"
    var body: some View {
        NavigationSplitView {
            List(["Services", "Releases", "Resources", "Settings"], id: \.self, selection: $page) { Text($0) }
            .navigationTitle("Tango")
        } detail: {
            VStack(alignment: .leading) {
                if let error = store.actionError {
                    HStack { Text(error).foregroundStyle(.red).textSelection(.enabled); Spacer(); Button("Dismiss") { store.actionError = nil } }.padding()
                }
                if page == "Settings" { SettingsView(store: store) }
                else if let error = store.connectionError {
                    ContentUnavailableView { Label("Tango Server unreachable", systemImage: "network.slash") } description: { Text(error) } actions: { Button("Retry") { Task { await store.refresh() } }; Button("Settings") { page = "Settings" } }
                } else {
                    switch page {
                    case "Releases": ReleasesView(store: store)
                    case "Resources": ResourcesView(store: store)
                    default: ServicesView(store: store)
                    }
                }
            }.navigationTitle(page ?? "Tango")
        }
        .background(WindowVisibility { store.windowVisible = $0 })
        .onAppear { Task { await store.refresh() } }
    }
}
struct ServicesView: View {
    @Bindable var store: Store
    @State private var selected: String?
    var body: some View {
        VStack(alignment: .leading) {
            MaintenanceControl(store: store).padding(.horizontal)
            Table(of: Service.self, selection: $selected) {
                TableColumn("Service") { (s: Service) in VStack(alignment: .leading) { Text(s.name); Text(s.group).font(.caption).foregroundStyle(.secondary) } }
                TableColumn("State", value: \.state)
                TableColumn("Health") { s in Text(s.health.detail ?? (s.health.ok ? "Healthy" : "Unhealthy")) }
                TableColumn("PID") { s in Text(s.pid.map(String.init) ?? "—") }
                TableColumn("Memory") { s in Text(s.memoryBytes.map(bytes) ?? "—") }
                TableColumn("CPU") { s in Text(s.cpuPct.map { String(format: "%.1f%%", $0) } ?? "—") }
                TableColumn("Restarts") { s in Text("\(s.restarts)") }
                TableColumn("Controls") { s in
                    VStack {
                        if s.mode != "managed" { Text("observed").font(.caption) }
                        HStack {
                            ForEach(["start", "stop", "restart"], id: \.self) { action in
                                Button(action.capitalized) { Task { await store.act(APIClient.servicePath(s.id) + "/" + action) } }
                            }
                        }.disabled(s.mode != "managed" || store.busy)
                        .help(s.mode != "managed" ? "Observed services are controlled outside Tango." : "Control this service")
                    }
                }.width(min: 220)
            } rows: {
                ForEach(Dictionary(grouping: store.services, by: \.group).keys.sorted(), id: \.self) { group in
                    Section(group) { ForEach(store.services.filter { $0.group == group }.sorted { $0.name < $1.name }) { TableRow($0) } }
                }
            }
            if let selected { LogView(client: store.client, serviceID: selected).id(selected + store.serverURL + store.tokenPath).frame(height: 220) }
        }.padding(.vertical)
    }
}
func bytes(_ value: Double) -> String { ByteCountFormatter.string(fromByteCount: Int64(min(max(value, 0), Double(Int64.max - 1024))), countStyle: .memory) }
struct LogView: View {
    let client: APIClient
    let serviceID: String
    @State private var lines: [String] = []
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading) {
            Text("Logs · \(serviceID)").font(.headline)
            if let error { Text(error).foregroundStyle(.red) }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading) {
                        Text(lines.joined(separator: "\n")).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        Color.clear.frame(height: 1).id("tail")
                    }
                }.onChange(of: lines) { proxy.scrollTo("tail", anchor: .bottom) }
            }
        }.padding().task {
            while !Task.isCancelled {
                do { let logs: Logs = try await client.request(APIClient.servicePath(serviceID) + "/logs?lines=200"); lines = logs.lines; error = nil }
                catch { self.error = error.localizedDescription }
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
    }
}
struct ReleasesView: View {
    @Bindable var store: Store
    @State private var confirm = false
    var body: some View {
        VStack(alignment: .leading) {
            Button("Rollback to previous release…") { confirm = true }.disabled(store.releases?.previous == nil || store.busy)
            List(store.releases?.releases ?? []) { r in
                HStack { Text(r.id).bold(); if r.id == store.releases?.current { Text("Current").foregroundStyle(.green) }; if r.id == store.releases?.previous { Text("Previous") }; Spacer(); Text(r.status); Text(bytes(r.bytes)); Text(r.buildTime) }
            }
        }.padding().confirmationDialog("Rollback to \(store.releases?.previous ?? "previous release")?", isPresented: $confirm) {
            Button("Rollback", role: .destructive) { Task { await store.act("releases/rollback") } }
        } message: { Text("The server will activate the previous release.") }
    }
}
struct ResourcesView: View {
    @Bindable var store: Store
    var body: some View {
        if let r = store.resources {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(String(format: "Memory free: %.1f%%", r.memory.freePct)).font(.title2)
                    ForEach(Array(r.memory.agents.enumerated()), id: \.offset) { _, agent in
                        VStack(alignment: .leading) {
                            Text("\(agent.name) · \(bytes(agent.bytes)) · \(agent.processes) processes")
                            Text(agent.threadId).font(.caption).foregroundStyle(.secondary)
                            ProgressView(value: max(0, min(agent.bytes, r.memory.totalBytes)), total: max(1, r.memory.totalBytes))
                        }
                    }
                    Text("Disk free: \(bytes(r.disk.freeBytes)) of \(bytes(r.disk.totalBytes))")
                    Text("Warm: \(r.warm.map(String.init) ?? "—") · Cooled: \(r.cooled.map(String.init) ?? "—")")
                }.padding()
            }
        } else { ContentUnavailableView("Resources unavailable", systemImage: "memorychip") }
    }
}
struct SettingsView: View {
    @Bindable var store: Store
    @State private var status: LaunchAgentState = .off
    @State private var loginBusy = false
    @State private var login = LaunchAgent()
    @State private var error: String?
    @State private var registrationError: String?
    // Edits stay drafts until Save: polling must never use (or send the token to) a half-typed address.
    @State private var draftURL = ""
    @State private var draftTokenPath = ""
    private func setLoginEnabled(_ enabled: Bool) {
        loginBusy = true
        Task {
            do {
                if enabled {
                    OwnLoginItem.retireIfNeeded()
                    guard !OwnLoginItem.registered else { throw LaunchAgentError(message: "Cannot retire the old login item. Try again before starting the server.") }
                }
                status = try await login.setEnabled(enabled)
                error = nil
            } catch {
                self.error = error.localizedDescription
                if let actual = try? await login.state() { status = actual }
            }
            loginBusy = false
        }
    }
    private func refreshLogin() async {
        do { status = try await login.state(); registrationError = nil }
        catch { registrationError = error.localizedDescription }
    }
    var body: some View {
        Form {
            VoiceSettings()
            TextField("Server URL", text: $draftURL)
            TextField("Token path", text: $draftTokenPath)
            Button("Save and reconnect") { store.save(serverURL: draftURL, tokenPath: draftTokenPath) }
                .disabled(draftURL == store.serverURL && draftTokenPath == store.tokenPath)
            Toggle("Start Tango Server at login", isOn: Binding(get: { status.loaded }, set: setLoginEnabled)).disabled(loginBusy)
            if let warning = status.warning {
                Text(warning).foregroundStyle(.orange)
                Button("Repair login configuration") { setLoginEnabled(true) }.disabled(loginBusy)
            }
            Text("Server: \(status.description)")
            Button("Refresh registration status") { Task { await refreshLogin() } }.disabled(loginBusy)
            if let error { Text(error).foregroundStyle(.red) }
            if let registrationError { Text(registrationError).foregroundStyle(.red) }
            Text("Quitting Tango.app never stops the server, agents, or services.").foregroundStyle(.secondary)
        }.padding().onAppear { draftURL = store.serverURL; draftTokenPath = store.tokenPath }
        .task {
            while !Task.isCancelled {
                if !loginBusy { await refreshLogin() }
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }
}
