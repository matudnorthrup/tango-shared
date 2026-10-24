import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http2';
import { generateKeyPairSync, verify } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { APNsSender, configuredAPNs } from '../server/apns.js';
import { DeskDevices, parseDevice } from '../server/desk/devices.js';
import { decisionPayload, DeskPush, pendingPushes } from '../server/desk/push.js';
import { registerDeskRoutes } from '../server/desk/routes.js';
import { accessControl, requireJsonPosts } from '../server/access.js';
import { makeHarness } from './desk-harness.js';
import type { DeskItem, PendingRequest } from '../server/desk/types.js';
const device = { token: 'ab'.repeat(32), platform: 'ios' as const, bundleId: 'org.example.TangoDesk', environment: 'sandbox' as const };
const pending = (): PendingRequest => ({ kind: 'question', requestId: 'decision:D-100', at: Date.now(), question: 'Choose a layout?', options: [],
  questions: [{ id: 'decision', header: 'Layout', question: 'Choose a layout?', multiSelect: false, options: [{ label: 'A · Compact (Recommended)', description: 'Less space' }, { label: 'B · Roomy', description: 'More space' }] }],
  brief: { id: 'D-100', about: 'Layout', revision: 1, optionKeys: ['A', 'B'], level: 2, class: 'design-direction', candidate: false, door: 'two-way', blast: 'private', standing: '', background: '', assets: [], deadline: null, defaultOption: null, vetoLeftMs: null, proposedRule: null, confidence: null, changeMyMind: null } });
const item = (p = pending()): DeskItem => ({ id: 'loom:test', agentName: 'Test', hidden: false, disposition: 'active', facts: { pending: p } } as DeskItem);
const dbs: DatabaseSync[] = [];
const storage = () => { const db = new DatabaseSync(':memory:'); dbs.push(db); return new DeskDevices(db); };
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

describe('device API', () => {
  it('registers idempotently through the JSON and tailnet access guards', async () => {
    const h = makeHarness();
    try {
      const app = new Hono();
      app.use('*', accessControl({ allowedLogins: 'owner@example.test' }), requireJsonPosts());
      registerDeskRoutes(app, { core: h.core, scenes: () => [] });
      const headers = { 'Content-Type': 'application/json', 'Tailscale-User-Login': 'owner@example.test', 'Tailscale-Headers-Info': 'test' };
      for (let i = 0; i < 2; i++) expect((await app.request('/api/desk/devices', { method: 'POST', headers, body: JSON.stringify(device) })).status).toBe(200);
      expect(new DeskDevices(h.core.store.db).all()).toEqual([{ ...device, registeredAt: expect.any(Number) }]);
      expect((await app.request('/api/desk/devices', { method: 'POST', headers, body: '{}' })).status).toBe(400);
      expect((await app.request('/api/desk/devices', { method: 'POST', headers: { ...headers, 'Tailscale-User-Login': 'stranger@example.test' }, body: JSON.stringify(device) })).status).toBe(403);
      expect((await app.request('/api/desk/devices', { method: 'POST', headers: { ...headers, Origin: 'https://elsewhere.example' }, body: JSON.stringify(device) })).status).toBe(403);
      expect((await app.request('/api/desk/devices', { method: 'POST', body: JSON.stringify(device) })).status).toBe(415);
    } finally { h.close(); }
  });
  it('keeps its identity, devices and revision receipts after the database is reopened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-push-test-'));
    const file = join(dir, 'screen.db');
    let db = new DatabaseSync(file);
    try {
      const first = new DeskDevices(db); const id = first.id;
      first.register(device); first.mark(device, 'D-100', 1); db.close();
      db = new DatabaseSync(file);
      const reopened = new DeskDevices(db);
      expect(reopened.id).toBe(id); expect(reopened.all()).toEqual([{ ...device, registeredAt: expect.any(Number) }]);
      expect(reopened.sent(device, 'D-100', 1)).toBe(true);
      expect(reopened.sent(device, 'D-100', 2)).toBe(false);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('migrates existing devices and preserves registration time on repeat registration', () => {
    const db = new DatabaseSync(':memory:'); dbs.push(db);
    db.exec('CREATE TABLE desk_devices (token TEXT, bundle_id TEXT, environment TEXT, PRIMARY KEY(token, bundle_id, environment))');
    db.prepare('INSERT INTO desk_devices VALUES (?, ?, ?)').run(device.token, device.bundleId, device.environment);
    const devices = new DeskDevices(db);
    const original = devices.all()[0]!.registeredAt;
    expect(original).toBeGreaterThan(0);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(original + 1000);
    try {
      devices.register(device);
      expect(new DeskDevices(db).all()[0]!.registeredAt).toBe(original);
    } finally { clock.mockRestore(); }
  });
  it('rejects malformed tokens and environments', () => {
    expect(parseDevice({ ...device, token: '../secret' })).toBeNull();
    expect(parseDevice({ ...device, environment: 'other' })).toBeNull();
  });
});
describe('brief push', () => {
  it('matches web answer strings, IDs, revision, labels and locked categories', () => {
    const p = pending(); const payload = decisionPayload(item(p), p)!;
    expect(payload).toMatchObject({ itemId: 'loom:test', requestId: 'decision:D-100', revision: 1, decisionId: 'D-100', aps: { category: 'decision-2', alert: { title: 'Layout', body: 'Choose a layout?\nA · Compact\nB · Roomy\nTap to open.' } }, options: [{ key: 'A', label: 'Compact', answer: 'A · Compact (Recommended)' }, { key: 'B', label: 'Roomy', answer: 'B · Roomy' }] });
    p.brief!.tripwire = 'money'; expect(decisionPayload(item(p), p)!.aps.category).toBe('decision-2-locked');
    p.brief!.tripwire = null; p.brief!.level = 1; expect(decisionPayload(item(p), p)!.aps.category).toBe('decision-2-locked');
    delete p.brief!.revision; expect(decisionPayload(item(p), p)).toBeNull();
  });
  it.each(['tripwire', 'level-one'])('redacts locked alert text for %s briefs, including Open-only fallbacks', kind => {
    const p = pending();
    if (kind === 'tripwire') p.brief!.tripwire = 'money';
    else p.brief!.level = 1;
    const generic = { title: 'Decision needs you', body: 'Unlock to read and answer.' };
    const normal = decisionPayload(item(p), p)!;
    expect(normal.aps.alert).toEqual(generic);
    expect(normal.aps.category).toBe('decision-2-locked');
    expect(normal.options.map(o => o.answer)).toEqual(p.questions[0]!.options.map(o => o.label));
    p.questions[0]!.options[0]!.label = 'A · ' + 'private'.repeat(2000);
    const oversized = decisionPayload(item(p), p)!;
    expect(oversized.aps.alert).toEqual(generic);
    expect(oversized.aps.category).toBe('decision-open-locked');
    expect(oversized.options).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThanOrEqual(4096);
    p.questions[0]!.options = ['A', 'B', 'C', 'D'].map(key => ({ label: key + ' · Private choice', description: '' }));
    const overflow = decisionPayload(item(p), p)!;
    expect(overflow.aps.alert).toEqual(generic);
    expect(overflow.aps.category).toBe('decision-open-locked');
  });
  it('pushes once on the counted carrier and never for answered/done briefs', () => {
    const source = item(); source.facts.carriedBy = { itemId: 'loom:lead', title: 'Lead' };
    const lead = item(); lead.id = 'loom:lead'; lead.facts = { carried: [{ from: { itemId: source.id, title: 'Worker' }, pending: pending(), counts: true, why: 'worker' }] };
    const mirror = item(); mirror.id = 'loom:mirror'; mirror.facts.carried = [{ ...lead.facts.carried![0]!, counts: false }];
    expect(pendingPushes([source, lead, mirror]).map(p => p.itemId)).toEqual(['loom:lead']);
    expect(pendingPushes([{ ...item(), disposition: 'done' }, { ...item(), facts: {} }])).toEqual([]);
  });
  it('pushes only briefs opened after registration, not the existing backlog', async () => {
    const devices = storage();
    const old = [pending(), pending()];
    old[1]!.brief!.id = 'D-101'; old[1]!.requestId = 'decision:D-101';
    old.forEach(p => { p.at = 100; });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(200);
    try {
      devices.register(device);
      const fresh = pending(); fresh.at = 300;
      fresh.brief!.id = 'D-102'; fresh.requestId = 'decision:D-102';
      clock.mockReturnValue(400); devices.register(device);
      const sender = { bundleId: device.bundleId, send: vi.fn().mockResolvedValue({ status: 200 }) };
      const rows = old.map(p => item(p));
      const push = new DeskPush({ items: () => rows }, devices, sender, vi.fn());
      await push.sync();
      expect(sender.send).not.toHaveBeenCalled();
      rows.push(item(fresh));
      await push.sync();
      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(sender.send.mock.calls[0]![2]).toBe('D-102');
    } finally { clock.mockRestore(); }
  });
  it('deduplicates across service recreation, sends revision updates with stable collapse id, retries failures', async () => {
    const devices = storage(); devices.register(device);
    const p = pending(); const core = { items: () => [item(p)] };
    const sender = { bundleId: device.bundleId, send: vi.fn().mockResolvedValue({ status: 200 }) };
    await new DeskPush(core, devices, sender, vi.fn()).sync();
    await new DeskPush(core, devices, sender, vi.fn()).sync();
    expect(sender.send).toHaveBeenCalledTimes(1);
    p.brief!.revision = 2;
    sender.send.mockResolvedValueOnce({ status: 503 });
    await new DeskPush(core, devices, sender, vi.fn()).sync();
    await new DeskPush(core, devices, sender, vi.fn()).sync();
    expect(sender.send).toHaveBeenCalledTimes(3);
    expect(sender.send.mock.calls.every(call => call[2] === 'D-100')).toBe(true);
  });
  it.each([{ status: 410, reason: 'Unregistered' }, { status: 400, reason: 'BadDeviceToken' }])('drops invalid devices: %j', async result => {
    const devices = storage(); devices.register(device);
    await new DeskPush({ items: () => [item()] }, devices, { bundleId: device.bundleId, send: async () => result }, vi.fn()).sync();
    expect(devices.all()).toEqual([]);
  });
  it('is cleanly disabled without complete configuration', async () => {
    const log = vi.fn(); const sender = configuredAPNs({ TANGO_APNS_KEY_ID: 'test' }, log);
    expect(sender).toBeNull(); expect(log).toHaveBeenCalledTimes(1);
    const core = { items: vi.fn() }; await new DeskPush(core, storage(), sender, log).sync(); expect(core.items).not.toHaveBeenCalled();
  });
  it.each([4, 6])('delivers briefs with %i options using Open and Snooze', async count => {
    const devices = storage(); devices.register(device);
    const p = pending();
    p.questions[0]!.options = Array.from({ length: count }, (_, i) => ({ label: String.fromCharCode(65 + i) + ' · Choice', description: '' }));
    const sender = { bundleId: device.bundleId, send: vi.fn().mockResolvedValue({ status: 200 }) };
    await new DeskPush({ items: () => [item(p)] }, devices, sender, vi.fn()).sync();
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send.mock.calls[0]![1]).toMatchObject({ decisionId: 'D-100', itemId: 'loom:test', aps: { category: 'decision-open' }, options: [] });
  });
  it('uses an Open-only alert when answer text exceeds the APNs limit', () => {
    const p = pending(); p.questions[0]!.options[0]!.label = 'A · ' + 'long'.repeat(2000);
    const payload = decisionPayload(item(p), p)!;
    expect(payload.aps.category).toBe('decision-open'); expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(4096);
  });
});
it('speaks HTTP/2 with a valid ES256 JWT and drops a device on an actual 410 response', async () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const server = createServer(); const received: any[] = [];
  server.on('stream', (stream, headers) => {
    let body = ''; stream.setEncoding('utf8'); stream.on('data', chunk => { body += chunk; });
    stream.on('end', () => { received.push({ headers, body: JSON.parse(body) }); stream.respond({ ':status': 410 }); stream.end(JSON.stringify({ reason: 'Unregistered' })); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const port = (server.address() as { port: number }).port;
    const hosts: string[] = [];
    const sender = new APNsSender({ keyPath: 'unused', keyId: 'test-key', teamId: 'test-team', bundleId: device.bundleId }, keys.privateKey, d => { hosts.push(d.environment); return `http://127.0.0.1:${port}`; });
    const devices = storage(); devices.register(device);
    await new DeskPush({ items: () => [item()] }, devices, sender, vi.fn()).sync();
    expect(devices.all()).toEqual([]); expect(hosts).toEqual(['sandbox']);
    const { headers, body } = received[0];
    expect(headers[':path']).toBe(`/3/device/${device.token}`); expect(headers['apns-topic']).toBe(device.bundleId); expect(headers['apns-collapse-id']).toBe('D-100');
    const jwt = headers.authorization.slice(7).split('.');
    expect(JSON.parse(Buffer.from(jwt[0], 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'test-key' });
    expect(verify('sha256', Buffer.from(jwt.slice(0, 2).join('.')), { key: keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(jwt[2], 'base64url'))).toBe(true);
    expect(body.decisionId).toBe('D-100');
  } finally { server.close(); await once(server, 'close'); }
});
