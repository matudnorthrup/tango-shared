/** Resolve named zones before Calendar writes; a UTC offset cannot identify a zone. */
export type CalendarLookup = (args: string[]) => Promise<string>;

const BOOLEAN_FLAGS = new Set([
  '-h', '--help', '-j', '--json', '--machine', '-p', '--plain', '--tsv',
  '-n', '--dry-run', '--dryrun', '--noop', '--preview', '-y', '--force', '--yes', '--assume-yes',
  '-v', '--verbose', '--version', '--no-input', '--non-interactive', '--noninteractive',
  '--readonly', '--gmail-no-send', '--wrap-untrusted', '--results-only',
  '--all-day', '--no-reminders', '--with-meet', '--with-zoom', '--include-passwords',
  '--guests-can-invite', '--guests-can-modify', '--guests-can-see-others',
]);
const LOOKUP_FLAGS = new Set([
  '--account', '--acct', '-a', '--client', '--access-token', '--home',
  '--enable-commands', '--enable-commands-exact', '--disable-commands',
]);
const ZONE_FLAGS = ['--timezone', '--tz', '--start-timezone', '--from-timezone', '--end-timezone', '--to-timezone'];

function parse(args: string[], positionalLimit = Infinity) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const lookupArgs: string[] = [];
  const zoneIndices = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) {
      positional.push(arg);
      if (positional.length === positionalLimit) break;
      continue;
    }
    if (arg === '--') throw new Error('Calendar commands must use explicit flags without a -- separator.');
    const flagIndex = i;
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    const value = eq >= 0 ? arg.slice(eq + 1) : BOOLEAN_FLAGS.has(name) ? 'true' : args[++i];
    if (value === undefined) throw new Error(`Missing value for ${name}.`);
    if (ZONE_FLAGS.includes(name) || ['--from', '--to', '--all-day'].includes(name)) {
      if (flags.has(name)) throw new Error(`Repeated ${name} is ambiguous; supply it once.`);
    }
    flags.set(name, name === '--rrule' && flags.get(name) ? flags.get(name)! + '\n' + value : value);
    if (ZONE_FLAGS.includes(name)) { zoneIndices.add(flagIndex); if (eq < 0) zoneIndices.add(i); }
    if (LOOKUP_FLAGS.has(name)) lookupArgs.push(name, value);
  }
  return { positional, flags, lookupArgs, zoneIndices };
}

function zone(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /^[+-]/.test(value)) {
    throw new Error('A named IANA timezone is required (for example America/Los_Angeles).');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); }
  catch { throw new Error(`Invalid IANA timezone: ${value}.`); }
  return value;
}

/** Reject a supplied wall time whose numeric offset contradicts its named zone. */
function validateOffset(timestamp: string | undefined, timeZone: string) {
  if (!timestamp) return;
  const match = /T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i.exec(timestamp);
  if (!match || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error('Timed calendar events require RFC3339 timestamps with an explicit offset.');
  }
  // UTC timestamps explicitly describe an instant, rather than a local wall time.
  if (match[1]!.toUpperCase() === 'Z') return;
  const offset = match[1]!.replace(':', '');
  const minutes = (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3))) * (offset[0] === '-' ? -1 : 1);
  const parts = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'longOffset' }).formatToParts(new Date(timestamp));
  const name = parts.find(p => p.type === 'timeZoneName')!.value;
  const actual = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  const actualMinutes = actual ? (Number(actual[2]) * 60 + Number(actual[3])) * (actual[1] === '-' ? -1 : 1) : 0;
  if (minutes !== actualMinutes) {
    throw new Error(`Timestamp offset does not match ${timeZone} on that date. Supply the correct local offset or a UTC (Z) timestamp.`);
  }
}

interface Endpoint { date?: string; dateTime?: string; timeZone?: string }
interface CalendarEvent { start?: Endpoint; end?: Endpoint; recurrence?: string[] }

export async function withCalendarTimezones(args: string[], lookup: CalendarLookup): Promise<string[]> {
  const [root, command] = parse(args, 2).positional;
  if (root !== 'calendar' && root !== 'cal') return args;
  if (['focus-time', 'focus', 'out-of-office', 'ooo'].includes(command ?? '') && !args.includes('--help') && !args.includes('-h')) {
    throw new Error('Use calendar create --event-type focus-time or --event-type out-of-office so Tango can resolve the event timezone.');
  }
  const create = ['create', 'add', 'new'].includes(command ?? '');
  const update = ['update', 'edit', 'set'].includes(command ?? '');
  if (!create && !update) return args;
  const { positional, flags, lookupArgs, zoneIndices } = parse(args);
  const [, , calendarId, eventId] = positional;
  if (flags.has('--help') || flags.has('-h') || flags.has('--version')) return args;
  if (!calendarId || (update && !eventId)) throw new Error('Calendar create/update requires a calendar ID (and an event ID for update).');
  const hasZone = ZONE_FLAGS.some(f => flags.has(f));
  const from = flags.get('--from');
  const to = flags.get('--to');
  // Metadata-only edits do not need to touch or resolve event timezones.
  if (update && !from && !to && !hasZone && !flags.has('--rrule') && !flags.has('--all-day')) return args;
  const explicitAllDay = flags.get('--all-day');
  if (explicitAllDay === 'true' || flags.get('--event-type') === 'working-location') {
    if (hasZone) throw new Error('All-day events use dates, not timezone flags.');
    return args;
  }
  let event: CalendarEvent | undefined;
  if (update) {
    const response = JSON.parse(await lookup(['calendar', 'event', calendarId, eventId!, ...lookupArgs, '--json', '--no-input']));
    event = response.event ?? response;
    if (!event?.start || !event?.end) throw new Error('Could not read existing event endpoints; calendar write stopped.');
    if (event.start.date && explicitAllDay !== 'false' && !from?.includes('T') && !to?.includes('T')) {
      if (hasZone) throw new Error('All-day events use dates, not timezone flags.');
      return from || to ? [...args, '--all-day'] : args;
    }
  }
  const common = flags.get('--timezone') ?? flags.get('--tz');
  const start = flags.get('--start-timezone') ?? flags.get('--from-timezone');
  const end = flags.get('--end-timezone') ?? flags.get('--to-timezone');
  if (common !== undefined && (start !== undefined || end !== undefined)) {
    throw new Error('Use either --timezone or separate --start-timezone/--end-timezone flags.');
  }
  // Reject duplicate aliases rather than allowing our interpretation to differ from gog's.
  for (const names of [['--timezone', '--tz'], ['--start-timezone', '--from-timezone'], ['--end-timezone', '--to-timezone']]) {
    if (names.filter(n => flags.has(n)).length > 1) throw new Error(`Use only one of ${names.join(' / ')}.`);
  }
  if (update && (((common !== undefined || start !== undefined) && !from) || ((common !== undefined || end !== undefined) && !to))) {
    throw new Error('Timezone overrides on update require the corresponding --from/--to timestamp.');
  }
  if (update && flags.get('--rrule') && ((!from && !event?.start?.timeZone) || (!to && !event?.end?.timeZone))) {
    throw new Error('Adding recurrence to an event without named zones requires both --from and --to.');
  }
  let startZone = common ?? start ?? event?.start?.timeZone;
  let endZone = common ?? end ?? event?.end?.timeZone;
  if (startZone === undefined || endZone === undefined) {
    const response = JSON.parse(await lookup(['calendar', 'calendars', ...lookupArgs, '--all', '--json', '--no-input']));
    const calendars = Array.isArray(response) ? response : response.calendars;
    const calendar = Array.isArray(calendars) ? calendars.find((c: {id?: string; primary?: boolean}) =>
      c.id === calendarId || (calendarId === 'primary' && c.primary === true)) : undefined;
    if (!calendar?.timeZone) throw new Error('Could not resolve the destination calendar timezone. Supply explicit named timezone flags.');
    startZone ??= calendar.timeZone;
    endZone ??= calendar.timeZone;
  }
  const resolvedStart = zone(startZone);
  const resolvedEnd = zone(endZone);
  const recurring = flags.has('--rrule') ? Boolean(flags.get('--rrule')) : Boolean(event?.recurrence?.length);
  if (recurring && resolvedStart !== resolvedEnd) throw new Error('Recurring events require the same named timezone for start and end.');
  validateOffset(from, resolvedStart);
  validateOffset(to, resolvedEnd);
  // Normalize to flags shared by create and update (update has no --timezone shorthand).
  const result = args.filter((_, i) => !zoneIndices.has(i));
  if (create || from) result.push('--start-timezone', resolvedStart);
  if (create || to) result.push('--end-timezone', resolvedEnd);
  return result;
}
