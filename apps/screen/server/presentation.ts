import type { Hono } from 'hono';
import { PRESENTATION_VIEWS, type Hub, type PresentationActor, type PresentationView } from './hub.js';

// The presentation hub's HTTP surface (agent-desk spec, "Screen model" and
// "Read API"): what every screen presents, and intents to change it. The state
// machine lives in the hub; this file only validates and maps results to HTTP.

const ACTORS: readonly PresentationActor[] = ['screen', 'director', 'agent'];

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function mountPresentation(app: Hono, hub: Hub): void {
  /** `{ view, itemId, conversationKey, sceneId, queue, by, since, manual, reason, screenAvailable }` */
  app.get('/api/desk/presentation', (c) => c.json(hub.publicPresentation()));

  /**
   * `{ view, itemId?, conversationKey?, sceneId?, prototypeId?, by: 'screen'|'director'|'agent', reason?, manual? }`
   * → `{ applied, queued?, ignored?, presentation }`. 400 for a malformed intent or one
   * with no conversation to act on; 404 for a scene that isn't live; 409 when the Screen
   * view has nothing staged for the conversation.
   */
  app.post('/api/desk/presentation', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'a JSON body is required' }, 400);
    const view = body.view as PresentationView;
    if (!PRESENTATION_VIEWS.includes(view)) return c.json({ error: `view must be one of ${PRESENTATION_VIEWS.join(', ')}` }, 400);
    const by = body.by as PresentationActor;
    if (!ACTORS.includes(by)) return c.json({ error: `by must be one of ${ACTORS.join(', ')}` }, 400);
    if (body.manual !== undefined && typeof body.manual !== 'boolean') return c.json({ error: 'manual must be a boolean' }, 400);
    const window = body.window as { id?: unknown; seq?: unknown; name?: unknown; screenId?: unknown } | undefined;
    const fromWindow =
      window && typeof window === 'object' && str(window.id) && Number.isSafeInteger(window.seq)
        ? { id: str(window.id)!, seq: window.seq as number, ...(str(window.name) ? { name: str(window.name)!.slice(0, 80) } : {}), ...(str(window.screenId) ? { screenId: str(window.screenId)!.slice(0, 40) } : {}) }
        : undefined;
    const result = hub.intent({
      view,
      by,
      itemId: str(body.itemId),
      conversationKey: str(body.conversationKey),
      sceneId: str(body.sceneId),
      prototypeId: str(body.prototypeId),
      reason: str(body.reason),
      manual: body.manual as boolean | undefined,
      window: fromWindow,
    });
    if (result.error === 'no-conversation') return c.json({ ...result, error: 'no conversation: pass conversationKey or a desk itemId' }, 400);
    if (result.error === 'unknown-scene') return c.json({ ...result, error: 'no live scene with that id' }, 404);
    if (result.error === 'no-scene') return c.json({ ...result, error: 'no scene is staged for this conversation' }, 409);
    if (result.error === 'unknown-prototype') return c.json({ ...result, error: 'no live prototype with that id' }, 404);
    if (result.error === 'no-prototype') return c.json({ ...result, error: 'no prototype is published for this conversation' }, 409);
    return c.json(result);
  });
}
