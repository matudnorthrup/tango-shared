import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseUsagePayload, type UsagePayload } from './types.js';
import { applyProfileColors } from './profile-colors.js';
import { renewClaudeProfiles } from './renewal.js';

export interface CollectorOptions {
  executable?: string;
  timeoutMs?: number;
}

export async function collectUsage(options: CollectorOptions = {}): Promise<UsagePayload> {
  const renewalWarnings = await renewClaudeProfiles();
  const executable = options.executable
    ?? process.env.AI_USAGE_BIN
    ?? path.join(os.homedir(), 'bin', 'ai-usage');
  const configuredTimeout = Number.parseInt(process.env.USAGE_UI_COLLECTOR_TIMEOUT_MS ?? '', 10);
  const timeoutMs = options.timeoutMs ?? (Number.isFinite(configuredTimeout) ? configuredTimeout : 60_000);

  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ['--json', '--quiet'],
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        try {
          // ai-usage intentionally exits 1 when it has useful partial data plus
          // provider errors. Parse stdout first and preserve that degraded view.
          const payload = parseUsagePayload(JSON.parse(stdout));
          payload.errors = payload.errors.map((error) => error.provider === 'Claude' && /OAuth token expired/.test(error.message)
            ? { ...error, message: renewalWarnings[error.account] ?? 'Monitoring access token renewal is pending. Automatic retries use backoff; a browser login is only needed if the saved login can no longer renew.' }
            : error);
          resolve(applyProfileColors(payload));
        } catch (parseError) {
          const detail = stderr.trim()
            || (error instanceof Error ? error.message : '')
            || (parseError instanceof Error ? parseError.message : String(parseError));
          reject(new Error(`Usage collection failed: ${detail.slice(0, 400)}`));
        }
      },
    );
  });
}
