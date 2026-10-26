"use strict";

const projectFeaturesDialog = document.querySelector("#project-features-dialog");
if (projectFeaturesDialog) {
  const form = projectFeaturesDialog.querySelector("form");
  const status = projectFeaturesDialog.querySelector("[data-project-features-status]");
  const save = projectFeaturesDialog.querySelector("[data-save-project-features]");
  const close = [...projectFeaturesDialog.querySelectorAll("[data-close-project-features]")];
  const mode = form.elements.namedItem("fingal_mode");
  const tools = ["map_editor", "character_editor"];
  const fields = [mode, ...tools.map(name => form.elements.namedItem(name))];
  let expected = null, individual = {}, loading = null, saving = false;

  function reflectTools() {
    tools.forEach(name => {
      const field = form.elements.namedItem(name);
      field.checked = mode.checked || individual[name];
      field.disabled = mode.checked || saving || !expected;
    });
  }
  function setBusy(busy) {
    save.disabled = busy;
    mode.disabled = busy;
    close.forEach(button => { button.disabled = saving; });
    reflectTools();
    if (busy) fields.forEach(field => { field.disabled = true; });
  }
  function populate(features) {
    expected = features;
    individual = Object.fromEntries(tools.map(name => [name, features[name]]));
    mode.checked = features.fingal_mode;
  }
  mode.addEventListener("change", reflectTools);
  tools.forEach(name => form.elements.namedItem(name).addEventListener("change", event => {
    individual[name] = event.target.checked;
  }));
  document.querySelectorAll("[data-open-project-features]").forEach(button => button.addEventListener("click", async () => {
    button.closest("details")?.removeAttribute("open");
    loading?.abort();
    const controller = loading = new AbortController();
    expected = null;
    status.textContent = "Loading project features…";
    setBusy(true);
    projectFeaturesDialog.showModal();
    try {
      const response = await fetch("/project/features", { credentials: "same-origin", signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load project features.");
      if (controller.signal.aborted || !projectFeaturesDialog.open) return;
      if (result.project_id !== projectFeaturesDialog.dataset.projectId) throw new Error("The active project changed. Return to the workspace to review its settings.");
      populate(result.features);
      status.textContent = "";
      setBusy(false);
      mode.focus();
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = error.message;
    }
  }));
  close.forEach(button => button.addEventListener("click", () => projectFeaturesDialog.close()));
  projectFeaturesDialog.addEventListener("close", () => loading?.abort());
  projectFeaturesDialog.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (saving || !expected || save.disabled) return;
    const features = { fingal_mode: mode.checked, ...individual };
    if (window.verwrityWorld?.canChangeFeatures && !(await window.verwrityWorld.canChangeFeatures(features))) return;
    saving = true;
    setBusy(true);
    status.textContent = "Saving project features…";
    try {
      const response = await fetch("/project/features", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Verwrity-Project-Id": projectFeaturesDialog.dataset.projectId },
        body: JSON.stringify({ features, expected_features: expected }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save project features. Your choices are kept here; retry saving.");
      populate(result.features);
      if (result.changed) window.verwrityMarkProjectChanged?.();
      if (result.changed) window.dispatchEvent(new CustomEvent("verwrity-project-features-changed", { detail: result.features }));
      status.textContent = "Features saved in this project's recovery draft. Use Save project to update the named library copy too.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      saving = false;
      setBusy(false);
    }
  });
}
