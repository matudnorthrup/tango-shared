import type { AgentTool } from "@tango/core";
import { getBrowserManager } from "./browser-manager.js";
import {
  ensureSiteSession,
  getSiteDescriptor,
  loadSiteDescriptors,
  siteFetch,
  siteScopeForUrl,
  siteSessionDiagnostics,
  type SiteSessionResult,
} from "./site-session.js";

/**
 * Study Library — annotations (highlights, notes, reference links) on an
 * authenticated online library.
 *
 * Which library, its API paths, and its reference vocabulary (the works and
 * their aliases) are NOT in this repo: they describe one operator's account and
 * tradition. They come from the `library` section of a browser-site descriptor
 * in the profile layer (`<profile>/config/browser-sites/*.yaml`).
 */
type LibraryBook = { path: string; name: string; aliases: RegExp[] };

type LibraryContext = {
  siteId: string;
  scopeId: string;
  origin: string;
  anchorUrl: string;
  annotationsPath: string;
  contentPath: string;
  referenceRoot: string;
  locale: string;
  defaultColor: string;
  defaultStyle: string;
  books: LibraryBook[];
};

let cachedContext: LibraryContext | null = null;

/** Test seam: drop the resolved library descriptor. */
export function resetLibraryContextCache(): void {
  cachedContext = null;
}

function readString(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Resolve the single configured site that declares a `library` section. Kept
 * out of the repo on purpose — a checkout with no descriptor simply reports
 * that the tool is unconfigured rather than pointing at somebody's account.
 */
export function libraryContext(): LibraryContext {
  if (cachedContext) {
    return cachedContext;
  }
  const candidates = loadSiteDescriptors().filter((site) => site.library);
  if (candidates.length === 0) {
    throw new Error(
      "No study library is configured. Add a browser-site descriptor with a 'library' section under <profile>/config/browser-sites/.",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `More than one browser-site descriptor declares a library section (${candidates.map((site) => site.id).join(", ")}); only one is supported.`,
    );
  }

  const site = candidates[0]!;
  const library = site.library as Record<string, unknown>;
  const scopeId = readString(library, "scope", site.scopes[0]!.id);
  const scope = site.scopes.find((entry) => entry.id === scopeId) ?? site.scopes[0]!;
  const books = Array.isArray(library.books) ? library.books : [];

  cachedContext = {
    siteId: site.id,
    scopeId: scope.id,
    origin: scope.origin,
    anchorUrl: scope.anchor_url,
    annotationsPath: readString(library, "annotations_path", "/annotations"),
    contentPath: readString(library, "content_path", "/content"),
    referenceRoot: readString(library, "reference_root", "").replace(/\/+$/u, ""),
    locale: readString(library, "locale", "eng"),
    defaultColor: readString(library, "default_color", "yellow"),
    defaultStyle: readString(library, "default_style", "red-underline"),
    books: books.flatMap((entry) => {
      const record = entry as Record<string, unknown>;
      const path = typeof record.path === "string" ? record.path : null;
      const name = typeof record.name === "string" ? record.name : null;
      const aliases = Array.isArray(record.aliases) ? record.aliases : [];
      if (!path || !name) return [];
      return [{
        path,
        name,
        aliases: aliases.flatMap((alias) => {
          try {
            return [new RegExp(String(alias), "i")];
          } catch {
            return [];
          }
        }),
      }];
    }),
  };
  return cachedContext;
}

type StudyLibraryAction =
  | "status"
  | "open"
  | "ensure_session"
  | "prepare_login"
  | "login"
  | "list_annotations"
  | "create_reference_link"
  | "create_highlight"
  | "create_annotation"
  | "delete_annotation";

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function buildAnnotationsUrl(ctx: LibraryContext, query: unknown): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(toRecord(query))) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, String(item));
      }
      continue;
    }
    params.set(key, String(value));
  }

  const suffix = params.toString();
  return `${ctx.origin}${ctx.annotationsPath}${suffix ? `?${suffix}` : ""}`;
}

function stringInput(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requestedLibraryUrl(ctx: LibraryContext, value: unknown): string {
  const requested = stringInput(value);
  if (!requested) {
    return ctx.anchorUrl;
  }
  if (requested.startsWith("/")) {
    return `${ctx.origin}${requested}`;
  }
  return requested;
}

/**
 * Every library call goes through the site-origin tab owned by site-session,
 * so an expired token is healed before the call and the request
 * cannot land cross-origin on whatever page another workflow left behind.
 */
async function pageFetch(ctx: LibraryContext, input: {
  url: string;
  method?: string;
  body?: unknown;
}): Promise<unknown> {
  return siteFetch(ctx.siteId, ctx.scopeId, input);
}

function extractAnnotationId(value: unknown): string | null {
  const body = toRecord(toRecord(value).body);
  const candidates = [
    body.id,
    body.annotationId,
    toRecord(body.annotation).id,
    toRecord(body.data).id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

// Normalize curly quotes/apostrophes so a model-supplied phrase with straight quotes
// still matches the verse text (which uses typographic ’ and “”). The replacements are
// 1:1 in length, so character offsets are preserved.
function normalizeQuotes(value: string): string {
  return value.replace(/[‘’′]/g, "'").replace(/[“”″]/g, '"');
}

// Decode the small set of HTML entities that appear in body text, keeping offsets
// aligned with what the highlight API expects.
//
// One pass, deliberately. Decoding `&amp;` before the others double-unescapes:
// `&amp;lt;` would become `&lt;` and then `<`, which is both wrong and one
// character short — and a wrong length silently shifts every offset after it.
const CONTENT_ENTITY = /&(?:amp|quot|apos|lt|gt|nbsp|#(\d+));/g;

function decodeContentEntities(value: string): string {
  return value.replace(CONTENT_ENTITY, (match, numeric?: string) => {
    if (numeric !== undefined) {
      return String.fromCharCode(Number(numeric));
    }
    switch (match) {
      case "&amp;": return "&";
      case "&quot;": return '"';
      case "&apos;": return "'";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&nbsp;": return " ";
      default: return match;
    }
  });
}

/**
 * Strip markup until the result stops changing.
 *
 * This is offset math over first-party content, not sanitization for rendering:
 * the goal is that what remains contains no tag the reader would have hidden,
 * because a stray one shifts every offset after it. Looping to a fixed point is
 * what makes that stable; a regex pass is not an HTML parser and malformed
 * markup can still leave loose text behind.
 */
function stripMarkup(value: string): string {
  let text = value;
  for (let pass = 0; pass < 5; pass += 1) {
    const next = text.replace(/<[^>]+>/g, "");
    if (next === text) break;
    text = next;
  }
  return text;
}

// Resolve a paragraph's highlight coordinate space exactly the way the site's reader
// does: drop the leading paragraph-number span, strip remaining markup, decode
// entities. The resulting plain text is what start/end offsets are measured against.
export function verseHighlightText(innerHtml: string): string {
  const withoutVerseNumber = innerHtml.replace(
    /^\s*<span[^>]*class="[^"]*verse-number[^"]*"[^>]*>[\s\S]*?<\/span>/i,
    "",
  );
  return decodeContentEntities(stripMarkup(withoutVerseNumber));
}

type HighlightBuild =
  | { error: string; detail?: unknown }
  | { annotation: Record<string, unknown>; resolution: Record<string, unknown> };

// Build a highlight/note annotation from a human-level reference (chapter uri +
// paragraph + phrase) by fetching the authenticated content and
// resolving docId, contentVersion, the verse paragraph id (pid), and the character
// offsets of the phrase. This keeps the model out of the brittle business of reading the
// page and computing offsets itself (the failure mode that left passages unmarked).
async function buildHighlightAnnotation(
  ctx: LibraryContext,
  input: Record<string, unknown>,
  opts: { allowAnchorOnly?: boolean } = {},
): Promise<HighlightBuild> {
  const rawUri = stringInput(input.uri) ?? stringInput(input.url);
  if (!rawUri) {
    return { error: "create_highlight needs 'uri' (the chapter path), plus 'verse' and 'phrase'." };
  }

  // The uri may be the chapter path or a paragraph uri (ending .pN or .N).
  let chapterUri = rawUri.replace(/[?#].*$/, "").replace(/\/+$/, "");
  let verseNum: number | null = null;
  const dotVerse = chapterUri.match(/\.p?(\d+)$/i);
  if (dotVerse) {
    verseNum = Number(dotVerse[1]);
    chapterUri = chapterUri.slice(0, chapterUri.length - dotVerse[0].length);
  }
  for (const candidate of [input.verse, input.paragraph]) {
    if (candidate === undefined || candidate === null) continue;
    const match = String(candidate).match(/(\d+)/);
    if (match) verseNum = Number(match[1]);
  }
  if (!verseNum || !Number.isFinite(verseNum)) {
    return { error: "create_highlight needs the verse number (e.g. verse: 6), or a uri ending in .p6." };
  }

  const phrase = stringInput(input.phrase) ?? stringInput(input.text);
  const noteContent = stringInput(input.note);
  if (!phrase && !noteContent && !opts.allowAnchorOnly) {
    return { error: "create_highlight needs 'phrase' (exact text to mark) and/or 'note' (a verse note)." };
  }

  const contentUrl = `${ctx.origin}${ctx.contentPath}?lang=${ctx.locale}&uri=${encodeURIComponent(chapterUri)}`;
  const resp = toRecord(await pageFetch(ctx, { url: contentUrl }));
  if (resp.ok !== true) {
    return { error: `Failed to load content for ${chapterUri} (status ${String(resp.status)}).`, detail: resp.body };
  }
  const body = toRecord(resp.body);
  const pageAttributes = toRecord(toRecord(body.meta).pageAttributes);
  const docId = typeof pageAttributes["data-aid"] === "string" ? pageAttributes["data-aid"] : null;
  const contentVersion = Number(pageAttributes["data-aid-version"]);
  const html = typeof toRecord(body.content).body === "string" ? String(toRecord(body.content).body) : "";
  if (!docId || !Number.isFinite(contentVersion) || !html) {
    return { error: `Could not read content metadata (docId/version/body) for ${chapterUri}.` };
  }

  const pId = `p${verseNum}`;
  const openTag = html.match(new RegExp(`<p[^>]*id="${pId}"[^>]*>`, "i"));
  const block = html.match(new RegExp(`<p[^>]*id="${pId}"[^>]*>([\\s\\S]*?)</p>`, "i"));
  if (!openTag || !block) {
    return { error: `Verse ${verseNum} (${pId}) not found in ${chapterUri}.` };
  }
  const pid = (openTag[0].match(/data-aid="([^"]+)"/) || [])[1] ?? null;
  if (!pid) {
    return { error: `Could not resolve paragraph id (pid) for verse ${verseNum} in ${chapterUri}.` };
  }
  const verseText = verseHighlightText(block[1] ?? "");

  const color = (stringInput(input.color) ?? "yellow").toLowerCase();
  const style = stringInput(input.style) ?? "red-underline";
  const verseUri = `${chapterUri}.p${verseNum}`;

  let startOffset = -1;
  let endOffset = -1;
  if (phrase) {
    const hay = normalizeQuotes(verseText);
    const needle = normalizeQuotes(phrase).trim();
    const occurrence = Number(input.occurrence) > 0 ? Number(input.occurrence) : 1;
    let idx = -1;
    let from = 0;
    for (let i = 0; i < occurrence; i += 1) {
      idx = hay.indexOf(needle, from);
      if (idx < 0) break;
      from = idx + needle.length;
    }
    if (idx < 0) {
      return { error: `Phrase not found in verse ${verseNum}. Verse text is: "${verseText}"` };
    }
    startOffset = idx;
    endOffset = idx + needle.length;
  }

  // A note with no phrase attaches to the whole paragraph: the reader stores that as a
  // "clear" highlight spanning -1/-1 (an anchor with no visible underline/fill).
  const highlight: Record<string, unknown> = phrase
    ? { uri: verseUri, pid, color, style, startOffset, endOffset }
    : { uri: verseUri, pid, color: "clear", startOffset: -1, endOffset: -1 };

  const annotation: Record<string, unknown> = {
    type: "highlight",
    docId,
    contentVersion,
    locale: "eng",
    uri: chapterUri,
    highlights: [highlight],
    folders: [],
    tags: [],
  };
  if (noteContent) {
    annotation.note = { content: `<div>${noteContent}</div>` };
  }

  return {
    annotation,
    resolution: {
      chapterUri,
      verse: verseNum,
      paragraph: pId,
      pid,
      docId,
      contentVersion,
      verseText,
      phrase: phrase ?? null,
      startOffset,
      endOffset,
      color: phrase ? color : "clear",
      style: phrase ? style : null,
      note: noteContent ?? null,
    },
  };
}

// The POST schema rejects fields that appear in the GET representation (e.g.
// highlights[].mediaType). Strip those so a model that copies a listed annotation as a
// template still POSTs cleanly.
function sanitizeAnnotationForPost(annotation: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...annotation };
  if (Array.isArray(clone.highlights)) {
    clone.highlights = clone.highlights.map((entry) => {
      const record = toRecord(entry);
      const { mediaType: _mediaType, ...rest } = record;
      return rest;
    });
  }
  for (const key of ["personId", "annotationId", "id", "created", "lastUpdated", "source", "device"]) {
    delete clone[key];
  }
  return clone;
}

// The library's works and their aliases come from the profile descriptor, so
// this repo carries the matching algorithm without the tradition's vocabulary.

type ParsedReference = { bookPath: string; displayBook: string; chapter: number; verses: number[] };

// Parse a human reference like "<Work> 88:89-91", "<Work> chapter 14", or
// "<Work> chapter 17 verses 1 through 5" into a structured form. The works and
// their aliases come from the profile descriptor.
// Returns null if the book is unknown or the shape is unrecognized.
function parseLibraryReference(ctx: LibraryContext, ref: string): ParsedReference | null {
  const cleaned = ref.replace(/\s+/g, " ").trim();
  // Split off the leading book name: words up to the first chapter token (a number,
  // optionally preceded by "chapter"/"section"). Keep a leading ordinal (1/2/3/First...).
  const m = cleaned.match(
    /^(.*?)\s*(?:chapters?|sections?|§)?\s*(\d+)\s*(?::|\bverses?\b|\bvs?\.?\b|\bv\b)?\s*(\d+(?:\s*(?:[-–—]|through|thru|to)\s*\d+)?(?:\s*,\s*\d+)*)?\s*$/i,
  );
  if (!m) return null;
  const bookRaw = (m[1] ?? "").replace(/[.,]+$/, "").trim();
  const chapter = Number(m[2]);
  const verseSpec = m[3]?.trim();
  if (!bookRaw || !Number.isFinite(chapter)) return null;

  const book = ctx.books.find((b) => b.aliases.some((re) => re.test(bookRaw)));
  if (!book) return null;

  const verses: number[] = [];
  if (verseSpec) {
    for (const part of verseSpec.split(",")) {
      const range = part.match(/(\d+)\s*(?:[-–—]|through|thru|to)\s*(\d+)/i);
      if (range) {
        const a = Number(range[1]);
        const b = Number(range[2]);
        for (let v = a; v <= b; v += 1) verses.push(v);
      } else {
        const single = part.match(/\d+/);
        if (single) verses.push(Number(single[0]));
      }
    }
  }
  return { bookPath: book.path, displayBook: book.name, chapter, verses };
}

type ChapterContent = { docId: string; contentVersion: number; html: string };

// Fetch + cache an authenticated chapter's content (docId, contentVersion, body
// HTML). Cached per chapter uri for the lifetime of a single tool call so a multi-target
// reference resolves each target's chapter only once.
async function fetchChapterContent(
  ctx: LibraryContext,
  chapterUri: string,
  cache: Map<string, ChapterContent | { error: string }>,
): Promise<ChapterContent | { error: string }> {
  const cached = cache.get(chapterUri);
  if (cached) return cached;
  const contentUrl = `${ctx.origin}${ctx.contentPath}?lang=${ctx.locale}&uri=${encodeURIComponent(chapterUri)}`;
  const resp = toRecord(await pageFetch(ctx, { url: contentUrl }));
  let result: ChapterContent | { error: string };
  if (resp.ok !== true) {
    result = { error: `Failed to load ${chapterUri} (status ${String(resp.status)}).` };
  } else {
    const body = toRecord(resp.body);
    const pageAttributes = toRecord(toRecord(body.meta).pageAttributes);
    const docId = typeof pageAttributes["data-aid"] === "string" ? pageAttributes["data-aid"] : null;
    const contentVersion = Number(pageAttributes["data-aid-version"]);
    const html = typeof toRecord(body.content).body === "string" ? String(toRecord(body.content).body) : "";
    result = docId && Number.isFinite(contentVersion) && html
      ? { docId, contentVersion, html }
      : { error: `Could not read content metadata for ${chapterUri}.` };
  }
  cache.set(chapterUri, result);
  return result;
}

// Resolve a verse paragraph's pid (data-aid) from chapter HTML.
function paragraphPid(html: string, verse: number): string | null {
  const openTag = html.match(new RegExp(`<p[^>]*id="p${verse}"[^>]*>`, "i"));
  if (!openTag) return null;
  return (openTag[0].match(/data-aid="([^"]+)"/) || [])[1] ?? null;
}

// Resolve one parsed reference into a library ref object (name/uri/docId/pid/
// contentVersion/locale). Verse lists become comma-joined uri+pid; an empty verse list
// links the whole chapter (pid = chapter docId, the format the reader uses).
async function resolveReferenceTarget(
  ctx: LibraryContext,
  parsed: ParsedReference,
  cache: Map<string, ChapterContent | { error: string }>,
): Promise<{ ref: Record<string, unknown> } | { error: string }> {
  const chapterUri = `${ctx.referenceRoot}/${parsed.bookPath}/${parsed.chapter}`;
  const content = await fetchChapterContent(ctx, chapterUri, cache);
  if ("error" in content) return { error: content.error };

  if (parsed.verses.length === 0) {
    return {
      ref: {
        name: `${parsed.displayBook} ${parsed.chapter}`,
        uri: chapterUri,
        docId: content.docId,
        pid: content.docId,
        contentVersion: content.contentVersion,
        locale: "eng",
      },
    };
  }

  const pids: string[] = [];
  for (const verse of parsed.verses) {
    const pid = paragraphPid(content.html, verse);
    if (!pid) return { error: `Verse ${verse} not found in ${parsed.displayBook} ${parsed.chapter}.` };
    pids.push(pid);
  }
  const verseSuffix = parsed.verses.map((v) => `p${v}`).join(",");
  const first = parsed.verses[0];
  const last = parsed.verses[parsed.verses.length - 1];
  const name = parsed.verses.length === 1
    ? `${parsed.displayBook} ${parsed.chapter}:${first}`
    : `${parsed.displayBook} ${parsed.chapter}:${first}–${last}`;
  return {
    ref: {
      name,
      uri: `${chapterUri}.${verseSuffix}`,
      docId: content.docId,
      pid: pids.join(","),
      contentVersion: content.contentVersion,
      locale: "eng",
    },
  };
}

// Build a type:"reference" annotation that links a source verse/phrase to one or more
// target passages. Resolves the source anchor (offsets for a phrase, whole-paragraph anchor
// otherwise) and every target's metadata server-side, so the model only supplies a verse
// and human-readable reference strings.
async function buildReferenceAnnotation(ctx: LibraryContext, input: Record<string, unknown>): Promise<HighlightBuild> {
  const linksRaw = input.links ?? input.refs ?? input.references;
  const linkList = Array.isArray(linksRaw)
    ? linksRaw.map((l) => stringInput(l)).filter((l): l is string => !!l)
    : (stringInput(linksRaw) ? [stringInput(linksRaw) as string] : []);
  if (linkList.length === 0) {
    return { error: "create_reference_link needs 'links': one or more target references in the library's citation style." };
  }

  // Reuse the highlight builder to resolve the source anchor + (optional) phrase offsets.
  // When no phrase is given it yields a whole-verse anchor (color 'clear'); we recolor that
  // to a visible yellow anchor so the link is discoverable in the reader.
  const built = await buildHighlightAnnotation(ctx, input, { allowAnchorOnly: true });
  if ("error" in built) return built;
  const annotation = built.annotation;
  annotation.type = "reference";
  const phrase = stringInput(input.phrase) ?? stringInput(input.text);
  if (!phrase) {
    // Whole-verse reference anchor: yellow, no underline, -1/-1 offsets.
    annotation.highlights = [
      {
        uri: (annotation.highlights as Record<string, unknown>[])[0]?.uri,
        pid: (annotation.highlights as Record<string, unknown>[])[0]?.pid,
        color: (stringInput(input.color) ?? "yellow").toLowerCase(),
        startOffset: -1,
        endOffset: -1,
      },
    ];
  }

  const cache = new Map<string, ChapterContent | { error: string }>();
  const refs: Record<string, unknown>[] = [];
  const resolvedLinks: string[] = [];
  for (const link of linkList) {
    const parsed = parseLibraryReference(ctx, link);
    if (!parsed) return { error: `Could not parse reference "${link}". Use the library's citation style, e.g. "<Work> 88:87" or "<Work> 17:1-5".` };
    const resolved = await resolveReferenceTarget(ctx, parsed, cache);
    if ("error" in resolved) return { error: resolved.error };
    refs.push(resolved.ref);
    resolvedLinks.push(String(resolved.ref.name));
  }
  annotation.refs = refs;

  return {
    annotation,
    resolution: {
      ...built.resolution,
      type: "reference",
      links: resolvedLinks,
    },
  };
}

/** Format an ensureSiteSession result for the agent without leaking cookies or secrets. */
function sessionSummary(session: SiteSessionResult): Record<string, unknown> {
  return {
    site: session.site,
    scope: session.scope,
    authenticated: session.authenticated,
    needsLogin: session.needsLogin,
    needsSecondFactor: session.needsSecondFactor ?? false,
    path: session.path,
    probe: session.probe,
    steps: session.steps,
    sessionPersisted: session.persisted?.converted.length ?? 0,
    browserProfile: session.profile,
    message: session.message,
  };
}

export function studyLibraryActionLooksMutating(action: string): boolean {
  return ["create_reference_link", "create_highlight", "create_annotation", "delete_annotation"].includes(action.trim().toLowerCase());
}

export function createStudyLibraryTools(): AgentTool[] {
  return [
    {
      name: "study_library",
      description: [
        "Annotations (highlights, notes, reference links) on the configured authenticated study library.",
        "",
        "Every action self-heals that site's session first (silent single sign-on, then the configured",
        "1Password login), so you do not need to check auth before calling one.",
        "",
        "Actions:",
        "- status: report auth + session diagnostics WITHOUT signing in (use this to explain a failure)",
        "- ensure_session: make sure the session is live, signing in if needed. Pass scope to target a",
        "    particular area of the site; call this before doing that site's work with the browser tool.",
        "- open: launch/connect and open one of the site's URLs in its own tab",
        "- prepare_login / login: aliases of ensure_session, kept for older prompts",
        "- list_annotations: GET the annotations endpoint with an optional query object",
        "- create_reference_link: LINK a passage (or a phrase in it) to one or more other passages. Pass a",
        "    human-level source + target list and the tool resolves every target's docId/pid/contentVersion",
        "    server-side. Params:",
        "      uri: source chapter path as the library expresses it; verse: source paragraph number",
        "      links: array of target references as plain strings, in the library's own citation style",
        "            (ranges and whole-chapter links supported; multiple targets allowed in one call)",
        "      phrase: optional — to anchor the link on specific words (also underlines them); color/style/note optional",
        "    Advanced: pass a full `annotation` object instead to POST it verbatim.",
        "- create_highlight: MARK/UNDERLINE text (optionally colored, optionally with a note). Just pass a",
        "    human-level reference and the tool resolves docId, contentVersion, the paragraph's pid, and the exact",
        "    character offsets for you — you do NOT need to read the page or compute offsets. Params:",
        "      uri: chapter path (or a paragraph path ending in .pN)",
        "      verse: paragraph number (omit if uri already ends in .pN)",
        "      phrase: the EXACT words to underline/highlight, verbatim from the paragraph",
        "      color: yellow|pink|blue|green|orange|red|purple|...; style: red-underline|highlight",
        "      note: optional study note text to attach to the paragraph",
        "      occurrence: optional 1-based match index when the phrase repeats in the paragraph (default 1)",
        "    To attach only a note to a whole paragraph, pass uri+verse+note and omit phrase. Advanced: pass a full",
        "    `annotation` object instead to POST it verbatim. The tool verifies the new annotation and returns its",
        "    id + resolved offsets.",
        "- create_annotation: POST any annotation payload (generic; for non-highlight/reference types).",
        "- delete_annotation: DELETE an annotation by annotation_id",
        "",
        "This tool owns browser launch/navigation for the library and owns sign-in for every scope of that site.",
        "Do not ask the user to open a browser tab and do not type the site password through the generic browser",
        "tool. Ask the user only when 1Password access, captcha, or a second-factor prompt blocks authentication.",
        "It never stores or prints cookies. Do not hardcode personal IDs; use IDs from the authenticated page/API payload when a write requires them.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "status",
              "open",
              "ensure_session",
              "prepare_login",
              "login",
              "list_annotations",
              "create_reference_link",
              "create_highlight",
              "create_annotation",
              "delete_annotation",
            ],
          },
          url: {
            type: "string",
            description: "For open/status/ensure_session: a URL or path on the configured library site. Defaults to the site's anchor page.",
          },
          scope: {
            type: "string",
            description: "Which scope of the configured site to act on. Defaults to the library's own scope.",
          },
          open_if_needed: {
            type: "boolean",
            description: "Deprecated — the site tab is opened automatically when needed.",
          },
          query: {
            type: "object",
            description: "For list_annotations: query parameters such as uri, docId, folderId, tagId, limit, or offset.",
          },
          annotation: {
            type: "object",
            description: "For create_reference_link/create_annotation (or advanced create_highlight): complete annotation payload for the library annotations API.",
          },
          verse: {
            type: "number",
            description: "For create_highlight: paragraph number to mark. Omit if uri already ends in .pN.",
          },
          phrase: {
            type: "string",
            description: "For create_highlight: the exact words to underline/highlight, verbatim from the paragraph.",
          },
          color: {
            type: "string",
            description: "For create_highlight: yellow|pink|blue|green|orange|red|purple|... (default yellow).",
          },
          style: {
            type: "string",
            description: "For create_highlight: 'red-underline' underlines the range; 'highlight' fills the color (default red-underline).",
          },
          note: {
            type: "string",
            description: "For create_highlight: optional study note text to attach to the paragraph (pass without phrase to note the whole paragraph).",
          },
          occurrence: {
            type: "number",
            description: "For create_highlight: 1-based match index when the phrase repeats in the paragraph (default 1).",
          },
          links: {
            type: "array",
            items: { type: "string" },
            description: "For create_reference_link: target references as plain strings in the library's citation style. Ranges and whole-chapter links supported.",
          },
          annotation_id: {
            type: "string",
            description: "For delete_annotation: annotation ID to delete.",
          },
          verify: {
            type: "boolean",
            description: "For create/delete actions: verify when possible. Defaults to true.",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const action = String(input.action ?? "").trim().toLowerCase() as StudyLibraryAction;
        const browserManager = getBrowserManager();
        let ctx: LibraryContext;
        try {
          ctx = libraryContext();
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }

        const requestedScope =
          stringInput(input.scope)
          ?? (input.url ? siteScopeForUrl(requestedLibraryUrl(ctx, input.url))?.scope.id : null)
          ?? ctx.scopeId;

        if (action === "status") {
          // Report, never repair: status is what a caller uses to find out why
          // things are broken, so it must not silently start a sign-in.
          const session = await ensureSiteSession({
            site: ctx.siteId,
            scope: requestedScope,
            url: input.url ? requestedLibraryUrl(ctx, input.url) : undefined,
            allowLogin: false,
          });
          const diagnostics = await siteSessionDiagnostics(ctx.siteId);
          return {
            connected: true,
            ...sessionSummary(session),
            diagnostics,
            message: session.authenticated
              ? `The ${session.scope} session is authenticated.`
              : `The ${session.scope} session is not authenticated. Run action 'login' (or 'ensure_session') to re-authenticate with the configured 1Password item; only ask the user if 1Password access, captcha, or a second factor blocks it.`,
          };
        }

        if (action === "open") {
          const target = requestedLibraryUrl(ctx, input.url);
          const session = await ensureSiteSession({ site: ctx.siteId, scope: requestedScope, url: target });
          const page = await browserManager.pageForOrigin(new URL(target).origin, target);
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
          return {
            connected: true,
            currentUrl: page.url(),
            authenticated: session.authenticated,
            needsLogin: session.needsLogin,
            message: session.message,
          };
        }

        if (action === "ensure_session" || action === "prepare_login" || action === "login") {
          const session = await ensureSiteSession({
            site: ctx.siteId,
            scope: requestedScope,
            url: input.url ? requestedLibraryUrl(ctx, input.url) : undefined,
          });
          return { connected: true, ...sessionSummary(session) };
        }

        // Every data action below talks to an authenticated endpoint. Heal the
        // session first so a stale token becomes a silent refresh instead of a
        // write that POSTs into a signed-out session and half-succeeds.
        const session = await ensureSiteSession({ site: ctx.siteId, scope: ctx.scopeId });
        if (!session.authenticated) {
          return {
            error: "The study library is not authenticated, so the request was not sent.",
            ...sessionSummary(session),
          };
        }

        if (action === "list_annotations") {
          return pageFetch(ctx, {
            url: buildAnnotationsUrl(ctx, input.query),
          });
        }

        if (action === "create_highlight") {
          // Preferred path: build the payload from a human-level reference (uri + verse +
          // phrase). Escape hatch: a fully-formed `annotation` object is POSTed as-is.
          let annotation = sanitizeAnnotationForPost(toRecord(input.annotation));
          let resolution: Record<string, unknown> | null = null;
          if (Object.keys(annotation).length === 0) {
            const built = await buildHighlightAnnotation(ctx, input);
            if ("error" in built) {
              return built;
            }
            annotation = built.annotation;
            resolution = built.resolution;
          }

          const created = await pageFetch(ctx, {
            url: `${ctx.origin}${ctx.annotationsPath}`,
            method: "POST",
            body: annotation,
          });

          if (input.verify === false) {
            return { created, resolution, verified: null };
          }

          const annotationId = extractAnnotationId(created);
          const verification = annotationId
            ? await pageFetch(ctx, {
                url: `${ctx.origin}${ctx.annotationsPath}/${encodeURIComponent(annotationId)}`,
              })
            : null;

          return {
            created,
            annotationId,
            resolution,
            verification,
          };
        }

        if (action === "create_reference_link" || action === "create_annotation") {
          // create_reference_link preferred path: build the type:reference annotation from
          // a source verse/phrase + human-readable `links`. Escape hatch (and the only path
          // for create_annotation): a fully-formed `annotation` object POSTed as-is.
          let annotation = sanitizeAnnotationForPost(toRecord(input.annotation));
          let resolution: Record<string, unknown> | null = null;
          const wantsHighLevel = action === "create_reference_link"
            && Object.keys(annotation).length === 0
            && (input.links !== undefined || input.refs !== undefined || input.references !== undefined);
          if (wantsHighLevel) {
            const built = await buildReferenceAnnotation(ctx, input);
            if ("error" in built) {
              return built;
            }
            annotation = built.annotation;
            resolution = built.resolution;
          }
          if (Object.keys(annotation).length === 0) {
            return { error: `${action} requires an annotation object, or (for create_reference_link) 'uri'+'verse'+'links'.` };
          }

          const created = await pageFetch(ctx, {
            url: `${ctx.origin}${ctx.annotationsPath}`,
            method: "POST",
            body: annotation,
          });

          if (input.verify === false) {
            return { created, resolution, verified: null };
          }

          const annotationId = extractAnnotationId(created);
          const verification = annotationId
            ? await pageFetch(ctx, {
                url: `${ctx.origin}${ctx.annotationsPath}/${encodeURIComponent(annotationId)}`,
              })
            : null;

          return {
            created,
            annotationId,
            resolution,
            verification,
          };
        }

        if (action === "delete_annotation") {
          const annotationId = typeof input.annotation_id === "string"
            ? input.annotation_id.trim()
            : "";
          if (!annotationId) {
            return { error: "delete_annotation requires annotation_id" };
          }

          const deleted = await pageFetch(ctx, {
            url: `${ctx.origin}${ctx.annotationsPath}/${encodeURIComponent(annotationId)}`,
            method: "DELETE",
          });

          if (input.verify === false) {
            return { deleted, verified: null };
          }

          const verification = await pageFetch(ctx, {
            url: `${ctx.origin}${ctx.annotationsPath}/${encodeURIComponent(annotationId)}`,
          });

          return {
            deleted,
            annotationId,
            verification,
          };
        }

        return { error: `Unknown study_library action: ${String(input.action ?? "")}` };
      },
    },
  ];
}
