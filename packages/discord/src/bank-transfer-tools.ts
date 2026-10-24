/**
 * Bank transfers — move money between the owner's own Bank accounts after the
 * owner approves a specific plan.
 *
 * Which accounts may be drawn from or paid into, the dollar caps, and who may
 * approve are NOT in this repo: they describe one operator's accounts. They come
 * from the `library.transfers` block of the profile's `browser-sites/bank.yaml`
 * descriptor, the same file that holds the sign-in configuration.
 *
 * The approval gate does not trust the model. `execute` checks the Discord
 * message that started the current turn — its id is injected by the MCP server
 * from the bot's turn provenance and model-supplied copies are stripped — and
 * requires that message to come from a configured approver, to be newer than
 * the plan, and to say "approve <plan code>".
 *
 * A submitted transfer cannot be recalled, so an item is marked `submitting`
 * before the submit click and is never retried from that state: if the
 * confirmation does not come back, the item becomes `unknown` and a person
 * checks Bank's activity list.
 */

import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "playwright-core";
import {
  formatCents,
  parseDollarAmountToCents,
  resolveDatabasePath,
  resolveTangoProfileDataDir,
  type AgentTool,
} from "@tango/core";
import { getBrowserManager } from "./browser-manager.js";
import { ensureSiteSession, getSiteDescriptor } from "./site-session.js";

const DEFAULT_SITE_ID = "bank";
const DEFAULT_PLAN_TTL_HOURS = 72;
const MAX_STORED_PLANS = 200;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export interface BankAccount {
  name: string;
  mask: string;
  /** Null for linked external accounts, which the form lists without a balance. */
  balanceCents: number | null;
}

export interface BankTransferRules {
  transferUrl: string;
  origin: string;
  sourceMasks: string[];
  destinationMasks: string[];
  maxPerTransferCents: number;
  maxPerPlanCents: number;
  approverDiscordUserIds: string[];
  planTtlHours: number;
}

export type BankTransferItemStatus = "pending" | "submitting" | "done" | "failed" | "unknown";

export interface BankTransferPlanItem {
  index: number;
  fromMask: string;
  fromName: string;
  toMask: string;
  toName: string;
  amountCents: number;
  memo?: string;
  status: BankTransferItemStatus;
  reference?: string;
  error?: string;
  executedAt?: string;
}

export type BankTransferPlanStatus =
  | "pending"
  | "executing"
  | "done"
  | "partial"
  | "needs_review"
  | "cancelled";

export interface BankTransferPlan {
  id: string;
  code: string;
  createdAt: string;
  expiresAt: string;
  status: BankTransferPlanStatus;
  reason?: string;
  requestedBy?: string;
  conversationKey?: string;
  channelId?: string;
  items: BankTransferPlanItem[];
  approval?: { messageId: string; discordUserId: string; approvedAt: string };
  /** Every approval message ever spent on this plan; each one runs it once. */
  usedApprovalMessageIds?: string[];
  balancesAfter?: Array<{ name: string; mask: string; balance: string | null }>;
}

export interface ApprovalMessage {
  direction: string;
  source: string;
  discordUserId: string | null;
  content: string;
  createdAt: string;
}

export interface BankTransferDriver {
  listAccounts(): Promise<BankAccount[]>;
  /**
   * Submit one transfer. Call `onSubmitting` immediately before the
   * irreversible click. Throw BankPreSubmitError for anything that fails
   * before that point.
   */
  transfer(
    item: { fromMask: string; toMask: string; amountCents: number },
    onSubmitting: () => void,
  ): Promise<{ reference: string }>;
}

/** Nothing was submitted; the item can be retried after the cause is fixed. */
export class BankPreSubmitError extends Error {}

export interface BankTransferToolOptions {
  siteId?: string;
  storePath?: string;
  rules?: BankTransferRules;
  driver?: BankTransferDriver;
  lookupMessage?: (discordMessageId: string) => ApprovalMessage | null;
  now?: () => Date;
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
    : [];
}

function dollarsToCents(value: unknown, field: string): number {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`bank transfers: '${field}' is required.`);
  }
  const cents = parseDollarAmountToCents(value);
  if (cents <= 0) {
    throw new Error(`bank transfers: '${field}' must be positive.`);
  }
  return cents;
}

export function loadBankTransferRules(siteId = DEFAULT_SITE_ID): BankTransferRules {
  const site = getSiteDescriptor(siteId);
  const raw = (site.library?.transfers ?? null) as Record<string, unknown> | null;
  if (!raw) {
    throw new Error(
      `Browser site '${siteId}' has no library.transfers block, so no transfers are allowed. Configure it in the profile.`,
    );
  }
  const [scope] = site.scopes;
  if (!scope) {
    throw new Error(`Browser site '${siteId}' has no scope.`);
  }
  const rules: BankTransferRules = {
    transferUrl: typeof raw.url === "string" ? raw.url : `${scope.origin}/payments/transfers`,
    origin: scope.origin,
    sourceMasks: asStringList(raw.sources).map(normalizeMask),
    destinationMasks: asStringList(raw.destinations).map(normalizeMask),
    maxPerTransferCents: dollarsToCents(raw.max_per_transfer, "max_per_transfer"),
    maxPerPlanCents: dollarsToCents(raw.max_per_plan, "max_per_plan"),
    approverDiscordUserIds: asStringList(raw.approver_discord_user_ids),
    planTtlHours: typeof raw.plan_ttl_hours === "number" ? raw.plan_ttl_hours : DEFAULT_PLAN_TTL_HOURS,
  };
  if (rules.sourceMasks.length === 0 || rules.destinationMasks.length === 0) {
    throw new Error("bank transfers: configure at least one source and one destination account.");
  }
  if (rules.approverDiscordUserIds.length === 0) {
    throw new Error("bank transfers: configure approver_discord_user_ids; nothing can be approved without one.");
  }
  return rules;
}

/** "••1234", "x1234", "1234" → "1234". */
export function normalizeMask(value: string): string {
  const digits = value.replace(/\D/gu, "");
  return digits.slice(-4);
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Parse one option of Bank's transfer-form account select. */
export function parseBankAccountOption(text: string): BankAccount | null {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const match = /^(.*?)\s*••(\d{4})(?:\s+\$(-?[\d,]+\.\d{2}))?/u.exec(normalized);
  if (!match) {
    return null;
  }
  const [, name = "", mask = "", balance] = match;
  return {
    name: name.trim(),
    mask,
    balanceCents: balance ? parseDollarAmountToCents(balance.replace(/,/gu, "")) : null,
  };
}

export function generatePlanCode(): string {
  let code = "";
  for (let i = 0; i < 4; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `BANK-${code}`;
}

/** SQLite `datetime('now')` is UTC without a zone marker. */
function parseStoredTimestamp(value: string): number {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(trimmed)) {
    return Date.parse(`${trimmed.replace(" ", "T")}Z`);
  }
  return Date.parse(trimmed);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The whole message must be the command: "approve BANK-XXXX", optionally after
 * a mention or the agent's name and with closing punctuation. Prose that merely
 * contains both words ("do not approve BANK-XXXX", "can I approve BANK-XXXX?")
 * is not an approval.
 */
export function isApprovalCommand(content: string, code: string): boolean {
  // Dictation may render the hyphen as a space or drop it.
  const codePattern = escapeRegExp(code).replace(/-/gu, "[-\\s]?");
  const pattern = new RegExp(
    `^(?:<@!?\\d+>[\\s,:]*)*(?:foxtrot[\\s,:]+)?approve\\s+${codePattern}[.!]?$`,
    "iu",
  );
  return pattern.test(content.trim());
}

export function verifyOwnerApproval(
  plan: Pick<BankTransferPlan, "code" | "createdAt">,
  message: ApprovalMessage | null,
  approverDiscordUserIds: string[],
): { ok: true } | { ok: false; reason: string } {
  const ask = `Ask the owner to reply \`approve ${plan.code}\` and run execute on that turn.`;
  if (!message) {
    return { ok: false, reason: `This turn was not started by a stored Discord message, so there is no owner approval to check. ${ask}` };
  }
  if (message.direction !== "inbound" || message.source !== "discord") {
    return { ok: false, reason: `This turn was not started by an inbound Discord message. ${ask}` };
  }
  if (!message.discordUserId || !approverDiscordUserIds.includes(message.discordUserId)) {
    return { ok: false, reason: `The message that started this turn is not from a configured approver. ${ask}` };
  }
  const planSecond = Math.floor(Date.parse(plan.createdAt) / 1000) * 1000;
  if (!(parseStoredTimestamp(message.createdAt) >= planSecond)) {
    return { ok: false, reason: `The approving message is older than the plan. ${ask}` };
  }
  if (!isApprovalCommand(message.content, plan.code)) {
    return { ok: false, reason: `The message that started this turn does not say "approve ${plan.code}". ${ask}` };
  }
  return { ok: true };
}

/** Validate requested transfers against the rules and live balances. */
export function validateTransfers(
  requested: Array<{ from: string; to: string; amountCents: number; memo?: string }>,
  accounts: BankAccount[],
  rules: BankTransferRules,
): { ok: true; items: BankTransferPlanItem[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const items: BankTransferPlanItem[] = [];
  const drawnBySource = new Map<string, number>();
  let total = 0;

  const resolve = (ref: string, role: string): BankAccount | null => {
    const mask = /\d{4}/u.test(ref) ? normalizeMask(ref) : null;
    const matches = mask
      ? accounts.filter((account) => account.mask === mask)
      : accounts.filter((account) => account.name.toLowerCase() === ref.trim().toLowerCase());
    const [match] = matches;
    if (!match || matches.length !== 1) {
      errors.push(`${role} account '${ref}' matched ${matches.length} Bank accounts; use the account's last four digits.`);
      return null;
    }
    if (match.balanceCents === null) {
      errors.push(`${role} account '${ref}' is a linked external account; only Bank-to-Bank transfers are supported.`);
      return null;
    }
    return match;
  };

  requested.forEach((entry, index) => {
    const from = resolve(entry.from, `Transfer ${index + 1} source`);
    const to = resolve(entry.to, `Transfer ${index + 1} destination`);
    if (!from || !to) {
      return;
    }
    if (!rules.sourceMasks.includes(from.mask)) {
      errors.push(`Transfer ${index + 1}: ${from.name} ••${from.mask} is not an allowed source.`);
    }
    if (!rules.destinationMasks.includes(to.mask)) {
      errors.push(`Transfer ${index + 1}: ${to.name} ••${to.mask} is not an allowed destination.`);
    }
    if (from.mask === to.mask) {
      errors.push(`Transfer ${index + 1}: source and destination are the same account.`);
    }
    if (!Number.isInteger(entry.amountCents) || entry.amountCents <= 0) {
      errors.push(`Transfer ${index + 1}: amount must be positive.`);
    } else if (entry.amountCents > rules.maxPerTransferCents) {
      errors.push(
        `Transfer ${index + 1}: ${formatCents(entry.amountCents)} is over the per-transfer cap of ${formatCents(rules.maxPerTransferCents)}.`,
      );
    }
    const drawn = (drawnBySource.get(from.mask) ?? 0) + entry.amountCents;
    drawnBySource.set(from.mask, drawn);
    if (from.balanceCents !== null && drawn > from.balanceCents) {
      errors.push(
        `Transfer ${index + 1}: ${from.name} ••${from.mask} has ${formatCents(from.balanceCents)}, less than the ${formatCents(drawn)} drawn from it.`,
      );
    }
    total += entry.amountCents;
    items.push({
      index: items.length + 1,
      fromMask: from.mask,
      fromName: from.name,
      toMask: to.mask,
      toName: to.name,
      amountCents: entry.amountCents,
      ...(entry.memo ? { memo: entry.memo } : {}),
      status: "pending",
    });
  });

  if (requested.length === 0) {
    errors.push("No transfers were requested.");
  }
  if (total > rules.maxPerPlanCents) {
    errors.push(`The plan totals ${formatCents(total)}, over the per-plan cap of ${formatCents(rules.maxPerPlanCents)}.`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, items };
}

/** Plan status from its items: any unconfirmed submit means a person must look. */
export function settlePlanStatus(plan: BankTransferPlan): BankTransferPlanStatus {
  const statuses = plan.items.map((item) => item.status);
  if (statuses.includes("unknown") || statuses.includes("submitting")) {
    return "needs_review";
  }
  return statuses.every((status) => status === "done") ? "done" : "partial";
}

/**
 * A plan stored as `executing` with no run in progress was interrupted (the
 * server restarted mid-plan). A `submitting` item may or may not have gone
 * through, so it becomes `unknown`; never-submitted items stay retryable.
 */
export function recoverInterruptedPlan(plan: BankTransferPlan): boolean {
  if (plan.status !== "executing") {
    return false;
  }
  for (const item of plan.items) {
    if (item.status === "submitting") {
      item.status = "unknown";
      item.error = "Interrupted after the submit click; check Bank's activity list.";
    }
  }
  plan.status = settlePlanStatus(plan);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Plan store                                                                  */
/* -------------------------------------------------------------------------- */

class BankTransferStore {
  constructor(private readonly filePath: string) {}

  load(): BankTransferPlan[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as { plans?: BankTransferPlan[] };
      return Array.isArray(parsed.plans) ? parsed.plans : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  save(plans: BankTransferPlan[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ plans: plans.slice(-MAX_STORED_PLANS) }, null, 2)}\n`);
    fs.renameSync(tmp, this.filePath);
  }

  get(id: string): BankTransferPlan | null {
    return this.load().find((plan) => plan.id === id || plan.code === id.toUpperCase()) ?? null;
  }

  put(plan: BankTransferPlan): void {
    const plans = this.load().filter((entry) => entry.id !== plan.id);
    plans.push(plan);
    this.save(plans);
  }
}

/* -------------------------------------------------------------------------- */
/* Browser driver                                                              */
/* -------------------------------------------------------------------------- */

async function mainText(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector("main") ?? document.body)?.innerText ?? "");
}

export function createBankBrowserDriver(siteId: string, rules: () => BankTransferRules): BankTransferDriver {
  const openForm = async (): Promise<Page> => {
    const session = await ensureSiteSession({ site: siteId, allowLogin: true });
    if (!session.authenticated) {
      throw new BankPreSubmitError(
        session.needsSecondFactor
          ? "Bank asked for a verification code. The owner needs to sign in once in the automation browser so Bank remembers it."
          : `Could not sign in to Bank: ${session.message}`,
      );
    }
    const { transferUrl, origin } = rules();
    const manager = getBrowserManager();
    await manager.ensureConnected(9223);
    const page = await manager.pageForOrigin(origin, transferUrl);
    await page.goto(transferUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForSelector("#fromAccount", { timeout: 30_000 }).catch(() => {
      throw new BankPreSubmitError(`The Bank transfer form did not load (landed on ${page.url()}).`);
    });
    return page;
  };

  const readOptions = (page: Page, selectId: string) =>
    page.$eval(`#${selectId}`, (select) =>
      [...(select as HTMLSelectElement).options].map((option) => ({ value: option.value, text: option.text })),
    );

  const selectByMask = async (page: Page, selectId: string, mask: string): Promise<void> => {
    const options = await readOptions(page, selectId);
    const matches = options.filter((option) => parseBankAccountOption(option.text)?.mask === mask);
    const [match] = matches;
    if (!match || matches.length !== 1) {
      throw new BankPreSubmitError(`Expected one ••${mask} in the ${selectId} list, found ${matches.length}.`);
    }
    await page.selectOption(`#${selectId}`, match.value);
  };

  return {
    async listAccounts() {
      const page = await openForm();
      return (await readOptions(page, "fromAccount"))
        .map((option) => parseBankAccountOption(option.text))
        .filter((account): account is BankAccount => account !== null);
    },

    async transfer(item, onSubmitting) {
      const page = await openForm();
      await selectByMask(page, "fromAccount", item.fromMask);
      await page.waitForTimeout(800);
      await selectByMask(page, "toAccount", item.toMask);
      await page.waitForSelector("#amount", { timeout: 15_000 }).catch(() => {
        throw new BankPreSubmitError("The amount field never appeared after choosing the accounts.");
      });

      const formText = await mainText(page);
      const remaining = /Remaining withdrawals[\s\S]{0,80}?cycle:\s*(\d+)/iu.exec(formText);
      if (remaining && Number(remaining[1]) === 0) {
        throw new BankPreSubmitError(`No withdrawals remain this statement cycle on ••${item.fromMask}.`);
      }

      await page.selectOption("#frequency", { label: "One-Time Transfer" });
      const amount = formatCents(item.amountCents).replace(/[$,]/gu, "");
      await page.fill("#amount", amount);
      await page.getByRole("button", { name: "Review Transfer" }).click();
      await page
        .waitForFunction(() => (document.querySelector("main") ?? document.body)?.innerText.includes("Submit This Transfer"), null, {
          timeout: 30_000,
        })
        .catch(async () => {
          const text = (await mainText(page)).replace(/\s+/gu, " ").slice(0, 300);
          throw new BankPreSubmitError(`Bank did not show the review screen: ${text}`);
        });

      const review = await mainText(page);
      const field = (label: string) => new RegExp(`${label}\\s*\\n\\s*([^\\n]+)`, "u").exec(review)?.[1]?.trim() ?? "";
      const checks = [
        field("From account").includes(`••${item.fromMask}`),
        field("To account").includes(`••${item.toMask}`),
        field("Amount") === formatCents(item.amountCents),
        field("Frequency") === "One-Time Transfer",
      ];
      if (checks.includes(false)) {
        await page.getByRole("button", { name: "Cancel" }).first().click().catch(() => undefined);
        throw new BankPreSubmitError(
          `The review screen did not match the plan (from "${field("From account")}", to "${field("To account")}", amount "${field("Amount")}", frequency "${field("Frequency")}"). Nothing was submitted.`,
        );
      }

      onSubmitting();
      await page.getByRole("button", { name: "Submit This Transfer" }).click();
      await page
        .waitForFunction(() => /Reference #/u.test((document.querySelector("main") ?? document.body)?.innerText ?? ""), null, {
          timeout: 45_000,
        })
        .catch(() => undefined);
      const confirmation = await mainText(page);
      const reference = /Reference #\s*(\d+)/u.exec(confirmation)?.[1];
      if (!reference || !/completed a transfer/iu.test(confirmation)) {
        throw new Error(
          `Submitted, but Bank did not show a confirmation: ${confirmation.replace(/\s+/gu, " ").slice(0, 300)}`,
        );
      }
      return { reference };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Approval lookup                                                             */
/* -------------------------------------------------------------------------- */

function createMessageLookup(): (discordMessageId: string) => ApprovalMessage | null {
  let db: DatabaseSync | null = null;
  return (discordMessageId) => {
    db ??= new DatabaseSync(resolveDatabasePath(process.env.TANGO_DB_PATH), { readOnly: true });
    const row = db
      .prepare(
        `SELECT direction, source, discord_user_id AS discordUserId, content, created_at AS createdAt
         FROM messages
         WHERE discord_message_id = ? AND direction = 'inbound'
         ORDER BY id ASC
         LIMIT 1`,
      )
      .get(discordMessageId) as ApprovalMessage | undefined;
    return row ?? null;
  };
}

/* -------------------------------------------------------------------------- */
/* Tool                                                                        */
/* -------------------------------------------------------------------------- */

type BankTransferAction = "accounts" | "plan" | "execute" | "history" | "cancel";

export function bankTransferActionLooksReadOnly(action: unknown): boolean {
  const normalized = typeof action === "string" ? action.trim().toLowerCase() : "";
  return normalized === "accounts" || normalized === "history";
}

function describePlan(plan: BankTransferPlan) {
  return {
    plan_id: plan.id,
    code: plan.code,
    status: plan.status,
    created_at: plan.createdAt,
    expires_at: plan.expiresAt,
    ...(plan.reason ? { reason: plan.reason } : {}),
    total: formatCents(plan.items.reduce((sum, item) => sum + item.amountCents, 0)),
    transfers: plan.items.map((item) => ({
      index: item.index,
      from: `${item.fromName} ••${item.fromMask}`,
      to: `${item.toName} ••${item.toMask}`,
      amount: formatCents(item.amountCents),
      ...(item.memo ? { memo: item.memo } : {}),
      status: item.status,
      ...(item.reference ? { reference: item.reference } : {}),
      ...(item.error ? { error: item.error } : {}),
    })),
    ...(plan.approval ? { approval: plan.approval } : {}),
    ...(plan.balancesAfter ? { balances_after: plan.balancesAfter } : {}),
  };
}

export function createBankTransferTools(options: BankTransferToolOptions = {}): AgentTool[] {
  const siteId = options.siteId ?? DEFAULT_SITE_ID;
  const now = options.now ?? (() => new Date());
  const rules = () => options.rules ?? loadBankTransferRules(siteId);
  const store = () =>
    new BankTransferStore(options.storePath ?? path.join(resolveTangoProfileDataDir(), "bank", "transfers.json"));
  let driver: BankTransferDriver | null = options.driver ?? null;
  const getDriver = () => (driver ??= createBankBrowserDriver(siteId, rules));
  const lookupMessage = options.lookupMessage ?? createMessageLookup();
  let executing = false;

  return [
    {
      name: "bank_transfer",
      description: [
        "Move money between the owner's own Bank accounts, only after the owner approves a specific plan.",
        "",
        "Actions:",
        "  accounts — Bank accounts with balances, and which are allowed as transfer sources/destinations.",
        "  plan — Validate transfers [{from, to, amount, memo}] against the configured allowlist, caps, and live balances. Returns a plan code. Nothing moves.",
        "  execute — Run an approved plan (plan_id). Only works on the turn started by the owner's own Discord message saying \"approve <code>\".",
        "  history — Recent plans with per-transfer status and Bank reference numbers.",
        "  cancel — Cancel a pending plan.",
        "",
        "Accounts are named by their last four digits. After `plan`, show the owner every transfer and the total, and ask them to reply `approve <code>`. Never call execute on a turn the owner did not start with that reply. An item in status `unknown` was submitted without a confirmation — never re-plan it; ask the owner to check Bank's activity list.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["accounts", "plan", "execute", "history", "cancel"] },
          transfers: {
            type: "array",
            description: "For plan: the transfers to make, in order.",
            items: {
              type: "object",
              properties: {
                from: { type: "string", description: "Source account's last four digits" },
                to: { type: "string", description: "Destination account's last four digits" },
                amount: { type: "string", description: "Dollar amount such as 125.40" },
                memo: { type: "string", description: "What the draw covers, for the record" },
              },
              required: ["from", "to", "amount"],
            },
          },
          reason: { type: "string", description: "For plan: why these transfers, e.g. the review that recommended them." },
          plan_id: { type: "string", description: "For execute/cancel: the plan id or code." },
          limit: { type: "number", description: "For history: how many recent plans (default 10)." },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const action = String(input.action ?? "").trim().toLowerCase() as BankTransferAction;

        if (action === "history") {
          const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : 10;
          const history = store();
          const loaded = history.load();
          if (!executing && loaded.some((entry) => recoverInterruptedPlan(entry))) {
            history.save(loaded);
          }
          return { plans: loaded.slice(-limit).reverse().map(describePlan) };
        }

        if (action === "accounts") {
          const activeRules = rules();
          const accounts = await getDriver().listAccounts();
          return {
            accounts: accounts.map((account) => ({
              name: account.name,
              mask: account.mask,
              balance: account.balanceCents === null ? null : formatCents(account.balanceCents),
              external: account.balanceCents === null,
              allowed_source: activeRules.sourceMasks.includes(account.mask),
              allowed_destination: activeRules.destinationMasks.includes(account.mask),
            })),
            caps: {
              per_transfer: formatCents(activeRules.maxPerTransferCents),
              per_plan: formatCents(activeRules.maxPerPlanCents),
            },
          };
        }

        if (action === "plan") {
          const requested = Array.isArray(input.transfers) ? (input.transfers as Array<Record<string, unknown>>) : [];
          const parsed: Array<{ from: string; to: string; amountCents: number; memo?: string }> = [];
          for (const entry of requested) {
            let amountCents: number;
            try {
              amountCents = parseDollarAmountToCents(String(entry.amount ?? ""));
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) };
            }
            parsed.push({
              from: String(entry.from ?? ""),
              to: String(entry.to ?? ""),
              amountCents,
              ...(typeof entry.memo === "string" && entry.memo.trim() ? { memo: entry.memo.trim() } : {}),
            });
          }
          const activeRules = rules();
          const validation = validateTransfers(parsed, await getDriver().listAccounts(), activeRules);
          if (!validation.ok) {
            return { error: "The plan was not created.", problems: validation.errors };
          }
          const created = now();
          const takenCodes = new Set(store().load().map((entry) => entry.code));
          let code = generatePlanCode();
          while (takenCodes.has(code)) {
            code = generatePlanCode();
          }
          const plan: BankTransferPlan = {
            id: `allyplan_${created.getTime().toString(36)}${randomInt(36 ** 4).toString(36)}`,
            code,
            createdAt: created.toISOString(),
            expiresAt: new Date(created.getTime() + activeRules.planTtlHours * 3_600_000).toISOString(),
            status: "pending",
            ...(typeof input.reason === "string" && input.reason.trim() ? { reason: input.reason.trim() } : {}),
            ...(typeof input._requester_agent_id === "string" ? { requestedBy: input._requester_agent_id } : {}),
            ...(typeof input._conversation_key === "string" ? { conversationKey: input._conversation_key } : {}),
            ...(typeof input._channel_id === "string" ? { channelId: input._channel_id } : {}),
            items: validation.items,
          };
          store().put(plan);
          return {
            ...describePlan(plan),
            next_step: `Show the owner these transfers and ask them to reply "approve ${plan.code}". Execute only on the turn that reply starts.`,
          };
        }

        const planId = typeof input.plan_id === "string" ? input.plan_id.trim() : "";
        if (!planId) {
          return { error: "plan_id is required." };
        }
        const plans = store();
        const plan = plans.get(planId);
        if (!plan) {
          return { error: `No plan '${planId}'.` };
        }
        if (!executing && recoverInterruptedPlan(plan)) {
          plans.put(plan);
        }

        if (action === "cancel") {
          if (plan.status !== "pending") {
            return { error: `Plan ${plan.code} is ${plan.status}; only a pending plan can be cancelled.` };
          }
          plan.status = "cancelled";
          plans.put(plan);
          return describePlan(plan);
        }

        if (action !== "execute") {
          return { error: `Unknown action '${action}'.` };
        }
        if (plan.status !== "pending" && plan.status !== "partial") {
          return { error: `Plan ${plan.code} is ${plan.status} and cannot be executed.`, plan: describePlan(plan) };
        }
        if (Date.parse(plan.expiresAt) < now().getTime()) {
          return { error: `Plan ${plan.code} expired at ${plan.expiresAt}. Create a new plan with current balances.` };
        }

        const activeRules = rules();
        const messageId = typeof input._message_id === "string" ? input._message_id : "";
        const approval = verifyOwnerApproval(plan, messageId ? lookupMessage(messageId) : null, activeRules.approverDiscordUserIds);
        if (!approval.ok) {
          return { error: "Not approved.", detail: approval.reason };
        }
        if (plan.usedApprovalMessageIds?.includes(messageId)) {
          return {
            error: "Not approved.",
            detail: `That approval was already used to run plan ${plan.code}. A retry needs a new "approve ${plan.code}" from the owner.`,
          };
        }
        // Rules may have tightened since the plan was made.
        const planTotal = plan.items.reduce((sum, item) => sum + item.amountCents, 0);
        if (planTotal > activeRules.maxPerPlanCents) {
          return {
            error: `Plan ${plan.code} totals ${formatCents(planTotal)}, over the current per-plan cap of ${formatCents(activeRules.maxPerPlanCents)}. Create a new plan.`,
          };
        }
        for (const item of plan.items) {
          if (
            !activeRules.sourceMasks.includes(item.fromMask)
            || !activeRules.destinationMasks.includes(item.toMask)
            || item.amountCents > activeRules.maxPerTransferCents
          ) {
            return { error: `Transfer ${item.index} is no longer allowed by the configured rules. Create a new plan.` };
          }
        }
        if (executing) {
          return { error: "Another Bank plan is executing right now; try again when it finishes." };
        }

        executing = true;
        try {
          const remaining = plan.items.filter((item) => item.status === "pending" || item.status === "failed");
          const liveAccounts = await getDriver().listAccounts();
          const drawn = new Map<string, number>();
          for (const item of remaining) {
            drawn.set(item.fromMask, (drawn.get(item.fromMask) ?? 0) + item.amountCents);
          }
          for (const [mask, cents] of drawn) {
            const balance = liveAccounts.find((account) => account.mask === mask)?.balanceCents ?? null;
            if (balance === null || balance < cents) {
              return {
                error: `••${mask} now has ${balance === null ? "no readable balance" : formatCents(balance)}, less than the ${formatCents(cents)} this plan draws from it. Nothing was submitted; create a new plan.`,
              };
            }
          }

          const message = lookupMessage(messageId);
          plan.approval = {
            messageId,
            discordUserId: message?.discordUserId ?? "",
            approvedAt: now().toISOString(),
          };
          plan.usedApprovalMessageIds = [...(plan.usedApprovalMessageIds ?? []), messageId];
          plan.status = "executing";
          plans.put(plan);

          const activeDriver = getDriver();
          for (const item of plan.items) {
            if (item.status !== "pending" && item.status !== "failed") {
              continue;
            }
            let submitted = false;
            try {
              const result = await activeDriver.transfer(item, () => {
                submitted = true;
                item.status = "submitting";
                delete item.error;
                plans.put(plan);
              });
              item.status = "done";
              item.reference = result.reference;
              item.executedAt = now().toISOString();
              plans.put(plan);
            } catch (err) {
              const messageText = err instanceof Error ? err.message : String(err);
              item.status = submitted ? "unknown" : "failed";
              item.error = messageText;
              plans.put(plan);
              break;
            }
          }

          plan.status = settlePlanStatus(plan);

          const touched = new Set(plan.items.flatMap((item) => [item.fromMask, item.toMask]));
          try {
            plan.balancesAfter = (await activeDriver.listAccounts())
              .filter((account) => touched.has(account.mask))
              .map((account) => ({
                name: account.name,
                mask: account.mask,
                balance: account.balanceCents === null ? null : formatCents(account.balanceCents),
              }));
          } catch {
            // The transfers stand on their references; balances are a courtesy.
          }
          plans.put(plan);
          return describePlan(plan);
        } finally {
          executing = false;
        }
      },
    },
  ];
}
