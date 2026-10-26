import { readingGroups, timing, ReaderPlayback } from "./speed-reader-core.js";

const dialog = document.querySelector("#speed-reader");
if (dialog) {
  const field = name => dialog.querySelector(`[data-reader-${name}]`);
  const words = field("words"), status = field("status"), play = field("play");
  const keys = ["start", "end", "size", "wpm", "visible", "repeats", "font", "font-size"];
  const storageKey = "verwrity-speed-reader-v1";
  let snapshot, playback, frame, controller, opener;
  function fitWords() {
    if (!dialog.open || !words.textContent) return;
    const barHeight = dialog.querySelector(".speed-reader-bar").getBoundingClientRect().height;
    const available = Math.max(24, innerHeight - 2 * (barHeight + 12));
    // Keep the reading centre fixed while fitting long groups above the bar.
    let size = Number(field("font-size").value);
    words.style.fontSize = `${size}px`;
    while (words.getBoundingClientRect().height > available && size > 12) {
      size -= 2;
      words.style.fontSize = `${size}px`;
    }
  }
  const number = (name, min, max, fallback, integer = true) => {
    let value = Number(field(name).value);
    if (!Number.isFinite(value)) value = fallback;
    value = Math.max(min, Math.min(max, integer ? Math.round(value) : value));
    field(name).value = String(value);
    return value;
  };
  function options() {
    const size = number("size", 1, 20, 1);
    const wpm = number("wpm", 30, 2000, 240);
    const repeats = number("repeats", 1, 20, 1);
    const maximum = 60000 * size / wpm / repeats;
    field("visible").max = String(maximum);
    const visible = number("visible", 1, maximum, 250, false);
    field("timing").textContent = `${wpm} WPM · ${(60000 * size / wpm).toFixed(1)} ms/group`;
    words.style.fontFamily = field("font").value;
    words.style.fontSize = `${number("font-size", 16, 160, 56)}px`;
    fitWords();
    return { size, ...timing(size, wpm, repeats, visible) };
  }
  function paint(now = performance.now()) {
    const text = playback?.frame(now) || "";
    if (words.textContent !== text) { words.textContent = text; fitWords(); }
    play.textContent = playback?.running ? "Pause" : "Play";
    dialog.dataset.reading = String(Boolean(playback?.running));
    play.disabled = !playback || playback.finished;
    if (playback) status.textContent = playback.finished ? "Finished" : `${playback.running ? "Reading" : "Paused"} · ${playback.index + 1}/${playback.groups.length}`;
    if (playback?.running) frame = requestAnimationFrame(paint);
  }
  function pause() {
    cancelAnimationFrame(frame);
    playback?.pause();
    paint();
  }
  function rebuild() {
    cancelAnimationFrame(frame);
    const settings = options();
    if (snapshot) {
      playback = new ReaderPlayback(readingGroups(snapshot.scenes, snapshot.activeId, snapshot.caret,
        field("start").value, field("end").value, settings.size), settings);
      paint();
      if (!playback.groups.length) status.textContent = "No words in this range";
    }
  }
  function toggle() {
    if (!playback || playback.finished) return;
    if (playback.running) pause();
    else { playback.play(); cancelAnimationFrame(frame); frame = requestAnimationFrame(paint); }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    for (const key of keys) if (Object.hasOwn(saved, key)) field(key).value = saved[key];
    for (const key of ["start", "end", "font"]) if (!field(key).value) field(key).selectedIndex = 0;
  } catch (_) { /* Storage is optional; reading remains available. */ }
  options();
  for (const key of keys) field(key).addEventListener("input", () => {
    if (["font", "font-size"].includes(key)) options();
    else if (["start", "end", "size"].includes(key)) rebuild();
    else {
      pause();
      const settings = options();
      if (playback) playback.options = settings;
    }
    try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(keys.map(name => [name, field(name).value])))); } catch (_) { /* Optional. */ }
  });
  for (const button of document.querySelectorAll("[data-speed-reader-open]")) button.addEventListener("click", async () => {
    const editor = window.verwrityEditor;
    if (!editor || dialog.open) return;
    opener = button;
    button.closest("details")?.removeAttribute("open");
    snapshot = null; playback = null;
    words.textContent = ""; status.textContent = "Loading…"; play.disabled = true;
    dialog.showModal();
    // Never accidentally substitute a historical preview for a current head.
    if (document.querySelector(".is-revision-preview")) {
      status.textContent = "Return to the current scene head before opening the speed reader.";
      return;
    }
    const activeId = editor.sceneId, text = editor.getText(), caret = editor.getCaretOffset();
    const requestController = new AbortController();
    controller = requestController;
    try {
      const projectId = document.querySelector("[data-workspace]").dataset.projectId;
      const response = await fetch(`/speed-reader/snapshot?project_id=${encodeURIComponent(projectId)}`, {
        signal: requestController.signal, cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load manuscript.");
      if (!dialog.open || controller !== requestController) return;
      if (editor.getText() !== text || editor.sceneId !== activeId || !data.scenes.some(scene => scene.id === activeId)) {
        throw new Error("The scene changed. Close and reopen the speed reader.");
      }
      snapshot = { activeId, caret, scenes: data.scenes.map(scene => scene.id === activeId ? { ...scene, text } : scene) };
      rebuild();
    } catch (error) {
      if (dialog.open && controller === requestController && error.name !== "AbortError") status.textContent = error instanceof TypeError ? "Could not load manuscript. Check the server connection and reopen." : error.message;
    }
  });
  play.addEventListener("click", toggle);
  field("restart").addEventListener("click", rebuild);
  field("exit").addEventListener("click", () => dialog.close());
  dialog.addEventListener("keydown", event => {
    if (event.code === "Space") {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) toggle();
    }
  });
  dialog.addEventListener("close", () => {
    controller?.abort(); cancelAnimationFrame(frame); playback?.pause();
    snapshot = null; playback = null; words.textContent = "";
    const returnTarget = opener?.closest("details:not([open])")?.querySelector("summary") || opener;
    returnTarget?.focus({ preventScroll: true });
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden && dialog.open) pause(); });
  window.addEventListener("blur", () => { if (dialog.open) pause(); });
  window.addEventListener("resize", fitWords);
  window.addEventListener("verwrity-editor-source-changed", () => { if (dialog.open) dialog.close(); });
  window.addEventListener("verwrity-editor-change", () => {
    if (!dialog.open) return;
    pause(); playback = null; snapshot = null; controller?.abort();
    words.textContent = ""; play.disabled = true;
    status.textContent = "The writing changed. Close and reopen the speed reader.";
  });
}
