import SwiftUI
import WebKit
import AVFAudio
import TangoDeskKit

struct DeskWebView: View {
    let url: URL; let address: DeskAddress
    let navigationID: UUID
    let openSettings: () -> Void
    @State private var failure: String?
    @State private var retry = 0
    @State private var microphoneDenied = false
    var body: some View {
        ZStack {
            WebContainer(url: url, address: address, retry: retry, failure: $failure, microphoneDenied: $microphoneDenied, navigationID: navigationID, openSettings: openSettings)
            if let failure {
                ContentUnavailableView {
                    Label("Desk unreachable", systemImage: "wifi.exclamationmark")
                } description: { Text(failure) } actions: {
                    Button("Retry") { self.failure = nil; retry += 1 }.buttonStyle(.borderedProminent)
                    Button("Open settings", action: openSettings).buttonStyle(.bordered)
                }.background(.background)
            }
        }
        .alert("Microphone access is off", isPresented: $microphoneDenied) {
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Allow microphone access in Settings to use voice replies and dictation.")
        }
    }
}
private struct WebContainer: UIViewRepresentable {
    let url: URL; let address: DeskAddress; let retry: Int
    @Binding var failure: String?
    @Binding var microphoneDenied: Bool
    let navigationID: UUID
    let openSettings: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator; view.uiDelegate = context.coordinator
        let settingsGesture = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.showSettings))
        settingsGesture.numberOfTouchesRequired = 2
        settingsGesture.minimumPressDuration = 1
        settingsGesture.cancelsTouchesInView = false
        view.addGestureRecognizer(settingsGesture)
        view.allowsBackForwardNavigationGestures = true
        view.scrollView.contentInsetAdjustmentBehavior = .automatic
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.refresh), for: .valueChanged)
        view.scrollView.refreshControl = refresh
        context.coordinator.view = view
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.loaded != url || context.coordinator.retry != retry || context.coordinator.navigationID != navigationID {
            context.coordinator.loaded = url; context.coordinator.retry = retry; context.coordinator.navigationID = navigationID
            view.load(URLRequest(url: url))
        }
    }
    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: WebContainer; weak var view: WKWebView?; var loaded: URL?; var retry = -1; var navigationID: UUID?
        var httpFailed = false
        init(_ parent: WebContainer) { self.parent = parent }
        @objc func showSettings(_ gesture: UILongPressGestureRecognizer) {
            if gesture.state == .began { parent.openSettings() }
        }
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
            let frameOrigin = frame.securityOrigin
            guard DeskMediaPermission.allowsMicrophone(
                deskURL: parent.address.base, scheme: origin.protocol, host: origin.host, port: origin.port,
                frameScheme: frameOrigin.protocol, frameHost: frameOrigin.host, framePort: frameOrigin.port,
                microphoneOnly: type == .microphone
            ) else { decisionHandler(.deny); return }
            guard AVAudioApplication.shared.recordPermission != .denied else {
                parent.microphoneDenied = true
                decisionHandler(.deny)
                return
            }
            let requestedAddress = parent.address
            Task { @MainActor in
                let granted = await AVAudioApplication.requestRecordPermission()
                // The configured desk may have changed while the system prompt was open.
                guard parent.address == requestedAddress, let currentURL = webView.url,
                      requestedAddress.contains(currentURL) else {
                    decisionHandler(.deny)
                    return
                }
                if !granted { parent.microphoneDenied = true }
                decisionHandler(granted ? .grant : .deny)
            }
        }
        @objc func refresh() { view?.reload() }
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { httpFailed = false }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if !httpFailed { parent.failure = nil }
            webView.scrollView.refreshControl?.endRefreshing()
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { fail(error) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { fail(error) }
        func fail(_ error: any Error) {
            view?.scrollView.refreshControl?.endRefreshing()
            if (error as NSError).code != NSURLErrorCancelled { parent.failure = error.localizedDescription }
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { parent.failure = "The web view stopped. Retry to reconnect." }
        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
                httpFailed = true
                parent.failure = "The desk returned HTTP \(http.statusCode). Check the address and your Tailscale connection."
            }
            return .allow
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .cancel }
            if parent.address.contains(url) { return .allow }
            if action.targetFrame?.isMainFrame != false, ["https", "http", "mailto", "tel"].contains(url.scheme ?? "") { await UIApplication.shared.open(url) }
            return .cancel
        }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url {
                if parent.address.contains(url) { webView.load(action.request) }
                else if ["https", "http"].contains(url.scheme ?? "") { UIApplication.shared.open(url, options: [:], completionHandler: nil) }
            }
            return nil
        }
    }
}
