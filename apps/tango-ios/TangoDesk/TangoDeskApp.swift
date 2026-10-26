import SwiftUI
import TangoDeskKit

@main struct TangoDeskApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = AppModel.shared
    @State private var settings = false
    var body: some Scene {
        WindowGroup {
            Group {
                if let url = model.currentURL, let address = model.address {
                    DeskWebView(url: url, address: address, navigationID: model.navigationID, firstLoad: { Task { await model.refreshAppPaths() } }, openSettings: { settings = true })
                        .accessibilityAction(named: "Open settings") { settings = true }
                } else { SettingsView(firstRun: true) }
            }
            .sheet(isPresented: $settings) { SettingsView(firstRun: false) }
            .onOpenURL { url in
                if let target = model.address?.deepLink(url) { model.navigate(to: target) }
                else if url.scheme == "tango", url.host == "decision" { model.pendingDecision = String(url.path.dropFirst()) }
            }
            .task { await model.permissions(); await model.registerToken(); await model.retry() }
            .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await model.refreshAppPaths(); await model.retry() } } }
        }
    }
}
struct SettingsView: View {
    let firstRun: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var model = AppModel.shared
    @State private var value = AppModel.shared.baseText
    var body: some View {
        NavigationStack {
            Form {
                Section("Your desk") {
                    TextField("https://desk.example", text: $value).textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("Use your desk's secure address with Tailscale connected.").font(.footnote)
                    Button(firstRun ? "Open desk" : "Save") { model.setAddress(value); if model.address != nil && model.error == nil { dismiss() } }
                }
                Section("Notifications") {
                    Button("Enable notifications") { Task { await model.permissions() } }
                    Text("A, B and C match the option labels in each notification. Tap the notification to open the full decision.").font(.footnote)
                }
                if let error = model.error { Section("Needs attention") { Text(error).foregroundStyle(.red) } }
                if !model.queued.isEmpty {
                    Section("Saved answers") {
                        ForEach(model.queued) { entry in
                            VStack(alignment: .leading) {
                                Text(entry.decisionId).bold()
                                Text(entry.failure ?? "Waiting for connection; will retry.")
                                Button("Open decision") { model.open(entry.decisionId); dismiss() }
                            }
                        }
                        Button("Retry waiting answers") { Task { await model.refreshAppPaths(); await model.retry() } }
                    }
                }
            }.navigationTitle(firstRun ? "Welcome to Tango" : "Settings")
        }
    }
}
