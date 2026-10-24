# Tango for iPhone

A SwiftUI shell around the web desk, with decision notification actions. Requires Xcode 27,
an iOS 26 simulator/device, and Swift 6.2 or later. No package downloads or XcodeGen are needed.

```sh
cp apps/tango-ios/Config/Local.example.xcconfig apps/tango-ios/Config/Local.xcconfig
# Set your desk URL, existing development team, bundle identifier, and TANGO_APS_ENTITLEMENT locally (development or production).
xcodebuild -project apps/tango-ios/TangoDesk.xcodeproj -scheme TangoDesk \
  -sdk iphonesimulator -configuration Debug \
  -derivedDataPath apps/tango-ios/DerivedData CODE_SIGNING_ALLOWED=NO build
swift test --package-path apps/tango-ios/TangoDeskKit
```

Open the committed project in Xcode to select a phone and run. Enable Push Notifications for
the app identifier in your existing Apple developer membership; use development signing for
sandbox APNs, distribution signing for production. Set TANGO_APS_ENTITLEMENT to development
or production to match provisioning; registration maps development to sandbox. Do not commit signing identities or keys.
On the phone, connect Tailscale, set the desk base URL, and allow notifications. Settings is
a two-finger long press anywhere on the desk (or the Open settings accessibility action).
Pending/rejected answers remain visible in Settings.

Voice requests microphone access on first use. Only microphone capture from the configured
desk origin (including its scheme and effective port) is allowed; a foreign frame or any camera
request is denied. If system microphone access is off, the app offers to open iOS Settings.
Inline voice playback is enabled. The app icon is compiled from the single universal iOS
image in `TangoDesk/Assets.xcassets/AppIcon.appiconset`.

To check microphone permission on the sandbox desk at port 9461, reset microphone access with
`xcrun simctl privacy <UDID> reset microphone org.example.TangoDesk`, then run the UI test
`-only-testing:TangoDeskUITests/DeskUITests/testMicrophonePermissionPrompt`. It captures the
system prompt and checks the Settings affordance after denying access.

For Simulator, install the built `.app` with `xcrun simctl install <UDID> <app-path>` and launch
`xcrun simctl launch <UDID> org.example.TangoDesk`. The placeholder identifier works unsigned
in Simulator; a real device needs the local identifier and provisioning profile.

## Sandbox notification UI test

Use a disposable simulator. No live desk, Apple key, or real APNs connection is involved.
Start `SCREEN_PORT=9461 npm run desk:test -w @tango/screen`, then run
`python3 apps/tango-ios/scripts/simulator-push.py <UDID> <sandbox-loom-directory>` using the
temporary Loom directory printed by that test desk. The helper only accepts its `/tmp/loom-desk-*`
directory, seeds an invented decision, and serves loopback port 9464. It injects payloads with
`xcrun simctl push`. The UI test opens the app, accepts notifications, taps Snooze and verifies a one-hour
deadline, then taps A and checks the decision was answered, taps a stale B, and captures the failure notification. It closes and reopens
the same decision through a notification and repeated deep links. It also checks that HTTP 403
and 500 errors keep the native Retry screen visible and that Retry recovers after HTTP 200.
The offline screen exposes Open settings to repair an unreachable address. A stale notification
Snooze leaves a done item unchanged; its informational refusal stays in Settings without an alert. Use the placeholder bundle
identifier and leave Local.xcconfig out of this test. Foreign-desk default taps, Open actions, and
local failure notices must show an explanation without navigating. Simulator notifications are
silent so validation does not play chimes through the host Mac; device notifications retain sound.

```sh
xcodebuild -project apps/tango-ios/TangoDesk.xcodeproj -scheme TangoDesk \
  -destination 'platform=iOS Simulator,id=<UDID>' \
  -derivedDataPath apps/tango-ios/DerivedData CODE_SIGNING_ALLOWED=NO ARCHS=arm64 \
  -resultBundlePath /tmp/tango-ios-ui.xcresult test
xcrun xcresulttool export attachments --path /tmp/tango-ios-ui.xcresult --output-path <evidence-dir>
```

Use your session's managed resource launcher for the two foreground test servers. Stop them
and shut down the disposable simulator afterward. For a repeat run, restart the helper to seed
a fresh decision. Full architecture and APNs setup: [iOS app spec](../../docs/specs/ios-app.md).
