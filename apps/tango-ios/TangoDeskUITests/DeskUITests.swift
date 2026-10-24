import XCTest

final class DeskUITests: XCTestCase {
    @MainActor func testMicrophonePermissionPrompt() {
        let app = XCUIApplication()
        app.resetAuthorizationStatus(for: .microphone)
        app.launchArguments = ["-deskURL", "http://127.0.0.1:9461"]
        app.launch()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 5) { allow.tap() }
        let voice = app.webViews.buttons["Start voice command"]
        XCTAssertTrue(voice.waitForExistence(timeout: 30), app.debugDescription)
        voice.tap()
        let microphone = springboard.alerts.firstMatch
        XCTAssertTrue(microphone.waitForExistence(timeout: 15), springboard.debugDescription)
        XCTAssertTrue(microphone.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "microphone")).firstMatch.exists)
        attach("microphone-system-prompt")
        microphone.buttons["Don’t Allow"].tap()
        XCTAssertTrue(app.alerts["Microphone access is off"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.alerts.buttons["Open Settings"].exists)
        attach("microphone-denied-settings")
        app.alerts.buttons["Cancel"].tap()
        app.terminate()
        app.launch()
        XCTAssertTrue(voice.waitForExistence(timeout: 20))
        voice.tap()
        XCTAssertTrue(app.alerts["Microphone access is off"].waitForExistence(timeout: 10))
        app.alerts.buttons["Open Settings"].tap()
        XCTAssertTrue(XCUIApplication(bundleIdentifier: "com.apple.Preferences").wait(for: .runningForeground, timeout: 10))
    }

    @MainActor func testNotificationAnswerAndStaleFailure() async throws {
        let app = XCUIApplication()
        app.launchArguments = ["-deskURL", "http://127.0.0.1:9461", "-deviceToken", String(repeating: "ab", count: 32)]
        app.launch()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 5) { allow.tap() }
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 20))
        attach("web-view")
        XCUIDevice.shared.press(.home)
        _ = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:9464/push")!)
        let alert = springboard.staticTexts["Layout choice"]
        XCTAssertTrue(alert.waitForExistence(timeout: 15), springboard.debugDescription)
        alert.press(forDuration: 1.5)
        XCTAssertTrue(springboard.buttons["A"].waitForExistence(timeout: 5), springboard.debugDescription)
        attach("notification-actions")
        springboard.buttons["Snooze 1 hour"].tap()
        var snoozed = false
        for _ in 0..<20 {
            let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:9464/item")!)
            let row = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            if row["disposition"] as? String == "snoozed", let until = row["snoozeUntil"] as? Double {
                let remaining = until / 1000 - Date().timeIntervalSince1970
                XCTAssertGreaterThan(remaining, 3550)
                XCTAssertLessThanOrEqual(remaining, 3600)
                snoozed = true
                break
            }
            try await Task.sleep(for: .milliseconds(200))
        }
        XCTAssertTrue(snoozed, "Notification must snooze the sandbox item for one hour")
        app.activate()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        app.webViews.buttons["Later"].tap()
        XCTAssertTrue(app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Sandbox README tidy")).firstMatch.waitForExistence(timeout: 10))
        attach("snoozed-decision")
        app.webViews.buttons["Active"].tap()
        XCUIDevice.shared.press(.home)
        _ = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:9464/push")!)
        XCTAssertTrue(alert.waitForExistence(timeout: 15))
        alert.press(forDuration: 1.5)
        XCTAssertTrue(springboard.buttons["A"].waitForExistence(timeout: 5))
        springboard.buttons["A"].tap()
        var answered = false
        for _ in 0..<20 {
            let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:9464/answered")!)
            if String(decoding: data, as: UTF8.self).contains("\"status\": \"answered\"") { answered = true; break }
            try await Task.sleep(for: .milliseconds(200))
        }
        XCTAssertTrue(answered, "Notification action must answer the sandbox brief before testing a stale tap")
        // The same old revision is injected after the answer: the server must refuse it.
        _ = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:9464/push")!)
        XCTAssertTrue(alert.waitForExistence(timeout: 15))
        alert.press(forDuration: 1.5)
        XCTAssertTrue(springboard.buttons["B"].waitForExistence(timeout: 5))
        springboard.buttons["B"].tap()
        let failure = springboard.staticTexts["Answer didn't go through"]
        XCTAssertTrue(failure.waitForExistence(timeout: 20), springboard.debugDescription)
        failure.press(forDuration: 1.5)
        attach("failure-notification")
        springboard.buttons["Open"].tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.webViews.staticTexts["Answered"].firstMatch.waitForExistence(timeout: 10))
        attach("opened-decision")
        let close = app.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Close")).firstMatch
        close.tap()
        XCTAssertFalse(app.webViews.staticTexts["Answered"].firstMatch.exists)
        XCUIDevice.shared.press(.home)
        _ = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:9464/push")!)
        XCTAssertTrue(alert.waitForExistence(timeout: 15))
        alert.tap()
        XCTAssertTrue(app.webViews.staticTexts["Answered"].firstMatch.waitForExistence(timeout: 15))
        attach("reopened-decision")
        for _ in 0..<2 {
            close.tap()
            XCTAssertFalse(app.webViews.staticTexts["Answered"].firstMatch.exists)
            _ = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:9464/open")!)
            let confirm = springboard.buttons["Open"]
            if confirm.waitForExistence(timeout: 3) { confirm.tap() }
            XCTAssertTrue(app.webViews.staticTexts["Answered"].firstMatch.waitForExistence(timeout: 15))
        }
        attach("reopened-deep-link")
        _ = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:9464/done")!)
        XCUIDevice.shared.press(.home)
        _ = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:9464/push")!)
        XCTAssertTrue(alert.waitForExistence(timeout: 15))
        alert.press(forDuration: 1.5)
        springboard.buttons["Snooze 1 hour"].tap()
        try await Task.sleep(for: .seconds(3))
        let (doneData, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:9464/item")!)
        let doneRow = try XCTUnwrap(JSONSerialization.jsonObject(with: doneData) as? [String: Any])
        XCTAssertEqual(doneRow["disposition"] as? String, "done")
        XCTAssertFalse(failure.exists, "Stale Snooze must not show a failure alert")
        for (route, explicitOpen) in [("foreign-push", false), ("foreign-push", true), ("foreign-failure", false)] {
            app.terminate()
            app.launch()
            XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 20))
            XCTAssertFalse(app.webViews.staticTexts["Answered"].firstMatch.exists, "Start each foreign tap on the desk without a decision open")
            XCUIDevice.shared.press(.home)
            _ = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:9464/\(route)")!)
            XCTAssertTrue(alert.waitForExistence(timeout: 15))
            if explicitOpen {
                alert.press(forDuration: 1.5)
                springboard.buttons["Open"].tap()
            } else { alert.tap() }
            let mismatch = springboard.staticTexts["Notification belongs to another desk"]
            XCTAssertTrue(mismatch.waitForExistence(timeout: 10))
            attach("foreign-desk-notification")
            mismatch.tap()
            XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
            XCTAssertFalse(app.webViews.staticTexts["Answered"].firstMatch.exists, "Foreign notification and its local explanation must not navigate")
        }
    }
    @MainActor func testHTTPFailureAndRetryRecovery() async throws {
        let app = XCUIApplication()
        app.launchArguments = ["-deskURL", "http://127.0.0.1:9464"]
        for status in [403, 500] {
            _ = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:9464/http-status/\(status)")!)
            app.launch()
            XCTAssertTrue(app.staticTexts["Desk unreachable"].waitForExistence(timeout: 20))
            // Let WebKit finish handling the response: the overlay must remain.
            try await Task.sleep(for: .seconds(2))
            XCTAssertTrue(app.staticTexts["Desk unreachable"].exists)
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "HTTP \(status)")).firstMatch.exists)
            attach("http-\(status)-retry")
            _ = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:9464/http-status/200")!)
            app.buttons["Retry"].tap()
            XCTAssertTrue(app.webViews.staticTexts["Recovered desk"].waitForExistence(timeout: 20))
            XCTAssertFalse(app.staticTexts["Desk unreachable"].exists)
            app.terminate()
        }
    }
    @MainActor func testOfflineRetry() {
        let app = XCUIApplication()
        app.launchArguments = ["-deskURL", "http://127.0.0.1:9469"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Desk unreachable"].waitForExistence(timeout: 20))
        app.buttons["Retry"].tap()
        XCTAssertTrue(app.staticTexts["Desk unreachable"].waitForExistence(timeout: 20))
        attach("offline-retry")
        app.buttons["Open settings"].tap()
        let address = app.textFields["https://desk.example"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap()
        let current = address.value as? String ?? ""
        address.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count) + "http://127.0.0.1:9464")
        app.buttons["Save"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Recovered desk"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["Desk unreachable"].exists)
        attach("settings-recovery")
    }
    @MainActor private func attach(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
