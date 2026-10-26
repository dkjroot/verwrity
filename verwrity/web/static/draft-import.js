/* Read bounded WAV sections produced incrementally by Python. */
function audioSection(packet) {
  if (typeof packet.audio !== "string" || packet.audio.length > 2 * 1024 * 1024 ||
      !Number.isFinite(packet.start) || !Number.isFinite(packet.end) || packet.start < 0 || packet.end <= packet.start ||
      typeof packet.quiet !== "boolean") throw new Error("Invalid audio section from conversion.");
  const bytes = Uint8Array.from(atob(packet.audio), char => char.charCodeAt(0));
  const buffer = bytes.buffer, view = new DataView(buffer);
  const label = offset => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (buffer.byteLength < 44 || label(0) !== "RIFF" || label(8) !== "WAVE" || label(12) !== "fmt " ||
      view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
      view.getUint32(24, true) !== 16000 || view.getUint16(34, true) !== 16 || label(36) !== "data" ||
      view.getUint32(40, true) !== buffer.byteLength - 44 || (buffer.byteLength - 44) % 2 ||
      Math.abs((packet.end - packet.start) - (buffer.byteLength - 44) / 32000) > .000001) {
    throw new Error("Audio conversion returned an unexpected format. Restart Verwrity and retry the original file.");
  }
  return { audio: new Blob([bytes], { type: "audio/wav" }), duration: packet.end - packet.start,
    start: packet.start, end: packet.end, quiet: packet.quiet, overlap: 0 };
}

export async function readImportedAudio(response, accept, cancelled = () => false) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = "", done = false, elapsed = 0, count = 0;
  const check = () => { if (cancelled()) throw new DOMException("Audio import cancelled", "AbortError"); };
  try {
    while (true) {
      check();
      let timeout;
      const next = await Promise.race([reader.read(), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Audio conversion stopped responding.")), 120000);
      })]).finally(() => clearTimeout(timeout));
      text += decoder.decode(next.value || new Uint8Array(), { stream: !next.done });
      let newline;
      while ((newline = text.indexOf("\n")) >= 0) {
        check();
        const line = text.slice(0, newline); text = text.slice(newline + 1);
        if (!line.trim()) continue;
        if (line.length > 2 * 1024 * 1024 || done) throw new Error("Invalid audio conversion stream.");
        const packet = JSON.parse(line);
        if (packet.error) throw new Error(packet.error);
        if (packet.done === true) { done = true; continue; }
        const section = audioSection(packet);
        if (Math.abs(section.start - elapsed) > .000001 || ++count > 500) throw new Error("Audio sections are out of sequence or exceed the buffer limit.");
        await accept(section);
        check();
        elapsed = section.end;
      }
      if (text.length > 2 * 1024 * 1024) throw new Error("Oversized audio conversion section.");
      if (next.done) break;
    }
    if (!done || text.trim() || !count) throw new Error("Audio conversion was interrupted before completion.");
    return { duration: elapsed, count };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
