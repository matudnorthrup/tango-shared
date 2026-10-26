import XCTest
import Carbon
@testable import TangoKit

final class LiveMicPresentationTests: XCTestCase {
    func testClientExplainsGateWithConfiguredShortcut() {
        let message = LiveMicPresentation.unavailableMessage(
            allowsLiveMic: AppStartup.allowsLiveMic(mode: .client),
            keyCode: UInt32(kVK_ANSI_V), modifiers: UInt32(cmdKey | shiftKey))
        XCTAssertEqual(message, "Live mic isn't available in the laptop build yet. Push to talk works: Shift + Command + V.")
    }

    func testHostDoesNotShowUnavailableGuidance() {
        XCTAssertNil(LiveMicPresentation.unavailableMessage(
            allowsLiveMic: AppStartup.allowsLiveMic(mode: .host),
            keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | optionKey)))
    }

    func testAllConfigurableKeysAndModifierCombinations() {
        for (key, label) in [(kVK_Space, "Space"), (kVK_ANSI_D, "D"), (kVK_ANSI_V, "V"), (kVK_F8, "F8")] {
            XCTAssertEqual(LiveMicPresentation.shortcut(keyCode: UInt32(key), modifiers: 0), label)
            XCTAssertEqual(LiveMicPresentation.shortcut(keyCode: UInt32(key), modifiers: UInt32(controlKey | optionKey | shiftKey | cmdKey)),
                           "Control + Option + Shift + Command + " + label)
        }
        XCTAssertEqual(LiveMicPresentation.shortcut(keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | optionKey)), "Control + Option + Space")
    }
}
