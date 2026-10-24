# Desk voice: dictation by default, Focus for a spoken back-and-forth

Status: direction from the owner (2026-10-22), refinements below. Changes the
reply-box mic from `docs/specs/desk-voice-composer.md`. Build after the top-right
navigator (`desk-voice-navigator.md`) lands, since both touch the same voice files.

## The owner's direction

- The reply-box mic is **dictation by default**: what you say goes into the box,
  and the send behaves exactly like the Send button, using your remembered
  Send / Send & stay choice (normally back to the list). Nothing is spoken back.
- A **Focus** toggle beside the mic, **off by default**. You can turn it on before
  or while dictating. With Focus on, voice stays on in that thread: the reply is
  read to you and you can answer by voice, back and forth.

## Refinements

1. **Dictation (Focus off)**
   - It ends your turn when you pause (the owner kept this), shows the 3-second
     undo, then sends the same way Send does.
   - The pause is detected on the desk server from the mic's own audio (about
     1.5 seconds of quiet after speech, once words have been transcribed), the
     same rule as the Mac app. The voice model's own end-of-turn also counts,
     but it doesn't always come, so the desk doesn't wait for it.
   - The mic closes once it sends.
   - The "Queued" note right after a send isn't seen in the usual case, because
     you're back on the list.
2. **Focus on**
   - It stays on the thread, ignoring Send & stay, because leaving would end the
     session.
   - **While the thread works, the mic is closed**, so no TV or room noise is picked
     up. The reply is read in the thread's own voice. **Then the mic reopens** for
     your next turn.
   - Focus ends when you turn the toggle off, press Esc, leave the thread or lock
     the phone, or when you say nothing for **30 seconds** after a reply.
     When it ends, voice is off; the toggle resets to off.
3. **One clear status strip** in the reply box while voice is active, in plain words:
   - the strip: "Listening…" · "Sending in 3s · Undo" · "Sent · waiting for the
     reply" · "Reading the reply" · "Your turn";
   - its one control: "Stop listening";
   - the thread's own Stop button keeps its own label, "Stop the turn", so the two
     no longer look alike.
   - "Queued" reads "Sent · starts shortly" while Focus is on.
4. **The toggle**
   - A small "Focus" pill that appears next to the mic once the mic is active.
     It's off each time; it isn't remembered.
   - Tapping it while dictating switches that exchange into Focus before it sends.
5. **Approvals stay off** in Focus too. Spoken words become a reply, never an
   approval or decision answer (standing voice rule).

## New threads (the Start work sheet)

Owner direction (2026-10-22): voice also works when starting a new thread
(`StartWorkSheet` in `apps/screen/public/desk/start-work.js`).

- The same mic sits in the sheet's message box (beside its attachment icon if it has one).
- **Default: dictation.** What you say fills the message. When you pause, the
  3-second undo shows, then it starts the thread exactly as the sheet's Start
  button does, with the project/role/where already chosen in the sheet.
- **Toggle: "Send and go to Focus"**, off by default. The pill sits beside the mic
  where Focus would be (there is no thread to focus yet). With it on, the
  thread is started, the desk opens it, and Focus is already on there: the mic
  stays closed while the new thread works its first turn, reads that reply, and
  then reopens.
- Starting a thread by voice obeys every limit Start work already has; voice
  adds no new way to start one.

## Open to the owner

- Should Focus be remembered per thread, or stay off every time (current: off
  every time, as asked)?
- Is the 30-second idle timeout after a reply the right length?
