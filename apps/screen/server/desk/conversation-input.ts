/** A transport choice, kept explicit so the shadow desk never changes its write path. */
export function conversationInputUrl(base: string, type: unknown, mode: string | undefined): string {
  return mode === 'tango' ? new URL(type === 'start' ? '/conversations/start' : '/conversations/turn', base).href : base;
}
