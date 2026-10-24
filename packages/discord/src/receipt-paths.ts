import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveConfiguredPath, resolveTangoProfileDataDir } from "@tango/core";

export const LEGACY_VAULT_ROOT = path.join(os.homedir(), "Documents/main");
export const CANONICAL_VAULT_RECEIPTS_ROOT = path.join(
  LEGACY_VAULT_ROOT,
  "Records",
  "Finance",
  "Receipts",
);
export const LEGACY_VAULT_RECEIPTS_ROOT = path.join(
  LEGACY_VAULT_ROOT,
  "Records",
  "Receipts",
);

export function resolveDefaultReceiptRoot(): string {
  const profileReceiptRoot = path.join(resolveTangoProfileDataDir(), "receipts");
  if (fs.existsSync(profileReceiptRoot)) {
    return profileReceiptRoot;
  }
  if (fs.existsSync(CANONICAL_VAULT_RECEIPTS_ROOT)) {
    return CANONICAL_VAULT_RECEIPTS_ROOT;
  }
  if (fs.existsSync(LEGACY_VAULT_RECEIPTS_ROOT)) {
    return LEGACY_VAULT_RECEIPTS_ROOT;
  }
  return CANONICAL_VAULT_RECEIPTS_ROOT;
}

export function resolveWalmartReceiptDir(defaultRoot = resolveDefaultReceiptRoot()): string {
  const normalizedRoot = path.resolve(defaultRoot);
  const profileReceiptRoot = path.resolve(path.join(resolveTangoProfileDataDir(), "receipts"));
  if (normalizedRoot === profileReceiptRoot) {
    return path.join(normalizedRoot, "walmart");
  }
  return path.join(normalizedRoot, "Walmart");
}

export function resolveConfiguredOrDefaultReceiptDir(
  envVarName: string,
  fallbackResolver: () => string,
): string {
  const configured = process.env[envVarName]?.trim();
  return configured && configured.length > 0
    ? resolveConfiguredPath(configured)
    : path.resolve(fallbackResolver());
}

export function resolveDefaultWalmartEvidenceRoot(): string {
  const profileEvidenceRoot = path.join(
    resolveTangoProfileDataDir(),
    "receipts",
    "walmart",
    "evidence",
  );
  if (fs.existsSync(profileEvidenceRoot)) {
    return profileEvidenceRoot;
  }
  const canonicalEvidenceRoot = path.join(CANONICAL_VAULT_RECEIPTS_ROOT, "Walmart", "Evidence");
  if (fs.existsSync(canonicalEvidenceRoot)) {
    return canonicalEvidenceRoot;
  }
  const legacyEvidenceRoot = path.join(LEGACY_VAULT_RECEIPTS_ROOT, "Walmart", "Evidence");
  if (fs.existsSync(legacyEvidenceRoot)) {
    return legacyEvidenceRoot;
  }
  return canonicalEvidenceRoot;
}
