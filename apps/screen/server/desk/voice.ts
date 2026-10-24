import { voiceHistoryCapture } from './voice-history.js';
import type { DictationHistoryStore } from './dictation-history-store.js';
import { NavigatorBridge } from './navigator-bridge.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { loadLayeredV2AgentConfigs } from '@tango/core';
import { resolveLiveRoute } from '@tango/tango-voice/live/create-live-client';
import { loadOperatorProfiles, selectOperatorProfile } from '@tango/tango-voice/live/operator-profile';
import { createCodexResponsesCaller } from '@tango/tango-voice/live/responses-caller';
import { registerVoiceEvents } from './voice-events.js';
import { NavigatorExchange } from './navigator-exchange.js';
import { navigatorContext, resolveNavigator } from './navigator-resolver.js';
import { VoiceExchange, pickThreadVoice, type VoiceSnapshot } from './voice-exchange.js';

export interface DeskVoiceOptions {
  dataDir: string;
  dictationHistory?: DictationHistoryStore;
  item(id: string): { agentId: string; place?: string | null; replyable?: boolean; disposition?: string } | null;
  snapshot(id: string): VoiceSnapshot;
}
export function voiceSetup(id: string, options: DeskVoiceOptions) {
  const item = options.item(id);
  if (!item || item.replyable === false || (item.disposition && item.disposition !== 'active')) throw new Error('This thread is not replyable.');
  const profile = selectOperatorProfile(loadOperatorProfiles(), process.env.SCREEN_VOICE_OPERATOR);
  if (profile.auth !== 'codex' && !profile.auth.startsWith('codex:')) throw new Error('Desk voice requires the ChatGPT subscription route.');
  const route = resolveLiveRoute(profile.auth, '');
  const override = loadLayeredV2AgentConfigs().get(item.agentId)?.voice?.liveVoice;
  return { route, voice: pickThreadVoice(id, profile.voice ?? route.defaultVoice, override) };
}
export function dictationSetup() {
  const { route, voice } = navigatorSetup();
  return { route, voice };
}
export function navigatorSetup() {
  const profile = selectOperatorProfile(loadOperatorProfiles(), process.env.SCREEN_VOICE_OPERATOR);
  if (profile.auth !== 'codex' && !profile.auth.startsWith('codex:')) throw new Error('Desk voice requires the ChatGPT subscription route.');
  const route = resolveLiveRoute(profile.auth, '');
  return { route, voice: profile.voice ?? route.defaultVoice,
    call: createCodexResponsesCaller({ codexHome: profile.auth.startsWith('codex:') ? profile.auth.slice(6) : undefined }) };
}
const bridges = new WeakMap<Hono, NavigatorBridge>();
/** Called within the normal Hono auth middleware, both for metadata and upgrade authorization. */
export function registerVoiceRoute(app: Hono, options: DeskVoiceOptions) {
  registerVoiceEvents(app, options.dataDir);
  const bridge = new NavigatorBridge((text, context) => resolveNavigator(text, context, navigatorSetup().call));
  bridges.set(app, bridge); bridge.register(app);
  app.get('/api/desk/voice', c => {
    try { return c.json({ voice: (c.req.query('mode') === 'navigator' ? navigatorSetup() : c.req.query('mode') === 'dictation' ? dictationSetup() : voiceSetup(c.req.query('item') ?? '', options)).voice }); }
    catch (error) { return c.json({ error: error instanceof Error && error.message.includes('subscription route') ? error.message : 'Voice is unavailable for this thread.' }, 503); }
  });
}
export function attachDeskVoice(server: Server, app: Hono, options: DeskVoiceOptions) {
  const closeBridge = bridges.get(app)?.attach(server, app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 524_288 });
  const exchanges = new Set<VoiceExchange | NavigatorExchange>();
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/desk/navigator/bridge') return;
    if (url.pathname !== '/api/desk/voice') { socket.destroy(); return; }
    // WebSocket handshakes bypass HTTP middleware unless we explicitly run it.
    if (!req.headers.origin) { socket.destroy(); return; }
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const response = await app.fetch(new Request(`http://${req.headers.host}${req.url}`, { headers }));
      if (!response.ok) { socket.write(`HTTP/1.1 ${response.status} Forbidden\r\nConnection: close\r\n\r\n`); socket.destroy(); return; }
      const id = url.searchParams.get('item') ?? '';
      const navigator = url.searchParams.get('mode') === 'navigator';
      const dictation = url.searchParams.get('mode') === 'dictation';
      const warm = dictation && url.searchParams.get('manualFinish') === '1' && url.searchParams.get('warm') === '1';
      const setup = navigator ? navigatorSetup() : dictation ? dictationSetup() : voiceSetup(id, options);
      const { route, voice } = setup;
      wss.handleUpgrade(req, socket, head, ws => {
        mkdirSync(join(options.dataDir, 'voice'), { recursive: true });
        const logFile = join(options.dataDir, 'voice', `${randomUUID()}.jsonl`);
        const transport = {
          voice, create: () => route.create(),
          json: (value: Record<string, unknown>) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value)); },
          audio: (pcm: Buffer) => { if (ws.readyState === ws.OPEN && ws.bufferedAmount < 240_000) ws.send(pcm); },
          log: (kind: string, data?: Record<string, unknown>) => appendFileSync(logFile, JSON.stringify({ at: Date.now(), kind, ...data }) + '\n', { mode: 0o600 }),
          disconnect: () => { exchanges.delete(exchange); ws.close(); },
        };
        const exchange = navigator ? new NavigatorExchange({ ...transport,
          resolve: (text, context) => resolveNavigator(text, context, (setup as ReturnType<typeof navigatorSetup>).call),
        }) : new VoiceExchange({ ...transport, capture: voiceHistoryCapture(headers, url, options.dictationHistory, dictation ? undefined : options.item(id)?.place || 'Conversation'), manualFinish: dictation && url.searchParams.get('manualFinish') === '1', snapshot: () => dictation ? { working: false, replyId: '', text: '' } : options.snapshot(id) });
        exchanges.add(exchange);
        ws.on('message', (data, binary) => {
          if (binary) { exchange.input(Buffer.from(data as Buffer)); return; }
          try {
            const event = JSON.parse(String(data));
            if (exchange instanceof NavigatorExchange) {
              if (event.type === 'context') exchange.setContext(navigatorContext(event.context));
              else if (event.type === 'executed') void exchange.acknowledge(event.ok === true);
              else if (event.type === 'stop') exchange.end('browser stopped');
              return;
            }
            if (event.type === 'start' && warm && exchange.state === 'armed') void exchange.start();
            else if (event.type === 'pause') exchange.requestPause(event.quietMs, event.id);
            else if (event.type === 'finish') exchange.finishInput();
            else if (event.type === 'sent' && !dictation) exchange.arm();
            else if (event.type === 'delivered' && !dictation) exchange.delivered(event.ok === true);
            else if (event.type === 'resume' && !dictation) exchange.resume();
            else if (event.type === 'stop') exchange.end('browser stopped');
          } catch { exchange.end('invalid frame'); }
        });
        ws.on('close', () => exchange.end('browser disconnected'));
        ws.on('error', () => exchange.end('socket error'));
        if (exchange instanceof VoiceExchange) {
          if (warm) exchange.warm();
          else void exchange.start(!dictation && url.searchParams.get('watch') === '1');
        }
        else void exchange.start();
      });
    } catch { socket.destroy(); }
  });
  return () => { closeBridge?.(); for (const exchange of exchanges) exchange.end('server shutdown'); wss.close(); };
}
