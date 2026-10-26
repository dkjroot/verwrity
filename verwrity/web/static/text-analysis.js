/* Scene LLM analyses: independent, transient, view-only layers. */
(() => {
  "use strict";
  const container = document.querySelector("[data-text-analyses]");
  if (!container) return;
  const form = document.querySelector("[data-text-analysis-form]");
  const formStatus = document.querySelector("[data-text-analysis-form-status]");
  const formTitle = document.querySelector("[data-text-analysis-form-title]");
  const promptNote = document.querySelector("[data-text-analysis-prompt-note]");
  const restoreFormButton = document.querySelector("[data-restore-text-analysis-form]");
  const states = new Map();
  let sourceVersion = 0;
  let changedSource = "Text";
  let settingsQueue = Promise.resolve();
  let rerunning = false;
  const rowFor = id => [...container.querySelectorAll("[data-text-analysis]")].find(row => row.dataset.textAnalysis === id);
  const notifyState = () => window.dispatchEvent(new CustomEvent("verwrity-text-analysis-state-change"));
  window.verwrityTextAnalyses = {
    status: () => ({
      stale: [...states.values()].some(state => state.enabled && (!state.result || state.edited)),
      busy: [...states.values()].some(state => state.busy),
    }),
    rerunEnabled: () => Promise.allSettled([...states.values()].filter(state => state.enabled).map(run)),
    setRerunning: active => { rerunning = active; refreshProgress(); },
    savePreferences: () => settingsQueue,
  };

  function refreshProgress() {
    const progress = document.querySelector("[data-text-analysis-progress]");
    const running = [...states.values()].filter(item => item.busy);
    progress.hidden = !rerunning && !running.length;
    progress.querySelector("[data-text-analysis-progress-message]").textContent = running.length
      ? running.map(item => `${item.definition.name}: ${item.message}`).join(" · ")
      : "Running enabled analyses…";
  }

  function reflect(state, updateEditor = true) {
    const row = rowFor(state.definition.id);
    if (!row) return;
    const runButton = row.querySelector("[data-run-text-analysis]");
    runButton.disabled = state.busy || !window.verwrityEditor?.sceneId;
    runButton.hidden = state.busy;
    row.querySelector("[data-cancel-text-analysis]").hidden = !state.busy;
    const toggle = row.querySelector("[data-toggle-text-analysis]");
    toggle.setAttribute("aria-pressed", String(state.enabled));
    toggle.title = state.enabled ? `Hide ${state.definition.name} highlights`
      : state.result ? `Show ${state.definition.name} highlights` : `Run ${state.definition.name} and show highlights`;
    toggle.disabled = !window.verwrityEditor?.sceneId;
    const status = row.querySelector("[data-text-analysis-status]");
    status.textContent = state.message;
    status.hidden = state.message === "Ready · current scene";
    row.querySelector("[data-text-analysis-color]").value = state.definition.color;
    row.querySelector("[data-text-analysis-style]").value = state.definition.style;
    row.querySelector(".annotation-color").style.setProperty("--selected-annotation-color", state.definition.color);
    const restore = row.querySelector("[data-restore-text-analysis]");
    if (restore) restore.disabled = !state.definition.prompt_overridden;
    const findings = row.querySelector("[data-text-analysis-findings]");
    findings.hidden = !state.result?.annotations.length;
    const list = findings.querySelector("ul");
    list.replaceChildren();
    for (const item of state.result?.annotations || []) {
      const entry = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.quote;
      button.addEventListener("click", () => window.verwrityEditor?.selectSourceRange(item.start, item.end));
      const explanation = document.createElement("span");
      explanation.textContent = ` — ${item.explanation}`;
      entry.append(button, explanation);
      list.append(entry);
    }
    if (updateEditor) window.verwrityEditor?.setTextAnalysis(state.definition.id, {
      items: state.result?.annotations || [], enabled: state.enabled,
      name: state.definition.name, color: state.definition.color, style: state.definition.style,
    });
    refreshProgress();
    notifyState();
  }

  function install(definitions) {
    for (const definition of definitions) {
      const state = states.get(definition.id) || {
        enabled: definition.enabled, result: null, busy: false, request: 0,
        message: definition.enabled ? "Analysis is stale. Rerun to review the current scene." : "Ready · current scene",
      };
      state.definition = definition;
      states.set(definition.id, state);
      reflect(state);
    }
  }
  install(JSON.parse(document.querySelector("[data-text-analysis-definitions]").textContent));

  function cancel(state, message) {
    state.controller?.abort();
    state.request += 1;
    state.busy = false;
    clearInterval(state.timer);
    state.message = message;
    reflect(state);
  }

  async function run(state) {
    const editor = window.verwrityEditor;
    if (state.busy || !editor?.sceneId) return;
    const text = editor.getText();
    if (!text.trim()) {
      state.message = "Write some scene text before running analysis.";
      reflect(state);
      return;
    }
    const version = sourceVersion;
    const request = ++state.request;
    const started = Date.now();
    state.controller = new AbortController();
    setEnabled(state, true);
    state.busy = true;
    state.result = null;
    state.edited = false;
    const progress = () => {
      state.message = version === sourceVersion
        ? `Reviewing current scene… ${Math.floor((Date.now() - started) / 1000)}s`
        : `${changedSource} changed during analysis; this run will be discarded. Rerun when ready.`;
      reflect(state);
    };
    progress();
    state.timer = setInterval(progress, 1000);
    try {
      const response = await fetch(`/scene/${editor.sceneId}/text-analysis/${state.definition.id}`, {
        method: "POST", credentials: "same-origin", signal: state.controller.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene_text: text }),
      });
      const result = await response.json();
      if (request !== state.request) return;
      if (!response.ok) throw new Error(result.error || "Analysis unavailable. Try again.");
      if (version !== sourceVersion || editor.getText() !== text) {
        state.message = `${changedSource} changed during analysis. Rerun to review the current scene.`;
      } else if (result.scene_id !== editor.sceneId || result.analysis_id !== state.definition.id || !Array.isArray(result.annotations)) {
        throw new Error("Invalid analysis response. Try again.");
      } else {
        state.result = result;
        const count = result.annotations.length;
        state.message = count ? `${count} passage${count === 1 ? "" : "s"} to review · AI suggestions` : "No passages flagged · AI judgement";
        if (result.discarded_findings) state.message += ` · ${result.discarded_findings} unverified or duplicate findings discarded`;
      }
    } catch (error) {
      if (request !== state.request) return;
      state.message = error.name === "AbortError" ? "Cancelled in this tab." : error.message;
    } finally {
      if (request === state.request) {
        state.busy = false;
        clearInterval(state.timer);
        reflect(state);
      }
    }
  }

  function sourceChanged(reason = "Text", preserve = false) {
    changedSource = reason;
    sourceVersion += 1;
    for (const state of states.values()) {
      if (state.result || state.busy) {
        if (preserve && state.result && !state.busy) {
          state.result = { ...state.result, annotations: window.verwrityEditor.getTextAnalysis(state.definition.id) };
          state.edited = true;
          const count = state.result.annotations.length;
          state.message = `${count} unchanged passage${count === 1 ? "" : "s"} remaining · text edited; analysis may be out of date`;
          reflect(state, false);
          continue;
        }
        state.result = null;
        state.message = state.busy ? `${changedSource} changed during analysis; this run will be discarded.`
          : "Analysis is stale. Rerun to review the current scene.";
        reflect(state);
      }
    }
  }
  window.addEventListener("verwrity-editor-change", () => sourceChanged("Text", true));
  window.addEventListener("verwrity-editor-source-changed", () => sourceChanged());
  window.addEventListener("verwrity-scene-metadata-changed", event => {
    if (event.detail.sceneId === window.verwrityEditor?.sceneId) sourceChanged("Scene metadata");
  });
  window.addEventListener("verwrity-editor-ready", () => states.forEach(reflect));

  async function mutate(url, method, data) {
    const response = await fetch(url, {
      method, credentials: "same-origin", headers: { "Content-Type": "application/json" },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not save analysis.");
    return result;
  }
  function setEnabled(state, enabled) {
    if (state.enabled === enabled) return;
    state.enabled = enabled;
    state.definition.enabled = enabled;
    // Keep the viewing preference across navigation, never the source-dependent
    // findings. Restoring this preference must not contact a model.
    settingsQueue = settingsQueue.catch(() => {}).then(() => mutate(`/text-analyses/${state.definition.id}`, "PATCH", { enabled }))
      .catch(error => { state.message = error.message; reflect(state); });
  }
  async function reloadDefinitions() {
    const response = await fetch("/text-analyses", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Could not load analyses.");
    const result = await response.json();
    container.innerHTML = result.html;
    install(result.definitions);
  }
  function resetForm() {
    form.reset();
    form.elements.identity.value = "";
    form.elements.name.disabled = false;
    formTitle.textContent = "Add a custom text analysis";
    promptNote.hidden = true;
    restoreFormButton.hidden = true;
    formStatus.textContent = "";
  }

  async function restoreDefault(state) {
    try {
      await settingsQueue;
      const definition = await mutate(`/text-analyses/${state.definition.id}`, "PATCH", { restore_default: true });
      state.result = null;
      state.definition = definition;
      cancel(state, "Default prompt restored. Run to review the current scene.");
      await reloadDefinitions();
      if (form.elements.identity.value === definition.id) {
        form.elements.prompt.value = definition.prompt;
        restoreFormButton.disabled = true;
        formStatus.textContent = "Default prompt restored and saved.";
      }
    } catch (error) { state.message = error.message; reflect(state); formStatus.textContent = error.message; }
  }

  container.addEventListener("click", async event => {
    const row = event.target.closest("[data-text-analysis]");
    if (!row) return;
    const state = states.get(row.dataset.textAnalysis);
    if (event.target.closest("[data-run-text-analysis]")) run(state);
    if (event.target.closest("[data-toggle-text-analysis]")) {
      setEnabled(state, !state.enabled);
      if (state.enabled && !state.result && !state.busy) run(state);
      else reflect(state);
    }
    if (event.target.closest("[data-clear-text-analysis]")) {
      state.result = null;
      cancel(state, "Cleared · current scene");
      row.querySelector(".text-analysis-options").open = false;
    }
    if (event.target.closest("[data-cancel-text-analysis]")) cancel(state, "Cancelled in this tab; the model may still be finishing.");
    if (event.target.closest("[data-restore-text-analysis]")) restoreDefault(state);
    if (event.target.closest("[data-edit-text-analysis]")) {
      row.querySelector(".text-analysis-options").open = false;
      form.elements.identity.value = state.definition.id;
      for (const key of ["name", "prompt", "color"]) form.elements[key].value = state.definition[key];
      form.elements.name.disabled = state.definition.builtin;
      formTitle.textContent = state.definition.builtin ? `Edit ${state.definition.name} prompt` : `Edit ${state.definition.name}`;
      promptNote.hidden = !state.definition.builtin;
      restoreFormButton.hidden = !state.definition.builtin;
      restoreFormButton.disabled = !state.definition.prompt_overridden;
      formStatus.textContent = "";
      form.closest("details").open = true;
    }
    if (event.target.closest("[data-delete-text-analysis]")) {
      try {
        await settingsQueue;
        await mutate(`/text-analyses/${state.definition.id}`, "DELETE");
        state.result = null;
        cancel(state, "Deleted");
        states.delete(state.definition.id);
        row.remove();
        notifyState();
      } catch (error) { state.message = error.message; reflect(state); }
    }
  });
  container.addEventListener("change", event => {
    if (!event.target.matches("[data-text-analysis-color], [data-text-analysis-style]")) return;
    const state = states.get(event.target.closest("[data-text-analysis]").dataset.textAnalysis);
    const key = event.target.matches("[data-text-analysis-style]") ? "style" : "color";
    const value = event.target.value;
    state.definition[key] = value;
    reflect(state);
    settingsQueue = settingsQueue.catch(() => {}).then(() => mutate(`/text-analyses/${state.definition.id}`, "PATCH",
      { [key]: value }))
      .catch(error => { state.message = error.message; reflect(state); });
  });
  document.addEventListener("click", event => {
    container.querySelectorAll(".annotation-picker[open]").forEach(options => {
      if (!options.contains(event.target)) options.open = false;
    });
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") container.querySelectorAll(".annotation-picker[open]").forEach(options => { options.open = false; });
  });
  document.querySelector("[data-reset-text-analysis-form]").addEventListener("click", resetForm);
  form.elements.prompt.addEventListener("input", () => {
    const definition = states.get(form.elements.identity.value)?.definition;
    if (definition?.builtin) restoreFormButton.disabled = !definition.prompt_overridden
      && form.elements.prompt.value === definition.prompt;
  });
  restoreFormButton.addEventListener("click", () => {
    const state = states.get(form.elements.identity.value);
    if (state?.definition.builtin) restoreDefault(state);
  });
  document.querySelector("[data-open-text-analysis-controls]").addEventListener("click", () => {
    container.closest("details.analysis-menu").open = true;
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    formStatus.textContent = "Saving analysis…";
    try {
      const identity = form.elements.identity.value;
      const data = Object.fromEntries(["name", "prompt", "color"].map(key => [key, form.elements[key].value]));
      if (states.get(identity)?.definition.builtin) delete data.name;
      await settingsQueue;
      await mutate(identity ? `/text-analyses/${identity}` : "/text-analyses", identity ? "PATCH" : "POST", data);
      if (identity && states.has(identity)) {
        const state = states.get(identity);
        state.result = null;
        cancel(state, "Prompt updated. Run to review the current scene.");
      }
      await reloadDefinitions();
      resetForm();
      formStatus.textContent = "Analysis saved. Its button is ready above.";
    } catch (error) { formStatus.textContent = error.message; }
    finally { submit.disabled = false; }
  });
})();
