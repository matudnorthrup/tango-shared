// Keep fractional sample position across render quanta, including devices that refuse 24 kHz.
class DeskCapture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = new Int16Array(2400); this.n = 0; this.phase = 0; }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) for (const sample of channel) {
      this.phase += 24000;
      while (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        const value = Math.max(-1, Math.min(1, sample));
        this.samples[this.n++] = value < 0 ? value * 32768 : value * 32767;
        if (this.n === 2400) {
          this.port.postMessage(this.samples.buffer.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('desk-capture', DeskCapture);
