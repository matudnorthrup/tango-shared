export const HOME = { id: 'home', name: 'Tango home', path: '/', icon: 'home' };
export const safePath = (path) => typeof path === 'string' && /^\/(?!\/)/.test(path) && !/[\\\s\u0000-\u001f\u007f]/.test(path);

/** One cache per page, shared by switcher triggers and the navigator. Failures retry on next open. */
export function createAppListCache(fetcher = (...args) => fetch(...args), now = () => Date.now()) {
  let cached, fetchedAt, pending;
  const load = async () => {
    if (cached && now() - fetchedAt < 300_000) return cached;
    if (!pending) pending = (async () => {
      const response = await fetcher('/apps.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('App list unavailable');
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('Invalid app list');
      const apps = data.filter(app => app && !app.hidden && typeof app.name === 'string' && safePath(app.path));
      if (!apps.length) throw new Error('Empty app list');
      cached = apps;
      fetchedAt = now();
      return cached;
    })().catch(() => { return [HOME]; }).finally(() => { pending = null; });
    return pending;
  };
  load.peek = () => cached || [];
  return load;
}
export const loadApps = createAppListCache();
