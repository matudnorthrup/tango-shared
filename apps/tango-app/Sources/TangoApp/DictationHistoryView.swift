import SwiftUI
import AppKit
import TangoVoice
import UserNotifications

@MainActor @Observable final class HistoryController {
    static let shared = HistoryController()
    let store: DictationHistory
    let sync: DictationSync
    private let notifications = HistoryNotificationDelegate()
    init() {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        // Bundle-specific storage also isolates separately signed QA app instances.
        store = DictationHistory(directory: root.appendingPathComponent(Bundle.main.bundleIdentifier ?? "Tango").appendingPathComponent("DictationHistory"),
            enabled: UserDefaults.standard.object(forKey: "saveDictationHistory") as? Bool ?? true)
        sync = DictationSync(directory: root.appendingPathComponent(Bundle.main.bundleIdentifier ?? "Tango").appendingPathComponent("DictationSync.noindex"))
        sync.configure(UserDefaults.standard.string(forKey: "historyDeskURL") ?? UserDefaults.standard.string(forKey: "voiceDeskURL") ?? "")
        sync.schedule()
        notifications.history = store
        let center = UNUserNotificationCenter.current()
        center.delegate = notifications
        Task { [store, sync] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
                store.refresh(); sync.sweep(); sync.schedule()
            }
        }
        center.setNotificationCategories([UNNotificationCategory(identifier: "dictation-recovery", actions: [
            UNNotificationAction(identifier: "copy-dictation", title: "Copy text", options: [.foreground])
        ], intentIdentifiers: [])])
    }
    func save(_ entry: DictationEntry) -> Bool {
        let saved = store.save(entry)
        sync.capture(entry); sync.schedule()
        return saved
    }
    func clearLocal() { sync.clearPending(); store.clear() }
    func voiceConnectionSaved(_ address: String) {
        guard UserDefaults.standard.object(forKey: "historyDeskURL") == nil else { return }
        sync.configure(address); sync.schedule()
    }
    func configureSync(_ address: String) {
        sync.configure(address)
        UserDefaults.standard.set(sync.address, forKey: "historyDeskURL")
        sync.schedule()
    }
    func setEnabled(_ enabled: Bool) {
        store.enabled = enabled; UserDefaults.standard.set(enabled, forKey: "saveDictationHistory")
    }
}

private final class HistoryNotificationDelegate: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    @MainActor var history: DictationHistory?
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["historyID"] as? String
        let copy = response.actionIdentifier == "copy-dictation"
        Task { @MainActor in
            history?.refresh()
            if copy, let id {
                let session = PushToTalk.shared.session
                let text = history?.entries.first(where: { $0.id.uuidString == id })?.text
                    ?? (!session.historySaved && session.historyID.uuidString == id ? session.transcript : nil)
                if let text, !text.isEmpty {
                    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
                }
            }
        }
        completionHandler()
    }
}

struct DictationCopyButton: View {
    let text: String
    var label = "Copy"
    @State private var copied = false
    var body: some View {
        Button(copied ? "Copied" : label) {
            NSPasteboard.general.clearContents()
            copied = NSPasteboard.general.setString(text, forType: .string)
        }.task(id: copied) {
            guard copied else { return }
            do { try await Task.sleep(for: .seconds(1.4)); copied = false } catch { }
        }.accessibilityLabel(copied ? "Copied" : "Copy dictation: \(text)")
    }
}

struct RecentDictations: View {
    @State private var history = HistoryController.shared.store
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Recent dictations").font(.headline)
            if history.entries.isEmpty { Text(history.enabled ? "No saved dictations" : "History is off").font(.caption).foregroundStyle(.secondary) }
            ForEach(Array(history.entries.prefix(5))) { entry in
                DictationCopyButton(text: entry.text, label: entry.text.replacingOccurrences(of: "\n", with: " "))
                    .lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
            }
            if let error = history.error { Text(error).font(.caption).foregroundStyle(.orange) }
            Button("Show all history…") { openWindow(id: "dictation-history"); NSApp.activate(ignoringOtherApps: true) }
        }.onAppear { history.refresh() }
    }
}

struct HistoryControls: View {
    @State private var controller = HistoryController.shared
    @State private var confirming = false
    @State private var endpoint = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle("Save dictation history", isOn: Binding(get: { controller.store.enabled }, set: { controller.setEnabled($0) }))
            Text("On this Mac · Last 7 days · Up to 200 entries. Text only, never audio.").font(.caption).foregroundStyle(.secondary)
            Text("Turning history off stops new saves. Clear history removes saved text.").font(.caption).foregroundStyle(.secondary)
            Toggle("Sync new dictations to the desk", isOn: Binding(get: { controller.sync.enabled }, set: { controller.sync.setEnabled($0); controller.sync.schedule() }))
            Text("Independent of local saving. Off cancels pending uploads; text already on the desk stays there. Sync begins after the first secure connection.").font(.caption).foregroundStyle(.secondary)
            HStack {
                TextField("HTTPS desk URL for history", text: $endpoint).textFieldStyle(.roundedBorder)
                Button("Connect history") { controller.configureSync(endpoint) }
            }.onAppear { endpoint = controller.sync.address }
            Button("Clear history…", role: .destructive) { confirming = true }
                .alert("Clear all dictation history on this Mac?", isPresented: $confirming) {
                    Button("Cancel", role: .cancel) { }
                    Button("Clear history", role: .destructive) { controller.clearLocal() }
                } message: { Text("Local text and pending uploads will be removed. Already synced text and messages already sent are unchanged.") }
        }
    }
}

struct DictationHistoryView: View {
    @State private var history = HistoryController.shared.store
    @State private var search = ""
    @State private var sync = HistoryController.shared.sync
    @State private var allDevices = false
    @State private var clearRemote = false
    @Environment(\.colorScheme) private var scheme
    private var colors: VoiceStripColors { VoiceStripColors(dark: scheme == .dark) }
    private var filtered: [DictationEntry] {
        history.entries.filter { search.isEmpty || $0.text.localizedCaseInsensitiveContains(search) || ($0.destination?.localizedCaseInsensitiveContains(search) ?? false) }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Dictation history").font(.title2.bold())
            Picker("History source", selection: $allDevices) {
                Text("Local").tag(false)
                Text("All devices").tag(true)
            }.pickerStyle(.segmented)
            if allDevices {
                HStack {
                    Button("Refresh") { Task { await sync.refresh() } }.disabled(sync.busy)
                    Text("\(sync.pendingCount) pending uploads").font(.caption)
                    if let date = sync.refreshedAt { Text("Updated \(date.formatted(date: .abbreviated, time: .shortened))").font(.caption) }
                }
                if let error = sync.error { Text(error).font(.caption).foregroundStyle(colors.amber) }
                Button("Clear all devices…", role: .destructive) { clearRemote = true }.disabled(sync.busy || !sync.enabled)
                    .alert("Clear desk history for all devices?", isPresented: $clearRemote) {
                        Button("Cancel", role: .cancel) { }
                        Button("Clear all devices", role: .destructive) { Task { await sync.refresh(action: "clear") } }
                    } message: { Text("Removes synced text and rejects old pending uploads when devices reconnect. Independent local history remains on each device until cleared or expired. Clipboard copies are unchanged.") }
            }
            TextField("Search text or conversation", text: $search).textFieldStyle(.roundedBorder)
            if let error = history.error { Text(error).foregroundStyle(colors.amber) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if allDevices {
                        ForEach(sync.entries.filter { search.isEmpty || $0.text.localizedCaseInsensitiveContains(search) || $0.destination.localizedCaseInsensitiveContains(search) }) { entry in
                            VStack(alignment: .leading, spacing: 10) {
                                HStack {
                                    Text(entry.outcome == "unknown" ? "Delivery unknown" : entry.outcome.capitalized).font(.caption.bold())
                                    Text(entry.date.formatted(date: .abbreviated, time: .shortened)).font(.caption)
                                    Spacer()
                                    DictationCopyButton(text: entry.text)
                                    Button("Delete", role: .destructive) { Task { await sync.refresh(action: "delete", id: entry.id) } }.disabled(sync.busy || !sync.enabled)
                                }
                                Text("Device \(String((entry.device ?? "unknown").prefix(8))) · \(entry.destination)").font(.caption).foregroundStyle(colors.secondary)
                                Text(entry.text).textSelection(.enabled)
                            }.padding(.vertical, 18)
                            Divider()
                        }
                        if sync.entries.isEmpty { Text("No synced dictations").foregroundStyle(colors.muted).padding(.vertical, 40) }
                    } else {
                        if filtered.isEmpty { Text(search.isEmpty ? "No saved dictations" : "No matching dictations").foregroundStyle(colors.muted).padding(.vertical, 40) }
                        ForEach(filtered) { entry in
                            VStack(alignment: .leading, spacing: 12) {
                                HStack {
                                    Text(label(entry.outcome)).font(.caption.bold()).foregroundStyle(color(entry.outcome))
                                        .padding(.horizontal, 8).padding(.vertical, 4).background(colors.card, in: RoundedRectangle(cornerRadius: 5))
                                    Text(entry.capturedAt.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(colors.muted)
                                    Spacer()
                                    DictationCopyButton(text: entry.text)
                                }
                                Text((entry.isCommand ? "Voice command · " : "") + (entry.destination ?? "No conversation")).font(.caption).foregroundStyle(colors.secondary)
                                Text(entry.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            }.padding(.vertical, 18)
                            Divider().overlay(colors.line)
                        }
                    }
                }
            }
            Divider()
            HistoryControls()
        }.padding(24).foregroundStyle(colors.foreground).background(colors.panel)
            .frame(minWidth: 620, minHeight: 480)
            .task { while !Task.isCancelled { history.refresh(); sync.sweep(); sync.schedule(); do { try await Task.sleep(for: .seconds(60)) } catch { return } } }
    }
    private func label(_ outcome: DictationEntry.Outcome) -> String {
        switch outcome { case .sent: "Sent"; case .undone: "Undone"; case .failed: "Failed"; case .pending: "Delivery unknown" }
    }
    private func color(_ outcome: DictationEntry.Outcome) -> Color {
        switch outcome { case .sent: colors.ok; case .undone: colors.working; case .failed, .pending: colors.amber }
    }
}
