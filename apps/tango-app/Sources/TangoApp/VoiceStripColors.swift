import SwiftUI

/// Corresponds to the dark and light tokens in apps/screen/public/desk.css.
struct VoiceStripColors {
    let dark: Bool
    private func color(_ darkValue: UInt32, _ lightValue: UInt32) -> Color {
        let hex = dark ? darkValue : lightValue
        return Color(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
    }
    var panel: Color { color(0x11141b, 0xffffff) }
    var line: Color { color(0x262c38, 0xdfe3ea) }
    var card: Color { color(0x1d2230, 0xf0f2f6) }
    var foreground: Color { color(0xeef0f4, 0x141821) }
    var secondary: Color { color(0xc9ced8, 0x2f3644) }
    var muted: Color { color(0x8d96a6, 0x5d6676) }
    var working: Color { color(0xa78bfa, 0x7c3aed) }
    var watching: Color { color(0x60a5fa, 0x2563eb) }
    var amber: Color { color(0xf5a524, 0xc77f00) }
    var ok: Color { color(0x3ecf8e, 0x17a36a) }
    var coord: Color { color(0x2dd4bf, 0x0d9488) }
    var primaryText: Color { color(0x0b0d12, 0xffffff) }
}
