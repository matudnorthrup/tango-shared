/**
 * Local energy endpointing for 24 kHz mono signed 16-bit little-endian PCM, the same rule as
 * the Mac app's SpeechPause.swift: the model's end-of-turn (a delegation) doesn't always come.
 * 120 ms above the greater of -40 dBFS or the tracked noise floor + 10 dB starts speech; a
 * 1.5-second pause after it ends the turn. Resumed speech needs 60 ms; shorter impulses don't
 * restart the pause. Keeps counters only, never audio.
 *
 * Audio often reaches it mid-sentence (the mic only streams once the voice connection is up), so
 * the first stretch can seed the floor with speech. A stretch of 120 ms above -40 dBFS heard before
 * any quiet is credited as speech once the floor under it is known, and the pause counts from its end.
 */
export class SpeechPause {
  private samples = 0;
  private energy = 0;
  private noiseFloor: number | null = null;
  private voicedWindows = 0;
  private quietWindows = 0;
  private window = 0;
  /** The current run above -40 dBFS before speech is confirmed: its length and quietest window. */
  private loudRun = 0;
  private loudMin = Infinity;
  /** The last such run of 120 ms or more: its quietest window and the window it ended on. */
  private early: { min: number; end: number } | null = null;
  heardSpeech = false;
  /** In a pause after speech now (1.5 s of quiet since the last voiced stretch). */
  paused = false;

  get trailingQuietMs(): number { return this.quietWindows * 20; }

  /** True when this chunk completes a pause after speech (once per pause). */
  append(pcm: Buffer): boolean {
    let ended = false;
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
      const sample = pcm.readInt16LE(offset) / 32768;
      this.energy += sample * sample; this.samples += 1;
      if (this.samples < 480) continue; // 20 ms, independent of chunk size.
      const power = this.energy / 480;
      this.samples = 0; this.energy = 0;
      // Track the lowest energy, with a slow upward drift (1 dB/sec), seeded from the input.
      this.noiseFloor = Math.max(Math.min(power, (this.noiseFloor ?? power) * 10 ** (0.02 / 10)), 1e-8);
      const voiced = power >= Math.max(0.0001, this.noiseFloor * 10);
      this.window += 1;
      if (!this.heardSpeech) {
        if (power >= 0.0001) { this.loudRun += 1; this.loudMin = Math.min(this.loudMin, power); }
        else {
          if (this.loudRun >= 6) this.early = { min: this.loudMin, end: this.window - 1 };
          this.loudRun = 0; this.loudMin = Infinity;
        }
        if (this.early && this.early.min >= this.noiseFloor * 10) {
          this.heardSpeech = true;
          this.quietWindows = this.window - 1 - this.early.end;
        }
      }
      if (this.heardSpeech) this.quietWindows += 1;
      if (voiced) {
        this.voicedWindows += 1;
        if (this.voicedWindows >= 6) this.heardSpeech = true;
        if (this.voicedWindows >= 3) { this.quietWindows = 0; this.paused = false; }
      } else this.voicedWindows = 0;
      if (this.quietWindows >= 75 && !this.paused) { this.paused = true; ended = true; }
    }
    return ended;
  }
}
