import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error browser module
import { appVoiceCommand, createAppVoiceAdapter } from '../public/desk/app-voice.js';
// @ts-expect-error browser module
import { claimVoice, releaseVoice } from '../public/desk/voice-owner.js';
const list = [{ id: 'lift', name: 'Tango Lift', path: '/lift/', agent: 'coach' }, { id: 'kilo', name: 'Kilo Ledger', path: '/kilo/', agent: 'budget' }];
afterEach(() => vi.useRealTimers());
it('maps navigation phrases to id-only navigator actions and leaves dictation alone', () => {
 for (const text of ['go to Kilo', 'please switch to Kilo Ledger.', 'take me to kilo']) expect(appVoiceCommand(text, list).action).toEqual({ op: 'app', id: 'kilo' });
 expect(appVoiceCommand('log three sets of bench at 185', list)).toBeNull();
 expect(appVoiceCommand('go to Kilo', [{ ...list[1], hidden: true }]).action).toBeNull();
 expect(appVoiceCommand('go to Kilo', [{ ...list[1], path: '//outside.invalid' }]).action).toBeNull();
});
function fixture(request = vi.fn()) {
 const caption = vi.fn(), notify = vi.fn(), navigateApp = vi.fn();
 const store = createAppVoiceAdapter({ app: list[0], itemId: 'home', caption, notify, request, apps: async () => list, navigateApp });
 return { store, caption, notify, request, navigateApp };
}
it('navigates through the guarded catalog without posting an agent message', async () => {
 const f = fixture(); f.store.setDraft('home', 'go to Kilo');
 expect(await f.store.sendReply('home')).toEqual({ status: 'sent' });
 expect(f.navigateApp).toHaveBeenCalledWith('/kilo/'); expect(f.request).not.toHaveBeenCalled(); f.store.dispose();
});
it('posts an ordinary reply and shows only new agent captions in this app, even without Focus', async () => {
 const request = vi.fn().mockResolvedValueOnce({ messages: [{ messageId: 'old', author: 'agent', text: 'Old' }] }).mockResolvedValueOnce({ status: 'sent' }).mockResolvedValueOnce({ item: { agentName: 'Coach' }, messages: [{ messageId: 'new', author: 'agent', text: 'Logged three sets.' }] });
 const f = fixture(request); f.store.setDraft('home', 'log three sets');
 expect(await f.store.sendReply('home')).toEqual({ status: 'sent' }); await Promise.resolve();
 expect(request.mock.calls[1][0]).toBe('commands'); expect(request.mock.calls[1][1]).toMatchObject({ type: 'reply', itemId: 'home', args: { text: 'log three sets' } });
 expect(f.caption).toHaveBeenLastCalledWith({ speaker: 'agent', name: 'Coach', text: 'Logged three sets.' }); f.store.dispose();
});
it('does not retry an uncertain send or discard its words', async () => {
 const f = fixture(vi.fn().mockResolvedValueOnce({ messages: [] }).mockRejectedValueOnce(new Error('lost response')));
 f.store.setDraft('home', 'log three sets'); expect(await f.store.sendReply('home')).toMatchObject({ transport: true });
 expect(f.store.draftFor()).toBe('log three sets'); expect(f.notify).toHaveBeenCalledWith(expect.stringContaining('could not be confirmed')); expect(f.request).toHaveBeenCalledTimes(2); f.store.dispose();
});
it('a second voice claim cancels the first and stale release cannot release the new owner', () => {
 const first = { cancel: vi.fn() }, second = { cancel: vi.fn() }, third = { cancel: vi.fn() };
 claimVoice(first); claimVoice(second); expect(first.cancel).toHaveBeenCalledOnce(); releaseVoice(first); claimVoice(third); expect(second.cancel).toHaveBeenCalledOnce(); releaseVoice(third);
});
