import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Google Docs, Sheets, Slides, and Drive files can't load inside a scene: the
// frame is an opaque origin, so Google can't read its sign-in cookies (and
// Safari blocks them as third-party anyway). Instead the server reads the file
// with the owner's `gog` accounts each time the frame loads and shows the
// content itself: a Doc as its exported HTML, a Sheet as tables of its displayed
// values, and Slides, PDFs, and images as page images.

/** A Google file a url scene points at. */
export interface GoogleRef {
  id: string;
  /** Label for the app it opens in. */
  app: string;
  /** A Docs tab the link selects (`?tab=t.…`). */
  tab?: string;
  /** A Sheets tab the link selects (`#gid=…`), shown first. */
  gid?: number;
}

const GOOGLE_APPS: Record<string, string> = {
  document: 'Google Docs',
  spreadsheets: 'Google Sheets',
  presentation: 'Google Slides',
  forms: 'Google Forms',
  drawings: 'Google Drawings',
};

/**
 * The Google file behind a signed-in URL. Published-to-web copies (/pub,
 * /pubhtml, /embed, /d/e/…) need no sign-in and embed as they are.
 */
export function parseGoogleUrl(body: string): GoogleRef | undefined {
  let url: URL;
  try {
    url = new URL(body.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  const host = url.hostname.toLowerCase();
  if (host !== 'docs.google.com' && host !== 'drive.google.com') return undefined;
  if (/\/(pub|pubhtml|embed)$/.test(url.pathname) || /\/d\/e\//.test(url.pathname)) return undefined;
  const id = /\/d\/([\w-]{10,})/.exec(url.pathname)?.[1] ?? (url.searchParams.get('id') || undefined);
  if (!id || !/^[\w-]+$/.test(id)) return undefined;
  const app = host === 'drive.google.com' ? 'Google Drive' : (GOOGLE_APPS[url.pathname.split('/')[1] ?? ''] ?? 'Google Docs');
  const tab = app === 'Google Docs' ? url.searchParams.get('tab') : null;
  if (tab && /^[\w.-]+$/.test(tab)) return { id, app, tab };
  const gid = app === 'Google Sheets' ? /(?:^#|&)gid=(\d+)/.exec(url.hash)?.[1] ?? url.searchParams.get('gid') : null;
  if (gid && /^\d+$/.test(gid)) return { id, app, gid: Number(gid) };
  return { id, app };
}

/** One tab of a spreadsheet, as displayed values. */
export interface SheetTable {
  title: string;
  rows: string[][];
}

/** What a frame shows for a Google file: a Doc's HTML, a Sheet's tabs, or page images (Slides, PDFs, images). */
export interface GoogleSnapshot {
  name: string;
  modifiedTime: string;
  /** Exported HTML document (Docs). */
  html?: string;
  /** Spreadsheet tabs (Sheets). */
  tables?: SheetTable[];
  /** Something the viewer should know about what's shown, e.g. only the first tab. */
  note?: string;
  /** Page image paths, relative to the frame (`../google/<key>/<file>`). */
  pages?: string[];
}

export class GoogleUnavailable extends Error {}

/** Runs a command; resolves stdout, rejects with stderr in the message. */
export type Runner = (command: string, args: string[]) => Promise<string>;

const defaultRunner: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      // Never the command line: it carries the account address and local paths.
      const timedOut = (err as { killed?: boolean }).killed === true;
      const detail = String(stderr).trim().split('\n').pop() ?? '';
      reject(new Error(timedOut ? `${command} timed out` : redact(detail) || `${command} failed`));
    });
  });

/** Error text reaches screens and callers: strip account addresses and local paths. */
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<account>')
    .replace(/(^|[\s"'(=])\/(?:[^\s"')]+\/)+([^\s"')/]*)/g, (_, lead: string, base: string) => `${lead}…/${base}`);
}

const MAX_PAGES = 60;
const MAX_TABS = 12;
const MAX_ROWS = 500;
const MAX_COLS = 40;
const ACCOUNTS_TTL_MS = 10 * 60 * 1000;
// Longer than a scene usually stays up.
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_FILE = /^[\w-]+\.(png|jpe?g|gif|webp)$/;
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

interface Account {
  email: string;
  scopes: string[];
}

interface DriveFile {
  name: string;
  mimeType: string;
  modifiedTime: string;
}

export interface GoogleContentOptions {
  /** Cache folder for exports and page images. */
  dir: string;
  run?: Runner;
  /** Accounts to try, in order; defaults to every `gog` account with Drive access. */
  accounts?: string[];
  now?: () => number;
}

export class GoogleContent {
  private readonly run: Runner;
  private readonly now: () => number;
  private accounts: { list: Account[]; at: number } | undefined;
  /** The account that last opened each file, tried first next time. */
  private readonly accountFor = new Map<string, string>();
  private readonly snapshots = new Map<string, GoogleSnapshot>();
  private readonly inFlight = new Map<string, Promise<GoogleSnapshot>>();

  constructor(private readonly options: GoogleContentOptions) {
    this.run = options.run ?? defaultRunner;
    this.now = options.now ?? Date.now;
  }

  /** The file's current content. Re-exports only when Drive reports a newer modifiedTime. */
  render(ref: GoogleRef): Promise<GoogleSnapshot> {
    const flight = `${ref.id}/${ref.tab ?? ''}/${ref.gid ?? ''}`;
    const running = this.inFlight.get(flight);
    if (running) return running;
    const task = this.load(ref).finally(() => this.inFlight.delete(flight));
    this.inFlight.set(flight, task);
    return task;
  }

  /** A cached page image, or null for anything that isn't one. */
  pagePath(key: string, file: string): string | null {
    if (!/^[\w-]+$/.test(key) || !PAGE_FILE.test(file)) return null;
    const full = path.join(this.options.dir, key, file);
    return fs.existsSync(full) ? full : null;
  }

  private async load(ref: GoogleRef): Promise<GoogleSnapshot> {
    // An account can see a file it isn't allowed to download (a viewer on a restricted file);
    // then the next account that can see it gets a turn.
    const tried = new Set<string>();
    let lastError: Error | undefined;
    for (;;) {
      let found: Awaited<ReturnType<GoogleContent['lookup']>>;
      try {
        found = await this.lookup(ref.id, tried);
      } catch (err) {
        throw lastError ?? err;
      }
      try {
        return await this.export(ref, found);
      } catch (err) {
        // Unsupported types and local failures are the same for every account.
        if (err instanceof GoogleUnavailable) throw err;
        tried.add(found.account);
        this.accountFor.delete(ref.id);
        lastError = new GoogleUnavailable(redact((err as Error).message));
      }
    }
  }

  private async export(ref: GoogleRef, { account, file, scopes }: { account: string; scopes: string[]; file: DriveFile }): Promise<GoogleSnapshot> {
    // A Sheet read tab-by-tab differs from Drive's first-tab CSV, so the read mode is part of the key.
    const allTabs = file.mimeType === 'application/vnd.google-apps.spreadsheet' && scopes.includes('sheets');
    const isDoc = file.mimeType === 'application/vnd.google-apps.document';
    const docTab = isDoc && ref.tab ? `-tab-${ref.tab.replace(/\W/g, '_')}` : '';
    const sheetTab = allTabs && ref.gid !== undefined ? `-gid-${ref.gid}` : '';
    const key = `${ref.id}-${file.modifiedTime.replace(/\D/g, '')}${allTabs ? '-tabs' : ''}${docTab}${sheetTab}`;
    const dir = path.join(this.options.dir, key);
    const cached = this.snapshots.get(key);
    if (cached && fs.existsSync(dir)) {
      // Still on screen: keep its export out of the week-old sweep.
      const now = new Date(this.now());
      fs.utimesSync(dir, now, now);
      return cached;
    }
    // Start clean: a failed earlier attempt may have left a partial export, and gog won't overwrite it.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const snapshot: GoogleSnapshot = { name: file.name, modifiedTime: file.modifiedTime };
    if (isDoc) {
      const out = path.join(dir, 'doc.html');
      await this.run('gog', ['docs', 'export', ref.id, '--format', 'html', '--out', out, ...(ref.tab ? ['--tab', ref.tab] : []), '-a', account]);
      snapshot.html = fs.readFileSync(out, 'utf8');
    } else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
      if (allTabs) {
        snapshot.tables = await this.sheetTabs(ref.id, account, ref.gid);
      } else {
        // Drive alone exports only the first tab (as displayed values).
        const out = path.join(dir, 'sheet.csv');
        await this.run('gog', ['drive', 'download', ref.id, '--format', 'csv', '--out', out, '-a', account]);
        snapshot.tables = [{ title: '', rows: trimRows(parseCsv(fs.readFileSync(out, 'utf8'))) }];
        snapshot.note = 'First tab only (this Google account has no Sheets access in gog)';
      }
    } else if (IMAGE_EXT[file.mimeType]) {
      const name = `image.${IMAGE_EXT[file.mimeType]}`;
      await this.run('gog', ['drive', 'download', ref.id, '--out', path.join(dir, name), '-a', account]);
      snapshot.pages = [`../google/${key}/${name}`];
    } else if (file.mimeType === 'application/pdf' || file.mimeType.startsWith('application/vnd.google-apps.')) {
      const pdf = path.join(dir, 'file.pdf');
      const native = file.mimeType !== 'application/pdf';
      await this.run('gog', ['drive', 'download', ref.id, ...(native ? ['--format', 'pdf'] : []), '--out', pdf, '-a', account]);
      // Local conversion: another account wouldn't help, so this fails the read outright.
      await this.run('pdftoppm', ['-png', '-r', '110', '-l', String(MAX_PAGES), pdf, path.join(dir, 'page')]).catch((err: Error) => {
        throw new GoogleUnavailable(`couldn't render its pages (${redact(err.message)})`);
      });
      const pages = fs
        .readdirSync(dir)
        .filter((name) => /^page-\d+\.png$/.test(name))
        .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
      if (pages.length === 0) throw new GoogleUnavailable(`${file.name} exported no pages`);
      snapshot.pages = pages.map((name) => `../google/${key}/${name}`);
    } else {
      throw new GoogleUnavailable(`${file.name} is a ${file.mimeType} file, which screens can't show yet`);
    }
    for (const old of this.snapshots.keys()) if (old.startsWith(`${ref.id}-`)) this.snapshots.delete(old);
    this.snapshots.set(key, snapshot);
    this.prune(key);
    return snapshot;
  }

  private async sheetTabs(id: string, account: string, gid?: number): Promise<SheetTable[]> {
    const meta = JSON.parse(await this.run('gog', ['sheets', 'metadata', id, '-a', account, '-j'])) as {
      sheets?: Array<{ properties?: { title?: string; sheetId?: number; sheetType?: string; hidden?: boolean } }>;
    };
    const grids = (meta.sheets ?? [])
      .map((sheet) => sheet.properties ?? {})
      .filter((props) => props.title && (props.sheetType ?? 'GRID') === 'GRID' && (!props.hidden || props.sheetId === gid));
    // The tab the link points at comes first, so it's on screen even past the tab cap.
    const linked = grids.filter((props) => gid !== undefined && (props.sheetId ?? 0) === gid);
    const titles = [...linked, ...grids.filter((props) => !linked.includes(props))].map((props) => props.title!).slice(0, MAX_TABS);
    const tabs: SheetTable[] = [];
    for (const title of titles) {
      const range = `'${title.replace(/'/g, "''")}'!A1:${columnName(MAX_COLS)}${MAX_ROWS}`;
      const out = JSON.parse(await this.run('gog', ['sheets', 'get', id, range, '-a', account, '-j'])) as { values?: unknown[][] };
      const rows = trimRows((out.values ?? []).map((row) => row.map((cell) => (cell == null ? '' : String(cell)))));
      if (rows.length > 0) tabs.push({ title, rows });
    }
    return tabs;
  }

  private async lookup(id: string, skip: Set<string> = new Set()): Promise<{ account: string; scopes: string[]; file: DriveFile }> {
    let accounts = (await this.accountList()).filter((a) => !skip.has(a.email));
    const result = await this.tryAccounts(id, accounts);
    if (result) return result;
    // Accounts may have been added or re-authorized since the list was read.
    const fresh = (await this.accountList(true)).filter((a) => !skip.has(a.email));
    if (fresh.map((a) => `${a.email}:${a.scopes}`).join() !== accounts.map((a) => `${a.email}:${a.scopes}`).join()) {
      accounts = fresh;
      const retried = await this.tryAccounts(id, accounts);
      if (retried) return retried;
    }
    // Shown on screens and returned to callers: no account addresses.
    throw new GoogleUnavailable(
      accounts.length === 0 ? 'no Google accounts are signed in to gog' : `none of the ${accounts.length} signed-in Google accounts can open it`,
    );
  }

  private async tryAccounts(id: string, accounts: Account[]): Promise<{ account: string; scopes: string[]; file: DriveFile } | undefined> {
    const preferred = this.accountFor.get(id);
    const order = preferred ? [...accounts.filter((a) => a.email === preferred), ...accounts.filter((a) => a.email !== preferred)] : accounts;
    for (const { email, scopes } of order) {
      try {
        const out = JSON.parse(await this.run('gog', ['drive', 'get', id, '-a', email, '-j'])) as { file?: DriveFile };
        if (!out.file?.mimeType) throw new Error('no file metadata');
        this.accountFor.set(id, email);
        return { account: email, scopes, file: out.file };
      } catch {
        // not shared with this account (or not found); try the next
      }
    }
    return undefined;
  }

  /** Accounts with Drive access, in `gog auth list` order (or the configured order). */
  private async accountList(refresh = false): Promise<Account[]> {
    if (!refresh && this.accounts && this.now() - this.accounts.at < ACCOUNTS_TTL_MS) return this.accounts.list;
    const out = await this.run('gog', ['auth', 'list', '-p']);
    const signedIn = out
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((cols) => cols.length >= 3 && cols[0]!.includes('@'))
      .map((cols) => ({ email: cols[0]!, scopes: cols[2]!.split(',').map((scope) => scope.trim()) }))
      .filter((account) => account.scopes.includes('drive'));
    const wanted = this.options.accounts;
    const accounts = wanted ? wanted.flatMap((email) => signedIn.filter((account) => account.email === email)) : signedIn;
    this.accounts = { list: accounts, at: this.now() };
    return accounts;
  }

  /** Drops exports untouched for a week (older versions of a file go the same way, once no frame needs them). */
  private prune(keep: string): void {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.options.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === keep) continue;
      const full = path.join(this.options.dir, name);
      try {
        if (this.now() - fs.statSync(full).mtimeMs > KEEP_MS) fs.rmSync(full, { recursive: true, force: true });
      } catch {
        // already gone
      }
    }
  }
}

/** Drops trailing empty cells, rows, and columns, and caps the size. */
function trimRows(rows: string[][]): string[][] {
  const trimmed = rows.slice(0, MAX_ROWS).map((row) => {
    const cells = row.slice(0, MAX_COLS);
    while (cells.length > 0 && cells[cells.length - 1]!.trim() === '') cells.pop();
    return cells;
  });
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]!.length === 0) trimmed.pop();
  return trimmed;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 1 → A, 40 → AN (A1 notation). */
function columnName(n: number): string {
  let name = '';
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) name = String.fromCharCode(65 + ((i - 1) % 26)) + name;
  return name;
}
