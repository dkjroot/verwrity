"use strict";

const editor = document.querySelector(".editor");
const saveStatus = document.querySelector("[data-save-status]");
const retrySaveButton = document.querySelector("[data-retry-save]");
let dirty = false;
let allowUnload = false;
let changeVersion = 0;
let saveTimer;
let saveInFlight;
let savedSceneHash = editor?.dataset.sourceHash || "";
let saveConflict = false;
window.verwritySceneHash = () => savedSceneHash;
const sourceProjectId = document.querySelector("[data-workspace]")?.dataset.projectId || "";
window.verwrityUpdateSavedSceneHash = (response) => {
  const hash = response.headers.get("X-Verwrity-Scene-Hash");
  if (hash) savedSceneHash = hash;
};
let spellingAnalyzedText = null;
let spellingCheckInFlight = false;
const locallyChangedAnnotationPreferences = new Set();
const sceneWordCountElements = [...document.querySelectorAll("[data-scene-word-count]")];
const sceneWordCounts = new Map(sceneWordCountElements.map((element) => [element.dataset.sceneWordCount, Number(element.textContent) || 0]));
const manuscriptWordCount = document.querySelector("[data-manuscript-word-count]");
function countWords(text) { return (text.match(/\S+/gu) || []).length; }
function updateSceneWordCount(text) {
  const sceneId = window.verwrityEditor?.sceneId;
  if (!sceneId) return;
  const count = countWords(text);
  sceneWordCounts.set(sceneId, count);
  const element = document.querySelector(`[data-scene-word-count="${sceneId}"]`);
  if (element) element.textContent = String(count);
  if (manuscriptWordCount) manuscriptWordCount.textContent = String([...sceneWordCounts.values()].reduce((total, words) => total + words, 0));
}
window.verwrityUpdateSceneWordCounts = (updates) => {
  for (const item of updates || []) {
    sceneWordCounts.set(item.scene_id, item.word_count);
    const element = document.querySelector(`[data-scene-word-count="${CSS.escape(item.scene_id)}"]`);
    if (element) element.textContent = String(item.word_count);
  }
  if (manuscriptWordCount) manuscriptWordCount.textContent = String([...sceneWordCounts.values()].reduce((total, words) => total + words, 0));
};
const namedSaveKey = "verwrity-project-needs-named-save";
let projectNeedsNamedSave = false;
projectNeedsNamedSave = document.querySelector("[data-workspace]")?.dataset.projectNeedsSave === "true";
if (document.querySelector("[data-workspace]")?.dataset.recoveryNeedsSave === "true") projectNeedsNamedSave = true;
let projectChangeVersion = 0;
let projectSaveInFlight = false;

function reflectProjectSave() {
  for (const button of document.querySelectorAll("[data-save-project]")) {
    button.dataset.state = projectNeedsNamedSave ? "unsaved" : "saved";
    button.textContent = projectSaveInFlight ? "Saving…" : projectNeedsNamedSave ? "Save · changes" : "Saved";
    button.title = projectNeedsNamedSave ? "Save project to the library (Ctrl+S)" : "Project matches the saved library copy (Ctrl+S)";
    button.disabled = projectSaveInFlight;
  }
}

function setProjectNeedsNamedSave(value) {
  projectNeedsNamedSave = value;
  if (value) projectChangeVersion += 1;
  try { sessionStorage.setItem(namedSaveKey, String(value)); } catch (_) { /* Recovery drafts remain available without this reminder. */ }
  reflectProjectSave();
}
reflectProjectSave();
window.verwrityMarkProjectChanged = () => setProjectNeedsNamedSave(true);
window.verwrityMarkSceneSaved = () => { dirty = false; };
window.verwrityAllowUnload = () => { allowUnload = true; };

function setSaveStatus(message, state) {
  if (!saveStatus) return;
  saveStatus.textContent = message;
  saveStatus.dataset.state = state;
  if (retrySaveButton) retrySaveButton.hidden = state !== "error";
}

function scheduleSceneSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { window.verwritySaveActiveScene(); }, 700);
}

window.addEventListener("verwrity-editor-change", () => {
  const text = window.verwrityEditor?.getText() || "";
  updateSceneWordCount(text);
  refreshAnalysisStale(text);
  dirty = true;
  setProjectNeedsNamedSave(true);
  changeVersion += 1;
  setSaveStatus("Unsaved changes", "unsaved");
  scheduleSceneSave();
});

window.addEventListener("beforeunload", (event) => {
  if (allowUnload) { allowUnload = false; return; }
  if (dirty || projectNeedsNamedSave) { event.preventDefault(); event.returnValue = ""; }
});

document.addEventListener("submit", (event) => {
  if (event.defaultPrevented) return;
  const action = new URL(event.target.action, window.location.href);
  if (action.origin === window.location.origin) window.verwrityAllowUnload();
});

document.addEventListener("click", async (event) => {
  if (event.defaultPrevented) return;
  const link = event.target.closest?.("a[href]");
  if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
  const destination = new URL(link.href, window.location.href);
  if (destination.origin !== window.location.origin) return;
  // Section links keep this document and its buffers; native navigation also
  // moves keyboard focus immediately without needing a server round trip.
  if (destination.pathname === location.pathname && destination.search === location.search && destination.hash) return;
  event.preventDefault();
  if (!(await window.verwritySaveActiveScene())) return;
  dirty = false;
  window.verwrityAllowUnload();
  window.location.assign(link.href);
});

function syncProjectFields(form) {
  const title = document.querySelector("#project-title");
  const manuscript = form.querySelector("[name='manuscript']") || document.querySelector(`#manuscript-form-value[form='${form.id}']`);
  if (manuscript) manuscript.value = window.verwrityEditor?.getText() || "";
  let comments = form.querySelector("[name='scene_comments']");
  if (!comments) {
    comments = document.createElement("input");
    comments.type = "hidden";
    comments.name = "scene_comments";
    form.append(comments);
  }
  comments.value = JSON.stringify(window.verwrityEditor?.getComments() || []);
  let dialogue = form.querySelector("[name=scene_dialogue]");
  if (!dialogue) { dialogue = document.createElement("input"); dialogue.type = "hidden"; dialogue.name = "scene_dialogue"; form.append(dialogue); }
  dialogue.value = JSON.stringify(window.verwrityEditor?.getDialogue() || []);
  let base = form.querySelector("[name='scene_base_hash']");
  if (!base) { base = document.createElement("input"); base.type = "hidden"; base.name = "scene_base_hash"; form.append(base); }
  base.value = savedSceneHash;
  let project = form.querySelector("[name='expected_project_id']");
  if (!project) { project = document.createElement("input"); project.type = "hidden"; project.name = "expected_project_id"; form.append(project); }
  project.value = sourceProjectId;
  const projectTitle = form.querySelector("[name='project_title']");
  if (projectTitle) projectTitle.value = title?.value || "Untitled story";
}

window.verwritySaveActiveScene = async () => {
  window.clearTimeout(saveTimer);
  // Scene navigation reloads the document; finish saving the author's switches
  // before it can restore older preferences on the next scene.
  await Promise.allSettled([annotationPreferenceSaveQueue, window.verwrityTextAnalyses?.savePreferences()]);
  const sceneId = window.verwrityEditor?.sceneId;
  // Clean scenes still need a connection before native project/wiki navigation.
  if (!sceneId || !window.verwrityEditor || !dirty) {
    const reachable = window.verwrityServerConnection ? await window.verwrityServerConnection.check() : true;
    return reachable && (sceneId && dirty ? window.verwritySaveActiveScene() : true);
  }
  if (saveConflict) return false;
  if (saveInFlight) {
    const succeeded = await saveInFlight;
    return succeeded && (dirty ? window.verwritySaveActiveScene() : true);
  }

  const version = changeVersion;
  const data = new FormData();
  data.set("scene_text", window.verwrityEditor.getText());
  data.set("scene_comments", JSON.stringify(window.verwrityEditor.getComments()));
  data.set("scene_dialogue", JSON.stringify(window.verwrityEditor.getDialogue()));
  setSaveStatus("Saving draft…", "saving");
  saveInFlight = fetch(`/scene/${sceneId}/text`, { method: "POST", body: data, credentials: "same-origin",
    headers: { "X-Verwrity-Scene-Hash": savedSceneHash, "X-Verwrity-Project-Id": sourceProjectId } })
    .then(async (response) => {
      if (response.status === 409) {
        saveConflict = true;
        throw new Error("conflict");
      }
      if (!response.ok) {
        const failure = new Error("Could not save the active scene");
        if (response.status === 400) {
          failure.permanent = true;
          try { failure.message = (await response.json()).error || failure.message; } catch (_) { /* Keep the safe fallback. */ }
        }
        throw failure;
      }
      window.verwrityUpdateSavedSceneHash(response);
      if (version === changeVersion) {
        dirty = false;
        setSaveStatus("Draft saved", "saved");
      } else {
        setSaveStatus("Saving latest draft…", "saving");
      }
      return true;
    })
    .catch((failure) => {
      if (saveConflict) {
        setSaveStatus("Scene changed elsewhere · edits kept here. Copy your edits before reopening the project.", "error");
        return false;
      }
      if (failure.permanent) {
        setSaveStatus(`${failure.message} · edits kept here`, "error");
        return false;
      }
      setSaveStatus(failure.serverUnavailable ? "Server unavailable · edits kept here" : "Draft save failed · retrying", "error");
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => { window.verwritySaveActiveScene(); }, 1800);
      return false;
    })
    .finally(() => { saveInFlight = undefined; });

  const succeeded = await saveInFlight;
  if (succeeded && dirty) return window.verwritySaveActiveScene();
  return succeeded;
};

document.querySelector("[data-storyboard-link]")?.addEventListener("click", async (event) => {
  event.preventDefault();
  const destination = event.currentTarget.href;
  if (!(await window.verwritySaveActiveScene())) return;
  dirty = false;
  window.verwrityAllowUnload();
  window.location.assign(destination);
});

editor?.addEventListener("focusout", () => { window.verwritySaveActiveScene(); });
retrySaveButton?.addEventListener("click", () => { window.verwritySaveActiveScene(); });
window.addEventListener("verwrity-server-restored", () => { if (dirty) window.verwritySaveActiveScene(); });
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    document.querySelector("#save-project-form")?.requestSubmit();
  }
});

document.querySelector("#save-project-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (projectSaveInFlight) return;
  projectSaveInFlight = true;
  reflectProjectSave();
  try {
    if (window.verwrityShowSceneHead && !(await window.verwrityShowSceneHead())) return;
    if (window.verwrityWiki?.hasPending() && await window.verwrityDialog.confirm("Save your wiki page changes too?", { title: "Unsaved wiki page", acceptLabel: "Save page", cancelLabel: "Save project only" })) {
      if (await window.verwrityWiki.savePending() === false) return;
    }
    if (!(await window.verwritySaveActiveScene())) return;
    syncProjectFields(form);
    const version = projectChangeVersion;
    const title = form.elements.project_title.value.trim() || "Untitled story";
    form.elements.project_title.value = title;
    const response = await fetch(form.action, { method: "POST", body: new FormData(form), credentials: "same-origin",
      headers: { Accept: "application/json" } });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || "Could not save project.");
    }
    const result = await response.json();
    if (version === projectChangeVersion) setProjectNeedsNamedSave(Boolean(window.verwrityWiki?.hasPending()));
    const label = document.querySelector(".project-name");
    if (label) label.textContent = title;
    document.title = `${title} · Verwrity`;
    setSaveStatus(projectNeedsNamedSave ? "Project saved · newer changes need saving" : "Project saved", projectNeedsNamedSave ? "unsaved" : "saved");
    document.querySelector("#file-dialog")?.close();
    const select = document.querySelector("#project-library");
    if (select && ![...select.options].some(option => option.value === result.filename)) select.add(new Option(title, result.filename));
  } catch (error) {
    setProjectNeedsNamedSave(true);
    setSaveStatus("Project save failed · edits kept here", "error");
    await window.verwrityDialog?.alert(error.message || "Could not save project. Your edits are still here.");
  } finally { projectSaveInFlight = false; reflectProjectSave(); }
});
document.querySelectorAll("[data-save-project]").forEach(button => button.addEventListener("click", () => document.querySelector("#save-project-form")?.requestSubmit()));
document.querySelector("#project-title")?.addEventListener("input", () => setProjectNeedsNamedSave(true));
document.addEventListener("input", event => {
  if (event.target.closest?.("[data-wiki-save]") && ["title", "body", "tags", "aliases", "purpose"].includes(event.target.name)) {
    setProjectNeedsNamedSave(true);
  }
});

document.querySelector("#add-scene-dialog form")?.addEventListener("submit", async (event) => {
  const form = event.currentTarget;
  if (form.dataset.sceneSaved === "true") {
    delete form.dataset.sceneSaved;
    return;
  }
  event.preventDefault();
  if (!(await window.verwritySaveActiveScene())) return;
  dirty = false;
  window.verwrityMarkProjectChanged();
  window.verwrityAllowUnload();
  form.dataset.sceneSaved = "true";
  form.submit();
});
document.querySelector("#export-project-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (window.verwrityShowSceneHead && !(await window.verwrityShowSceneHead())) return;
  if (!(await window.verwritySaveActiveScene())) return;
  syncProjectFields(form);
  try {
    const response = await fetch(form.action, { method: "POST", body: new FormData(form), credentials: "same-origin" });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || "Could not export project.");
    }
    window.verwrityUpdateSavedSceneHash(response);
    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a"); link.href = objectUrl;
    link.download = response.headers.get("Content-Disposition")?.match(/filename="?([^";]+)"?/)?.[1] || "project.verwrity.zip";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    await window.verwrityDialog?.alert(error.message || "Could not export project. Your edits are still here.");
  }
});

async function runSpellingCheck() {
  if (spellingCheckInFlight) return false;
  const sceneId = window.verwrityEditor?.sceneId;
  const status = document.querySelector("[data-analysis-status]");
  if (!sceneId || !window.verwrityEditor) return false;
  spellingCheckInFlight = true;
  refreshAnalysisStale();
  const checkedText = window.verwrityEditor.getText();
  if (status) status.textContent = "Checking spelling…";
  const data = new FormData();
  data.set("scene_text", checkedText);
  try {
    const response = await fetch(`/scene/${sceneId}/spell-check`, { method: "POST", body: data, credentials: "same-origin" });
    if (!response.ok) throw new Error("Spell check failed");
    const result = await response.json();
    if (window.verwrityEditor.getText() === checkedText) {
      window.verwrityEditor.setAnnotations(result.annotations);
      spellingAnalyzedText = checkedText;
      if (status) status.textContent = result.annotations.length
        ? `${result.annotations.length} possible spelling error${result.annotations.length === 1 ? "" : "s"}`
        : "No spelling errors found";
    } else {
      if (status) status.textContent = "Text changed during spelling check";
    }
    return window.verwrityEditor.getText() === checkedText;
  } catch (error) {
    if (status) status.textContent = "Spell check unavailable";
    return false;
  } finally {
    spellingCheckInFlight = false;
    refreshAnalysisStale();
  }
}

window.addEventListener("verwrity-project-words-changed", () => { spellingAnalyzedText = null; refreshAnalysisStale(); });
document.querySelector("[data-word-dictionary]")?.addEventListener("click", async () => {
  document.querySelector("[data-wiki-selection-menu]").hidden = true;
  const { reviewVocabulary } = await import("./project-words.js");
  try { await reviewVocabulary({ projectId: sourceProjectId, projectMode: true }); }
  catch (error) { await window.verwrityDialog.alert(error.message); }
});

const annotationDefaults = {
  spelling: { enabled: false, style: "squiggly", color: "#ef4444" },
  wiki_links: { enabled: false, style: "underline", color: "#4f8fba" },
  comments: { enabled: false, style: "underline", color: "#8b72c7" },
  dialogue: { enabled: false, style: "underline", color: "#0d9488" },
};
let annotationPreferenceSaveQueue = Promise.resolve();

function refreshAnalysisStale(text = window.verwrityEditor?.getText() || "") {
  const llm = window.verwrityTextAnalyses?.status();
  const stale = (annotationDefaults.spelling.enabled
    && (spellingAnalyzedText === null || text !== spellingAnalyzedText)) || llm?.stale;
  const status = document.querySelector("[data-analysis-stale-status]");
  const rerun = document.querySelector("[data-rerun-analysis]");
  const spellingRefresh = document.querySelector("[data-run-spelling]");
  if (spellingRefresh) spellingRefresh.disabled = spellingCheckInFlight || !window.verwrityEditor?.isEditable();
  if (status) status.hidden = !stale;
  if (rerun) {
    rerun.hidden = !stale;
    rerun.disabled = spellingCheckInFlight || llm?.busy || rerunningAnalyses;
  }
}

let rerunningAnalyses = false;
window.addEventListener("verwrity-text-analysis-state-change", () => refreshAnalysisStale());

async function rerunEnabledAnalyses() {
  if (rerunningAnalyses) return;
  rerunningAnalyses = true;
  window.verwrityTextAnalyses?.setRerunning(true);
  refreshAnalysisStale();
  try {
    // Start independent checks together so one slow model cannot delay the rest.
    await Promise.allSettled([
      annotationDefaults.spelling.enabled ? runSpellingCheck() : Promise.resolve(),
      window.verwrityTextAnalyses?.rerunEnabled(),
    ]);
  } finally {
    rerunningAnalyses = false;
    window.verwrityTextAnalyses?.setRerunning(false);
    refreshAnalysisStale();
  }
}

function reflectAnnotationPreference(feature, preference) {
  window.verwrityEditor?.setAnnotationOptions(feature, preference);
  const controls = document.querySelector(`[data-annotation-controls="${feature}"]`);
  if (controls) {
    const enabled = Boolean(preference.enabled);
    const picker = controls.querySelector(".annotation-picker");
    picker?.setAttribute("aria-disabled", String(!enabled));
    picker?.classList.toggle("is-disabled", !enabled);
    const pickerSummary = picker?.querySelector("summary");
    if (pickerSummary) {
      pickerSummary.setAttribute("aria-disabled", String(!enabled));
      if (enabled) pickerSummary.removeAttribute("tabindex");
      else pickerSummary.tabIndex = -1;
    }
    const styleSelect = controls.querySelector(`[data-annotation-style="${feature}"]`);
    const colorInput = controls.querySelector(`[data-annotation-color="${feature}"]`);
    if (styleSelect) styleSelect.disabled = !enabled;
    if (colorInput) {
      colorInput.disabled = !enabled;
      const colorControl = colorInput.closest(".annotation-color");
      colorControl?.classList.toggle("is-disabled", !enabled);
      colorControl?.style.setProperty("--selected-annotation-color", preference.color);
    }
  }
  const toggle = document.querySelector(`[data-annotation-toggle="${feature}"]`);
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(preference.enabled));
    const label = { spelling: "spelling", wiki_links: "wiki link", comments: "comment", dialogue: "dialogue speaker" }[feature];
    toggle.title = `${preference.enabled ? "Hide" : "Show"} ${label} annotations`;
  }
  for (const [key, value] of [["style", preference.style], ["color", preference.color]]) {
    const control = document.querySelector(`[data-annotation-${key}="${feature}"]`);
    if (control) control.value = value;
  }
}

async function saveAnnotationPreference(feature, updates) {
  locallyChangedAnnotationPreferences.add(feature);
  const current = { ...annotationDefaults[feature], ...updates };
  annotationDefaults[feature] = current;
  reflectAnnotationPreference(feature, current);
  const save = annotationPreferenceSaveQueue.catch(() => {}).then(async () => {
    const response = await fetch(`/preferences/annotations/${feature}`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    if (!response.ok) throw new Error("Could not save annotation preference");
    const saved = await response.json();
    annotationDefaults[feature] = { enabled: saved.enabled, style: saved.style, color: saved.color };
    reflectAnnotationPreference(feature, annotationDefaults[feature]);
  });
  annotationPreferenceSaveQueue = save;
  try { await save; } catch (_) {
    // Keep the current-session choice active; the next successful update can persist it.
  }
}
window.verwritySetAnnotationPreference = saveAnnotationPreference;

document.querySelectorAll("[data-annotation-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const feature = button.dataset.annotationToggle;
    const enabled = button.getAttribute("aria-pressed") !== "true";
    saveAnnotationPreference(feature, { enabled });
    if (feature === "comments" && !enabled) window.dispatchEvent(new Event("verwrity-hide-comment-popover"));
    if (feature === "spelling" && enabled && spellingAnalyzedText === null) runSpellingCheck();
    refreshAnalysisStale();
  });
});
document.querySelectorAll("[data-annotation-style]").forEach((control) => {
  control.addEventListener("change", () => saveAnnotationPreference(control.dataset.annotationStyle, { style: control.value }));
});
document.querySelectorAll("[data-annotation-color]").forEach((control) => {
  control.addEventListener("change", () => saveAnnotationPreference(control.dataset.annotationColor, { color: control.value }));
});
document.querySelector("[data-rerun-analysis]")?.addEventListener("click", rerunEnabledAnalyses);
document.querySelector("[data-run-spelling]")?.addEventListener("click", async () => {
  if (!window.verwrityEditor?.isEditable()) return;
  await saveAnnotationPreference("spelling", { enabled: true });
  await runSpellingCheck();
});

for (const [feature, preference] of Object.entries(annotationDefaults)) reflectAnnotationPreference(feature, preference);
refreshAnalysisStale();

fetch("/preferences/annotations", { credentials: "same-origin" })
  .then((response) => response.ok ? response.json() : Promise.reject(new Error("Could not load preferences")))
  .then((preferences) => {
    for (const feature of Object.keys(annotationDefaults)) {
      if (locallyChangedAnnotationPreferences.has(feature)) continue;
      annotationDefaults[feature] = { ...annotationDefaults[feature], ...(preferences[feature] || {}) };
      reflectAnnotationPreference(feature, annotationDefaults[feature]);
    }
    refreshAnalysisStale();
  })
  .catch(() => {
    for (const [feature, preference] of Object.entries(annotationDefaults)) reflectAnnotationPreference(feature, preference);
  });
window.addEventListener("verwrity-editor-ready", () => {
  for (const [feature, preference] of Object.entries(annotationDefaults)) reflectAnnotationPreference(feature, preference);
  refreshAnalysisStale();
});

// Persist the active scene before switching, moving, removing, or creating one.
document.querySelectorAll(".storyboard form").forEach((form) => form.addEventListener("submit", async (event) => {
  if (event.defaultPrevented) return;
  event.preventDefault();
  if (!(await window.verwritySaveActiveScene())) return;
  if (await window.verwrityWiki?.prepareSceneNavigation() === false) return;
  if (!form.action.includes("/scene/select/")) setProjectNeedsNamedSave(true);
  dirty = false;
  window.verwrityAllowUnload();
  form.submit();
}));

// Keep an in-memory editor buffer from being replaced by project navigation.
document.querySelectorAll("form[action$='/project/library-open'], form[action$='/project/new'], form[action$='/project/open']").forEach((form) => form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const initialChoice = form.closest("#start-dialog") && !dirty && projectChangeVersion === 0;
  if (projectNeedsNamedSave && !initialChoice && !await window.verwrityDialog?.confirm("This project has changes that are not saved to a named project. Continue?", {
    title: "Unsaved project changes", acceptLabel: "Continue",
  })) return;
  if (!saveConflict && !(await window.verwritySaveActiveScene())) return;
  if (form.action.endsWith("/project/new")) {
    const title = await window.verwrityDialog?.prompt("Give your new project a name. Scene 1 will be created and the project saved in your library.", {
      title: "New project", label: "Project name", acceptLabel: "Create and save", maxLength: 500,
    });
    if (!title?.trim()) return;
    const field = document.createElement("input");
    field.type = "hidden"; field.name = "project_title"; field.value = title.trim();
    form.querySelector('[name="project_title"]')?.remove();
    form.append(field);
    try {
      const response = await fetch(form.action, { method: "POST", body: new FormData(form), credentials: "same-origin" });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "Could not create the new project. Keep your current project open and retry.");
      }
      dirty = false;
      setProjectNeedsNamedSave(false);
      window.verwrityAllowUnload();
      window.location.assign(response.url);
    } catch (error) { await window.verwrityDialog?.alert(error.message); }
    return;
  }
  dirty = false;
  setProjectNeedsNamedSave(false);
  window.verwrityAllowUnload();
  form.submit();
}));

document.querySelectorAll("form[action$='/project/duplicate']").forEach((form) => form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (window.verwrityShowSceneHead && !(await window.verwrityShowSceneHead())) return;
  if (!(await window.verwritySaveActiveScene())) return;
  syncProjectFields(form);
  dirty = false;
  window.verwrityAllowUnload();
  form.submit();
}));
