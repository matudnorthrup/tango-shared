import type { Artifact, ArtifactKind } from './types.js';

// Artifacts are extracted deterministically from the conversation's words
// (never by a model): GitHub pull requests and CI runs, preview deployments,
// links on the tailnet (artifact pages and files, local dev servers), and any
// link the agent named in markdown ("[Play-style prototype](https://…)"). The
// list is flat ({ kind, label, url }); the UI groups several of one kind into a
// dropdown pill.
//
// The list is current, not comprehensive: agents restate the live links at the
// end of a turn, so the newest agent message that carries links is the set.
// Screenshots and pages an earlier turn linked drop off once the agent stops
// listing them. The label is the agent's own name for the link.

const URL_RE = /https?:\/\/[^\s<>()\[\]"'`]+/gi;
const MD_LINK_START_RE = /\[([^\]\n]+)\]\((?=https?:\/\/)/g;
const PR_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i;
const CI_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)/i;
// "pr-123.preview.example.com", "foo.preview.app": any host with a preview label.
const PREVIEW_RE = /^https?:\/\/(?:[\w-]+\.)*preview\.[\w.-]+/i;
const TAILNET_RE = /^https?:\/\/[\w-]+\.[\w-]+\.ts\.net(?::\d+)?\//i;
// The desk's own tailnet mount: a link back to the desk is no use on the desk.
const SELF_RE = /^https?:\/\/[\w-]+\.[\w-]+\.ts\.net\/tango-screen(?:\/|$)/i;
const PAGE_RE = /\.html?$/i;
const FILE_RE = /\.(png|jpe?g|gif|webp|svg|mp4|webm|mov|pdf|csv|json|zip|txt|md)$/i;
const MAX_LABEL = 80;
const LIST_MARK_RE = /^\s*(?:>\s*)?(?:\d+[.)]|[-*•+])\s+/;
// "- Name — https://…", "2. Name: https://…": one bare link closing a list line.
const LIST_LINE_RE = /^\s*(?:>\s*)?(?:\d+[.)]|[-*•+])\s+([^\n]*?[^\s—–:-])\s*(?:[—–:]|\s-)\s*<?(https?:\/\/[^\s<>]+?)>?\s*$/;

// Pull requests and CI runs lead; everything else keeps the agent's order.
const LEAD: ArtifactKind[] = ['pr', 'ci'];

function clean(url: string): string {
  // Trailing punctuation belongs to the sentence, not the link.
  return url.replace(/[.,;:!?*_)>\]]+$/, '');
}

/** "acme-newsletter/index.html" names the page by its folder, not "index" (or "README.md"). */
function pathName(parsed: URL): string {
  const parts = parsed.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  const last = parts.at(-1) ?? '';
  if (/^(?:index|readme)(?:\.\w+)?$/i.test(last) && parts.length > 1) return parts.at(-2)!.replace(/[-_]+/g, ' ');
  return last;
}

/** A GitHub PR link in its canonical form (https://github.com/<owner>/<repo>/pull/<n>), or null. */
export function parsePrUrl(raw: string): { url: string; number: number } | null {
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(raw.trim());
  if (!match) return null;
  const number = Number(match[3]);
  return { url: `https://github.com/${match[1]}/${match[2]}/pull/${number}`, number };
}

export function classifyArtifact(url: string): Artifact | null {
  const pr = PR_RE.exec(url);
  if (pr) return { kind: 'pr', label: `PR #${pr[3]}`, url: pr[0] };
  const ci = CI_RE.exec(url);
  if (ci) return { kind: 'ci', label: `CI run ${ci[3]}`, url: ci[0] };
  if (PREVIEW_RE.test(url)) return { kind: 'preview', label: new URL(url).host, url };
  if (SELF_RE.test(url)) return null;
  if (TAILNET_RE.test(url)) {
    const parsed = new URL(url);
    const name = pathName(parsed) || parsed.host;
    // A dev server on a port, or an HTML artifact page: previewable in the Conversation view.
    if (parsed.port && (parsed.pathname === '/' || !FILE_RE.test(parsed.pathname))) return { kind: 'prototype', label: `:${parsed.port}${parsed.pathname === '/' ? '' : ` ${name}`}`, url };
    if (PAGE_RE.test(parsed.pathname)) return { kind: 'prototype', label: name.replace(PAGE_RE, ''), url };
    if (FILE_RE.test(parsed.pathname)) return { kind: 'file', label: name, url };
    return { kind: 'link', label: name, url };
  }
  return null;
}

/** A link the agent named but no rule above claims: a page, a file or a plain link. */
function namedArtifact(url: string): Artifact | null {
  if (SELF_RE.test(url)) return null;
  const parsed = new URL(url);
  const kind: ArtifactKind = PAGE_RE.test(parsed.pathname) ? 'doc' : FILE_RE.test(parsed.pathname) ? 'file' : 'link';
  return { kind, label: pathName(parsed) || parsed.host, url };
}

/** Drops hosting asides ("(tailnet only)", "on your tailnet") the desk has no use for. */
function tidyLabel(text: string): string {
  const label = text
    .replace(/[*_`]+/g, '')
    .replace(/\s*\((?:[^()]*\btailnet\b[^()]*)\)/gi, '')
    .replace(/\s+on (?:your|the) tailnet\b/gi, '')
    .replace(/\s*↗\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1).trimEnd()}…` : label;
}

interface MdLink {
  start: number;
  end: number;
  text: string;
  url: string;
}

/** "[name](url)" links in one line; the destination may hold balanced parentheses ("…/Foo_(bar)"). */
function mdLinks(line: string): MdLink[] {
  const links: MdLink[] = [];
  for (const match of line.matchAll(MD_LINK_START_RE)) {
    const from = match.index + match[0].length;
    let depth = 0;
    let at = from;
    for (; at < line.length; at += 1) {
      const char = line[at]!;
      if (/\s/.test(char)) break;
      if (char === '(') depth += 1;
      else if (char === ')' && depth-- === 0) break;
    }
    if (line[at] !== ')') continue;
    links.push({ start: match.index, end: at + 1, text: match[1]!, url: line.slice(from, at) });
  }
  return links;
}

/**
 * The agent's names for one line's links, url → label: "[Research page](…)", or a list line that
 * ends in a bare link ("- Decision packet — https://…"). A terse name in a grouped line
 * ("3. Question screens: [A](…) · [B](…)") takes the line's lead-in: "Question screens: A".
 */
function namesIn(line: string, links: MdLink[]): Map<string, string> {
  const names = new Map<string, string>();
  if (!links.length) {
    const bare = LIST_LINE_RE.exec(line);
    const name = bare ? tidyLabel(bare[1]!) : '';
    if (bare && name) names.set(clean(bare[2]!), name);
    return names;
  }
  const lead = line
    .slice(0, links[0]!.start)
    .replace(LIST_MARK_RE, '')
    .replace(/[*_`]+/g, '')
    .trim();
  const group = links.length > 1 && /:$/.test(lead) ? lead.replace(/:$/, '').trim() : '';
  for (const link of links) {
    const name = tidyLabel(link.text);
    if (name && !names.has(link.url)) names.set(link.url, group ? `${group}: ${name}` : name);
  }
  return names;
}

/** A PR or CI run keeps its number: "PR #448: stale updates", unless the name already has it. */
function withNumber(artifact: Artifact, name: string): string {
  if (artifact.kind !== 'pr' && artifact.kind !== 'ci') return name;
  const number = /\d+$/.exec(artifact.label)?.[0] ?? '';
  return number && !name.includes(number) ? `${artifact.label}: ${name}` : name;
}

/** One message's links, in the order the agent wrote them. */
function artifactsIn(text: string): Artifact[] {
  const found: Artifact[] = [];
  const add = (url: string, name: string | undefined) => {
    try {
      const artifact = classifyArtifact(url) ?? (name ? namedArtifact(url) : null);
      if (artifact && !found.some((existing) => existing.url === artifact.url)) found.push(name ? { ...artifact, label: withNumber(artifact, name) } : artifact);
    } catch {
      // not a parseable URL
    }
  };
  for (const line of text.split('\n')) {
    const links = mdLinks(line);
    const names = namesIn(line, links);
    // Markdown links whole; bare URLs only outside them, so both passes see the same URL.
    let bare = line;
    for (const link of links) bare = bare.slice(0, link.start) + ' '.repeat(link.end - link.start) + bare.slice(link.end);
    const hits = [...links.map((link) => ({ at: link.start, url: link.url })), ...[...bare.matchAll(URL_RE)].map((match) => ({ at: match.index, url: clean(match[0]) }))];
    for (const hit of hits.sort((a, b) => a.at - b.at)) add(hit.url, names.get(hit.url));
  }
  return found;
}

/** texts: the agent's messages, oldest first. */
export function extractArtifacts(texts: string[], extra: { pullRequest?: { url: string; number: number } | null } = {}): Artifact[] {
  let current: Artifact[] = [];
  for (let i = texts.length - 1; i >= 0 && !current.length; i -= 1) current = artifactsIn(texts[i]!);
  const found = [...current];
  // The thread's own PR stays even when the latest turn didn't restate it.
  const pr = extra.pullRequest?.url ? (classifyArtifact(extra.pullRequest.url) ?? { kind: 'pr' as const, label: `PR #${extra.pullRequest.number}`, url: extra.pullRequest.url }) : null;
  if (pr && !found.some((existing) => existing.url === pr.url)) found.unshift(pr);
  const rank = (kind: ArtifactKind) => (LEAD.includes(kind) ? LEAD.indexOf(kind) : LEAD.length);
  return found.map((artifact, index) => ({ artifact, index })).sort((a, b) => rank(a.artifact.kind) - rank(b.artifact.kind) || a.index - b.index).map((entry) => entry.artifact);
}
