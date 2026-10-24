/**
 * 1Password Secret Resolver — Transparent credential fetching for tool handlers.
 *
 * Fetches secrets from 1Password through the service-account SDK, caches them
 * in memory for the process lifetime, and retains the CLI as a fallback. Used
 * by tool handlers that need API keys or credentials at runtime.
 *
 * Falls back gracefully: if OP_SERVICE_ACCOUNT_TOKEN is not set or the
 * item doesn't exist, returns null so callers can use legacy sources.
 */

import { createClient } from "@1password/sdk";
import { spawn } from "node:child_process";

const debug = (...args: unknown[]) => {
  console.error("[op-secret]", ...args);
};

const OP_BINARY = "/opt/homebrew/bin/op";

// In-memory cache: "vault/item/field" -> value
const cache = new Map<string, string>();
let sdkAuthToken: string | null = null;
let sdkClientPromise: ReturnType<typeof createClient> | null = null;

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function execOp(args: string[], token: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(OP_BINARY, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token },
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2000).unref();
    }, 45_000);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end();
  });
}

async function getSdkClient(token: string) {
  if (!sdkClientPromise || sdkAuthToken !== token) {
    sdkAuthToken = token;
    sdkClientPromise = createClient({
      auth: token,
      integrationName: "tango-runtime",
      integrationVersion: "1.0.0",
    });
  }

  const clientPromise = sdkClientPromise;
  try {
    return await clientPromise;
  } catch (error) {
    // A transient initialization failure must not poison this long-lived process.
    if (sdkClientPromise === clientPromise) {
      sdkClientPromise = null;
      sdkAuthToken = null;
    }
    throw error;
  }
}

async function resolveWithSdk(
  vault: string,
  item: string,
  field: string,
  token: string,
): Promise<string | null> {
  const client = await getSdkClient(token);
  const value = await client.secrets.resolve(`op://${vault}/${item}/${field}`);
  return value.trim() || null;
}

/**
 * Fetch a secret from 1Password. Returns the field value or null if unavailable.
 * Results are cached in memory after first fetch.
 */
export async function getSecret(
  vault: string,
  item: string,
  field = "credential",
): Promise<string | null> {
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  if (!token) return null;

  const cacheKey = `${vault}/${item}/${field}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const value = await resolveWithSdk(vault, item, field, token);
    if (value) {
      cache.set(cacheKey, value);
      debug(`Resolved secret through SDK: ${vault}/${item}/${field}`);
      return value;
    }
  } catch (err) {
    debug(
      `SDK failed for "${item}"; trying CLI fallback:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    const result = await execOp(
      ["item", "get", item, "--vault", vault, "--fields", field, "--reveal"],
      token,
    );

    if (result.code !== 0) {
      debug(`Failed to get "${item}" from "${vault}": ${result.stderr.trim()}`);
      return null;
    }

    const value = result.stdout.trim();
    if (!value) {
      debug(`Empty value for "${item}" field "${field}" in "${vault}"`);
      return null;
    }

    cache.set(cacheKey, value);
    debug(`Resolved secret: ${vault}/${item}/${field}`);
    return value;
  } catch (err) {
    debug(`Error fetching secret "${item}":`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Fetch a one-time password from a 1Password item. OTP values are intentionally
 * not cached because they rotate.
 */
export async function getOneTimePassword(
  vault: string,
  item: string,
): Promise<string | null> {
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  if (!token) return null;

  try {
    const result = await execOp(
      ["item", "get", item, "--vault", vault, "--otp"],
      token,
    );

    if (result.code !== 0) {
      debug(`Failed to get OTP for "${item}" from "${vault}": ${result.stderr.trim()}`);
      return null;
    }

    const value = result.stdout.trim();
    return value || null;
  } catch (err) {
    debug(`Error fetching OTP for "${item}":`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Check if 1Password integration is available (token is set).
 */
export function isOpAvailable(): boolean {
  return !!process.env.OP_SERVICE_ACCOUNT_TOKEN;
}
