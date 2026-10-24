import { choiceLabel, type RoutedInput } from './hub.js';
import type { Scene } from './store.js';

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The user turn a tap becomes: what was tapped, on which scene, plus any data the scene sent. */
export function sceneTapMessage(scene: Scene, input: Pick<RoutedInput, 'type' | 'data'>): string {
  const name = clip(scene.title || scene.summary, 80);
  const where = `your screen “${name}” (slot \`${scene.slot}\`)`;
  const label = input.type === 'choice' ? choiceLabel(scene, input.data) : undefined;
  if (label) return `[Screen] I tapped “${label}” on ${where}.`;
  const data = Object.keys(input.data ?? {}).length ? `\n\n\`\`\`json\n${clip(JSON.stringify(input.data, null, 2), 4000)}\n\`\`\`` : '';
  return `[Screen] ${where} sent \`${input.type}\`.${data}`;
}

// Scenes staged from a Loom thread (`tango-screen` run there, TANGO_DESK_ITEM): their conversationKey is
// the thread's desk item id, `loom:<threadId>`, so they link to that item the same way. A tap is a new
// user turn in the thread (Loom queues it while the thread is busy).

const LOOM_PREFIX = 'loom:';

export function loomSceneItemId(scene: Pick<Scene, 'conversationKey'>): string | null {
  const key = scene.conversationKey ?? '';
  return key.startsWith(LOOM_PREFIX) && key.length > LOOM_PREFIX.length ? key : null;
}

/** Posts the tap into the scene's Loom thread through `reply` (the desk's Loom source). */
export async function routeLoomInput(
  reply: ((itemId: string, text: string, commandId?: string) => Promise<{ ok: true } | { ok: false; error: string; unknown?: boolean }>) | null,
  scene: Scene,
  input: RoutedInput,
): Promise<string> {
  const itemId = loomSceneItemId(scene);
  if (!itemId) return 'failed:not-a-loom-scene';
  if (!reply) return 'failed:no Loom on this desk';
  try {
    const result = await reply(itemId, sceneTapMessage(scene, input), input.commandId);
    if (result.ok) return 'agent';
    return result.unknown ? `unknown:${result.error}` : `failed:${result.error}`;
  } catch (err) {
    return `failed:${(err as Error).message}`;
  }
}

/** Retired scenes go directly to the retirement refusal, never through voice interpretation. */
export function directCodingScene(scene: Pick<Scene, 'conversationKey'>): boolean {
  return scene.conversationKey?.startsWith('t3:') === true || loomSceneItemId(scene) !== null;
}
