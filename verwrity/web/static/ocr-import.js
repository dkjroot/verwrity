import { buffers, saveBuffer, deleteBuffer } from "./ocr-storage.js";
import { showCleanupChanges } from "./draft-review.js";
import { postProgress } from "./ocr-progress.js";

const dialog = document.querySelector("#ocr-import-dialog");
const workspace = document.querySelector("[data-workspace]");
const $ = name => dialog.querySelector(`[data-ocr-${name}]`);
let draft, context, selected, destination, busy = false, inserting = false, opening = false;
let epoch = 0, message = "", storageFailed = false, saveChain = Promise.resolve(), saveTimer;
let videoURL, videoName, videoMetadata, renderedPage, renderedSignature = "";
let videoSource, batch, jobStage = "", startedAt = 0, serverAt = 0, stageAt = 0, generatedTokens;
let comparisonAnchor, fineFrame;
let pendingVideos = [];
const controllers = new Set();
const current = () => draft?.pages.find(p => p.id === selected);
// Retained video variants already include the import rotation. Adjustments are
// counterclockwise Pillow rotations relative to those retained pixels.
const captureRotation = p => (((p?.videoRotation || 0) - (p?.adjustment?.rotation || 0)) % 360 + 360) % 360;
const imageURL = p => `data:image/jpeg;base64,${p.preview || p.variants[p.variant || 0].image}`;
const approved = () => draft.pages.filter(p => p.checked && p.choice && p.review?.trim() && !p.inserted);
const local = endpoint => { try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname); } catch { return false; } };
const blank = projectId => ({ projectId, version: 0, pages: [] });
function vocabulary() {
  const terms = (draft.vocabulary || "").split("\n").map(term => term.trim()).filter(Boolean);
  if (terms.length > 1500 || terms.some(term => term.length > 100)) throw new Error("Keep at most 1,500 project terms of up to 100 characters each.");
  return terms;
}
const defaultProfile = { longest_edge: 1288, brightness: 1, contrast: 1, sharpness: 1, mode: "color", threshold: 160, autocontrast: false };
function readProfile() {
  return { longest_edge: Number($("profile-edge").value), brightness: Number($("profile-brightness").value),
    contrast: Number($("profile-contrast").value), sharpness: Number($("profile-sharpness").value),
    mode: $("profile-mode").value, threshold: Number($("profile-threshold").value), autocontrast: $("profile-autocontrast").checked };
}
function showProfile(value = defaultProfile) {
  for (const [name, key] of [["edge", "longest_edge"], ["brightness", "brightness"], ["contrast", "contrast"], ["sharpness", "sharpness"], ["mode", "mode"], ["threshold", "threshold"]]) $("profile-" + name).value = value[key];
  $("profile-autocontrast").checked = value.autocontrast;
}
function quality(p) { return [p.uncertain ? 0 : 1, p.variants[p.variant || 0].sharpness || 0]; }
function qualityOrder(a, b) { const x = quality(a), y = quality(b); return y[0] - x[0] || y[1] - x[1]; }
function protectedSelection(p) { return Boolean(p.choice || p.inserted || p.selectionManual || p.raw !== undefined); }
function progressView() {
  $("job-progress").hidden = !busy;
  if (!busy) return;
  $("job-stage").textContent = `${batch ? `${batch.kind} · page ${batch.index} of ${batch.total} · ${batch.done} completed${batch.failed ? `, ${batch.failed} failed` : ""}. ` : ""}${jobStage || "Working"}`;
  $("batch-progress").max = batch?.total || 1;
  $("batch-progress").value = (batch?.done || 0) + (batch?.failed || 0);
  const silence = serverAt ? Math.floor((Date.now() - serverAt) / 1000) : 0;
  $("job-time").textContent = `${Math.floor((Date.now() - startedAt) / 1000)}s elapsed${generatedTokens != null ? ` · ${generatedTokens} generated tokens` : ""}${serverAt ? ` · Last server update ${silence}s ago` : ""}${stageAt ? ` · Stage/token count unchanged for ${Math.floor((Date.now() - stageAt) / 1000)}s` : ""}${silence >= 10 ? " · Waiting for server updates; check connection or Cancel." : ""}${!context?.settings.ocr.remote && context?.settings.ocr.device === "cpu" ? " · CPU can be slow; no time estimate yet." : ""}`;
}
async function processing(url, data) {
  const controller = new AbortController(); controllers.add(controller);
  serverAt = Date.now(); generatedTokens = undefined;
  try { return await postProgress(url, data, { signal: controller.signal, onProgress: e => {
    if (jobStage !== e.stage || generatedTokens !== e.tokens) stageAt = Date.now();
    jobStage = e.stage; serverAt = Date.now(); generatedTokens = e.tokens; progressView();
  } }); }
  finally { controllers.delete(controller); }
}
async function persist() {
  clearTimeout(saveTimer);
  const owner = draft, snapshot = structuredClone(owner);
  const task = saveChain.catch(() => {}).then(async () => {
    owner.version = await saveBuffer(snapshot, owner.version);
    storageFailed = false;
  });
  saveChain = task;
  try { await task; }
  catch (failure) {
    storageFailed = true;
    throw failure;
  }
}
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist().catch(failure => { message = failure.message; render(); }), 250);
}
async function api(url, data, options = {}) {
  const controller = new AbortController(); controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 15 * 60 * 1000);
  try {
    const response = await fetch(url, { ...options, ...(data === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }), signal: controller.signal });
    const result = await response.json().catch(() => ({ error: `Server rejected this request (${response.status}). Check file limits and server availability; source is retained.` }));
    if (!response.ok) throw new Error(result.error || `OCR request failed (${response.status}).`);
    return result;
  } finally { clearTimeout(timeout); controllers.delete(controller); }
}
function pageRequest(p, extra = {}) {
  return { project_id: draft.projectId, page_id: p.id, image: p.variants[p.variant || 0].image,
    adjustment: p.adjustment || {}, ...extra };
}
function render() {
  if (!draft) return;
  if (!$("show-unchecked").checked && !comparisonAnchor && current() && !current().checked) selected = draft.pages.find(p => p.checked)?.id;
  const p = current();
  $("status").textContent = `${busy ? "Processing… " : ""}${message}\n${draft.pages.length} capture(s); ${draft.pages.filter(x => x.checked).length} checked; ${approved().length} approved, uninserted.`;
  progressView();
  const shown = draft.pages.filter(page => page.checked || $("show-unchecked").checked);
  $("visible-count").textContent = `${shown.length} of ${draft.pages.length} thumbnails shown · ${draft.pages.length - shown.length} unchecked hidden.`;
  const signature = JSON.stringify(draft.pages.map(p => [p.id, p.checked, p.variant, p.choice, p.inserted, p.stage, p.failure, p.raw !== undefined, p.uncertain, p.preview?.length]));
  if (signature !== renderedSignature || selected !== renderedPage) {
    $("pages").replaceChildren();
    for (const [index, page] of draft.pages.entries()) {
      const row = document.createElement("div"); row.className = "ocr-page";
      row.dataset.pageId = page.id;
      row.dataset.ocrState = ["Recognizing", "Correcting"].includes(page.stage) ? "working" : page.raw !== undefined ? "complete" : "pending";
      row.setAttribute("aria-current", String(page.id === selected));
      const check = document.createElement("input"); check.type = "checkbox"; check.checked = page.checked;
      check.setAttribute("aria-label", `Include capture ${index + 1}`); check.disabled = busy || inserting;
      check.addEventListener("change", () => { page.checked = check.checked; page.selectionManual = true; page.autoUnchecked = false; render(); saveSoon(); });
      const button = document.createElement("button"); button.type = "button";
      const image = document.createElement("img"); image.src = imageURL(page); image.alt = `Capture ${index + 1}`;
      const label = document.createElement("small");
      label.textContent = `${index + 1}. ${page.label}${page.timestamp !== undefined ? ` · ${page.timestamp.toFixed(2)}s` : ""} · ${page.inserted ? "Insertion " + page.inserted : page.choice ? "✓ " + page.choice : page.stage || "Awaiting OCR"}${page.uncertain ? " · Inspect uncertain capture" : ""}`;
      if (page.similar_to) label.textContent += " · Looks similar to another capture; inspect for repeats";
      if (page.variants[page.variant || 0].sharpness != null) label.textContent += ` · Sharpness ${page.variants[page.variant || 0].sharpness}`;
      if (page.raw !== undefined) label.textContent += " · ✓ OCR completed";
      if (page.cleaned !== undefined) label.textContent += " · ✓ Correction completed";
      if (page.similarity != null) label.textContent += ` · Similarity ${(page.similarity * 100).toFixed(1)}%${page.autoUnchecked ? " · Auto-unchecked repeat" : ""}`;
      if (["Recognizing", "Correcting"].includes(page.stage)) { const spinner = document.createElement("span"); spinner.className = "ocr-spinner"; button.append(spinner); }
      button.append(image, label); button.addEventListener("click", () => { comparisonAnchor = undefined; selected = page.id; render(); });
      row.append(check, button); $("pages").append(row);
    }
    renderedSignature = signature;
  }
  for (const row of $("pages").children) {
    const page = draft.pages.find(p => p.id === row.dataset.pageId);
    row.hidden = !page.checked && !$("show-unchecked").checked;
  }
  const changed = renderedPage !== selected;
  if (changed) {
    renderedPage = selected;
    $("raw").value = p?.raw ?? ""; $("review").value = p?.review ?? "";
    $("variant").replaceChildren();
    for (const [i, v] of (p?.variants || []).entries()) {
      const option = document.createElement("option"); option.value = i;
      option.textContent = `${i + 1}${v.timestamp !== undefined ? ` · ${v.timestamp.toFixed(2)}s` : ""}`;
      $("variant").append(option);
    }
    $("variant").value = p?.variant || 0;
    const crop = p?.adjustment?.crop || [0, 0, 1, 1];
    ["left", "top", "right", "bottom"].forEach((name, i) => { $(name).value = crop[i] * 100; });
    $("rotation").value = p?.adjustment?.rotation || 0;
    $("page-rotation").value = Math.round(captureRotation(p) / 90) * 90 % 360;
    $("image").src = p ? imageURL(p) : "";
    showProfile(p?.adjustment?.profile || defaultProfile);
    $("profile-status").textContent = p?.adjustment?.profile ? "Saved profile is used for this page's OCR." : "No profile applied to this page. Preview does not change the OCR input.";
    showCleanupChanges($("cleaned"), p);
  }
  $("page-status").textContent = p ? `${p.stage || "Awaiting OCR"}${p.model ? " · " + p.model : ""}${p.choice ? " · Approved: " + p.choice : ""}${p.inserted ? " · Insertion receipt: " + p.inserted : ""}${p.failure ? " · " + p.failure : ""} ${(p.warnings || []).join(" ")}` : "Import a video or image to begin.";
  for (const name of ["run", "clean-all", "import", "placement", "grab", "clear", "approve-all", "video-rotation", "rotate-video", "duplicates", "auto-duplicates", "duplicate-threshold"]) $(name).disabled = busy || inserting;
  for (const name of ["variant", "up", "down", "delete", "adjust", "retry", "clean", "raw-choice", "clean-choice", "approve", "review", "left", "top", "right", "bottom", "rotation", "page-rotation", "rotate-page"]) {
    $(name).disabled = !p || busy || inserting || Boolean(p.inserted);
  }
  $("raw-choice").disabled ||= p?.raw === undefined;
  $("clean-choice").disabled ||= p?.cleaned === undefined;
  $("clean").disabled ||= !p?.raw?.trim();
  $("run").disabled ||= !context?.settings.ocr.readiness?.configured;
  $("extract").disabled = busy || inserting || !pendingVideos.length;
  $("retry").disabled ||= !context?.settings.ocr.readiness?.configured;
  $("run").disabled ||= Boolean(context?.settings.ocr.remote && !$("image-consent").checked);
  $("retry").disabled ||= Boolean(context?.settings.ocr.remote && !$("image-consent").checked);
  $("clean-all").disabled ||= !context?.settings.llm.model || !draft.pages.some(p => p.checked && p.raw?.trim() && !p.choice && !p.inserted);
  $("clean").disabled ||= !context?.settings.llm.model;
  $("approve").disabled ||= !p?.review?.trim();
  $("insert").disabled = busy || inserting || storageFailed || !approved().length;
  $("cancel").disabled = !busy;
  $("source").disabled = !p;
  const position = draft.pages.indexOf(p), anchor = draft.pages.find(p => p.id === comparisonAnchor);
  $("previous").disabled = busy || inserting || !p || position <= 0;
  $("next").disabled = busy || inserting || !p || position >= draft.pages.length - 1;
  $("keep-capture").disabled = busy || inserting || !p || !anchor || p.checked;
  if (fineFrame && fineFrame.pageId !== p?.id) fineFrame = undefined;
  const checkedPages = draft.pages.filter(page => page.checked), checkedPosition = checkedPages.findIndex(page => page.id === (comparisonAnchor || p?.id));
  $("selected-previous").disabled = busy || inserting || checkedPosition <= 0;
  $("selected-next").disabled = busy || inserting || checkedPosition < 0 || checkedPosition >= checkedPages.length - 1;
  const videoAvailable = Boolean(p?.sourceId && videoSource === p.sourceId && $("video").videoWidth && !$("video").error);
  for (const name of ["frame-previous", "frame-next"]) $(name).disabled = busy || inserting || !videoAvailable;
  $("frame-keep").disabled = busy || inserting || !fineFrame || !p || Boolean(p.inserted);
  $("frame-reset").disabled = busy || inserting || !fineFrame;
  $("video-reselect").disabled = busy || inserting || !p?.sourceId;
  $("video-reselect").hidden = !p?.sourceId || videoAvailable;
  $("frame-status").textContent = fineFrame ? `Preview at ${fineFrame.timestamp.toFixed(3)}s` : "";
  $("comparison-status").textContent = p ? `Viewing capture ${position + 1} of ${draft.pages.length}${anchor && anchor.id !== p.id ? ` · Comparing with checked capture ${draft.pages.indexOf(anchor) + 1}.${p.checked ? " This capture is already checked." : " Keep this capture instead to replace that checked choice."}` : ". Arrows also show neighbouring unchecked captures."}` : "";
  $("review-during").disabled = busy || inserting || !context?.settings.llm.model;
  $("vocabulary").disabled = busy || inserting;
  $("prefer-sharpest").disabled = busy || inserting;
  for (const name of ["preview", "page", "all", "reset", "edge", "brightness", "contrast", "sharpness", "mode", "threshold", "autocontrast"]) $("profile-" + name).disabled = busy || inserting || !p || Boolean(p.inserted);
  // Checkboxes must reflect processing state even when page data did not change.
  $("pages").querySelectorAll("input").forEach(c => { c.disabled = busy || inserting; });
}
function refreshPage() { fineFrame = undefined; renderedPage = null; render(); }
async function open() {
  if (opening || inserting) return;
  opening = true;
  try {
    const editor = window.verwrityEditor, root = document.querySelector("[data-rich-editor]");
    const target = editor?.isEditable() ? editor.captureDictationTarget() : null;
    destination = target ? { target, projectId: workspace.dataset.projectId, sceneId: root?.dataset.sceneId } : null;
    context = await api("/ai/ocr");
    comparisonAnchor = undefined;
    if (context.project_id !== workspace.dataset.projectId) throw new Error("Project changed; reload before opening OCR import.");
    if (!draft || draft.projectId !== context.project_id) {
      draft = (await buffers()).find(b => b.projectId === context.project_id) || blank(context.project_id);
      for (const p of draft.pages) if (["Recognizing", "Correcting"].includes(p.stage)) p.stage = "Interrupted; retry explicitly";
      selected = draft.pages[0]?.id; renderedPage = undefined; renderedSignature = "";
    }
    draft.vocabulary = [...(context.terms || []), ...(draft.extraVocabulary || "").split(/[,\n]/)].map(term => term.trim()).filter(Boolean).join("\n");
    $("vocabulary").value = draft.extraVocabulary || "";
    const { ocr, llm } = context.settings;
    $("auto-duplicates").checked = draft.autoDuplicates !== false;
    $("duplicate-threshold").value = draft.duplicateThreshold || 75;
    $("show-unchecked").checked = draft.showUnchecked !== false;
    $("prefer-sharpest").checked = draft.preferSharpest !== false;
    $("review-during").checked = Boolean(draft.reviewDuring && llm.model);
    $("config-notice").hidden = Boolean(ocr.readiness?.configured);
    $("config-message").textContent = `OCR needs configuration: ${ocr.readiness?.message || "Choose an OCR provider in AI Models."}`;
    $("providers").textContent = `OCR: ${ocr.provider} · ${ocr.remote ? ocr.endpoint : `${ocr.device} · ${ocr.model_path || "local weights not configured"}`}. Optional text correction: ${llm.model || "not configured"} · ${llm.endpoint}.`;
    $("online-notice").hidden = !ocr.remote;
    $("online-endpoint").textContent = ocr.remote ? `Images will be sent to ${ocr.endpoint}. Provider charges may apply.` : "";
    $("image-consent").checked = false;
    $("consent-label").hidden = local(llm.endpoint);
    $("consent-text").textContent = `I allow each selected page's raw OCR text and selected words to go to ${llm.endpoint} for text correction. The text model doesn't receive page images.`;
    $("consent").checked = false;
    $("destination").textContent = destination ? "Insert at manuscript caret." : "Choose a manuscript caret before inserting.";
    render(); if (!dialog.open) dialog.showModal();
  } finally { opening = false; }
}
async function addPage(page, original) {
  if (draft.pages.length >= 500) throw new Error("This buffer reached 500 captures. Export and start a fresh buffer.");
  const p = { ...page, id: page.id || crypto.randomUUID(), label: page.label || "Image", checked: true,
    variant: 0, original, stage: "Awaiting OCR" };
  let index = draft.pages.length;
  if ($("placement").value === "after" && current()) index = draft.pages.indexOf(current()) + 1;
  draft.pages.splice(index, 0, p); selected = p.id;
  await duplicateSelection(p);
  try { await persist(); }
  catch (failure) { message = failure.message; render(); throw failure; }
  render();
}
async function duplicateSelection(newPage) {
  const comparable = p => p.fingerprint_version === 2 && p.fingerprint;
  const pages = newPage ? [newPage].filter(comparable) : draft.pages.filter(p => comparable(p) && (p.checked || p.autoUnchecked));
  if (!newPage && $("prefer-sharpest").checked) pages.sort((a, b) => Number(protectedSelection(b)) - Number(protectedSelection(a)) || qualityOrder(a, b));
  const references = newPage ? draft.pages.filter(p => p !== newPage && comparable(p) && p.checked).map(p => ({ id: p.id, fingerprint: p.fingerprint })) : [];
  if (!pages.length || pages.length + references.length < 2) return;
  jobStage = "Comparing duplicate captures"; progressView();
  const threshold = Number($("duplicate-threshold").value) / 100;
  const result = await api("/ai/ocr/similarity", { project_id: draft.projectId, threshold, references,
    pages: pages.map(p => ({ id: p.id, fingerprint: p.fingerprint, keep: protectedSelection(p) })) });
  for (const match of result.matches) {
    const p = draft.pages.find(p => p.id === match.id); if (!p) continue;
    p.similarity = match.similarity; p.similar_to = match.similarity >= threshold ? match.similar_to : undefined;
    if (p.choice || p.inserted || p.selectionManual || p.raw !== undefined) continue;
    p.autoUnchecked = $("auto-duplicates").checked && match.similarity >= threshold;
    p.checked = !p.autoUnchecked;
    const previous = draft.pages.find(item => item.id === match.similar_to);
    if (newPage && p.autoUnchecked && $("prefer-sharpest").checked && previous && !protectedSelection(previous) && qualityOrder(p, previous) < 0) {
      previous.checked = false; previous.autoUnchecked = true; previous.similar_to = p.id; previous.similarity = match.similarity;
      p.checked = true; p.autoUnchecked = false; delete p.similar_to;
    }
  }
}
async function applyRotation(p, clockwise) {
  const adjustment = { ...(p.adjustment || {}), rotation: (((p.videoRotation || 0) - clockwise + 540) % 360) - 180 };
  const result = await api("/ai/ocr/preview", { ...pageRequest(p), adjustment });
  for (const name of ["raw", "cleaned", "edits", "choice", "review", "model", "failure"]) delete p[name];
  p.stage = "Awaiting OCR"; p.adjustment = adjustment; p.preview = result.image;
  p.processedSize = `${result.width} × ${result.height}`;
  p.fingerprint = result.fingerprint; p.fingerprint_version = result.fingerprint_version;
}
async function importImage(file, label, timestamp) {
  if (file.size > 24 * 1024 * 1024) throw new Error("Choose an image up to 24 MiB.");
  const token = epoch;
  const result = await api("/ai/ocr/import", undefined, { method: "POST", body: file,
    headers: { "X-Verwrity-Project": draft.projectId, "X-Verwrity-Media": "image" } });
  if (token !== epoch) return;
  await addPage({ label: label || file.name, timestamp, fingerprint: result.fingerprint, fingerprint_version: result.fingerprint_version,
    sourceId: timestamp !== undefined ? videoSource : undefined, sourceFile: timestamp !== undefined ? videoMetadata : undefined, videoRotation: timestamp !== undefined ? Number($("video-rotation").value) : undefined,
    variants: [{ image: result.image, timestamp, sharpness: result.sharpness }] }, file);
}
function videoPreview(file, sourceId) {
  if (videoURL) URL.revokeObjectURL(videoURL);
  videoURL = URL.createObjectURL(file); videoName = file.name;
  videoMetadata = { name: file.name, size: file.size };
  videoSource = sourceId || crypto.randomUUID();
  $("video").src = videoURL; $("video-panel").hidden = false;
}
async function nearbyFrame(step) {
  const p = current(), video = $("video"), token = epoch;
  if (!p?.sourceId || videoSource !== p.sourceId || !video.videoWidth) throw new Error("Re-select this capture's original video first.");
  const time = (fineFrame?.pageId === p.id ? fineFrame.timestamp : p.variants[p.variant || 0].timestamp ?? p.timestamp);
  const target = time + step * (p.frame_step || 1 / 30);
  if (!Number.isFinite(target) || target < 0 || target >= video.duration) throw new Error("Reached the end of the available video frames.");
  video.pause();
  if (Math.abs(video.currentTime - target) > .00001) await new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); video.removeEventListener("seeked", done); video.removeEventListener("error", failed); resolve(); };
    const failed = () => { clearTimeout(timer); video.removeEventListener("seeked", done); video.removeEventListener("error", failed); reject(new Error("Could not decode this nearby video frame.")); };
    const timer = setTimeout(failed, 15000); video.addEventListener("seeked", done); video.addEventListener("error", failed); video.currentTime = target;
  });
  if (token !== epoch || current()?.id !== p.id) return;
  const canvas = document.createElement("canvas"), scale = Math.min(1, 3200 / Math.max(video.videoWidth, video.videoHeight));
  const angle = p.videoRotation || 0, w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);
  canvas.width = angle % 180 ? h : w; canvas.height = angle % 180 ? w : h;
  const ctx = canvas.getContext("2d"); ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(angle * Math.PI / 180); ctx.drawImage(video, -w / 2, -h / 2, w, h);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .95));
  if (!blob) throw new Error("Could not capture this video frame.");
  const result = await api("/ai/ocr/import", undefined, { method: "POST", body: blob, headers: { "X-Verwrity-Project": draft.projectId, "X-Verwrity-Media": "image" } });
  const preview = p.adjustment ? await api("/ai/ocr/preview", { project_id: draft.projectId, page_id: p.id, image: result.image, adjustment: p.adjustment }) : result;
  if (token !== epoch || current()?.id !== p.id) return;
  fineFrame = { ...result, preview: preview.image, processedSize: `${preview.width || canvas.width} × ${preview.height || canvas.height}`, timestamp: target, pageId: p.id };
  $("image").src = `data:image/jpeg;base64,${preview.image}`; render();
}
async function importVideo(file) {
  if (file.size > 1024 ** 3) throw new Error("Video exceeds 1 GiB. Split the recording before import.");
  videoPreview(file);
  const token = epoch, controller = new AbortController(); controllers.add(controller);
  let reader, complete = false;
  try {
    const response = await fetch("/ai/ocr/import", { method: "POST", body: file, signal: controller.signal,
      headers: { "X-Verwrity-Project": draft.projectId, "X-Verwrity-Media": "video", "X-Verwrity-Rotation": $("video-rotation").value } });
    if (!response.ok) { const result = await response.json(); throw new Error(result.error || "Video upload failed."); }
    reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    while (token === epoch) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      if (buffer.length > 40 * 1024 * 1024) throw new Error("Capture packet exceeds its size limit.");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const item = JSON.parse(line);
        if (token !== epoch) return;
        if (item.error) throw new Error(item.error);
        if (item.done) complete = true;
        else if (item.progress !== undefined) { message = `Video analysed through ${item.progress.toFixed(1)}s. Completed captures saved.`; render(); }
        else { await addPage({ ...item, label: file.name, sourceId: videoSource, sourceFile: videoMetadata, videoRotation: Number($("video-rotation").value) }); }
      }
      if (done) break;
    }
    if (!complete && token === epoch) throw new Error("Video import ended before completion. Completed captures are retained.");
    if (token === epoch) message = "Video analysis complete. Inspect thumbnails and uncheck repeats before OCR.";
  } finally { if (reader) await reader.cancel().catch(() => {}); controllers.delete(controller); }
}
async function work(action) {
  if (busy || inserting) return;
  if (storageFailed) await persist();
  busy = true; startedAt = Date.now(); serverAt = 0; stageAt = 0; jobStage = "Preparing operation"; generatedTokens = undefined; render(); const token = epoch;
  const timer = setInterval(progressView, 500);
  try { await action(token); }
  finally { clearInterval(timer); busy = false; batch = null; render(); }
}
async function resetText(p) {
  if (p.inserted) return false;
  if (p.raw !== undefined || p.choice || p.review?.trim()) {
    if (!await window.verwrityDialog.confirm("Replace this capture's OCR/review with a new source or recognition? Download text first if you need the old review. Manuscript text is unaffected.", { title: "Reset page review" })) return false;
  }
  delete p.raw; delete p.cleaned; delete p.edits; delete p.choice; delete p.review; delete p.model;
  delete p.failure; p.stage = "Awaiting OCR"; return true;
}
async function recognize(p, token) {
  p.stage = "Recognizing"; delete p.failure; render(); await persist();
  revealPage(p.id);
  jobStage = context.settings.ocr.remote ? "Starting online OCR" : "Starting local OCR";
  const result = await processing("/ai/ocr/recognize", pageRequest(p, { configuration: context.configurations.ocr,
    consent_endpoint: $("image-consent").checked ? context.settings.ocr.endpoint : "" }));
  if (token !== epoch) return;
  if (result.page_id !== p.id || typeof result.text !== "string") throw new Error("OCR response did not match this page.");
  p.raw = result.text; p.review = result.text; p.model = result.model; p.warnings = result.warnings;
  p.stage = result.text.trim() ? "OCR ready" : "No text recognised; inspect image";
  await persist(); refreshPage();
}
function checkCleanupConsent() {
  const llm = context.settings.llm;
  if (!llm.model) throw new Error("Configure an LLM in AI Models or keep raw OCR.");
  if (!local(llm.endpoint) && (!llm.remote_consent || !$("consent").checked)) throw new Error("Consent to text correction at the displayed LLM endpoint first, including AI Models consent.");
}
async function clean(p, token) {
  checkCleanupConsent();
  const llm = context.settings.llm;
  const raw = p.raw, words = draft.vocabulary || ""; p.stage = "Correcting"; render(); await persist();
  revealPage(p.id);
  jobStage = "Waiting for text correction provider";
  const result = await processing("/ai/ocr/cleanup", { project_id: draft.projectId, page_id: p.id, text: raw,
    configuration: context.configurations.llm, terms: vocabulary(), consent_endpoint: $("consent").checked ? llm.endpoint : "" });
  if (token !== epoch || p.raw !== raw || words !== (draft.vocabulary || "") || p.choice || p.inserted) return;
  p.cleaned = result.text; p.edits = result.edits;
  p.cleanupVocabulary = words;
  p.stage = result.edits?.length ? `Correction ready${result.skipped_edits ? "; some proposals withheld" : ""}` : "Model had no usable corrections";
  await persist(); refreshPage();
}
function revealPage(id) {
  const row = Array.from($("pages").children).find(row => row.dataset.pageId === id), nav = $("pages").parentElement;
  if (!row) return;
  const bounds = row.getBoundingClientRect(), viewport = nav.getBoundingClientRect();
  if (bounds.top < viewport.top) nav.scrollTop += bounds.top - viewport.top;
  else if (bounds.bottom > viewport.bottom) nav.scrollTop += bounds.bottom - viewport.bottom;
}
async function processPages(kind, pages) {
  if (kind === "ocr" && context.settings.ocr.remote && !$("image-consent").checked) throw new Error("Allow selected manuscript images to leave your computer for this OCR endpoint first.");
  const reviewDuring = kind === "ocr" && $("review-during").checked;
  if (reviewDuring) checkCleanupConsent();
  if (reviewDuring || kind === "clean") vocabulary();
  await work(async token => {
    message = "";
    batch = { kind: kind === "ocr" ? reviewDuring ? "OCR + LLM review" : "OCR" : "Correction", total: pages.length, index: 0, done: 0, failed: 0 };
    for (const p of pages) {
      if (token !== epoch) break;
      batch.index++; progressView();
      try {
        if (kind === "ocr") { if (p.raw === undefined) await recognize(p, token); }
        else await clean(p, token);
        if (reviewDuring && token === epoch && p.raw?.trim()) await clean(p, token);
        if (token === epoch) batch.done++;
      }
      catch (failure) {
        if (token !== epoch) break;
        p.stage = "Needs attention"; p.failure = failure.message; message = failure.message;
        batch.failed++;
        render(); await persist();
        if (storageFailed || failure.status === 409) break;
      }
    }
    if (token === epoch) message = `${batch.kind}: ${batch.done} page(s) completed${batch.failed ? `; ${batch.failed} need attention. Raw OCR is retained; retry unfinished review with the same run control.` : ". Review and approve before insertion."}`;
  });
}
function cancel() {
  epoch++;
  for (const controller of controllers) controller.abort();
  for (const p of draft.pages) if (["Recognizing", "Correcting"].includes(p.stage)) p.stage = "Cancelled; retry explicitly";
  message = "Processing cancelled. The OCR worker is stopped; completed results are retained. Any online OCR or text-provider request already sent may finish and incur charges remotely.";
  render(); saveSoon();
}
function choose(kind) {
  const p = current(); if (!p || p.inserted) return;
  if (kind === "raw") p.review = p.raw;
  if (kind === "correction") p.review = p.cleaned;
  if (!p.review?.trim()) return;
  p.choice = kind; refreshPage(); saveSoon();
}
async function insert() {
  if (busy || inserting || storageFailed) return;
  const parts = approved(); if (!parts.length) return;
  const target = destination;
  if (!target || target.projectId !== workspace.dataset.projectId || target.projectId !== draft.projectId ||
      target.sceneId !== document.querySelector("[data-rich-editor]")?.dataset.sceneId || !window.verwrityEditor?.isEditable()) throw new Error("Choose an editable manuscript caret and reopen OCR import before inserting.");
  inserting = true; render();
  try {
    const omitted = draft.pages.filter(p => !p.inserted && !parts.includes(p)).length;
    if (!await window.verwrityDialog.confirm(`Insert ${parts.length} approved page(s) in thumbnail order as one undoable edit? ${omitted} unchecked or unapproved capture(s) will be omitted. Review and source images will be retained.`, { title: "Insert OCR pages" })) return;
    parts.forEach(p => { p.inserted = "prepared"; });
    try { await persist(); }
    catch (failure) { parts.forEach(p => { delete p.inserted; }); throw failure; }
    if (!target.target.insert(parts.map(p => p.review).join("\n\n"))) {
      parts.forEach(p => { delete p.inserted; }); await persist();
      throw new Error("The captured manuscript changed. Hide, choose the caret and reopen. Review is retained.");
    }
    parts.forEach(p => { p.inserted = "confirmed"; }); destination = null;
    message = "Inserted. Use manuscript Undo to undo insertion. Retained receipts prevent duplicate insertion; a prepared receipt after a crash needs manual manuscript review.";
    await persist(); dialog.close(); window.verwrityEditor.focus();
  } finally { inserting = false; render(); }
}
function on(name, action) {
  $(name)?.addEventListener("click", () => Promise.resolve().then(action).catch(failure => {
    message = failure.name === "AbortError" ? "Cancelled; completed work retained." : failure.message; render();
  }));
}
async function applyProfile(p, profile) {
  const adjustment = { ...(p.adjustment || {}), profile };
  if (!profile) delete adjustment.profile;
  const result = await api("/ai/ocr/preview", { ...pageRequest(p), adjustment });
  // A failed preview leaves previous review intact. Successful application is
  // explicit and always starts from the retained capture, avoiding compounded edits.
  for (const name of ["raw", "cleaned", "edits", "choice", "review", "model", "failure"]) delete p[name];
  p.stage = "Awaiting OCR"; p.adjustment = adjustment; p.preview = result.image;
  p.processedSize = `${result.width} × ${result.height}`;
}
if (dialog) {
  for (const event of ["loadeddata", "error"]) $("video").addEventListener(event, () => { if (draft) render(); });
  for (const [name, step] of [["selected-previous", -1], ["selected-next", 1]]) on(name, () => {
    if (busy || inserting) return;
    const pages = draft.pages.filter(p => p.checked), index = pages.findIndex(p => p.id === (comparisonAnchor || selected));
    const next = pages[index + step]; if (index < 0 || !next) return;
    comparisonAnchor = undefined; fineFrame = undefined; selected = next.id; refreshPage();
  });
  for (const [name, step] of [["frame-previous", -1], ["frame-next", 1]]) on(name, () => work(() => nearbyFrame(step)));
  on("frame-reset", () => { fineFrame = undefined; refreshPage(); });
  on("video-reselect", () => $("video-source").click());
  $("video-source").addEventListener("change", () => {
    const file = $("video-source").files[0], p = current(); $("video-source").value = "";
    if (!file || !p?.sourceId || busy || inserting) return;
    if (file.name !== p.label || (p.sourceFile?.size && file.size !== p.sourceFile.size)) { message = `Choose the original recording named ${p.label}${p.sourceFile?.size ? ` (${p.sourceFile.size} bytes)` : ""}.`; render(); return; }
    videoPreview(file, p.sourceId); fineFrame = undefined; render();
  });
  on("frame-keep", () => work(async () => {
    const p = current(), frame = fineFrame;
    if (!p || p.inserted || !frame || frame.pageId !== p.id) return;
    if (draft.pages.length >= 500) throw new Error("This buffer reached 500 captures; export and start a fresh buffer.");
    const replacement = { id: crypto.randomUUID(), label: p.label, sourceId: p.sourceId, sourceFile: p.sourceFile, videoRotation: p.videoRotation, frame_step: p.frame_step,
      timestamp: frame.timestamp, variants: [{ image: frame.image, timestamp: frame.timestamp, sharpness: frame.sharpness }], variant: 0,
      fingerprint: frame.fingerprint, fingerprint_version: frame.fingerprint_version, checked: true, selectionManual: true,
      adjustment: structuredClone(p.adjustment), preview: frame.preview, processedSize: frame.processedSize, stage: "Awaiting OCR" };
    const anchor = draft.pages.find(page => page.id === comparisonAnchor) || p;
    if (anchor.inserted) throw new Error("This selected page was already inserted. Select an uninserted page first.");
    anchor.checked = false; anchor.selectionManual = true; anchor.autoUnchecked = false;
    draft.pages.splice(draft.pages.indexOf(anchor) + 1, 0, replacement);
    selected = replacement.id; comparisonAnchor = undefined; fineFrame = undefined;
    await persist(); message = "Nearby video frame selected. The old capture and its review are retained unchecked."; refreshPage();
  }));
  window.addEventListener("verwrity-project-words-changed", event => {
    if (!draft || event.detail.project_id !== draft.projectId) return;
    context.terms = event.detail.words;
    draft.vocabulary = [...event.detail.words, ...(draft.extraVocabulary || "").split(/[,\n]/)].map(term => term.trim()).filter(Boolean).join("\n"); $("vocabulary").value = draft.extraVocabulary || ""; saveSoon();
  });
  $("vocabulary").addEventListener("input", () => { draft.extraVocabulary = $("vocabulary").value; draft.vocabulary = [...context.terms, ...draft.extraVocabulary.split(/[,\n]/)].map(term => term.trim()).filter(Boolean).join("\n"); saveSoon(); });
  $("image-consent").addEventListener("change", render);
  for (const [name, step] of [["previous", -1], ["next", 1]]) on(name, () => {
    if (busy || inserting) return;
    const p = current(), position = draft.pages.indexOf(p), next = draft.pages[position + step];
    if (!p || !next) return;
    if (!comparisonAnchor && p.checked) comparisonAnchor = p.id;
    selected = next.id; refreshPage();
  });
  on("keep-capture", async () => {
    if (busy || inserting) return;
    const p = current(), anchor = draft.pages.find(p => p.id === comparisonAnchor);
    if (!p || p.checked || !anchor || !anchor.checked) return;
    anchor.checked = false; anchor.selectionManual = true; anchor.autoUnchecked = false;
    p.checked = true; p.selectionManual = true; p.autoUnchecked = false;
    comparisonAnchor = undefined; await persist(); refreshPage();
    message = "Capture choice replaced. Both source captures and any OCR/review are retained; manuscript text is unchanged."; render();
  });
  for (const [control, property] of [["show-unchecked", "showUnchecked"], ["prefer-sharpest", "preferSharpest"], ["review-during", "reviewDuring"]]) {
    $(control).addEventListener("change", () => { if (control === "show-unchecked") comparisonAnchor = undefined; draft[property] = $(control).checked; render(); saveSoon(); });
  }
  on("profile-preview", () => work(async () => {
    const p = current(); if (!p) return;
    fineFrame = undefined;
    const result = await api("/ai/ocr/preview", { ...pageRequest(p), adjustment: { ...(p.adjustment || {}), profile: readProfile() } });
    $("image").src = `data:image/jpeg;base64,${result.image}`;
    $("profile-status").textContent = `Preview only · ${result.width} × ${result.height} px. Apply to use this profile for OCR. Existing review is unchanged.`;
  }));
  for (const scope of ["page", "all", "reset"]) on("profile-" + scope, () => work(async token => {
    const p = current(); if (!p) return;
    const profile = scope === "reset" ? undefined : readProfile();
    const pages = scope === "all" ? draft.pages.filter(p => !p.inserted) : [p];
    if (pages.some(p => p.raw !== undefined || p.choice || p.review?.trim()) && !await window.verwrityDialog.confirm(`Apply this image profile to ${pages.length} page(s) and reset their OCR, corrections and review? Manuscript text is unaffected.`)) return;
    let applied = 0;
    for (const page of pages) {
      if (token !== epoch) break;
      jobStage = `Applying image profile · ${++applied} of ${pages.length}`; progressView();
      await applyProfile(page, profile);

      await persist();
    }
    refreshPage();
    message = `Image profile ${scope === "reset" ? "removed" : "applied"} on ${applied} page(s).`;
    render();
  }));
  $("auto-duplicates").addEventListener("change", () => { draft.autoDuplicates = $("auto-duplicates").checked; saveSoon(); });
  $("duplicate-threshold").addEventListener("change", () => { draft.duplicateThreshold = Number($("duplicate-threshold").value); saveSoon(); });
  document.querySelectorAll("[data-ocr-open]").forEach(b => b.addEventListener("click", () => open().catch(failure => window.verwrityDialog.alert(failure.message))));
  dialog.querySelectorAll("[data-ocr-hide]").forEach(b => b.addEventListener("click", () => { if (!inserting) dialog.close(); }));
  dialog.addEventListener("cancel", e => { if (inserting) e.preventDefault(); });
  on("import", () => $("files").click());
  $("files").addEventListener("change", () => {
    const files = Array.from($("files").files); $("files").value = "";
    work(async token => {
      for (const file of files) {
        if (token !== epoch) break;
        if (/^image\//u.test(file.type) || /\.(jpe?g|png|webp)$/iu.test(file.name)) await importImage(file);
        else { pendingVideos.push(file); videoPreview(file); }
      }
    }).catch(failure => { message = failure.message; render(); });
  });
  on("extract", () => work(async token => {
    while (pendingVideos.length && token === epoch) {
      const file = pendingVideos[0];
      await importVideo(file);
      pendingVideos.shift();
    }
  }));
  on("grab", () => work(async () => {
    const video = $("video"); if (!video.videoWidth || video.seeking) throw new Error("Wait for the selected video frame to load.");
    const canvas = document.createElement("canvas"), scale = Math.min(1, 3200 / Math.max(video.videoWidth, video.videoHeight));
    const angle = Number($("video-rotation").value), w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);
    canvas.width = angle % 180 ? h : w; canvas.height = angle % 180 ? w : h;
    const ctx = canvas.getContext("2d"); ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(angle * Math.PI / 180);
    ctx.drawImage(video, -w / 2, -h / 2, w, h);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .95));
    if (!blob) throw new Error("Could not capture this frame.");
    await importImage(blob, videoName || "Manual video frame", video.currentTime);
  }));
  on("duplicates", () => work(async () => { await duplicateSelection(); await persist(); render(); }));
  on("rotate-page", () => work(async () => {
    const p = current(); if (!p || !await resetText(p)) return;
    await applyRotation(p, Number($("page-rotation").value)); await persist(); refreshPage();
  }));
  on("rotate-video", () => work(async () => {
    const source = current()?.sourceId || videoSource;
    if (!source) throw new Error("Select a capture from the video you want to rotate. Older buffers need a new video import to identify a video group.");
    const pages = draft.pages.filter(p => p.sourceId === source && !p.inserted);
    if (!await window.verwrityDialog.confirm(`Apply this orientation to ${pages.length} uninserted video capture(s)? Existing OCR, approval and review for those pages will reset; manuscript text is unaffected.`)) return;
    for (const p of pages) {
      await applyRotation(p, Number($("video-rotation").value));
      await persist();
    }
    await duplicateSelection(); await persist(); refreshPage();
  }));
  on("run", () => processPages("ocr", draft.pages.filter(p => p.checked && !p.choice && !p.inserted &&
    (p.raw === undefined || ($("review-during").checked && p.raw?.trim() &&
      (p.cleaned === undefined || (p.cleanupVocabulary || "") !== (draft.vocabulary || "")))))));
  on("clean-all", () => processPages("clean", draft.pages.filter(p => p.checked && p.raw?.trim() &&
    (p.cleaned === undefined || (p.cleanupVocabulary || "") !== (draft.vocabulary || "")) && !p.choice && !p.inserted)));
  on("retry", async () => { const p = current(); if (p && await resetText(p)) { refreshPage(); await persist(); await processPages("ocr", [p]); } });
  on("clean", async () => {
    const p = current(); if (!p || p.choice) { message = "This page is approved. Preserve that choice; use its editable review or explicitly rerun OCR to reset it."; render(); return; }
    await processPages("clean", [p]);
  });
  on("cancel", cancel);
  on("raw-choice", () => choose("raw")); on("clean-choice", () => choose("correction")); on("approve", () => choose("edited"));
  $("review").addEventListener("input", () => { const p = current(); if (!p || p.inserted) return; p.review = $("review").value; if (p.choice) p.choice = "edited"; saveSoon(); render(); });
  on("approve-all", async () => {
    const candidates = draft.pages.filter(p => p.checked && !p.choice && !p.inserted && p.raw?.trim());
    if (!await window.verwrityDialog.confirm(`Approve ${candidates.length} ready page(s), using existing manual edits, otherwise correction when ready or raw OCR? This does not insert anything.`, { title: "Approve OCR pages" })) return;
    for (const p of candidates) {
      const edited = p.review !== p.raw;
      if (!edited) p.review = p.cleaned ?? p.raw;
      p.choice = edited ? "edited" : p.cleaned !== undefined ? "correction" : "raw";
    }
    await persist(); refreshPage();
  });
  for (const [name, step] of [["up", -1], ["down", 1]]) on(name, () => {
    const p = current(), i = draft.pages.indexOf(p), j = i + step;
    if (p && j >= 0 && j < draft.pages.length) { draft.pages.splice(i, 1); draft.pages.splice(j, 0, p); render(); saveSoon(); }
  });
  $("variant").addEventListener("change", () => {
    const p = current(), variant = Number($("variant").value);
    Promise.resolve().then(async () => {
      if (!await resetText(p)) { $("variant").value = p.variant || 0; return; }
      p.variant = variant; delete p.preview; delete p.adjustment; delete p.processedSize; refreshPage(); await persist();
    }).catch(failure => { message = failure.message; render(); });
  });
  on("adjust", () => work(async () => {
    const p = current(); if (!p) return;
    const adjustment = { ...(p.adjustment || {}), crop: ["left", "top", "right", "bottom"].map(n => Number($(n).value) / 100), rotation: Number($("rotation").value) };
    const result = await api("/ai/ocr/preview", { ...pageRequest(p), adjustment });
    if (!await resetText(p)) return;
    p.adjustment = adjustment; p.preview = result.image; p.fingerprint = result.fingerprint; p.fingerprint_version = result.fingerprint_version; refreshPage(); await persist();
  }));
  on("original", () => { const p = current(); fineFrame = undefined; if (p) $("image").src = `data:image/jpeg;base64,${p.variants[p.variant || 0].image}`; render(); });
  function zoom() {
    const image = $("image"), mode = $("zoom").value;
    image.style.height = mode === "height" ? "100%" : "auto";
    image.style.width = mode === "height" ? "auto" : mode === "fit" ? "100%" : `${image.naturalWidth * Number(mode) / 100}px`;
    $("image-status").textContent = current() ? `${image.naturalWidth} × ${image.naturalHeight} px displayed · ${current().processedSize ? `saved OCR input ${current().processedSize} px` : "retained capture"}` : "";
  }
  $("zoom").addEventListener("change", zoom); $("image").addEventListener("load", zoom);
  on("source", () => {
    const p = current(); if (!p) return;
    const link = document.createElement("a");
    link.download = p.original?.name || `capture-${p.id}.jpg`;
    const url = p.original ? URL.createObjectURL(p.original) : null;
    link.href = url || `data:image/jpeg;base64,${p.variants[p.variant || 0].image}`;
    link.click(); if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  on("delete", async () => {
    const p = current(); if (!p || !await window.verwrityDialog.confirm("Delete this capture and its OCR review from browser recovery? Manuscript text is unaffected.")) return;
    const i = draft.pages.indexOf(p); draft.pages.splice(i, 1); selected = draft.pages[Math.min(i, draft.pages.length - 1)]?.id;
    await persist(); refreshPage();
  });
  on("insert", insert);
  on("clear", async () => {
    if (busy || inserting) return;
    if (!await window.verwrityDialog.confirm("Clear this import, including its images and reviewed pages?")) return;
    clearTimeout(saveTimer); await saveChain.catch(() => {}); await deleteBuffer(draft.projectId, draft.version);
    pendingVideos = []; draft = blank(draft.projectId); selected = undefined; storageFailed = false; epoch++;
    draft.vocabulary = [...(context.terms || []), ...(draft.extraVocabulary || "").split(/[,\n]/)].map(term => term.trim()).filter(Boolean).join("\n"); $("vocabulary").value = draft.extraVocabulary || "";
    comparisonAnchor = undefined;
    if (videoURL) URL.revokeObjectURL(videoURL); videoURL = undefined; $("video").removeAttribute("src"); $("video-panel").hidden = true;
    $("video").load(); videoName = undefined; videoSource = undefined;
    $("files").value = "";
    $("video-rotation").value = "0"; $("page-rotation").value = "0";
    $("placement").value = "end"; $("zoom").value = "height";
    $("image").style.width = "auto"; $("image").style.height = "100%";
    $("show-unchecked").checked = true; $("prefer-sharpest").checked = true; $("review-during").checked = false;
    $("image-consent").checked = false;
    $("image-status").textContent = "";
    $("auto-duplicates").checked = true; $("duplicate-threshold").value = 75;
    message = "OCR dialog cleared. Import video or images to start a fresh test. Manuscript text is unaffected.";
    await persist(); refreshPage();
  });
}
