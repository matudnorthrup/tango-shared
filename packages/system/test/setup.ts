import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests never touch the machine's profile, ledger or bot database.
const home = mkdtempSync(join(tmpdir(), "tango-system-test-"));
process.env.TANGO_HOME = home;
process.env.TANGO_PROFILE = "test";
process.env.TANGO_SYSTEM_DB = join(home, "system.sqlite");
process.env.TANGO_DB_PATH = join(home, "tango.sqlite");
process.env.TANGO_ENV_FILE = join(home, "no.env");
for (const name of ["TANGO_CONFIG_DIR", "TANGO_SERVICE_TMUX_SOCKET", "DISCORD_TOKEN", "TANGO_SCHEDULER_ALERTS_CHANNEL_ID", "LOOM_HOME"]) delete process.env[name];
