/* Transport-independent audio boundaries and complete mono PCM WAV encoding. */
export const MAX_CHUNK_SECONDS = 45;
export const MIN_CHUNK_SECONDS = 8;
export const SILENCE_SECONDS = 1.2;

export function wav(parts, sampleRate) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const bytes = new ArrayBuffer(44 + length * 2);
  const view = new DataView(bytes);
  const label = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  label(0, "RIFF"); view.setUint32(4, 36 + length * 2, true); label(8, "WAVE");
  label(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, "data"); view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const part of parts) for (const sample of part) {
    view.setInt16(offset, Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), true);
    offset += 2;
  }
  return new Blob([bytes], { type: "audio/wav" });
}

export class Chunker {
  constructor(rate, emit) {
    this.rate = rate; this.emit = emit; this.parts = []; this.samples = 0;
    this.silence = 0; this.speech = false; this.totalSamples = 0;
  }
  get elapsed() { return this.totalSamples / this.rate; }
  push(part) {
    // Process bounded blocks, retaining every sample including leading/trailing
    // quiet audio. Quiet-only chunks are still transcribed: volume is not proof
    // of no speech, especially for quiet speakers.
    this.parts.push(part); this.samples += part.length; this.totalSamples += part.length;
    const rms = Math.sqrt(part.reduce((sum, sample) => sum + sample * sample, 0) / part.length);
    if (rms > .003) { this.silence = 0; this.speech = true; }
    else this.silence += part.length / this.rate;
    if (this.samples / this.rate >= MAX_CHUNK_SECONDS || this.samples * 2 >= 12 * 1024 * 1024 ||
        this.samples / this.rate >= MIN_CHUNK_SECONDS && this.silence >= SILENCE_SECONDS) this.flush();
  }
  flush() {
    if (!this.samples) return;
    const duration = this.samples / this.rate;
    this.emit({ audio: wav(this.parts, this.rate), duration, start: (this.totalSamples - this.samples) / this.rate,
      end: this.elapsed, overlap: 0, quiet: !this.speech });
    this.parts = []; this.samples = 0; this.silence = 0; this.speech = false;
  }
}

export async function microphone(onChunk, onFailure) {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error("Dictate draft needs microphone access and AudioWorklet on localhost or HTTPS.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  let context, node, source, gain, closed = false;
  try {
    context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule("/static/draft-audio-worklet.js");
    const chunker = new Chunker(context.sampleRate, onChunk);
    node = new AudioWorkletNode(context, "verwrity-draft-pcm");
    source = context.createMediaStreamSource(stream);
    gain = context.createGain(); gain.gain.value = 0;
    source.connect(node); node.connect(gain); gain.connect(context.destination);
    let flushed;
    node.port.onmessage = event => {
      if (event.data === "flushed") { chunker.flush(); flushed?.(); }
      else chunker.push(event.data);
    };
    stream.getTracks().forEach(track => track.addEventListener("ended", () => { if (!closed) onFailure("Microphone disconnected. Completed chunks are retained."); }));
    node.onprocessorerror = () => onFailure("Audio processing stopped. Review retained chunks before resuming.");
    context.onstatechange = () => {
      if (!closed && context.state !== "running") onFailure("Audio input was interrupted. Review the last chunk before resuming.");
    };
    await context.resume();
    return {
      boundary: () => chunker.flush(),
      elapsed: () => chunker.elapsed,
      close: async () => {
        if (closed) return;
        closed = true;
        // Flush the worklet's sub-block before closing, preserving the last word.
        let timeout;
        const complete = await Promise.race([new Promise(resolve => { flushed = () => resolve(true); node.port.postMessage("flush"); }),
          new Promise(resolve => { timeout = setTimeout(() => resolve(false), 500); })]);
        clearTimeout(timeout);
        if (!complete) onFailure("The audio device could not flush its final block. The last fraction of a second may be missing; review the last chunk.");
        chunker.flush();
        source.disconnect(); node.disconnect(); gain.disconnect();
        stream.getTracks().forEach(track => track.stop());
        await context.close();
      },
    };
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    if (context) await context.close();
    throw error;
  }
}
