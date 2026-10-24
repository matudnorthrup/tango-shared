import * as path from 'node:path';

// A stub `tailscale` first on PATH, so the CLI's tailnet lookups are instant
// and the same on every machine.
process.env.PATH = `${path.join(import.meta.dirname, 'fixtures', 'bin')}${path.delimiter}${process.env.PATH ?? ''}`;
