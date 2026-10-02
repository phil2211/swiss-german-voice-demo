class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.input = new Float32Array(0);
    this.position = 0;
    this.chunk = new Int16Array(1600);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    const next = new Float32Array(this.input.length + channel.length);
    next.set(this.input);
    next.set(channel, this.input.length);
    this.input = next;

    while (this.position + 1 < this.input.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const sample = this.input[index] * (1 - fraction) + this.input[index + 1] * fraction;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.chunk[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.position += this.ratio;

      if (this.filled === this.chunk.length) {
        const buffer = this.chunk.buffer;
        this.port.postMessage(buffer, [buffer]);
        this.chunk = new Int16Array(1600);
        this.filled = 0;
      }
    }

    const drop = Math.floor(this.position);
    if (drop > 0) {
      const rest = new Float32Array(this.input.length - drop);
      rest.set(this.input.subarray(drop));
      this.input = rest;
      this.position -= drop;
    }

    return true;
  }
}

registerProcessor("pcm-processor", PcmProcessor);
