import { microphone } from "./draft-recording.js";
import { loadDraft, saveDraft, deleteDraft } from "./draft-storage.js";
import { showCleanupChanges } from "./draft-review.js";
import { readImportedAudio } from "./draft-import.js";

const dialog = document.querySelector("#dictate-draft-dialog");
const $ = name => dialog?.querySelector(`[data-draft-${name}]`);
const workspace = document.querySelector("[data-workspace]");
let draft, context, selected, recorder, destination, saveTimer;
let phase = "idle", error = "", storageMessage = "", saveChain = Promise.resolve();
let opening = false, recordingEpoch = 0, transcribing = false, cleaning = false, disposed = false;
let recoveryFailed = false;
let inserting = false;
let clearing = false;
let autoCleanup = true;
let renderedList = "", renderedChunkStatus = "";
let renderedCleanup = "";
let renderedSelected;
let importing = false, importEpoch = 0, importMessage = "";
const controllers = new Set();
const cleanupCompatible = () => context?.cleanup_protocol === "section-only-quotes-v2";
const pending = () => draft?.chunks.filter(chunk => chunk.audio).length || 0;
const current = () => draft?.chunks.find(chunk => chunk.id === selected);
const approvedChunks = () => draft?.chunks.filter(chunk => chunk.reviewChoice && chunk.review?.trim() && !chunk.inserted) || [];
const approvalCandidates = () => draft.chunks.filter(chunk => chunk.raw?.trim() && !chunk.inserted && !chunk.reviewChoice);
const approvalBusy = () => importing || ["recording", "opening", "pausing"].includes(phase) ||
  draft.chunks.some(chunk => ["queued", "transcribing"].includes(chunk.stage) || ["queued", "processing"].includes(chunk.cleanup));
const cleanupCandidates = () => draft.chunks.filter(chunk => chunk.raw?.trim() && !chunk.inserted && !chunk.reviewChoice &&
  !["queued", "processing"].includes(chunk.cleanup) &&
  (chunk.cleanup !== "ready" || chunk.cleanupProtocol !== context?.cleanup_protocol || (chunk.cleanupVocabulary !== undefined && chunk.cleanupVocabulary !== draft.vocabulary)));
function reviewChunks(value = draft) {
  // Keep stored identities and timings intact. Only omit confirmed empty STT
  // results at the edges; internal gaps and author-entered text remain visible.
  const empty = chunk => chunk.stage === "silence" && !chunk.raw?.trim() && !chunk.review?.trim() && !chunk.inserted;
  let start = 0, end = value.chunks.length;
  while (start < end && empty(value.chunks[start])) start++;
  while (end > start && empty(value.chunks[end - 1])) end--;
  return value.chunks.slice(start, end);
}
const terms = () => {
  const values = (draft.vocabulary || "").split("\n").map(value => value.trim()).filter(Boolean);
  if (values.length > 1500 || values.some(value => value.length > 100)) throw new Error("Keep up to 1,500 project terms, each at most 100 characters.");
  return [...new Set(values)];
};
function setVocabulary(value) {
  for (const chunk of draft.chunks) if (chunk.cleanup === "ready" && chunk.cleanupVocabulary === undefined && !chunk.reviewChoice && !chunk.inserted) chunk.cleanupVocabulary = draft.vocabulary;
  draft.vocabulary = value; $("vocabulary").value = draft.extraVocabulary || "";
}
const local = endpoint => {
  try { return ["localhost", "[::1]"].includes(new URL(endpoint).hostname) || /^127(?:\.\d{1,3}){3}$/.test(new URL(endpoint).hostname); }
  catch { return false; }
};

function blank() {
  return { id: crypto.randomUUID(), projectId: context.project_id,
    title: context.title || context.project_id,
    storageVersion: 0, chunks: [], vocabulary: context.terms.join("\n"), proposals: [],
    combined: "", combinedParts: [], combinedInserted: false, elapsed: 0 };
}

async function persist(addition = null) {
  clearTimeout(saveTimer);
  // Queue saves so late provider callbacks cannot publish an older browser buffer.
  const owner = draft;
  const operation = saveChain.catch(() => {}).then(async () => {
    if (!owner || owner !== draft) return;
    const snapshot = structuredClone(owner);
    if (addition) {
      snapshot.chunks.push(structuredClone(addition.chunk));
      snapshot.elapsed = addition.elapsed;
    }
    const version = await saveDraft(snapshot, owner.storageVersion);
    owner.storageVersion = version;
    if (addition) {
      if (addition.cancelled()) {
        addition.chunk.stage = "cancelled";
        addition.chunk.failure = "Import cancelled; audio retained for explicit retry.";
      }
      owner.chunks.push(addition.chunk);
      owner.elapsed = addition.elapsed;
    }
    recoveryFailed = false;
    storageMessage = `Local recovery saved · ${new Date().toLocaleTimeString()}`;

  });
  saveChain = operation;
  try { await operation; }
  catch (failure) {
    recoveryFailed = true;
    error = `Local recovery failed: ${failure.message}`; storageMessage = "Local recovery failed. Keep this tab open.";
    if (phase === "recording" || phase === "opening") await pause("Recording paused because local recovery failed.");
    render(); throw failure;
  }
}
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist().catch(() => {}), 250);
}
async function json(url, options = {}) {
  const controller = new AbortController(); controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The provider request failed. Retry explicitly.");
    return result;
  } finally { clearTimeout(timeout); controllers.delete(controller); }
}
function llmRequest(data) {
  if (!context.settings.llm.model) throw new Error("Configure an LLM in AI Models, or keep raw transcription only.");
  const endpoint = context.settings.llm.endpoint;
  if (!local(endpoint) && (!context.settings.llm.remote_consent || !$("consent").checked))
    throw new Error("Acknowledge text/vocabulary processing for the displayed LLM endpoint, and its AI Models consent.");
  return { ...data, project_id: draft.projectId, configuration: context.configurations.llm,
    consent_endpoint: $("consent").checked ? endpoint : "" };
}
function post(action, data) {
  if (action === "cleanup") requireCleanup();
  return json(`/ai/dictate-draft/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(llmRequest(data)) });
}
function requireCleanup() {
  if (!cleanupCompatible()) throw new Error("Restart Verwrity, then reopen Dictate draft to load the updated section cleanup. Your dictation is retained.");
}

function chunkProgress(chunk) {
  if (["failed", "cancelled"].includes(chunk.stage)) return { state: "attention", label: `Transcription ${chunk.stage}`, icon: "!" };
  if (chunk.stage === "queued") return { state: "queued", label: "Queued for transcription", icon: "◷" };
  if (chunk.stage === "transcribing") return { state: "working", label: "Transcribing…" };
  if (chunk.cleanup === "queued") return { state: "queued", label: "Cleanup queued", icon: "◷" };
  if (chunk.cleanup === "processing") return { state: "working", label: "Preparing cleanup…" };
  if (["failed", "stale", "cancelled"].includes(chunk.cleanup)) return { state: "attention",
    label: `Cleanup ${chunk.cleanup === "stale" ? "outdated" : chunk.cleanup} · raw available`, icon: "!" };
  if (chunk.inserted === "prepared") return { state: "attention", label: "Check insertion in manuscript", icon: "!" };
  if (chunk.inserted) return { state: "ready", label: "Inserted", icon: "✓" };
  if (chunk.stage === "silence") return { state: "empty", label: "No speech recognized", icon: "—" };
  return { state: "ready", label: chunk.cleanup === "ready" ?
    (chunk.edits?.length ? "Cleanup ready" : "Cleanup ready · model had no notes") : "Raw ready", icon: "●" };
}

function progressBadge(progress) {
  const badge = document.createElement("span"); badge.className = "draft-progress";
  badge.dataset.state = progress.state;
  const icon = document.createElement("span");
  icon.className = `draft-progress-icon${progress.state === "working" ? " draft-progress-spinner" : ""}`;
  icon.setAttribute("aria-hidden", "true"); icon.textContent = progress.icon || "";
  badge.append(icon, document.createTextNode(progress.label));
  return badge;
}

function reviewChoiceBadge(chunk) {
  if (!chunk.reviewChoice) return document.createTextNode("");
  const badge = document.createElement("span"); badge.className = "draft-review-choice";
  badge.dataset.choice = chunk.reviewChoice;
  const tick = document.createElement("span"); tick.textContent = "✓ "; tick.setAttribute("aria-hidden", "true");
  badge.append(tick, document.createTextNode(`${chunk.reviewChoice === "cleanup" ? "Cleanup" : "Raw"} selected${chunk.reviewEdited ? " · edited" : ""}`));
  return badge;
}

function render() {
  if (!dialog || !draft) return;
  const visibleChunks = reviewChunks();
  if (!visibleChunks.some(chunk => chunk.id === selected)) selected = visibleChunks[0]?.id;
  const counts = stage => draft.chunks.filter(chunk => chunk.stage === stage).length;
  const elapsed = draft.elapsed + (recorder?.elapsed() || 0);
  const retained = draft.chunks.some(chunk => chunk.source === "import") ? `${pending()} retained audio chunks` : `${pending()}/6 retained audio chunks`;
  $("status").textContent = `${phase} · ${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")} recorded · ${counts("queued")} queued · ${counts("transcribing")} transcribing · ${counts("raw")} complete · ${counts("failed") + counts("cancelled")} unresolved · ${draft.chunks.filter(chunk => chunk.cleanup === "processing" || chunk.cleanup === "queued").length} cleanup pending · ${retained}`;
  $("error").textContent = error;

  if ($("import-status")) $("import-status").textContent = importMessage;
  if ($("import")) $("import").disabled = clearing || importing || ["recording", "opening", "pausing"].includes(phase);
  const busyRecording = importing || ["recording", "opening", "pausing"].includes(phase);
  $("start").disabled = clearing || busyRecording || draft.chunks.length > 0;
  $("resume").disabled = clearing || busyRecording || !draft.chunks.length && phase === "idle";
  $("pause").disabled = !["recording", "opening"].includes(phase);
  $("finish").disabled = importing || phase === "finishing" || phase === "finished" || phase === "idle";
  $("boundary").disabled = phase !== "recording";
  $("new").disabled = clearing || inserting;
  const candidates = cleanupCandidates();
  // An already-running Flask server may still cache the earlier dialog template
  // while serving this updated script. Keep existing dictation usable until it
  // restarts with the new optional bulk control.
  const cleanupAll = $("cleanup-all");
  if (cleanupAll) {
    cleanupAll.disabled = clearing || !cleanupCompatible() || !candidates.length;
    cleanupAll.textContent = `Run cleanup for all sections${candidates.length ? ` (${candidates.length})` : ""}`;
  }
  const listState = JSON.stringify([selected, $("unresolved").checked,
    visibleChunks.map(chunk => [chunk.id, chunk.stage, chunk.cleanup, chunk.inserted, chunk.reviewChoice, chunk.reviewEdited])]);
  // Elapsed-time updates must not restart spinners or remove keyboard focus.
  if (listState !== renderedList) {
    renderedList = listState;
    const list = $("chunks"); list.replaceChildren();
    for (const [index, chunk] of visibleChunks.entries()) {
      const unresolved = ["failed", "cancelled", "queued", "transcribing"].includes(chunk.stage) || ["failed", "stale", "cancelled"].includes(chunk.cleanup);
      if ($("unresolved").checked && !unresolved) continue;
      const progress = chunkProgress(chunk);
      const button = document.createElement("button"); button.type = "button";
      button.dataset.draftChunkId = chunk.id;
      button.append(document.createTextNode(`${index + 1}. `), progressBadge(progress), reviewChoiceBadge(chunk));
      button.setAttribute("aria-current", String(chunk.id === selected));
      button.setAttribute("aria-busy", String(["working", "queued"].includes(progress.state)));
      button.addEventListener("click", () => { selected = chunk.id; render(); }); list.append(button);
    }
  }
  const chunk = current();
  const sectionChanged = chunk?.id !== renderedSelected;
  renderedSelected = chunk?.id;
  const statusState = JSON.stringify(chunk ? [chunk.id, chunk.stage, chunk.cleanup, chunk.duration, chunk.quiet,
    chunk.failure, chunk.cleanupError, chunk.inserted, chunk.reviewChoice, chunk.reviewEdited] : null);
  if (statusState !== renderedChunkStatus) {
    renderedChunkStatus = statusState;
    const status = $("chunk-status");
    if (!chunk) status.textContent = "Select a chunk to review.";
    else status.replaceChildren(document.createTextNode(`Chunk ${visibleChunks.indexOf(chunk) + 1} · ${chunk.duration.toFixed(1)} s · `),
      progressBadge(chunkProgress(chunk)), reviewChoiceBadge(chunk), document.createTextNode(`${chunk.quiet ? " · quiet audio" : ""}${chunk.failure ? ` · ${chunk.failure}` : ""}${chunk.cleanupError ? ` · ${chunk.cleanupError}` : ""}${chunk.inserted ? " · Insertion recorded or pending confirmation; review manuscript before inserting again." : ""}`));
  }
  for (const [field, value] of [["raw", chunk?.raw], ["review", chunk?.review]]) {
    const control = $(field);
    if (control.value !== (value || "")) control.value = value || "";
  }
  const cleanupState = JSON.stringify(chunk ? [chunk.id, chunk.cleanup, chunk.raw, chunk.cleaned, chunk.edits, chunk.skippedEdits] : null);
  if (cleanupState !== renderedCleanup) {
    renderedCleanup = cleanupState;
    showCleanupChanges($("cleaned"), chunk);
    $("cleanup-note").textContent = chunk?.cleanup === "ready" ? (chunk.edits?.length ?
      "Highlights mark changed text; [−] marks a deletion." :
      "Model had no notes. The raw transcript is copied here and can be accepted with Use reviewed cleanup.") : "";
    if (chunk?.cleanup === "ready" && chunk.edits?.length && chunk.skippedEdits) {
      $("cleanup-note").textContent += " Some other suggestions could not be used; their original text is retained.";
    }
  }
  $("review").disabled = !chunk || chunk.raw === undefined;
  $("retry").disabled = !chunk?.audio || !["failed", "cancelled"].includes(chunk?.stage);
  $("reclean").disabled = clearing || !cleanupCompatible() || !chunk?.raw?.trim() || ["queued", "processing"].includes(chunk?.cleanup);
  $("use-cleaned").disabled = clearing || !chunk || chunk.cleaned === undefined || chunk.cleanup !== "ready";
  $("use-raw").disabled = clearing || !chunk || chunk.raw === undefined;
  $("delete-audio").disabled = !chunk?.audio || chunk.stage === "transcribing";
  $("cancel").disabled = !importing && !draft.chunks.some(chunk => ["queued", "transcribing"].includes(chunk.stage) || ["queued", "processing"].includes(chunk.cleanup));
  const approved = approvedChunks();
  const awaiting = draft.chunks.filter(chunk => !chunk.inserted && !chunk.reviewChoice && chunk.stage !== "silence").length;
  const approvalSummary = `${approved.length} approved section${approved.length === 1 ? "" : "s"} ready to insert${awaiting ? ` · ${awaiting} pending or awaiting your choice` : ""}`;
  if ($("approved-summary").textContent !== approvalSummary) $("approved-summary").textContent = approvalSummary;
  $("insert").textContent = `Insert ${approved.length} approved section${approved.length === 1 ? "" : "s"} at caret`;
  $("insert").disabled = clearing || !approved.length || busyRecording || inserting;
  const approveAll = $("approve-all");
  if (approveAll) {
    const candidates = approvalCandidates();
    approveAll.disabled = clearing || inserting || approvalBusy() || !candidates.length;
  }
  if (sectionChanged) {
    for (const name of ["raw", "cleaned", "review", "chunk-status", "cleanup-note"]) $(name).scrollTop = 0;
  }
}

async function open() {
  if (opening) return;
  opening = true;
  try {
    // Capture on explicit opening, before panel focus moves away from the author-chosen caret.
    const editorRoot = document.querySelector("[data-rich-editor]");
    const target = window.verwrityEditor?.isEditable() ? window.verwrityEditor.captureDictationTarget() : null;
    destination = target ? { target, projectId: workspace.dataset.projectId,
      sceneId: editorRoot?.dataset.sceneId,
      title: document.querySelector(".scene-row.selected .scene")?.textContent.trim() || "current scene",
      offset: window.verwrityEditor.getCaretOffset() } : null;
    context = await json("/ai/dictate-draft");
    if (context.project_id !== workspace.dataset.projectId) throw new Error("Project changed. Refresh before opening Dictate draft.");
    if (!draft) {
      draft = await loadDraft(context.project_id) || blank();
      for (const chunk of draft.chunks) {
        if (["transcribing", "queued"].includes(chunk.stage)) { chunk.stage = "cancelled"; chunk.failure = "Interrupted; retry explicitly."; }
        if (["processing", "queued"].includes(chunk.cleanup)) { chunk.cleanup = "cancelled"; chunk.cleanupError = "Interrupted cleanup; raw retained."; }
      }
      phase = draft.chunks.length ? "paused" : "idle";
      selected = draft.chunks[0]?.id;
      $("vocabulary").value = draft.vocabulary;
      await persist();
    }
    setVocabulary([...context.terms, ...(draft.extraVocabulary || "").split(/[,\n]/)].map(term => term.trim()).filter(Boolean).join("\n"));
    const { stt, llm } = context.settings;
    $("providers").textContent = `Speech: ${stt.provider} · ${stt.model || stt.model_path || "local model not configured"} · ${stt.provider === "faster_whisper" ? "offline" : stt.endpoint}. Cleanup: ${llm.standard} · ${llm.model || "not configured"} · ${llm.endpoint}. Raw-only mode needs no LLM.`;
    if (!cleanupCompatible()) $("providers").textContent += " Restart Verwrity, then reopen this panel to enable the updated section cleanup. Your dictation is retained; raw-only recording remains available.";
    $("consent-label").hidden = local(llm.endpoint);
    $("consent-text").textContent = `I allow each section's raw transcript and selected words to go to ${llm.endpoint} for cleanup.`;
    $("consent").checked = false;
    $("cleanup").checked = autoCleanup && Boolean(llm.model) && cleanupCompatible();
    $("cleanup").disabled = !cleanupCompatible();
    $("destination").textContent = destination ? `Insertion destination: “${destination.title}”, character ${destination.offset}.` : "Choose a manuscript caret before inserting.";
    render();
    if (!dialog.open) dialog.showModal();
  } finally { opening = false; }
}

async function enqueue(info) {
  const chunk = { ...info, start: draft.elapsed + info.start, end: draft.elapsed + info.end,
    id: crypto.randomUUID(), order: draft.chunks.length,
    stage: "queued", cleanup: "", raw: undefined, review: "", reviewVersion: 0,
    sttConfiguration: context.configurations.stt, autoCleanup: $("cleanup").checked };
  draft.chunks.push(chunk); selected ||= chunk.id;
  // Reserve one slot for the worklet's final partial block when pausing.
  if ((pending() >= 5 || draft.chunks.length >= 499) && phase === "recording") void pause("Recording paused: audio is falling behind, or this buffer reached its chunk limit. Finish queued work or start a new buffer before resuming.");
  render();
  try { await persist(); if (!disposed) void pumpTranscription(); } catch { /* kept in memory for export/retry */ }
}
async function start() {
  if (clearing || importing || ["recording", "opening", "pausing"].includes(phase)) return;
  if (window.verwrityQuickDictationActive) throw new Error("Finish quick dictation before starting Dictate draft.");
  if (pending() >= 5 || draft.chunks.length >= 499) throw new Error("Resolve pending audio or start a new buffer before resuming.");
  checkInputSettings();
  const owner = draft;
  await persist();
  if (owner !== draft || clearing || importing || ["recording", "opening", "pausing"].includes(phase)) return;
  error = ""; phase = "opening"; window.verwrityDraftRecording = true;
  const epoch = ++recordingEpoch; render();
  try {
    let accepted = false;
    const input = await microphone(info => { if (accepted && owner === draft) void enqueue(info); },
      reason => { if (owner === draft) void pause(reason); });
    if (owner !== draft || epoch !== recordingEpoch || disposed) { await input.close(); return; }
    accepted = true;
    recorder = input; phase = "recording"; render();
  } catch (failure) {
    if (owner !== draft || epoch !== recordingEpoch || disposed) return;
    phase = "paused"; window.verwrityDraftRecording = false;
    throw new Error(failure.name === "NotAllowedError" ? "Allow microphone access to record a draft." : failure.message);
  }
}
function checkInputSettings() {
  terms();
  if ($("cleanup").checked) { requireCleanup(); llmRequest({}); }
  const stt = context.settings.stt;
  if (stt.provider === "faster_whisper" && !stt.model_path) throw new Error("Choose a complete local model in AI Models → Speech-to-text first.");
  if (stt.token_required && !stt.token_configured) throw new Error("Configure the transcription API key before recording.");
  if (stt.provider !== "faster_whisper" && !local(stt.endpoint) && !stt.remote_consent) throw new Error("Consent to audio processing at this exact endpoint in AI Models first.");
}
async function importAudioFile(file) {
  if (!file || clearing || importing || ["recording", "opening", "pausing"].includes(phase)) return;
  if (window.verwrityQuickDictationActive) throw new Error("Finish quick dictation before importing audio.");
  if (context.audio_import_protocol !== "wav-sections-v2") throw new Error("Restart Verwrity and reopen Dictate draft to enable audio import.");
  if (!file.size || file.size > 24 * 1024 * 1024) throw new Error("Choose a non-empty audio file of at most 24 MiB.");
  checkInputSettings();
  const owner = draft, epoch = ++importEpoch;
  const sttConfiguration = context.configurations.stt, prepareCleanup = $("cleanup").checked;
  const cancelled = () => disposed || owner !== draft || epoch !== importEpoch;
  const controller = new AbortController(); controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 2 * 60 * 1000);
  let imported = 0, importedSeconds = 0;
  const origin = owner.elapsed;
  importing = true; phase = "importing"; error = "";
  importMessage = "Converting audio locally…"; window.verwrityDraftRecording = true; render();
  try {
    const response = await fetch("/ai/dictate-draft/audio", { method: "POST", body: file,
      headers: { "Content-Type": "application/octet-stream", "X-Verwrity-Project": owner.projectId }, signal: controller.signal });
    if (!response.ok) { const failure = await response.json(); throw new Error(failure.error || "Audio conversion failed."); }
    clearTimeout(timeout);
    if (cancelled()) return;
    const result = await readImportedAudio(response, async info => {
      // Keep the same small retained-audio queue as microphone capture. Reading
      // pauses here while inference releases successfully saved audio.
      while (pending() >= 5) {
        if (cancelled() || controller.signal.aborted) throw new DOMException("Audio import cancelled", "AbortError");
        if (recoveryFailed) throw new Error("Local recovery failed; imported sections are retained.");
        importMessage = `Imported ${imported} sections. Waiting for transcription; retry failed sections or cancel to stop here.`;
        render();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (cancelled() || controller.signal.aborted) throw new DOMException("Audio import cancelled", "AbortError");
      if (owner.chunks.length >= 500) throw new Error("This dictation reached 500 sections. Imported sections are retained; start a fresh dictation for the remainder.");
      const chunk = { ...info, start: origin + info.start, end: origin + info.end,
        id: crypto.randomUUID(), order: owner.chunks.length, source: "import",
        stage: "queued", cleanup: "", raw: undefined, review: "", reviewVersion: 0,
        sttConfiguration, autoCleanup: prepareCleanup };
      await persist({ chunk, elapsed: origin + info.end, cancelled });
      if (cancelled()) return;
      if (!imported) selected = chunk.id;
      imported++; importedSeconds = info.end;
      importMessage = `Imported ${imported} audio section${imported === 1 ? "" : "s"}…`;
      render(); void pumpTranscription();
    }, () => cancelled() || controller.signal.aborted);
    if (cancelled()) return;
    importMessage = `Imported ${result.count} audio section${result.count === 1 ? "" : "s"}. Review them before insertion. Your original file is unchanged.`;
    phase = "finishing";
    void pumpTranscription();
  } catch (failure) {
    if (cancelled()) return;
    phase = owner.chunks.length ? "paused" : "idle";
    importMessage = imported ? `Import stopped after ${Math.floor(importedSeconds / 60)}:${String(Math.floor(importedSeconds % 60)).padStart(2, "0")} (${imported} sections). Those sections are retained. Reimporting the whole file would repeat them.` : "Audio import did not finish. Existing dictation is retained; you can retry the original file.";
    throw failure;
  } finally {
    clearTimeout(timeout); controllers.delete(controller);
    if (!cancelled()) { importing = false; window.verwrityDraftRecording = false; finishStatus(); }
  }
}
async function pause(reason = "") {
  ++recordingEpoch;
  const input = recorder; recorder = null;
  const wasRecording = phase === "recording" || phase === "opening";
  if (wasRecording) phase = "pausing";
  if (input) { await input.close(); draft.elapsed += input.elapsed(); }
  window.verwrityDraftRecording = false;
  if (wasRecording) phase = "paused";
  if (reason) error = reason;
  render();
  // enqueue already requests durable storage; include updated elapsed time too.
  saveSoon();
}
function finishStatus() {
  if (phase === "finishing" && !draft.chunks.some(chunk => ["queued", "transcribing"].includes(chunk.stage) || ["queued", "processing"].includes(chunk.cleanup))) phase = "finished";
  render();
}
async function pumpTranscription() {
  if (transcribing || disposed || recoveryFailed) return;
  transcribing = true;
  const owner = draft;
  try {
    for (const chunk of owner.chunks) {
      if (chunk.stage !== "queued" || owner !== draft || disposed) continue;
      chunk.stage = "transcribing"; chunk.failure = ""; render();
      try {
        const result = await json("/ai/transcribe", { method: "POST", headers: {
          "Content-Type": "audio/wav", "X-Verwrity-STT-Configuration": chunk.sttConfiguration }, body: chunk.audio });
        if (owner !== draft || disposed || chunk.stage !== "transcribing") continue;
        if (typeof result.text !== "string" || result.text.length > 20000) throw new Error("Oversized/invalid transcript; audio retained for explicit retry.");
        chunk.raw = result.text; chunk.review = result.text; chunk.reviewVersion++;
        chunk.stage = result.text.trim() ? "raw" : "silence";
        // First durably publish raw + audio. Only then release recoverable audio.
        await persist();
        if (owner !== draft || disposed) break;
        delete chunk.audio;
        if (chunk.raw.trim() && chunk.autoCleanup) chunk.cleanup = "queued";
        await persist();
        void pumpCleanup();
      } catch (failure) {
        if (owner !== draft || disposed) break;
        if (chunk.stage === "transcribing") { chunk.stage = "failed"; chunk.failure = failure.name === "AbortError" ? "Upload interrupted; retry explicitly." : failure.message; }
        error = chunk.failure || failure.message;
        try { await persist(); } catch { break; }
      }
      render();
    }
  } finally {
    if (owner === draft) { transcribing = false; finishStatus(); }
    if (!disposed && !recoveryFailed && owner === draft && owner.chunks.some(chunk => chunk.stage === "queued")) void pumpTranscription();
  }
}
async function pumpCleanup() {
  if (cleaning || disposed || recoveryFailed) return;
  cleaning = true;
  const owner = draft;
  try {
    for (const chunk of owner.chunks) {
      if (chunk.cleanup !== "queued" || owner !== draft || disposed) continue;
      chunk.cleanup = "processing"; chunk.cleanupError = "";
      const version = chunk.reviewVersion;
      const vocabularySnapshot = owner.vocabulary;
      render();
      try {
        const result = await post("cleanup", { text: chunk.raw, terms: terms() });
        if (disposed || owner !== draft || chunk.cleanup !== "processing") continue;
        if (version !== chunk.reviewVersion || vocabularySnapshot !== owner.vocabulary) { chunk.cleanup = "stale"; chunk.cleanupError = "Review or vocabulary changed during cleanup; proposal discarded. Rerun explicitly."; }
        else { chunk.cleaned = result.edits.length ? result.text : chunk.raw; chunk.edits = result.edits;
          chunk.skippedEdits = result.skipped_edits || 0; chunk.cleanupProtocol = context.cleanup_protocol; chunk.cleanupVocabulary = vocabularySnapshot; chunk.cleanup = "ready"; }
      } catch (failure) {
        if (owner !== draft || disposed) break;
        if (chunk.cleanup === "processing") { chunk.cleanup = "failed"; chunk.cleanupError = failure.name === "AbortError" ? "Cleanup cancelled; raw retained." : failure.message; }
      }
      try { await persist(); } catch { break; }
      render();
    }
  } finally {
    if (owner === draft) { cleaning = false; finishStatus(); }
    if (!disposed && !recoveryFailed && owner === draft && owner.chunks.some(chunk => chunk.cleanup === "queued")) void pumpCleanup();
  }
}
async function cancelWork() {
  ++importEpoch;
  if (importing) { importing = false; importMessage = "Audio import cancelled. Already imported sections are retained; reimporting the whole file would repeat them. The original is unchanged."; phase = draft.chunks.length ? "paused" : "idle"; }
  await pause();
  for (const chunk of draft.chunks) {
    if (["queued", "transcribing"].includes(chunk.stage)) { chunk.stage = "cancelled"; chunk.failure = "Cancelled; audio retained for explicit retry."; }
    if (["queued", "processing"].includes(chunk.cleanup)) chunk.cleanup = "cancelled";
  }
  controllers.forEach(controller => controller.abort());
  render(); await persist(); finishStatus();
}
async function insert(combined = false) {
  if (inserting || clearing) return;
  inserting = true; render();
  try { await performInsertion(combined); }
  finally { inserting = false; render(); }
}
async function performInsertion(combined) {
  if (!destination || destination.projectId !== workspace.dataset.projectId || destination.projectId !== draft.projectId ||
      destination.sceneId !== document.querySelector("[data-rich-editor]")?.dataset.sceneId || !window.verwrityEditor.isEditable())
    throw new Error("Choose an editable manuscript caret and reopen the panel before inserting.");
  $("cancel").disabled = !importing && !draft.chunks.some(chunk => ["queued", "transcribing"].includes(chunk.stage) || ["queued", "processing"].includes(chunk.cleanup));
  const approved = approvedChunks();
  const text = combined ? draft.combined : approved.map(chunk => chunk.review).join("\n\n");
  if (!text?.trim() || combined && draft.combinedInserted) return;
  const ids = combined ? draft.combinedParts : approved.map(chunk => chunk.id);
  if (combined && ids.some(id => draft.chunks.find(item => item.id === id)?.inserted)) throw new Error("Part of this combined draft was already inserted. Rebuild from uninserted chunks first.");
  if (combined && !ids.length) throw new Error("Build a combined draft before inserting it.");
  const awaiting = draft.chunks.filter(chunk => !chunk.inserted && !ids.includes(chunk.id) && chunk.stage !== "silence").length;
  const description = combined ? "the combined review" : `${ids.length} approved section${ids.length === 1 ? "" : "s"} in recording order`;
  if (!window.verwrityDialog.confirmWithCheckbox) throw new Error("Refresh the browser with Shift+Refresh to load the updated insertion dialog.");
  const decision = await window.verwrityDialog.confirmWithCheckbox(`Insert ${description} at the manuscript caret?${awaiting ? ` ${awaiting} pending or unapproved section(s) will be left out.` : ""}`, {
    title: "Insert Dictate draft", acceptLabel: "Insert",
    checkbox: { label: "Clear recordings", checked: true,
      description: "Clear all recordings and reviewed sections after insertion, including unapproved sections." },
  });
  if (!decision.confirmed) return;
  // Reserve insertion durably first. A crash between publication and receipt is
  // deliberately ambiguous: recovery never offers an automatic duplicate insert.
  ids.forEach(id => { draft.chunks.find(item => item.id === id).inserted = "prepared"; });
  if (combined) draft.combinedInserted = true;
  try { await persist(); }
  catch (failure) { ids.forEach(id => { draft.chunks.find(item => item.id === id).inserted = false; }); if (combined) draft.combinedInserted = false; throw failure; }
  if (!destination.target.insert(text)) {
    ids.forEach(id => { draft.chunks.find(item => item.id === id).inserted = false; });
    if (combined) draft.combinedInserted = false;
    await persist(); throw new Error("The captured scene/revision/text changed. Hide, choose the caret and reopen; the review is retained.");
  }
  ids.forEach(id => { draft.chunks.find(item => item.id === id).inserted = "confirmed"; });
  destination = null; error = "Inserted. Review text is retained; use manuscript Undo to undo insertion.";
  render(); await persist();
  if (decision.checked) {
    clearing = true; render();
    try { await clearDraftBuffer(); }
    catch (failure) {
      error = `Your text was inserted, but clearing recordings did not finish. ${failure.message}`;
      render(); return;
    } finally { clearing = false; render(); }
  }
  dialog.close();
}

async function clearDraftBuffer() {
  const chosenVocabulary = draft.vocabulary;
  const extraVocabulary = draft.extraVocabulary || "";
  // Keep the previous buffer until its explicit deletion succeeds. Version
  // checks prevent clearing another tab's newer dictation. Late work remains
  // tied to its old owner and cannot populate the replacement session.
  await cancelWork().catch(() => {});
  await saveChain.catch(() => {});
  await deleteDraft(draft.projectId, draft.storageVersion);
  draft = blank(); draft.vocabulary = chosenVocabulary; draft.extraVocabulary = extraVocabulary;
  importMessage = "";
  selected = null; phase = "idle"; error = ""; transcribing = false; cleaning = false;
  $("vocabulary").value = extraVocabulary;
  render(); await persist();
}

function on(name, action) {
  $(name)?.addEventListener("click", () => {
    const owner = draft;
    Promise.resolve().then(action).catch(failure => {
      if (owner !== draft) return;
      error = failure.name === "AbortError" ? "Request cancelled; retained work is unchanged." : failure.message; render();
    });
  });
}
function nextReview(chunk) {
  const chunks = reviewChunks();
  const next = chunks[chunks.indexOf(chunk) + 1];
  if (next) {
    selected = next.id;
    // Review choices advance in recording order, including already-ready chunks.
    $("unresolved").checked = false;
  }
  render();
  const row = $("chunks").querySelector('[aria-current="true"]');
  const navigation = $("chunks").closest("nav");
  if (row && navigation) {
    const bounds = row.getBoundingClientRect(), viewport = navigation.getBoundingClientRect();
    if (bounds.top < viewport.top) navigation.scrollTop += bounds.top - viewport.top;
    else if (bounds.bottom > viewport.bottom) navigation.scrollTop += bounds.bottom - viewport.bottom;
  }
}
if (dialog) {
  on("import", () => { if (!importing) $("audio-file")?.click(); });
  $("audio-file")?.addEventListener("change", () => {
    const file = $("audio-file").files[0], owner = draft;
    $("audio-file").value = "";
    importAudioFile(file).catch(failure => { if (owner === draft) {
      error = recoveryFailed ? `Local recovery failed: ${failure.message}` : failure.name === "AbortError" ? "Audio import cancelled; your original file is unchanged." : failure.message; render();
    } });
  });
  document.querySelectorAll("[data-draft-open]").forEach(button => button.addEventListener("click", () => open().catch(failure => window.verwrityDialog.alert(failure.message, { title: "Dictate draft" }))));
  on("start", start); on("resume", start); on("pause", () => pause());
  on("boundary", () => recorder?.boundary());
  on("finish", async () => { await pause(); phase = "finishing"; await persist(); finishStatus(); });
  on("cancel", cancelWork);
  dialog.querySelectorAll("[data-draft-hide]").forEach(button => button.addEventListener("click", async () => { await pause(); dialog.close(); }));
  dialog.addEventListener("cancel", event => { event.preventDefault(); void pause().then(() => dialog.close()); });
  on("retry", async () => { const chunk = current(); if (!chunk?.audio || !["failed", "cancelled"].includes(chunk.stage)) return; chunk.stage = "queued"; chunk.sttConfiguration = context.configurations.stt; error = ""; await persist(); render(); void pumpTranscription(); });
  on("reclean", async () => {
    const chunk = current();
    if (clearing || !chunk?.raw?.trim() || ["queued", "processing"].includes(chunk.cleanup)) return;
    requireCleanup(); llmRequest({}); terms(); chunk.cleanup = "queued"; render();
    await persist(); void pumpCleanup();
  });
  on("cleanup-all", async () => {
    if (clearing) return;
    const chunks = cleanupCandidates();
    if (!chunks.length) return;
    requireCleanup(); llmRequest({}); terms();
    chunks.forEach(chunk => { chunk.cleanup = "queued"; });
    error = ""; render();
    await persist(); void pumpCleanup();
  });
  on("use-raw", async () => { const chunk = current(); if (chunk?.raw !== undefined) { chunk.review = chunk.raw; chunk.reviewVersion++; chunk.reviewChoice = "raw"; chunk.reviewEdited = false; await persist(); nextReview(chunk); } });
  on("use-cleaned", async () => {
    const chunk = current(); if (chunk?.cleanup !== "ready") return;
    // This explicit review button accepts the displayed changes; one click is
    // enough to approve a section and continue through the full dictation.
    chunk.review = chunk.cleaned; chunk.reviewVersion++; chunk.reviewChoice = "cleanup"; chunk.reviewEdited = false; await persist(); nextReview(chunk);
  });
  on("approve-all", async () => {
    if (clearing || inserting || approvalBusy()) return;
    for (const chunk of approvalCandidates()) {
      const useCleanup = chunk.cleanup === "ready" && typeof chunk.cleaned === "string";
      const edited = chunk.reviewEdited || Boolean(chunk.review && chunk.review !== chunk.raw);
      if (!edited) chunk.review = useCleanup ? chunk.cleaned : chunk.raw;
      chunk.reviewChoice = useCleanup ? "cleanup" : "raw";
      chunk.reviewEdited = Boolean(edited);
      chunk.reviewVersion++;
    }
    render(); await persist();
  });
  $("vocabulary").addEventListener("input", () => { draft.extraVocabulary = $("vocabulary").value; setVocabulary([...context.terms, ...draft.extraVocabulary.split(/[,\n]/)].map(term => term.trim()).filter(Boolean).join("\n")); saveSoon(); });
  $("review").addEventListener("input", () => { const chunk = current(); if (chunk) { chunk.review = $("review").value; chunk.reviewVersion++; chunk.reviewEdited = true; render(); saveSoon(); } });
  window.addEventListener("verwrity-project-words-changed", event => {
    if (!draft || event.detail.project_id !== draft.projectId) return;
    context.terms = event.detail.words; setVocabulary([...event.detail.words, ...(draft.extraVocabulary || "").split(/[,\n]/)].map(term => term.trim()).filter(Boolean).join("\n")); saveSoon();
  });
  $("unresolved").addEventListener("change", render);
  $("cleanup").addEventListener("change", () => { autoCleanup = $("cleanup").checked; });
  on("insert", () => insert());
  on("delete-audio", async () => { const chunk = current(); if (!chunk?.audio || chunk.stage === "transcribing") return; if (!await window.verwrityDialog.confirm("Permanently delete this retained audio? Failed transcription cannot be retried afterwards.", { title: "Delete audio" })) return; delete chunk.audio; if (chunk.raw === undefined) { chunk.stage = "cancelled"; chunk.failure = "Audio deleted by author."; } render(); await persist(); });
  on("new", async () => {
    if (clearing || inserting) return;
    clearing = true; render();
    try {
      if (!await window.verwrityDialog.confirm("Clear this dictation and start fresh? This deletes its recordings, transcripts and reviewed sections.", { title: "Clear dictation", acceptLabel: "Clear / start fresh" })) return;
      await clearDraftBuffer();
    } finally { clearing = false; render(); }
  });
  setInterval(() => { if (phase === "recording") render(); }, 1000);
  document.addEventListener("visibilitychange", () => { if (document.hidden && ["recording", "opening"].includes(phase)) void pause("Recording paused while this tab was hidden. Review the boundary before resuming."); });
  navigator.mediaDevices?.addEventListener?.("devicechange", () => { if (phase === "recording") void pause("Audio devices changed. Review the boundary and resume explicitly."); });
  window.addEventListener("beforeunload", event => { if (importing || ["recording", "opening", "pausing"].includes(phase)) { event.preventDefault(); event.returnValue = ""; } });
  window.addEventListener("pagehide", () => { disposed = true; controllers.forEach(controller => controller.abort()); void pause(); });
}
