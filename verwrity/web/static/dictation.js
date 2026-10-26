const banner = document.querySelector("[data-dictation-status]");
const message = document.querySelector("[data-dictation-message]");
const stopButton = document.querySelector("[data-dictation-stop]");
const review = document.querySelector("[data-dictation-review]");
const transcript = document.querySelector("[data-dictation-transcript]");
let shortcut = "ControlRight";
let active = null;
let focusedTarget = null;
let keyDown = false;
let pressStarted = 0;
let releaseTimer = null;
let firstRelease = 0;

function targetFor(element) {
  if (element?.closest?.("[data-rich-editor]")) return "manuscript";
  if (element?.matches?.('[data-project-question-form] textarea[name="question"]')) return element;
  if (element?.matches?.('[data-dictation-input="wiki"]')) return element;
  if (element?.matches?.('[data-dictation-input="wiki-instruction"]')) return element;
  return null;
}

document.addEventListener("focusin", event => {
  const target = targetFor(event.target);
  if (target) focusedTarget = target;
});

function capture(target) {
  if (target === "manuscript") return window.verwrityEditor?.captureDictationTarget();
  if (!target?.isConnected || target.disabled || target.readOnly || !target.getClientRects().length) return null;
  const original = target.value;
  const position = target.selectionEnd;
  return { insert(text) {
    if (!target.isConnected || !target.getClientRects().length || target.value !== original || target.disabled || target.readOnly) return false;
    const value = (/\S/u.test(original.slice(position - 1, position)) ? " " : "") + text + (/\S/u.test(original.slice(position, position + 1)) ? " " : "");
    if (target.maxLength >= 0 && original.length + value.length > target.maxLength) return false;
    target.dispatchEvent(new CustomEvent("verwrity-textarea-before-edit", { detail: { start: position, end: position } }));
    target.setRangeText(value, position, position, "end");
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.focus();
    return true;
  } };
}

function showReview(text, reason) {
  transcript.value = text;
  document.querySelector("[data-dictation-review-message]").textContent = reason;
  review.hidden = false;
}

function render() {
  window.verwrityQuickDictationActive = Boolean(active);
  if (!banner) return;
  banner.hidden = !active;
  banner.dataset.phase = active?.phase || "";
  stopButton.hidden = !active || !["starting", "recording"].includes(active.phase);
  if (active) message.textContent = active.phase === "processing" ? "Transcribing your recording…" : active.phase === "starting" ? "Opening microphone…" : `Recording ${active.label}${active.mode === "latch" ? " · latched" : ""}…`;
  document.querySelectorAll("[data-dictation-target]").forEach(button => {
    const selected = active?.button === button;
    button.textContent = selected && active.phase !== "processing" ? "■" : "🎙";
    button.setAttribute("aria-pressed", String(Boolean(selected)));
    button.setAttribute("aria-label", selected ? "Stop dictation" : `Start ${button.dataset.dictationTarget} dictation`);
    button.title = button.getAttribute("aria-label");
    button.disabled = Boolean(active && (!selected || active.phase === "processing"));
  });
}

function releaseStream(job) {
  job.stream?.getTracks().forEach(track => track.stop());
  window.clearTimeout(job.limitTimer);
}

function resetKeys() {
  window.clearTimeout(releaseTimer);
  releaseTimer = null;
  firstRelease = 0;
}

function cancel() {
  resetKeys(); keyDown = false;
  if (!active) return;
  const job = active;
  active = null;
  job.controller.abort();
  if (job.recorder?.state === "recording") job.recorder.stop();
  releaseStream(job);
  render();
}

async function finish(job) {
  releaseStream(job);
  if (active !== job) return;
  job.phase = "processing";
  render();
  try {
    const blob = new Blob(job.chunks, { type: job.recorder.mimeType || job.chunks[0]?.type || "audio/webm" });
    if (!blob.size) throw new Error("The microphone returned no audio. Please try again.");
    if (blob.size > 24 * 1024 * 1024) throw new Error("The recording exceeds 24 MiB. Please dictate a shorter passage.");
    const response = await fetch("/ai/transcribe", { method: "POST", body: blob, headers: { "Content-Type": blob.type }, signal: job.controller.signal });
    if (!response.headers.get("Content-Type")?.includes("application/json")) throw new Error(`Transcription returned an unexpected response (HTTP ${response.status}). Check the Verwrity console for the failed stage.`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Transcription failed.");
    if (active !== job) return;
    if (!result.text) throw new Error("No speech was recognized. Please try again.");
    if (!job.target.insert(result.text)) showReview(result.text, "The original text-entry area changed while dictation was processing. Your transcript is retained here.");
  } catch (error) {
    if (active === job && error.name !== "AbortError") await window.verwrityDialog?.alert(error.message, { title: "Dictation" });
  } finally {
    if (active === job) { active = null; render(); }
  }
}

function stop() {
  resetKeys();
  if (!active || active.phase === "processing") return;
  active.stopRequested = true;
  if (active.recorder?.state === "recording") active.recorder.stop();
}

async function start(target, button, mode = "latch") {
  if (active || !banner) return;
  if (window.verwrityDraftRecording) {
    await window.verwrityDialog?.alert("Pause Dictate draft before starting quick dictation.", { title: "Microphone in use" });
    return;
  }
  if (!review.hidden) {
    await window.verwrityDialog?.alert("Insert, copy, or dismiss the retained transcript before recording again.", { title: "Retained transcript" });
    return;
  }
  const captured = capture(target);
  if (!captured) return;
  const job = { target: captured, button, mode, label: button?.dataset.dictationTarget || "dictation", phase: "starting", controller: new AbortController(), chunks: [] };
  active = job; render();
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("Microphone recording requires a supported browser on localhost or HTTPS.");
    const response = await fetch("/ai/models", { signal: job.controller.signal });
    if (!response.ok) throw new Error("Could not check speech-to-text settings.");
    const { settings, capabilities } = await response.json();
    if (capabilities?.speech_to_text?.audio_upload !== "raw-v1") throw new Error("The running Verwrity server is out of date. Restart Verwrity and refresh this page before using dictation.");
    shortcut = settings.stt.shortcut;
    if (settings.stt.token_required && !settings.stt.token_configured) throw new Error("This speech-to-text service requires an API key, including on its free tier. Add one in AI Models → Speech-to-text before recording.");
    if (settings.stt.provider === "faster_whisper" && !settings.stt.model_path) throw new Error("Open AI Models → Speech-to-text and choose or download a local model first.");
    if (settings.stt.provider === "openai_compatible" && !isLoopback(settings.stt.endpoint) && !settings.stt.remote_consent) throw new Error("Open AI Models → Speech-to-text and consent to sending audio to this online endpoint first.");
    if (active !== job) return;
    job.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (active !== job) { releaseStream(job); return; }
    const mediaType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(type => MediaRecorder.isTypeSupported(type));
    job.recorder = new MediaRecorder(job.stream, mediaType ? { mimeType: mediaType, audioBitsPerSecond: 128000 } : undefined);
    job.recorder.addEventListener("dataavailable", event => { if (event.data.size) job.chunks.push(event.data); });
    job.recorder.addEventListener("stop", () => finish(job), { once: true });
    job.recorder.addEventListener("error", () => {
      if (active !== job) return;
      cancel();
      window.verwrityDialog?.alert("Microphone recording failed. Please try again.", { title: "Dictation" });
    });
    job.recorder.start(1000);
    job.phase = "recording";
    job.limitTimer = window.setTimeout(stop, 5 * 60 * 1000);
    render();
    if (job.stopRequested) stop();
  } catch (error) {
    releaseStream(job);
    if (active === job) {
      active = null; resetKeys(); render();
      if (error.name !== "AbortError") await window.verwrityDialog?.alert(error.name === "NotAllowedError" ? "Allow microphone access in your browser to use dictation." : error.message, { title: "Dictation" });
    }
  }
}

function isLoopback(value) {
  try {
    const host = new URL(value).hostname;
    return ["localhost", "[::1]"].includes(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
  }
  catch (_) { return false; }
}

function buttonTarget(button) {
  if (button.dataset.dictationTarget === "manuscript") return "manuscript";
  if (button.dataset.dictationTarget === "wiki-instruction") return document.querySelector('[data-dictation-input="wiki-instruction"]');
  return document.querySelector(button.dataset.dictationTarget === "wiki" ? '[data-dictation-input="wiki"]' : '[data-project-question-form] textarea[name="question"]');
}

document.addEventListener("pointerdown", event => {
  if (event.target.closest?.("[data-dictation-target], [data-dictation-insert]")) event.preventDefault();
});
document.addEventListener("click", event => {
  const button = event.target.closest?.("[data-dictation-target]");
  if (!button) return;
  if (active) { if (active.button === button) stop(); return; }
  const target = buttonTarget(button); focusedTarget = target;
  start(target, button);
});
stopButton?.addEventListener("click", stop);
document.querySelector("[data-dictation-cancel]")?.addEventListener("click", cancel);
document.querySelector("[data-dictation-dismiss]")?.addEventListener("click", () => { review.hidden = true; transcript.value = ""; });
document.querySelector("[data-dictation-insert]")?.addEventListener("click", async () => {
  if (capture(focusedTarget)?.insert(transcript.value)) { review.hidden = true; transcript.value = ""; }
  else await window.verwrityDialog?.alert("Focus an editable manuscript, wiki content, or question field before inserting.", { title: "Choose an insertion point" });
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && active) { event.preventDefault(); event.stopImmediatePropagation(); cancel(); return; }
  if (!shortcut || event.code !== shortcut || event.repeat || document.querySelector("dialog[open]")) return;
  if (!active && (!targetFor(document.activeElement) || event.ctrlKey && event.code !== "ControlRight" || event.metaKey)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (keyDown) return;
  keyDown = true; pressStarted = performance.now();
  if (active) {
    if (active.mode === "latch") stop();
    else if (firstRelease && performance.now() - firstRelease < 350) { resetKeys(); active.mode = "latch"; render(); }
    return;
  }
  focusedTarget = targetFor(document.activeElement);
  const label = focusedTarget === "manuscript" ? "manuscript" : focusedTarget?.dataset.dictationInput === "wiki" ? "wiki" : "question";
  start(focusedTarget, document.querySelector(`[data-dictation-target="${label}"]`), "hold");
}, true);

document.addEventListener("keyup", event => {
  if (event.code !== shortcut || !keyDown) return;
  event.preventDefault(); event.stopImmediatePropagation(); keyDown = false;
  if (!active || active.mode === "latch" || active.phase === "processing") return;
  if (performance.now() - pressStarted >= 250) stop();
  else {
    firstRelease = performance.now();
    releaseTimer = window.setTimeout(stop, 350);
  }
}, true);
window.addEventListener("blur", () => { if (active && active.phase !== "processing") cancel(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && active && active.phase !== "processing") cancel(); });
window.addEventListener("pagehide", cancel);
window.addEventListener("verwrity-stt-settings", event => { shortcut = event.detail.shortcut; });
if (banner) fetch("/ai/models").then(response => response.json()).then(result => { shortcut = result.settings.stt.shortcut; }).catch(() => {});
