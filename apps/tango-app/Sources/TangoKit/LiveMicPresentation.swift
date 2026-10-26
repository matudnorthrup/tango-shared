import Carbon

/// Shared menu guidance, derived from the same capability gate as capture.
public enum LiveMicPresentation {
    public static func unavailableMessage(allowsLiveMic: Bool, keyCode: UInt32, modifiers: UInt32) -> String? {
        guard !allowsLiveMic else { return nil }
        return "Live mic isn't available in the laptop build yet. Push to talk works: \(shortcut(keyCode: keyCode, modifiers: modifiers))."
    }

    public static func shortcut(keyCode: UInt32, modifiers: UInt32) -> String {
        let keys: [UInt32: String] = [UInt32(kVK_Space): "Space", UInt32(kVK_ANSI_D): "D",
                                      UInt32(kVK_ANSI_V): "V", UInt32(kVK_F8): "F8"]
        let flags: [(Int, String)] = [(controlKey, "Control"), (optionKey, "Option"),
                                      (shiftKey, "Shift"), (cmdKey, "Command")]
        let labels = flags.compactMap { modifiers & UInt32($0.0) != 0 ? $0.1 : nil }
        return (labels + [keys[keyCode] ?? "Key \(keyCode)"]).joined(separator: " + ")
    }
}
