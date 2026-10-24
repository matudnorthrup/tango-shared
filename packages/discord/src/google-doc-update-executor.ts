import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface GoogleDocReplacement {
  find: string;
  replace: string;
  first?: boolean;
}

export interface GoogleDocTabUpdateInput {
  doc: string;
  tab: string;
  account: string;
  replacements?: GoogleDocReplacement[];
  content?: string;
  verify_contains?: string[];
}

export interface GoogleDocTabUpdateDeps {
  gogCommand: string;
  runCommand(command: string, args: string[], timeoutMs?: number): Promise<string>;
}

interface GoogleDocWriteReceipt {
  revisionToken?: string;
  raw: string;
}

export async function executeGoogleDocTabUpdate(
  input: GoogleDocTabUpdateInput,
  deps: GoogleDocTabUpdateDeps,
): Promise<Record<string, unknown>> {
  const target = resolveGoogleDocTarget(input.doc, input.tab);
  const replacements = Array.isArray(input.replacements)
    ? input.replacements.filter((replacement) => replacement.find.trim().length > 0)
    : [];
  const verifyContains = Array.isArray(input.verify_contains)
    ? input.verify_contains.filter((value) => typeof value === "string" && value.trim().length > 0)
    : [];

  if (replacements.length === 0 && (!input.content || input.content.length === 0)) {
    throw new Error("google_doc_update_tab requires either replacements or content.");
  }

  const beforeText =
    replacements.length > 0
      ? await runGogDocs(deps, [
          "docs",
          "cat",
          target.docId,
          "--tab",
          target.tabId,
          "--account",
          input.account,
        ])
      : null;

  let nextText =
    typeof input.content === "string" && input.content.length > 0
      ? input.content
      : null;

  if (replacements.length > 0) {
    const missing = replacements
      .filter((replacement) => !(beforeText ?? "").includes(replacement.find))
      .map((replacement) => replacement.find);
    if (missing.length > 0) {
      return {
        status: "precondition_failed",
        docId: target.docId,
        tabId: target.tabId,
        account: input.account,
        missing,
      };
    }
    nextText = applyReplacementBatch(beforeText ?? "", replacements);
  }

  if (nextText === null) {
    throw new Error("google_doc_update_tab could not derive the next tab content.");
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-gdocs-update-"));
  let writeOutput = "";
  try {
    const filePath = path.join(tempDir, "content.txt");
    fs.writeFileSync(filePath, nextText, "utf8");
    writeOutput = await runGogDocs(deps, [
      "docs",
      "write",
      target.docId,
      "--file",
      filePath,
      "--tab-id",
      target.tabId,
      "--account",
      input.account,
    ], 120_000);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const writeReceipt = parseWriteReceipt(writeOutput);
  if (verifyContains.length === 0 && writeReceipt) {
    return {
      status: "confirmed",
      docId: target.docId,
      tabId: target.tabId,
      account: input.account,
      appliedReplacementCount: replacements.length,
      verificationCount: 0,
      verificationMode: "write_receipt",
      writeReceipt,
    };
  }

  const afterText = await runGogDocs(deps, [
    "docs",
    "cat",
    target.docId,
    "--tab",
    target.tabId,
    "--account",
    input.account,
  ]);

  const expectedSnippets = verifyContains.length > 0
    ? verifyContains
    : replacements.map((replacement) => replacement.replace);
  const missingVerifications = expectedSnippets.filter((snippet) => !afterText.includes(snippet));

  return {
    status: missingVerifications.length === 0 ? "confirmed" : "verification_failed",
    docId: target.docId,
    tabId: target.tabId,
    account: input.account,
    appliedReplacementCount: replacements.length,
    verificationCount: expectedSnippets.length,
    verificationMode: "content_readback",
    missingVerifications,
    tabText: afterText,
  };
}

function applyReplacementBatch(text: string, replacements: GoogleDocReplacement[]): string {
  let nextText = text;
  for (const replacement of replacements) {
    if (replacement.first) {
      nextText = replaceFirst(nextText, replacement.find, replacement.replace);
      continue;
    }
    nextText = nextText.split(replacement.find).join(replacement.replace);
  }
  return nextText;
}

function replaceFirst(text: string, find: string, replace: string): string {
  const index = text.indexOf(find);
  if (index < 0) {
    return text;
  }
  return `${text.slice(0, index)}${replace}${text.slice(index + find.length)}`;
}

function resolveGoogleDocTarget(doc: string, tab: string): { docId: string; tabId: string } {
  const docUrlParts = extractDocUrlParts(doc);
  const tabUrlParts = extractDocUrlParts(tab);
  const docId = docUrlParts.docId || tabUrlParts.docId || doc.trim();
  const tabId = tabUrlParts.tabId || docUrlParts.tabId || tab.trim();
  if (!docId || !tabId) {
    throw new Error("google_doc_update_tab requires a valid doc id/url and tab id/url.");
  }
  return { docId, tabId };
}

function extractDocUrlParts(value: string): { docId: string; tabId: string } {
  const trimmed = value.trim();
  if (!trimmed.startsWith("http")) {
    return { docId: "", tabId: "" };
  }
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/document\/d\/([^/]+)/u);
    return {
      docId: match?.[1] ?? "",
      tabId: url.searchParams.get("tab") ?? "",
    };
  } catch {
    return { docId: "", tabId: "" };
  }
}

async function runGogDocs(
  deps: GoogleDocTabUpdateDeps,
  args: string[],
  timeoutMs = 60_000,
): Promise<string> {
  const output = await deps.runCommand(deps.gogCommand, args, timeoutMs);
  if (/^Error \(exit \d+\):/u.test(output)) {
    throw new Error(output);
  }
  return output;
}

function parseWriteReceipt(output: string): GoogleDocWriteReceipt | null {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const candidate =
        firstNonEmptyString(record["revisionToken"])
        || firstNonEmptyString(record["revision_token"])
        || firstNonEmptyString(record["revisionId"])
        || firstNonEmptyString(record["revision_id"])
        || firstNonEmptyString(record["revision"])
        || firstNonEmptyString(record["value"]);
      if (candidate) {
        return {
          revisionToken: candidate,
          raw: trimmed,
        };
      }
    }
  } catch {
    // Fall through to regex parsing.
  }

  const revisionMatch = trimmed.match(/\brevision(?:\s+token)?\s*[:=]\s*([A-Za-z0-9._-]+)/iu);
  if (revisionMatch?.[1]) {
    return {
      revisionToken: revisionMatch[1],
      raw: trimmed,
    };
  }

  return null;
}

function firstNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
