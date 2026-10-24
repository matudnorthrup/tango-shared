import { describe, expect, it, vi } from "vitest";
import {
  isVictorBridgeManualConsoleEnabled,
  isVictorManualConsoleBridgeActive,
  VICTOR_BRIDGE_MANUAL_CONSOLE_MODE,
  VICTOR_BRIDGE_MODE_ENV,
} from "../src/victor-bridge.js";

describe("Victor bridge manual-console gate", () => {
  it("is disabled by default", () => {
    expect(isVictorBridgeManualConsoleEnabled({})).toBe(false);
  });

  it("does not inspect tmux when manual-console mode is disabled", () => {
    const exec = vi.fn((_command: string) => undefined);

    expect(isVictorManualConsoleBridgeActive({ env: {}, exec })).toBe(false);

    expect(exec).not.toHaveBeenCalled();
  });

  it("treats a VICTOR-COS tmux session as active only after explicit opt-in", () => {
    const exec = vi.fn((_command: string) => undefined);

    expect(
      isVictorManualConsoleBridgeActive({
        env: { [VICTOR_BRIDGE_MODE_ENV]: VICTOR_BRIDGE_MANUAL_CONSOLE_MODE },
        exec,
      }),
    ).toBe(true);

    expect(exec).toHaveBeenCalledWith("tmux has-session -t VICTOR-COS 2>/dev/null");
  });

  it("falls back to the normal runtime when opted in but VICTOR-COS is absent", () => {
    const exec = vi.fn((_command: string) => {
      throw new Error("missing tmux session");
    });

    expect(
      isVictorManualConsoleBridgeActive({
        env: { [VICTOR_BRIDGE_MODE_ENV]: VICTOR_BRIDGE_MANUAL_CONSOLE_MODE },
        exec,
      }),
    ).toBe(false);
  });

  it("ignores non-manual bridge modes", () => {
    const exec = vi.fn((_command: string) => undefined);

    expect(
      isVictorManualConsoleBridgeActive({
        env: { [VICTOR_BRIDGE_MODE_ENV]: "operations" },
        exec,
      }),
    ).toBe(false);

    expect(exec).not.toHaveBeenCalled();
  });
});
