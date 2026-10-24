// Merge authority is evidence, never a reading of the ask's wording.
import { checkCommand } from "./triggers.js";
import type { LoomStore } from "./store.js";

export interface PrRef { repo: string; number: number }
export interface MergeFacts { head: string; observedAt: number; green: boolean; threadsResolved: boolean; approvalsSatisfied: boolean; open: boolean }
export type ReadMergeFacts = (pr: PrRef) => Promise<MergeFacts | null>;

export function prAsset(value: unknown): PrRef | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Record<string, unknown>;
  if (a.kind !== "pr" || typeof a.url !== "string") return null;
  try {
    const url = new URL(a.url), parts = url.pathname.split("/");
    const number = Number(parts[4]);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || parts.length !== 5 || !parts[1] || !parts[2] || parts[3] !== "pull" || !Number.isSafeInteger(number) || number < 1) return null;
    return { repo: `${parts[1]}/${parts[2]}`, number };
  } catch { return null; }
}

export function approvedWork(store: LoomStore, threadId: string, buildInstruction?: unknown): boolean {
  // Only structured parent links extend approval to delegated work. Mail itself is not approval.
  const seen = new Set<string>();
  let current: string | null = threadId;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof buildInstruction === "string" && store.messages(current).some(m => m.id === buildInstruction && m.role === "user" && !m.origin)) return true;
    if (store.decisions(current).some(d =>
      ["plan-approval", "design-direction"].includes(d.class) && d.status === "answered" &&
      ["person", "person-chat"].includes(d.decided_by ?? "") && d.followed_recommendation === 1 && !d.reversed_at)) return true;
    const parent: string | null | undefined = store.thread(current)?.parent_thread_id;
    current = parent?.startsWith("loom:") ? parent.slice(5) : null;
  }
  return false;
}

const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state isDraft headRefOid baseRefName reviewDecision baseRef{branchProtectionRule{requiredApprovingReviewCount}} commits(last:1){nodes{commit{oid statusCheckRollup{state}}}} reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage}}}}}`;
/** Unknown data passes through. GraphQL reviewDecision accounts for required reviews, code owners and stale approvals. */
export async function readMergeFacts(pr: PrRef, command = checkCommand): Promise<MergeFacts | null> {
  try {
    const [owner, name] = pr.repo.split("/");
    if (!owner || !name) return null;
    const result = JSON.parse(await command("gh", ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr.number}`], undefined, 10_000));
    if (result.errors) return null;
    const p = result.data?.repository?.pullRequest;
    if (!p?.headRefOid || !p.baseRefName || !p.baseRef || !p.reviewThreads?.nodes || p.reviewThreads.pageInfo?.hasNextPage !== false) return null;
    // GitHub's protected flag includes branch protections and rulesets. An explicitly
    // unprotected branch needs no rules API (that endpoint is unavailable on some plans).
    const branch = JSON.parse(await command("gh", ["api", `repos/${pr.repo}/branches/${encodeURIComponent(p.baseRefName)}`], undefined, 10_000));
    if (typeof branch.protected !== "boolean") return null;
    const rules = branch.protected ? JSON.parse(await command("gh", ["api", `repos/${pr.repo}/rules/branches/${encodeURIComponent(p.baseRefName)}`], undefined, 10_000)) : [];
    if (!Array.isArray(rules)) return null;
    const required = [p.baseRef.branchProtectionRule?.requiredApprovingReviewCount ?? 0,
      ...rules.filter(r => r.type === "pull_request").map(r => r.parameters?.required_approving_review_count)];
    if (required.some(n => !Number.isInteger(n) || n < 0)) return null;
    const commit = p.commits?.nodes?.[0]?.commit;
    return { head: p.headRefOid, observedAt: Date.now(), open: p.state === "OPEN" && p.isDraft === false,
      green: commit?.oid === p.headRefOid && commit.statusCheckRollup?.state === "SUCCESS",
      threadsResolved: p.reviewThreads.nodes.every((t: { isResolved?: boolean }) => t.isResolved === true),
      approvalsSatisfied: p.reviewDecision === "APPROVED" || (Math.max(...required) === 0 && (p.reviewDecision === null || p.reviewDecision === "")) };
  } catch { return null; }
}

export function mergeReady(f: MergeFacts | null, now: number): boolean {
  return !!f && !!f.head && f.observedAt <= now && now - f.observedAt < 30_000 && f.open && f.green && f.threadsResolved && f.approvalsSatisfied;
}
