import { afterEach, describe, expect, it } from "vitest";
import {
  printerMonitorHandler,
  resetPrinterMonitorStateForTests,
  setPrinterStatusFetcherForTests,
} from "../src/printer-monitor.js";

describe("printerMonitorHandler", () => {
  afterEach(() => {
    resetPrinterMonitorStateForTests();
    delete process.env.TANGO_PRINTER_STATUS_URL;
    delete process.env.TANGO_PRINTER_API_KEY;
  });

  it("reports a missing configuration once, distinct from an unreachable printer", async () => {
    delete process.env.TANGO_PRINTER_STATUS_URL;
    delete process.env.TANGO_PRINTER_API_KEY;

    const first = await printerMonitorHandler({} as never);
    const second = await printerMonitorHandler({} as never);

    expect(first).toMatchObject({
      status: "ok",
      summary: "⚙️ Printer monitor not configured — set TANGO_PRINTER_STATUS_URL and TANGO_PRINTER_API_KEY",
    });
    expect(second).toMatchObject({
      status: "skipped",
      summary: "Printer monitor not configured",
    });
  });

  it("learns the first real state silently when the printer was unreachable at startup", async () => {
    process.env.TANGO_PRINTER_STATUS_URL = "http://printer.local/api/v1/status";
    process.env.TANGO_PRINTER_API_KEY = "test-key";
    const statuses: Array<{ printer: { state: string } } | null> = [
      null,
      { printer: { state: "FINISHED" } },
    ];

    setPrinterStatusFetcherForTests(async () => statuses.shift() ?? null);

    const unreachable = await printerMonitorHandler({} as never);
    const firstAnswer = await printerMonitorHandler({} as never);

    expect(unreachable).toMatchObject({
      status: "ok",
      summary: "⚠️ Printer unreachable — could not connect to printer.local",
    });
    expect(firstAnswer).toMatchObject({
      status: "skipped",
      summary: "Initial state: FINISHED",
    });
  });

  it("does not re-notify print completion after a transient outage", async () => {
    process.env.TANGO_PRINTER_STATUS_URL = "http://printer.local/api/v1/status";
    process.env.TANGO_PRINTER_API_KEY = "test-key";
    const statuses = [
      { printer: { state: "FINISHED" } },
      null,
      { printer: { state: "FINISHED" } },
    ];

    setPrinterStatusFetcherForTests(async () => statuses.shift() ?? null);

    const initial = await printerMonitorHandler({} as never);
    const unreachable = await printerMonitorHandler({} as never);
    const recovered = await printerMonitorHandler({} as never);

    expect(initial).toMatchObject({
      status: "skipped",
      summary: "Initial state: FINISHED",
    });
    expect(unreachable).toMatchObject({
      status: "ok",
      summary: "⚠️ Printer unreachable — could not connect to printer.local",
    });
    expect(recovered).toMatchObject({
      status: "skipped",
      summary: "State changed: UNREACHABLE -> FINISHED (already notified)",
    });
  });

  it("re-arms completion alerts once a new print starts", async () => {
    const statuses = [
      { printer: { state: "FINISHED" } },
      { printer: { state: "PRINTING" }, job: { time_remaining: 900, file: "part.gcode" } },
      { printer: { state: "FINISHED" }, job: { file: "part.gcode" } },
    ];

    setPrinterStatusFetcherForTests(async () => statuses.shift() ?? null);

    const initial = await printerMonitorHandler({} as never);
    const printing = await printerMonitorHandler({} as never);
    const finished = await printerMonitorHandler({} as never);

    expect(initial).toMatchObject({
      status: "skipped",
      summary: "Initial state: FINISHED",
    });
    expect(printing).toMatchObject({
      status: "ok",
      summary: "State changed: FINISHED -> PRINTING (silent)",
    });
    expect(finished).toMatchObject({
      status: "ok",
      summary: "✅ Print complete! (part.gcode) — bed is ready to clear.",
    });
  });

  it("does not re-notify when printer oscillates between FINISHED and IDLE", async () => {
    const statuses = [
      { printer: { state: "PRINTING" }, job: { time_remaining: 900, file: "part.gcode" } },
      { printer: { state: "FINISHED" }, job: { file: "part.gcode" } },
      { printer: { state: "IDLE" } },
      { printer: { state: "FINISHED" }, job: { file: "part.gcode" } },
      { printer: { state: "IDLE" } },
      { printer: { state: "FINISHED" }, job: { file: "part.gcode" } },
    ];

    setPrinterStatusFetcherForTests(async () => statuses.shift() ?? null);

    const initial = await printerMonitorHandler({} as never);
    expect(initial).toMatchObject({ status: "skipped", summary: "Initial state: PRINTING" });

    const finished = await printerMonitorHandler({} as never);
    expect(finished).toMatchObject({
      status: "ok",
      summary: "✅ Print complete! (part.gcode) — bed is ready to clear.",
    });

    // IDLE should NOT re-arm notifications
    const idle1 = await printerMonitorHandler({} as never);
    expect(idle1).toMatchObject({ status: "ok", summary: expect.stringContaining("silent") });

    const finished2 = await printerMonitorHandler({} as never);
    expect(finished2).toMatchObject({
      status: "skipped",
      summary: "State changed: IDLE -> FINISHED (already notified)",
    });

    // Even after multiple oscillations
    const idle2 = await printerMonitorHandler({} as never);
    expect(idle2).toMatchObject({ status: "ok", summary: expect.stringContaining("silent") });

    const finished3 = await printerMonitorHandler({} as never);
    expect(finished3).toMatchObject({
      status: "skipped",
      summary: "State changed: IDLE -> FINISHED (already notified)",
    });
  });
});
