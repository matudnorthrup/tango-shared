import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Some MCP modules construct storage at import time. Isolate before importing
// any test, even when the invoking shell inherited a production profile.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tango-discord-test-"));
process.env.TANGO_HOME = root;
process.env.TANGO_PROFILE = "test";
process.env.TANGO_DATA_DIR = path.join(root, "profiles", "test", "data");
process.env.TANGO_DB_PATH = path.join(process.env.TANGO_DATA_DIR, "tango.sqlite");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
