"use strict";

const dialog = document.querySelector("#dialogue-dialog");
const speakerDialog = document.querySelector("#speaker-dialog");
const speakerForm = speakerDialog?.querySelector("form");
const list = dialog?.querySelector("[data-dialogue-list]");
const status = dialog?.querySelector("[data-dialogue-status]");
const accept = dialog?.querySelector("[data-accept-dialogue]");
const evaluate = dialog?.querySelector("[data-evaluate-dialogue]");
const observations = dialog?.querySelector("[data-dialogue-observations]");
const extractionControls = document.querySelector("[data-dialogue-analysis]");
const extractionStatus = extractionControls?.querySelector("[data-dialogue-analysis-status]");
let extracting = false;
function extractionState(busy, message) {
  extracting = busy;
  extractionControls?.setAttribute("aria-busy", String(busy));
  document.querySelectorAll("[data-extract-dialogue]").forEach(node => { node.disabled = busy; });
  document.querySelectorAll("[data-cancel-dialogue-analysis]").forEach(node => { node.hidden = !busy; });
  if (extractionStatus && message) extractionStatus.textContent = message;
}
const projectId = document.querySelector("[data-workspace]")?.dataset.projectId;
let contextRange, selection, sourceHash, assignmentSnapshot, proposal, chooser, collection, controller, visit = 0, pages = [], characters = [];
let publishingPages = false;
function publishPages(values) {
  publishingPages = true;
  try { for (const page of values || []) window.dispatchEvent(new CustomEvent("verwrity-wiki-page-updated", { detail: page })); }
  finally { publishingPages = false; }
}

const api = () => window.verwrityEditor;
const sceneUrl = () => `/scene/${api().sceneId}/dialogue`;
const element = (tag, text, parent) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; parent?.append(node); return node; };
const button = (text, parent, handler) => { const node = element("button", text, parent); node.type = "button"; node.addEventListener("click", handler); return node; };
const headers = () => ({ "Content-Type": "application/json", "X-Verwrity-Project-Id": projectId });

async function request(url, data, signal) {
  const response = await fetch(url, { method: data === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: headers(), ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not complete the dialogue action");
  return result;
}

async function loadPages() {
  ({ pages, characters } = await request("/dialogue/characters"));
}

function speakerSelect(parent, selected = "") {
  const wrapper = element("div", undefined, parent);
  const filter = element("button", "Character pages only", wrapper); filter.type = "button";
  filter.className = "annotation-toggle"; filter.setAttribute("aria-pressed", "true");
  const characterOnly = () => filter.getAttribute("aria-pressed") === "true";
  const label = element("label", "Speaker", wrapper);
  const select = element("select", undefined, label);
  select.setAttribute("aria-label", "Dialogue speaker");
  const outside = element("p", "The current selection is outside the character filter and has been kept.", wrapper);
  outside.className = "muted"; outside.hidden = true;
  const name = element("input", undefined, wrapper); name.placeholder = "New character name"; name.maxLength = 200;
  name.setAttribute("aria-label", "New character wiki name"); name.hidden = true;
  const isCharacter = page => (page.tags || []).some(tag => tag.trim().toLocaleLowerCase() === "character");
  function choices(value) {
    select.replaceChildren(); select.add(new Option("Unknown speaker", ""));
    const current = pages.find(page => page.id === value);
    for (const page of pages.filter(page => !characterOnly() || isCharacter(page) || page.id === value)) {
      const retained = characterOnly() && !isCharacter(page);
      select.add(new Option(page.title + (retained ? " (current selection · outside filter)" : ""), page.id));
    }
    select.add(new Option("Create a character wiki…", "create"));
    select.value = value;
    outside.hidden = !(characterOnly() && current && !isCharacter(current));
    name.hidden = select.value !== "create";
  }
  label.after(filter);
  choices(selected || "");
  filter.addEventListener("click", () => {
    filter.setAttribute("aria-pressed", String(!characterOnly()));
    choices(select.value);
  });
  select.addEventListener("change", () => choices(select.value));
  return { select, name, value: () => ({ speaker_id: select.value === "create" ? null : select.value || null,
    new_name: select.value === "create" ? name.value : "" }) };
}

async function refreshEditor() {
  const data = await request(sceneUrl());
  window.dispatchEvent(new CustomEvent("verwrity-scene-checkpoints-changed", { detail: { sceneId: api().sceneId, revisions: data.revisions } }));
  api().setDialogue(data.dialogue.map(item => ({ ...item, speaker_name: pages.find(page => page.id === item.speaker_id)?.title || "Unknown" })));
  return data;
}

function begin(title) {
  controller?.abort(); extractionState(false); visit += 1; proposal = null; collection = null;
  list.replaceChildren(); observations.replaceChildren(); status.textContent = ""; dialog.querySelector("[data-dialogue-view-options]")?.remove();
  accept.hidden = true; evaluate.hidden = true; dialog.querySelector("[data-voice-disclosure]").hidden = true;
  dialog.querySelector("h2").textContent = title;
  if (!dialog.open) dialog.showModal();
  return visit;
}

async function openAssignment(range, record = null) {
  if (!api()?.isEditable()) return;
  if (!range) return window.verwrityDialog.alert("Select a dialogue passage first.");
  if (!(await window.verwritySaveActiveScene())) return;
  await loadPages();
  const current = await request(sceneUrl());
  selection = { ...range, ...(record ? { id: record.id } : {}) };
  sourceHash = current.source_hash; assignmentSnapshot = current.snapshot;
  const overlap = current.dialogue.find(item => !item.detached && range.start < item.end && range.end > item.start);
  if (!record && overlap) {
    selection = { id: overlap.id, start: overlap.start, end: overlap.end, quote: overlap.quote };
    record = overlap;
  }
  speakerForm.querySelector("[data-speaker-quote]").textContent = selection.quote;
  speakerForm.querySelector("[data-speaker-error]").textContent = "";
  const container = speakerForm.querySelector("[data-speaker-picker]");
  container.replaceChildren();
  chooser = speakerSelect(container, record?.speaker_id);
  chooser.select.dataset.speakerSelect = "";
  speakerDialog.showModal();
}

speakerForm?.addEventListener("submit", async event => {
  event.preventDefault();
  const submit = speakerForm.querySelector("[type=submit]"); submit.disabled = true;
  const values = { ...selection, ...chooser.value(), source_hash: sourceHash, snapshot: assignmentSnapshot };
  try {
    if (!(await window.verwritySaveActiveScene())) throw new Error("Save the current scene before assigning a speaker");
    if (chooser.select.value === "create" && !chooser.name.value.trim()) throw new Error("Enter a new character name");
    const result = await request(sceneUrl(), values);
    publishPages(result.created_pages);
    await loadPages(); await refreshEditor();
    window.verwrityMarkProjectChanged(); speakerDialog.close();
    if (dialog.open) await reviewScene();
  } catch (error) { speakerForm.querySelector("[data-speaker-error]").textContent = error.message; }
  finally { submit.disabled = false; }
});

window.addEventListener("verwrity-context-opened", event => { contextRange = event.detail.range; });
document.querySelectorAll("[data-assign-speaker]").forEach(node => {
  node.addEventListener("mousedown", event => event.preventDefault());
  node.addEventListener("click", () => {
    const fromContext = Boolean(node.closest("[data-wiki-selection-menu]"));
    const range = fromContext ? contextRange : api()?.getSelectedRange();
    const menu = document.querySelector("[data-wiki-selection-menu]"); if (menu) menu.hidden = true;
    openAssignment(range).catch(error => window.verwrityDialog.alert(error.message));
  });
});

async function navigate(row) {
  if (!(await window.verwritySaveActiveScene())) return;
  if (row.scene_id === api().sceneId) {
    if (Array.from(api().getText()).slice(row.start, row.end).join("") !== row.quote) throw new Error("This source changed. Reopen dialogue.");
    dialog.close(); api().highlightSourceRange(row.start, row.end); return;
  }
  const data = new FormData();
  if (await window.verwrityWiki?.prepareSceneNavigation() === false) return;
  for (const [key, value] of Object.entries({ ai_start: row.start, ai_end: row.end, ai_quote: row.quote,
    evidence_hash: row.scene_hash, expected_project_id: projectId })) data.set(key, value);
  const response = await fetch(`/scene/select/${row.scene_id}`, { method: "POST", body: data, credentials: "same-origin" });
  if (!response.ok) throw new Error("This source changed. Reopen dialogue.");
  window.verwrityAllowUnload(); location.assign(response.url);
}

async function reviewScene() {
  if (!api()?.isEditable()) return window.verwrityDialog.alert("Return to the editable current scene head before reviewing assignments.");
  const range = api()?.getSelectedRange();
  if (!(await window.verwritySaveActiveScene())) return;
  const currentVisit = begin("Scene dialogue");
  await loadPages(); const result = await refreshEditor();
  if (visit !== currentVisit || !dialog.open) return;
  status.textContent = result.dialogue.length ? "" : "No dialogue assignments yet. Select speech and choose Label selected dialogue.";
  for (const row of result.dialogue) {
    const section = element("section", undefined, list); section.className = "dialogue-record";
    element("strong", pages.find(page => page.id === row.speaker_id)?.title || "Unknown speaker", section);
    element("blockquote", row.quote, section);
    element("p", `${row.detached ? "Detached · original passage retained" : "Attached"} · ${row.origin}`, section);
    if (!row.detached) button("Go to source", section, () => { dialog.close(); api().highlightSourceRange(row.start, row.end); });
    button(row.detached ? "Reattach to selected passage" : "Change speaker", section, () => openAssignment(row.detached ? range : row, row)
      .catch(error => { status.textContent = error.message; }));
    button("Remove assignment", section, async () => {
      try {
        if (!(await window.verwritySaveActiveScene())) return;
        await request(`${sceneUrl()}/${row.id}/delete`, { source_hash: window.verwritySceneHash(), snapshot: result.snapshot });
        window.verwrityMarkProjectChanged(); await reviewScene();
      } catch (error) { status.textContent = error.message; }
    });
  }
}

document.querySelectorAll("[data-review-dialogue], [data-review-dialogue-analysis]").forEach(node => node.addEventListener("click", () => {
  node.closest(".text-analysis-options")?.removeAttribute("open");
  reviewScene().catch(error => window.verwrityDialog.alert(error.message));
}));
document.addEventListener("click", event => {
  extractionControls?.querySelectorAll(".annotation-picker[open]").forEach(picker => { if (!picker.contains(event.target)) picker.open = false; });
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") extractionControls?.querySelectorAll(".annotation-picker[open]").forEach(picker => { picker.open = false; });
});

document.querySelector("[data-extract-dialogue]")?.addEventListener("click", async () => {
  if (extracting) return;
  if (!api()?.isEditable()) {
    await window.verwrityDialog.alert("Return to the editable current scene head before extracting speakers.");
    return;
  }
  const preparation = ++visit;
  extractionState(true, "Saving current scene before speaker extraction…");
  const saved = await window.verwritySaveActiveScene();
  if (visit !== preparation) return;
  if (!saved) {
    extractionState(false, "Current scene could not be saved · retry before extracting speakers"); return;
  }
  const currentVisit = begin("Review suggested dialogue speakers");
  controller = new AbortController();
  extractionState(true, "Extracting speakers · current scene… Cancel to stop waiting.");
  status.textContent = "Extracting dialogue from the current scene using your configured model… Cancel to stop waiting.";
  try {
    await loadPages();
    if (visit !== currentVisit || !dialog.open) return;
    const result = await request(`${sceneUrl()}/extract`, { source_hash: window.verwritySceneHash() }, controller.signal);
    if (visit !== currentVisit || !dialog.open) return;
    proposal = result;
    extractionState(false, `${result.rows.length} speaker suggestions · current scene · review before accepting`);
    status.textContent = `${result.rows.length} suggestions · ${result.discarded} invalid, overlapping or already confirmed passages omitted. Review each speaker and select only assignments you accept.`;
    result.choices = [];
    result.rows.forEach((row, index) => {
      const section = element("section", undefined, list); section.className = "dialogue-record";
      const label = element("label", undefined, section); const checked = element("input", undefined, label); checked.type = "checkbox";
      label.append(document.createTextNode(" Accept this passage")); element("blockquote", row.quote, section);
      element("p", row.uncertainty, section); if (row.suggested_name) element("p", `Suggested name: ${row.suggested_name}`, section);
      const picker = speakerSelect(section, row.speaker_id); result.choices.push({ index, checked, picker });
    });
    accept.hidden = !result.rows.length;
  } catch (error) {
    if (error.name !== "AbortError" && visit === currentVisit) {
      status.textContent = error.message; extractionState(false, error.message);
    }
  } finally { if (visit === currentVisit) extractionState(false); }
});

document.querySelectorAll("[data-cancel-dialogue-analysis]").forEach(node => node.addEventListener("click", () => {
  if (!extracting) return;
  controller?.abort(); visit += 1; proposal = null;
  list.replaceChildren(); accept.hidden = true;
  status.textContent = "Speaker extraction cancelled in this tab. The model may still finish its request.";
  extractionState(false, "Cancelled · current scene · run again when ready");
}));

accept?.addEventListener("click", async () => {
  if (!proposal) return;
  accept.disabled = true; const currentVisit = visit;
  try {
    if (!(await window.verwritySaveActiveScene())) return;
    const choices = proposal.choices.filter(item => item.checked.checked).map(item => ({ index: item.index, ...item.picker.value() }));
    const result = await request(`${sceneUrl()}/apply`, { proposal: proposal.proposal, source_hash: proposal.source_hash, snapshot: proposal.snapshot, choices });
    publishPages(result.created_pages);
    extractionState(false, "Speaker assignments accepted · current scene");
    await loadPages(); await refreshEditor(); window.verwrityMarkProjectChanged();
    if (dialog.open && visit === currentVisit) await reviewScene();
  } catch (error) { status.textContent = error.message; }
  finally { accept.disabled = false; }
});

window.addEventListener("verwrity-speaker-dialogue", async event => {
  if (!(await window.verwritySaveActiveScene())) return;
  const currentVisit = begin("Character dialogue");
  try {
    const result = await request(`/wiki/page/${event.detail}/dialogue`);
    if (visit !== currentVisit || !dialog.open) return;
    collection = { ...result, id: event.detail };
    dialog.querySelector("h2").textContent = `${result.title} · dialogue`;
    status.textContent = `${result.rows.length} attributed passages in current manuscript order`;
    evaluate.hidden = !result.rows.some(row => !row.detached); dialog.querySelector("[data-voice-disclosure]").hidden = evaluate.hidden;
    const options = element("div", undefined); options.dataset.dialogueViewOptions = ""; options.className = "dialogue-view-options"; list.before(options);
    for (const [name, text] of [["scene", "Show scene"], ["context", "Show surrounding text"]]) {
      const label = element("label", undefined, options), toggle = element("input", undefined, label); toggle.type = "checkbox"; toggle.checked = true;
      label.append(document.createTextNode(text)); toggle.onchange = () => list.querySelectorAll(`[data-dialogue-${name}]`).forEach(node => { node.hidden = !toggle.checked; });
    }
    for (const row of result.rows) {
      const section = element("section", undefined, list); section.className = "dialogue-record";
      const scene = element("div", undefined, section); scene.dataset.dialogueScene = "";
      element("h3", `Scene ${row.scene_number}: ${row.scene_title}`, scene);
      if (row.summary) element("p", `Scene description: ${row.summary}`, scene);
      element("blockquote", row.display_quote || row.quote, section);
      const context = element("div", undefined, section); context.dataset.dialogueContext = "";
      if (row.detached) element("p", "Detached", context);
      else { element("strong", "Surrounding text", context); element("p", row.context, context); }
      if (!row.detached) button("Go to source", section, () => navigate(row).catch(error => { status.textContent = error.message; }));
    }
  } catch (error) { status.textContent = error.message; }
});

evaluate?.addEventListener("click", async () => {
  if (!collection) return;
  const currentVisit = visit, source = collection;
  controller?.abort(); controller = new AbortController(); evaluate.disabled = true;
  status.textContent = "Evaluating collected dialogue… Close to cancel waiting."; observations.replaceChildren();
  try {
    const result = await request(`/wiki/page/${source.id}/dialogue/evaluate`, { snapshot: source.snapshot }, controller.signal);
    if (visit !== currentVisit || !dialog.open) return;
    status.textContent = `${result.observations.length} source-backed advisory observations`;
    for (const item of result.observations) {
      const section = element("section", undefined, observations); element("blockquote", item.quote, section); element("p", item.explanation, section);
      const row = source.rows.find(row => row.id === item.dialogue_id);
      button("Go to evidence", section, () => navigate({ ...row, ...item }).catch(error => { status.textContent = error.message; }));
    }
  } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
  finally { evaluate.disabled = false; }
});

dialog?.addEventListener("close", () => {
  if (extracting) extractionState(false, "Cancelled · current scene · run again when ready");
  else if (proposal) extractionState(false, "Review closed · current scene · run again for new suggestions");
  controller?.abort(); visit += 1; proposal = null; collection = null;
});
for (const name of ["verwrity-editor-change", "verwrity-editor-source-changed", "verwrity-scene-metadata-changed", "verwrity-wiki-page-updated"]) {
  window.addEventListener(name, () => {
    if (!dialog?.open || (name === "verwrity-wiki-page-updated" && publishingPages)) return;
    controller?.abort(); extractionState(false, "Sources changed · run again to review the current scene"); visit += 1; proposal = null; collection = null; accept.hidden = true; evaluate.hidden = true;
    observations.replaceChildren(); list.replaceChildren(); status.textContent = "Sources changed. Reopen dialogue to review current passages.";
  });
}
document.querySelectorAll("[data-close-tool]").forEach(node => node.addEventListener("click", () => node.closest("dialog").close()));

for (const node of [dialog, speakerDialog, document.querySelector("#scene-structure-dialog")]) node?.addEventListener("click", event => { if (event.target === node) { const rect = node.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) node.close(); } });
