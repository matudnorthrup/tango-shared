import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';
import { z } from 'zod';
const positive = z.number().finite().positive();
const target = z.union([z.strictObject({ launchd: z.string().min(1) }), z.strictObject({ tmux: z.string().regex(/^[^:]+:[^:]+$/), socket: z.string().min(1).optional() })]);
const timing = { intervalSeconds: positive.default(10), graceSeconds: z.number().finite().nonnegative().default(10) };
const health = z.union([
    z.strictObject({ http: z.string().url().refine(v => /^https?:/.test(v)), ...timing }),
    z.strictObject({ port: z.number().int().min(1).max(65535), ...timing }),
    z.strictObject({ tmux: z.string().regex(/^[^:]+:[^:]+$/), socket: z.string().min(1).optional(), ...timing }),
    z.strictObject({ launchd: z.string().min(1), ...timing }),
    z.strictObject({ process: z.string().min(1).refine(v => { try {
            new RegExp(v);
            return true;
        }
        catch {
            return false;
        } }), ...timing }),
]);
export const serviceSchema = z.strictObject({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/), name: z.string().min(1), group: z.string().default('Services'),
    mode: z.enum(['observe', 'managed']).default('observe'), command: z.array(z.string()).min(1).optional(),
    cwd: z.string().optional(), env: z.record(z.string(), z.string()).default({}), dependsOn: z.array(z.string()).default([]),
    health: health.or(z.strictObject(timing)).default({}), restart: z.strictObject({ policy: z.enum(['always', 'on-failure', 'never']).default('on-failure'),
        backoffSeconds: positive.default(1), maxRestarts: z.number().int().nonnegative().default(5), windowSeconds: positive.default(300) }).default({ policy: 'on-failure', backoffSeconds: 1, maxRestarts: 5, windowSeconds: 300 }),
    budget: z.strictObject({ memoryMB: positive.optional(), cpuPct: positive.optional() }).default({}), adopt: target.optional(),
}).superRefine((s, ctx) => {
    if (!s.adopt && !['http', 'port', 'process', 'tmux', 'launchd'].some(key => key in s.health))
        ctx.addIssue({ code: 'custom', message: 'A health check or adoption target is required' });
    if (s.mode === 'managed' && (!s.command?.[0] || s.adopt))
        ctx.addIssue({ code: 'custom', message: 'Managed services require a command and cannot adopt' });
});
export type Service = z.infer<typeof serviceSchema>;
export const servicesSchema = z.strictObject({ services: z.array(serviceSchema) }).superRefine(({ services }, ctx) => {
    const seen = new Set<string>();
    for (const s of services) {
        if (seen.has(s.id))
            ctx.addIssue({ code: 'custom', message: `Duplicate service ${s.id}` });
        seen.add(s.id);
    }
    const visited = new Set<string>(), active = new Set<string>();
    const visit = (id: string) => {
        if (active.has(id)) {
            ctx.addIssue({ code: 'custom', message: `Dependency cycle at ${id}` });
            return;
        }
        if (visited.has(id))
            return;
        visited.add(id);
        active.add(id);
        for (const dep of services.find(s => s.id === id)!.dependsOn) {
            if (!seen.has(dep))
                ctx.addIssue({ code: 'custom', message: `Unknown dependency ${dep}` });
            else
                visit(dep);
        }
        active.delete(id);
    };
    services.forEach(s => visit(s.id));
});
function merge(a: unknown, b: unknown): unknown {
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
        const out = { ...a } as Record<string, unknown>;
        for (const [k, v] of Object.entries(b))
            out[k] = merge(out[k], v);
        return out;
    }
    return b;
}
export function loadServices(repoFile: string, profileFile?: string): Service[] {
    const layers = [repoFile, profileFile].filter((v): v is string => !!v).map(file => fs.existsSync(file) ? yaml.load(fs.readFileSync(file, 'utf8')) : { services: [] });
    const rows = new Map<string, unknown>();
    for (const raw of layers) {
        const layer = z.strictObject({ services: z.array(z.object({ id: z.string() }).passthrough()) }).parse(raw);
        const ids = new Set<string>();
        for (const row of layer.services) {
            if (ids.has(row.id))
                throw new Error(`Duplicate service ${row.id}`);
            ids.add(row.id);
            rows.set(row.id, merge(rows.get(row.id), row));
        }
    }
    return servicesSchema.parse({ services: [...rows.values()] }).services;
}
export function ensureToken(home: string): string {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = path.join(home, 'token');
    try {
        fs.writeFileSync(file, randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 });
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
            throw e;
    }
    fs.chmodSync(file, 0o600);
    const token = fs.readFileSync(file, 'utf8').trim();
    if (!token)
        throw new Error('Empty server token');
    return token;
}
