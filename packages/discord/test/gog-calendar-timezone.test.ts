import { describe, expect, it, vi } from 'vitest';
import { withCalendarTimezones } from '../src/gog-calendar-timezone.js';

const pacific = 'America/Los_Angeles';
const eastern = 'America/New_York';
const create = ['calendar', 'create', 'primary', '--from', '2026-07-15T09:00:00-07:00', '--to', '2026-07-15T10:00:00-07:00'];
const existing = { start: { dateTime: '2026-07-15T09:00:00-04:00', timeZone: eastern }, end: { dateTime: '2026-07-15T10:00:00-04:00', timeZone: eastern }, recurrence: ['RRULE:FREQ=WEEKLY'] };
const calendars = {calendars: [{id:'personal@example.com', primary:true, timeZone:pacific}, {id:'other', timeZone:eastern}]};
function lookup(event = existing) {
  return vi.fn(async (args: string[]) => JSON.stringify(args[1] === 'event' ? {event} : calendars));
}

describe('calendar timezone writes', () => {
  it('defaults both endpoints to the selected calendar, forwarding identity flags', async () => {
    const read = lookup();
    const result = await withCalendarTimezones(['-a','personal@example.com',...create, '--client=work','--dry-run','--select=start'], read);
    expect(result.slice(-4)).toEqual(['--start-timezone',pacific,'--end-timezone',pacific]);
    expect(read).toHaveBeenCalledWith(['calendar','calendars','-a','personal@example.com','--client','work','--all','--json','--no-input']);
  });
  it('resolves a secondary calendar by ID', async () => {
    const result = await withCalendarTimezones(['cal','new','other','--from','2026-12-15T09:00:00-05:00','--to','2026-12-15T10:00:00-05:00'],lookup());
    expect(result.slice(-4)).toEqual(['--start-timezone',eastern,'--end-timezone',eastern]);
  });
  it('honors explicit zones without metadata reads, including quoted command-like titles', async () => {
    const read=lookup();
    const result=await withCalendarTimezones([...create,'--summary','calendar update','--tz='+pacific],read);
    expect(result).toContain('calendar update');
    expect(result.slice(-4)).toEqual(['--start-timezone',pacific,'--end-timezone',pacific]);
    expect(read).not.toHaveBeenCalled();
  });
  it('supports different endpoint zones for travel', async () => {
    const result=await withCalendarTimezones(['calendar','add','primary','--from','2026-07-15T09:00:00-07:00','--to','2026-07-15T18:00:00-04:00','--from-timezone',pacific,'--to-timezone',eastern],lookup());
    expect(result.slice(-4)).toEqual(['--start-timezone',pacific,'--end-timezone',eastern]);
  });
  it.each(['--from','--to'])('preserves the existing event zone for a partial %s update',async flag=>{
    const read=lookup();
    const result=await withCalendarTimezones(['calendar','edit','primary','event-id',flag,'2026-12-15T09:00:00-05:00'],read);
    expect(result.slice(-2)).toEqual([flag==='--from'?'--start-timezone':'--end-timezone',eastern]);
    expect(result).not.toContain(flag==='--from'?'--end-timezone':'--start-timezone');
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('leaves a recurrence-only update anchored to its existing timestamps',async()=>{
    const args=['calendar','update','primary','event-id','--rrule','RRULE:FREQ=WEEKLY;COUNT=4','--scope','future','--original-start','2026-08-01T09:00:00-04:00'];
    expect(await withCalendarTimezones(args,lookup())).toEqual(args);
  });
  it('honors explicit update overrides with timestamps',async()=>{
    const result=await withCalendarTimezones(['calendar','set','primary','event-id','--from','2026-12-15T09:00:00-08:00','--to','2026-12-15T10:00:00-08:00','--timezone',pacific],lookup());
    expect(result.slice(-4)).toEqual(['--start-timezone',pacific,'--end-timezone',pacific]);
    expect(result).not.toContain('--timezone');
  });
  it('rejects a zone-only update instead of silently changing the event',async()=>{
    await expect(withCalendarTimezones(['calendar','update','primary','id','--start-timezone',pacific],lookup())).rejects.toThrow('corresponding');
  });
  it.each(['2026-12-15T09:00:00-07:00','2026-03-08T02:30:00-08:00'])('rejects wrong-season or nonexistent wall time %s',async timestamp=>{
    await expect(withCalendarTimezones(['calendar','create','primary','--from',timestamp,'--timezone',pacific],lookup())).rejects.toThrow('offset does not match');
  });
  it.each(['2026-11-01T01:30:00-07:00','2026-11-01T01:30:00-08:00','2026-12-15T17:00:00Z'])('accepts explicit instants around DST: %s',async timestamp=>{
    await expect(withCalendarTimezones(['calendar','create','primary','--from',timestamp,'--timezone',pacific],lookup())).resolves.toContain(pacific);
  });
  it('rejects invalid and conflicting zones',async()=>{
    await expect(withCalendarTimezones([...create,'--tz','Invalid/Zone'],lookup())).rejects.toThrow('Invalid IANA');
    await expect(withCalendarTimezones([...create,'--tz','',],lookup())).rejects.toThrow('named IANA');
    await expect(withCalendarTimezones([...create,'--tz',pacific,'--start-timezone',pacific],lookup())).rejects.toThrow('either');
  });
  it('requires one zone for recurring events',async()=>{
    await expect(withCalendarTimezones([...create,'--start-timezone',pacific,'--end-timezone',eastern,'--rrule','RRULE:FREQ=WEEKLY'],lookup())).rejects.toThrow('same named timezone');
  });
  it('fails closed when calendar lookup fails or the calendar is absent',async()=>{
    await expect(withCalendarTimezones(create,async()=>{throw new Error('offline');})).rejects.toThrow('offline');
    await expect(withCalendarTimezones(create,async()=>'{"calendars":[]}')).rejects.toThrow('Could not resolve');
  });
  it('passes all-day creates and metadata-only updates without lookups',async()=>{
    const read=lookup();
    for(const args of [ ['calendar','create','primary','--all-day','--from','2026-12-15','--to','2026-12-16'], ['calendar','update','primary','id','--summary','new title'] ]) {
      expect(await withCalendarTimezones(args,read)).toEqual(args);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('preserves date semantics when updating an existing all-day event',async()=>{
    const args=['calendar','update','primary','id','--from','2026-12-15','--to','2026-12-16'];
    const read=async()=>JSON.stringify({event:{start:{date:'2026-12-14'},end:{date:'2026-12-15'}}});
    expect(await withCalendarTimezones(args,read)).toEqual([...args,'--all-day']);
  });
  it('leaves read commands and their boolean flags unchanged',async()=>{
    const read=lookup();
    for(const args of [['calendar','events','--today','--all'],['calendar','calendars','--all'],['calendar','create','--help']]) {
      expect(await withCalendarTimezones(args,read)).toEqual(args);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects specialized timed shortcuts that bypass zone resolution', async () => {
    await expect(withCalendarTimezones(['calendar','focus-time','primary','--from','2026-07-15T09:00:00-07:00'],lookup())).rejects.toThrow('calendar create --event-type');
  });
  it('rejects duplicate timezone aliases and repeated scalar timestamps', async () => {
    await expect(withCalendarTimezones([...create,'--tz',pacific,'--timezone',pacific],lookup())).rejects.toThrow('only one');
    await expect(withCalendarTimezones([...create,'--from','2026-12-15T09:00:00-08:00'],lookup())).rejects.toThrow('Repeated');
  });
  it('requires timestamps before adding recurrence to an event without named zones',async()=>{
    const read=async()=>JSON.stringify({event:{start:{dateTime:'2026-07-15T09:00:00-07:00'},end:{dateTime:'2026-07-15T10:00:00-07:00'}}});
    await expect(withCalendarTimezones(['calendar','update','primary','id','--rrule','RRULE:FREQ=WEEKLY'],read)).rejects.toThrow('requires both');
  });
  it('fails closed on missing existing endpoints',async()=>{
    await expect(withCalendarTimezones(['calendar','update','primary','id','--from','2026-07-15T09:00:00-07:00'],async()=>'{}')).rejects.toThrow('Could not read');
  });

});
