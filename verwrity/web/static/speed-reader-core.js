// View-only grouping uses canonical code-point offsets, as the editor adapter does.
export function readingGroups(scenes, activeId, caret, start, end, size) {
  const active = scenes.findIndex(scene => scene.id === activeId);
  if (active < 0) return [];
  const first = start === "manuscript" ? 0 : active;
  const last = end === "scene" ? active : scenes.length - 1;
  const groups = [];
  for (let i = first; i <= last; i++) {
    const text = scenes[i].text.replace(/\r\n?/gu, "\n");
    const offset = i === active && start === "caret" ? Array.from(text).slice(0, caret).join("").length : 0;
    let position = 0;
    for (const paragraph of text.split(/\n\n/gu)) {
      const words = [...paragraph.matchAll(/\S+/gu)]
        .filter(match => position + match.index + match[0].length > offset)
        .map(match => match[0]);
      for (let j = 0; j < words.length; j += size) groups.push(words.slice(j, j + size).join(" "));
      position += paragraph.length + 2;
    }
  }
  return groups;
}

export function timing(words, wpm, repeats, visible) {
  const interval = 60000 * words / wpm;
  const period = interval / repeats;
  return { interval, period, visible: Math.min(visible, period) };
}

// The UI supplies animation timestamps. Late frames never skip unseen groups;
// resume deliberately restarts the current group's complete timing cycle.
export class ReaderPlayback {
  constructor(groups, options) {
    this.groups = groups;
    this.options = options;
    this.index = 0;
    this.running = false;
    this.started = null;
    this.finished = groups.length === 0;
  }
  play() {
    if (this.finished) return;
    this.running = true;
    this.started = null;
  }
  pause() { this.running = false; this.started = null; }
  frame(now) {
    if (!this.running) return this.groups[this.index] || "";
    if (this.started === null) this.started = now;
    const { interval, period, visible } = this.options;
    let elapsed = now - this.started;
    if (elapsed >= interval) {
      this.index++;
      if (this.index >= this.groups.length) {
        this.finished = true;
        this.pause();
        return "";
      }
      // Carry small frame overshoot to avoid drift, but give late groups a
      // complete first flash rather than racing through background time.
      this.started += interval;
      elapsed -= interval;
      if (elapsed >= visible || elapsed >= interval) { this.started = now; elapsed = 0; }
    }
    return elapsed % period < visible ? this.groups[this.index] : "";
  }
}
