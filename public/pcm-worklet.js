class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.input = new Float32Array(0);
    this.position = 0;
    this.chunk = new Int16Array(1600);
    this.filled = 0;
    this.levelSum = 0;
    this.levelCount = 0;
  }

  process(inputs) {
    try {
      return this.handle(inputs);
    } catch (error) {
      this.port.postMessage({ type: "error", message: `${error.name}: ${error.message}` });
      return false;
    }
  }

  handle(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    for (let i = 0; i < channel.length; i++) {
      this.levelSum += channel[i] * channel[i];
    }
    this.levelCount += channel.length;
    if (this.levelCount >= 2048) {
      this.port.postMessage({ type: "level", value: Math.sqrt(this.levelSum / this.levelCount) });
      this.levelSum = 0;
      this.levelCount = 0;
    }

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
        this.port.postMessage({ type: "audio", buffer }, [buffer]);
        this.chunk = new Int16Array(1600);
        this.filled = 0;
      }
    }

    // The read position can land past the end of the buffer (e.g. ratio 3 at 48 kHz);
    // keep the fractional overshoot and only drop samples that actually exist.
    const drop = Math.min(Math.floor(this.position), this.input.length);
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
