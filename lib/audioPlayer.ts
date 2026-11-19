// Plays the 24 kHz 16-bit PCM chunks that Gemini sends, back-to-back with no gaps.
export class PcmPlayer {
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private ctx: AudioContext,
    private onIdle: () => void,
  ) {}

  get playing() {
    return this.sources.size > 0;
  }

  enqueue(base64: string, sampleRate = 24000) {
    // Plain loop: much faster than Uint8Array.from(str, fn) for ~10 KB chunks arriving many times a second.
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
    if (pcm.length === 0) return;

    const buffer = this.ctx.createBuffer(1, pcm.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);

    // When playback starts (or the queue ran dry on a slow network), begin 120 ms ahead so a
    // little audio is buffered; after that, chunks are scheduled back-to-back with no gaps.
    const now = this.ctx.currentTime;
    const startAt = this.nextTime > now + 0.02 ? this.nextTime : now + 0.12;
    src.start(startAt);
    this.nextTime = startAt + buffer.duration;

    this.sources.add(src);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0) {
        // Wait a moment in case the next chunk is still arriving over the network.
        this.idleTimer = setTimeout(() => this.sources.size === 0 && this.onIdle(), 300);
      }
    };
  }

  /** Stop immediately (user interrupted, or session ended). */
  stop() {
    for (const src of this.sources) {
      src.onended = null;
      try {
        src.stop();
      } catch {}
    }
    this.sources.clear();
    this.nextTime = 0;
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }
}

export function int16ToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
