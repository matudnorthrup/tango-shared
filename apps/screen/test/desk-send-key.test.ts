import { describe, expect, it } from 'vitest';
import { isSendKey } from '../public/desk/util.js';

const key = (init: Partial<KeyboardEvent>, tagName = 'TEXTAREA') =>
  ({ key: 'Enter', code: 'Enter', metaKey: false, ctrlKey: false, target: { tagName }, ...init }) as unknown as KeyboardEvent;

describe('isSendKey', () => {
  it('sends on ⌘↵, Ctrl+↵, and the keypad Enter alone', () => {
    expect(isSendKey(key({ metaKey: true }))).toBe(true);
    expect(isSendKey(key({ ctrlKey: true }))).toBe(true);
    expect(isSendKey(key({ code: 'NumpadEnter' }))).toBe(true);
  });

  it('leaves the keypad Enter to buttons and selects (Codex review on #508)', () => {
    expect(isSendKey(key({ code: 'NumpadEnter' }, 'BUTTON'))).toBe(false);
    expect(isSendKey(key({ code: 'NumpadEnter' }, 'SELECT'))).toBe(false);
    expect(isSendKey(key({ metaKey: true }, 'BUTTON'))).toBe(true);
  });

  it('leaves plain Return as a newline', () => {
    expect(isSendKey(key({}))).toBe(false);
    expect(isSendKey(key({ key: 'a', code: 'KeyA', metaKey: true }))).toBe(false);
  });
});
