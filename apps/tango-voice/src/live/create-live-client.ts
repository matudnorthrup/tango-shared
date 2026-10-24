import { homedir } from 'node:os';
import { join } from 'node:path';
import { CodexLiveClient } from './codex-live-client.js';
import { GptLiveClient, type LiveSessionClient } from './gpt-live-client.js';

export interface LiveRoute {
  label: string;
  defaultVoice: string;
  create(): LiveSessionClient;
}

/**
 * "api" bills the OpenAI Platform key (gpt-live-1, $0.05/min).
 * "codex" or "codex:<CODEX_HOME>" uses a ChatGPT subscription login (gpt-live-1-codex).
 */
export function resolveLiveRoute(spec: string, apiKey: string): LiveRoute {
  if (spec === 'api') {
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for --auth api');
    return { label: 'OpenAI API (gpt-live-1)', defaultVoice: 'compass', create: () => new GptLiveClient({ apiKey }) };
  }
  if (spec === 'codex' || spec.startsWith('codex:')) {
    const codexHome = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : join(homedir(), '.codex');
    return {
      label: `ChatGPT subscription via ${codexHome} (gpt-live-1-codex)`,
      defaultVoice: 'cove',
      create: () => new CodexLiveClient({ codexHome }),
    };
  }
  throw new Error(`Unknown --auth "${spec}" (use api, codex, or codex:<CODEX_HOME>)`);
}
