import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import { RemoteRuntime } from "../src/remote-runtime.js";
import { releaseId } from "../src/release-info.js";
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(() => Object.assign(new EventEmitter(), { unref() {} })),
}));
it("sends the complete profile in the detached session host spawn config", async () => {
  const home = mkdtempSync(join(tmpdir(), "loom-profile-spawn-"));
  const runtime = new RemoteRuntime({ loomHome: home, releasesDir: join(home, "releases"), claude: { accounts: [], defaultAccount: "a", sharedProjectsDir: join(home, "shared") } });
  const existing = { hello: { release: releaseId() } };
  vi.spyOn(runtime, "attach").mockResolvedValueOnce(null).mockResolvedValue(existing as never);
  const session = { system: "persona", env: { TOKEN: "sentinel" }, mcpServers: { remote: { type: "sse" as const, url: "https://example.test", headers: { Authorization: "sentinel-header" } } }, settingSources: [] };
  try {
    await runtime.open({ threadId: "t", account: "a", cwd: "/repo", nativeSessionId: "native", session }, () => {});
    const options = vi.mocked(spawn).mock.calls.at(-1)![2] as { env: Record<string, string> };
    expect(JSON.parse(options.env.LOOM_HOST_CONFIG).open).toEqual({ threadId: "t", account: "a", cwd: "/repo", nativeSessionId: "native", session });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
