import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error browser module
import { appChoices, navigatorContext as browserContext, executeNavigator } from '../public/desk/navigator-context.js';
// @ts-expect-error browser module
import { createAppListCache } from '../public/desk/app-list.js';
// @ts-expect-error browser module
import { validNavigatorAction, sameNavigatorAction } from '../public/desk/navigator-actions.js';
// @ts-expect-error browser module
import { createStore } from '../public/desk/store.js';
import { navigatorContext, resolveNavigator } from '../server/desk/navigator-resolver.js';
import { commandCandidate } from '../server/desk/navigator-bridge.js';

const list = [
  { id: 'desk', name: 'Tango Desk', path: '/tango-screen/' },
  { id: 'food', name: 'Tango Food', path: '/tango-food/' },
  { id: 'lift', name: 'Tango Lift', path: '/tango-workout/' },
  { id: 'hidden', name: 'Hidden', path: '/hidden/', hidden: true },
  { id: 'unsafe', name: 'Unsafe', path: '//elsewhere.test/' },
];
afterEach(() => vi.unstubAllGlobals());
it('offers only visible safe app choices, excluding the desk and fallback home', () => {
  expect(appChoices(list)).toEqual([
    { action: { op: 'app', id: 'food' }, label: 'Tango Food', confirmation: 'Opened Tango Food.' },
    { action: { op: 'app', id: 'lift' }, label: 'Tango Lift', confirmation: 'Opened Tango Lift.' },
  ]);
  expect(appChoices([{ id: 'My_app', name: 'Custom', path: '/custom/' }])[0].action).toEqual({ op: 'app', id: 'My_app' });
  expect(appChoices([{ id: 'home', name: 'Tango home', path: '/' }])).toEqual([]);
  for (const bad of [null, {}, 'bad', [null, { name: 'No id', path: '/' }]]) expect(appChoices(bad)).toEqual([]);
});
it.each([['switch to Food', 'food'], ['go to Lift', 'lift']])('resolves %s through the catalog and executes its safe path', async (text, id) => {
  const store = createStore({}), context = browserContext(store, list);
  expect(commandCandidate(text)).toBe(true);
  expect(navigatorContext(context)).toEqual(context);
  const index = context.choices.findIndex((c: any) => c.action.id === id);
  const call = vi.fn(async () => JSON.stringify({ status: 'action', index, action: { op: 'app', id: 'unsafe' } }));
  const resolution = await resolveNavigator(text, context, call);
  expect(resolution.action).toEqual({ op: 'app', id });
  expect(call.mock.calls[0][0].input[0].text).toContain(text);
  const navigateApp = vi.fn();
  expect(await executeNavigator(store, resolution, context, { apps: async () => list, navigateApp })).toBe(true);
  expect(navigateApp).toHaveBeenCalledWith(list.find(a => a.id === id)!.path);
});
it('refuses stale, hidden, unsafe or invented destinations at execution', async () => {
  const store = createStore({}), context = browserContext(store, list), navigateApp = vi.fn();
  for (const apps of [[], [{ ...list[1], hidden: true }], [{ ...list[1], path: '//elsewhere.test/' }]]) {
    expect(await executeNavigator(store, { action: { op: 'app', id: 'food' } }, context, { apps: async () => apps, navigateApp })).toBe(false);
  }
  expect(await executeNavigator(store, { action: { op: 'app', id: 'other' } }, context, { apps: async () => list, navigateApp })).toBe(false);
  expect(navigateApp).not.toHaveBeenCalled();
  expect(sameNavigatorAction({ op: 'app', id: 'food' }, { op: 'app', id: 'lift' })).toBe(false);
  for (const action of [{ op: 'app', id: 'food', target: '/' }, { op: 'app', id: 'x'.repeat(257) }, { op: 'app', id: '' }]) expect(validNavigatorAction(action)).toBe(false);
});
it('shares an in-flight list request and keeps ordinary choices when a bad response yields no apps', async () => {
  let now = 0;
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => list }));
  const load = createAppListCache(fetcher, () => now);
  const [menu, navigator] = await Promise.all([load(), load()]);
  expect(menu).toBe(navigator); expect(load.peek()).toBe(menu); expect(fetcher).toHaveBeenCalledOnce();
  now = 300_001; fetcher.mockResolvedValue({ ok: true, json: async () => ({ bad: true }) } as never);
  const store = createStore({}), context = browserContext(store, await load());
  expect(context.choices.some((c: any) => c.action.op === 'app')).toBe(false);
  expect(context.choices.some((c: any) => c.action.op === 'back')).toBe(true);
  store.nextBack = vi.fn();
  expect(await executeNavigator(store, { action: { op: 'back', target: '' } }, context)).toBe(true);
  expect(store.nextBack).toHaveBeenCalledOnce();
});
