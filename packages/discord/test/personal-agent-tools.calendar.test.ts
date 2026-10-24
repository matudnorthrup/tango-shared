import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCalendarTools } from '../src/personal-agent-tools.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup(failLookup = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tango-calendar-test-'));
  dirs.push(dir);
  const script = path.join(dir, 'gog');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(script, `#!${process.execPath}\nconst fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[1]==='calendars') {
 if(${failLookup}) process.exit(1);
 console.log(JSON.stringify({calendars:[{id:'primary-id',primary:true,timeZone:'America/Los_Angeles'}]}));
} else if(args[1]==='event') {
 console.log(JSON.stringify({event:{start:{dateTime:'2026-07-15T09:00:00-04:00',timeZone:'America/New_York'},end:{dateTime:'2026-07-15T10:00:00-04:00',timeZone:'America/New_York'}}}));
} else console.log(JSON.stringify({args}));
`, { mode: 0o755 });
  return { tool: createCalendarTools({ gogCommand: script })[0]!, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) };
}
describe('gog_calendar timezone integration', () => {
  it('adds named zones before the create subprocess without changing a quoted title', async () => {
    const {tool, calls}=setup();
    const result = await tool.handler({command:"calendar create primary --summary '--timezone' --from '2026-07-15T09:00:00-07:00' --to '2026-07-15T10:00:00-07:00' --account personal@example.com --dry-run --json"});
    const final=JSON.parse((result as {result:string}).result).args;
    expect(final.slice(-4)).toEqual(['--start-timezone','America/Los_Angeles','--end-timezone','America/Los_Angeles']);
    expect(final.slice(final.indexOf('--summary'),final.indexOf('--summary')+2)).toEqual(['--summary','--timezone']);
    expect(calls()).toHaveLength(2);
  });
  it('preserves an event zone when only its end time changes',async()=>{
    const {tool,calls}=setup();
    await tool.handler({command:'calendar update primary event-id --to 2026-12-15T11:00:00-05:00 --json'});
    const final=calls()[1];expect(final.slice(-2)).toEqual(['--end-timezone','America/New_York']);
    expect(final).not.toContain('--start-timezone');expect(final).not.toContain('--from');
  });
  it('does not invoke create when the metadata subprocess fails',async()=>{
    const {tool,calls}=setup(true);
    await expect(tool.handler({command:'calendar create primary --from 2026-07-15T09:00:00-07:00 --to 2026-07-15T10:00:00-07:00'})).rejects.toThrow('no calendar write attempted');
    expect(calls()).toHaveLength(1);expect(calls()[0][1]).toBe('calendars');
  });
});
