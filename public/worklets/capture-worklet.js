// Runs on the audio thread. Converts mic audio (usually 44.1k/48k float) into
// 16 kHz 16-bit PCM chunks of ~100 ms and posts them to the main thread.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0; // fractional read position into incoming audio
    this.chunk = new Int16Array(1600); // 100 ms at 16 kHz
    this.fill = 0;
    this.prev = 0; // last sample of the previous block, for interpolation
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;

    // Linear-interpolation resampler (good enough for speech).
    while (this.pos < input.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i === 0 ? this.prev : input[i - 1];
      const b = input[i];
      let s = a + (b - a) * frac;
      s = Math.max(-1, Math.min(1, s));
      this.chunk[this.fill++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.fill === this.chunk.length) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(1600);
        this.fill = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= input.length;
    this.prev = input[input.length - 1];
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
