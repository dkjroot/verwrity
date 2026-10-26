"use strict";

const metadataDialog = document.querySelector("[data-scene-metadata-dialog]");
if (metadataDialog) {
  const metadataForm = metadataDialog.querySelector("[data-scene-metadata-form]");
  const metadataStatus = metadataDialog.querySelector("[data-scene-metadata-status]");
  const metadataTitle = metadataDialog.querySelector("[data-metadata-scene-title]");
  const sceneName = metadataForm.elements.namedItem("scene_title");
  const sceneSummary = metadataForm.elements.namedItem("scene_summary");
  const saveMetadata = metadataDialog.querySelector("[data-save-scene-metadata]");
  const closeMetadata = [...metadataDialog.querySelectorAll("[data-close-scene-metadata]")];
  let sceneId = "", loading = null, saving = false;

  const fields = [...metadataForm.querySelectorAll("[data-metadata-fields] input[name], [data-metadata-fields] textarea[name]")];
  const setBusy = busy => {
    saveMetadata.disabled = busy;
    fields.forEach(field => { field.disabled = busy; });
    sceneName.disabled = sceneSummary.disabled = busy;
    closeMetadata.forEach(button => { button.disabled = saving; });
  };

  document.querySelectorAll("[data-open-scene-metadata]").forEach(button => {
    button.addEventListener("click", async () => {
      loading?.abort();
      loading = new AbortController();
      const controller = loading;
      sceneId = button.dataset.openSceneMetadata;
      if (!sceneId) return;
      metadataForm.reset();
      metadataTitle.textContent = "";
      metadataStatus.textContent = "Loading scene metadata…";
      setBusy(true);
      metadataDialog.showModal();
      try {
        const response = await fetch(`/scene/${encodeURIComponent(sceneId)}/metadata`, {
          credentials: "same-origin", signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not load scene metadata.");
        if (controller.signal.aborted || !metadataDialog.open) return;
        metadataTitle.textContent = result.title;
        const note = button.closest("[data-story-note]");
        const row = button.closest("tr");
        sceneName.value = row?.querySelector('input[name^="scene_title_"]')?.value || result.title;
        sceneSummary.value = note?.querySelector('.story-note-summary')?.value
          ?? row?.querySelector('textarea[name^="scene_summary_"]')?.value ?? result.summary;
        sceneName.readOnly = document.querySelector('[data-workspace]')?.dataset.typewriterMode === "true"
          || document.querySelector('.storyboard-page')?.dataset.typewriterMode === "true";
        fields.forEach(field => { field.value = result.metadata[field.name] || ""; });
        metadataStatus.textContent = "";
        setBusy(false);
        (sceneName.readOnly ? fields[0] : sceneName)?.focus();
      } catch (error) {
        if (!controller.signal.aborted) metadataStatus.textContent = error.message;
      }
    });
  });

  closeMetadata.forEach(button => button.addEventListener("click", () => metadataDialog.close()));
  metadataDialog.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
  metadataDialog.addEventListener("close", () => loading?.abort());
  metadataForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (saving || saveMetadata.disabled) return;
    const metadata = Object.fromEntries(fields.map(field => [field.name, field.value]));
    const title = sceneName.value, summary = sceneSummary.value;
    saving = true;
    setBusy(true);
    metadataStatus.textContent = "Saving scene metadata…";
    try {
      const response = await fetch(`/scene/${encodeURIComponent(sceneId)}/metadata`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata, title, summary }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save scene metadata.");
      const selector = CSS.escape(sceneId);
      const sceneRow = document.querySelector(`.scene-row[data-scene-id="${selector}"]`);
      const sceneButton = sceneRow?.querySelector('button.scene');
      if (sceneButton) {
        sceneButton.textContent = result.title;
        sceneButton.title = result.summary;
        sceneRow.querySelectorAll('.scene-controls form').forEach(form => {
          const direction = form.querySelector('[name="direction"]')?.value;
          form.querySelector('button').setAttribute('aria-label', direction ? `Move ${result.title} ${direction}` : `Remove ${result.title}`);
        });
      }
      const note = document.querySelector(`[data-story-note][data-scene-id="${selector}"]`);
      if (note) {
        note.querySelector('h3').textContent = result.title;
        if (note.querySelector('[data-note-title-input]')) note.querySelector('[data-note-title-input]').value = result.title;
        note.querySelector('.story-note-summary').value = result.summary;
        note.setAttribute('aria-label', `${result.title} scene note`);
        note.querySelector('[data-note-drag-handle]').setAttribute('aria-label', `Drag ${result.title} to reorder`);
        note.querySelectorAll('[data-note-move]').forEach(button => button.setAttribute('aria-label', `Move ${result.title} ${button.dataset.noteMove}`));
        note.querySelector('[data-note-delete]').setAttribute('aria-label', `Delete ${result.title}`);
        note.querySelector('[data-note-color]').setAttribute('aria-label', `Color for ${result.title} note`);
      }
      const gridButton = document.querySelector(`[data-storyboard-grid-form] [data-open-scene-metadata="${selector}"]`);
      if (gridButton) {
        const row = gridButton.closest('tr');
        row.querySelector('input[name^="scene_title_"]').value = result.title;
        row.querySelector('textarea[name^="scene_summary_"]').value = result.summary;
      }
      document.querySelectorAll(`[data-open-scene-metadata="${selector}"]`).forEach(button => {
        if (button.closest('[data-story-note], [data-storyboard-grid-form]')) button.setAttribute('aria-label', `Scene metadata for ${result.title}`);
      });
      const preview = document.querySelector(`[data-scene-metadata-preview="${selector}"]`);
      if (preview) preview.textContent = [
        result.metadata.pov_character || result.metadata.narrator || result.metadata.narrative_perspective,
        result.metadata.location,
      ].filter(Boolean).join(" · ");
      if (result.changed) {
        window.verwrityMarkProjectChanged?.();
        window.dispatchEvent(new CustomEvent("verwrity-scene-metadata-changed", { detail: { sceneId } }));
      }
      metadataDialog.close();
    } catch (error) {
      metadataStatus.textContent = error.message;
    } finally {
      saving = false;
      setBusy(false);
    }
  });
}
