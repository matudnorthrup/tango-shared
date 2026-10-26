import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error browser module
import { appMenuItems, AppSwitcher, createAppListCache } from '../public/desk/next/app-switcher.js';
// @ts-expect-error browser module
import { Breadcrumb } from '../public/desk/next/app.js';

type Node = { type: unknown; props?: Record<string, any> };
function nodes(value: any): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...nodes(value.props?.children)];
}
const apps = [
  { id: 'food', name: 'Food', path: '/food/', icon: 'food' },
  { id: 'desk', name: 'Desk', path: '/tango-screen/', icon: 'desk' },
];
const response = (data = apps) => ({ ok: true, json: async () => data });

describe('desk app menu', () => {
  it('keeps list order, checks Desk, appends home and navigates to the selected path', () => {
    const navigate = vi.fn();
    const items = appMenuItems(apps, navigate);
    expect(items.map((item: any) => [item.label, item.on])).toEqual([['Food', false], ['Desk', true], ['Tango home', false]]);
    items[0].onSelect();
    items[2].onSelect();
    expect(navigate.mock.calls).toEqual([['/food/'], ['/']]);
  });
  it('omits hidden and foreign paths, and never duplicates home', () => {
    const items = appMenuItems([...apps, { ...apps[0], hidden: true }, { ...apps[0], path: '//outside.example' }, { ...apps[0], path: '/\\outside.example' }, { id: 'home', name: 'Home', path: '/' }]);
    expect(items.map((item: any) => item.label)).toEqual(['Food', 'Desk', 'Home']);
  });
  it('shares an in-flight fetch, caches for five minutes, then refreshes', async () => {
    let now = 0;
    const fetcher = vi.fn(async () => response());
    const load = createAppListCache(fetcher, () => now);
    await Promise.all([load(), load()]);
    now = 299999;
    await load();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 300000;
    await load();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith('/apps.json', { cache: 'no-store' });
  });
  it.each(['network', 'http', 'json', 'empty'])('uses home-only fallback on %s failure and retries', async kind => {
    const fetcher = vi.fn(async () => {
      if (kind === 'network') throw new Error('offline');
      if (kind === 'http') return { ok: false };
      return response(kind === 'empty' ? [] : {} as any);
    });
    const load = createAppListCache(fetcher);
    expect(appMenuItems(await load()).map((item: any) => item.label)).toEqual(['Tango home']);
    fetcher.mockImplementation(async () => response());
    expect(await load()).toEqual(apps);
  });
  it('falls back to home on failure while retaining the last good list for voice and retrying', async () => {
    let now = 0;
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error('offline'));
    const load = createAppListCache(fetcher, () => now);
    await load();
    now = 300001;
    expect(appMenuItems(await load()).map((item: any) => item.label)).toEqual(['Tango home']);
    expect(load.peek()).toEqual(apps);
    fetcher.mockResolvedValueOnce(response());
    expect(await load()).toEqual(apps);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('phone breadcrumb app switcher', () => {
  const back = vi.fn();
  const store = { state: { nextRoute: { page: 'inbox' } }, threadOpen: () => true, nextBack: back };
  it('shows the logo at the root', () => {
    const tree = nodes(Breadcrumb({ store, crumbs: [{ label: 'Inbox' }], phone: true }));
    expect(tree.find(node => node.type === AppSwitcher)?.props?.phone).toBe(true);
    expect(tree.find(node => node.props?.class === 'nx-backc')).toBeUndefined();
  });
  it('keeps back in the logo spot on a child page', () => {
    const tree = nodes(Breadcrumb({ store, crumbs: [{ label: 'Inbox' }, { label: 'Thread' }], phone: true }));
    expect(tree.find(node => node.type === AppSwitcher)).toBeUndefined();
    const button = tree.find(node => node.props?.class === 'nx-backc');
    expect(button?.props?.['aria-label']).toBe('Back to Inbox');
    button?.props?.onClick();
    expect(back).toHaveBeenCalledOnce();
  });
});
