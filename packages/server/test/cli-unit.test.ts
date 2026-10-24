import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { serviceCommand } from '../src/cli.js';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('handles ownership, service state, errors and actions without output', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('test-token');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let mode = 'managed', state = 'stopped', ok = true;
    const request = vi.fn(async (url: string, options: RequestInit) => {
        expect(options.headers).toEqual({ Authorization: 'Bearer test-token' });
        return { ok: true, json: async () => url.endsWith('/services') ? { services: [{ id: 'a', mode, state }] } : { ok } };
    });
    vi.stubGlobal('fetch', request);
    expect(await serviceCommand(['managed', 'a'])).toBe(0);
    expect(await serviceCommand(['status', 'a'])).toBe(1);
    state = 'running';
    expect(await serviceCommand(['status', 'a'])).toBe(0);
    for (const action of ['start', 'stop', 'restart']) {
        expect(await serviceCommand([action, 'a'])).toBe(0);
        expect(request.mock.lastCall?.[0]).toMatch(new RegExp(`/services/a/${action}$`));
        expect(request.mock.lastCall?.[1].method).toBe('POST');
    }
    ok = false;
    expect(await serviceCommand(['restart', 'a'])).toBe(1);
    mode = 'observe';
    expect(await serviceCommand(['managed', 'a'])).toBe(1);
    expect(await serviceCommand(['restart', 'a'])).toBe(1);
    expect(await serviceCommand(['managed', 'unknown'])).toBe(1);
    expect(await serviceCommand(['status', 'unknown'])).toBe(4);
    expect(await serviceCommand(['restart'])).toBe(2);
    request.mockRejectedValue(new Error('unavailable'));
    expect(await serviceCommand(['managed', 'a'])).toBe(3);
    expect(await serviceCommand(['restart', 'a'])).toBe(3);
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});
