/* A continuous input stream: every PCM sample belongs to exactly one chunk.
 * No lossy restart, timeslice container assumptions or guessed text overlap. */
class DraftPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.used = 0;
    this.accepting = true;
    this.port.onmessage = event => {
      if (event.data === "flush") {
        this.accepting = false;
        if (this.used) this.port.postMessage(this.buffer.slice(0, this.used));
        this.port.postMessage("flushed");
      }
    };
  }
  process(inputs) {
    if (!this.accepting) return true;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      this.buffer[this.used++] = sample;
      if (this.used === this.buffer.length) {
        this.port.postMessage(this.buffer);
        this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor("verwrity-draft-pcm", DraftPCM);
