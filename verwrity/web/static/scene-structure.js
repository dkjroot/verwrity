"use strict";
const dialog = document.querySelector("#scene-structure-dialog");
const form = dialog?.querySelector("form");
const projectId = document.querySelector("[data-workspace]")?.dataset.projectId;
let operation, snapshot, offset, sourceText;
const api = () => window.verwrityEditor;
const headers = () => ({ "Content-Type": "application/json", "X-Verwrity-Project-Id": projectId });

async function openStructure(kind) {
  if (!api()?.isEditable()) return;
  offset = api().getCaretOffset();
  if (!(await window.verwritySaveActiveScene())) return;
  if (await window.verwrityWiki?.savePending() === false) throw new Error("Save the active wiki edits before changing scene structure.");
  const response = await fetch(`/scene/${api().sceneId}/structure`, { credentials: "same-origin" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  if (kind === "join" && !result.later) throw new Error("This is the last current scene. Choose the earlier scene of an adjacent pair.");
  if (kind === "split" && (offset <= 0 || offset >= Array.from(api().getText()).length)) throw new Error("Place the caret inside the scene, leaving text on both sides.");
  operation = kind; snapshot = result; sourceText = api().getText();
  form.elements.title.value = kind === "split" ? `${result.earlier.title} (continued)` : result.earlier.title;
  form.elements.summary.value = kind === "split" ? result.earlier.summary : [result.earlier.summary, result.later.summary].filter(Boolean).join("\n\n");
  form.querySelector("[data-structure-title-label]").textContent = kind === "split" ? "New scene title" : "Resulting scene title";
  form.querySelector("[data-join-separator]").hidden = kind !== "join";
  dialog.querySelector("h2").textContent = kind === "split" ? "Split scene" : "Join adjacent scenes";
  form.querySelector("[data-structure-existing]").textContent = kind === "split" ? `Original: ${result.earlier.title}\n${result.earlier.summary}\nSplit at character ${offset}.` :
    `Earlier: ${result.earlier.title}\n${result.earlier.summary}\n\nLater: ${result.later.title}\n${result.later.summary}`;
  form.querySelector("[data-structure-consequences]").textContent = kind === "split" ?
    "Text before the selection stays in this scene; the rest becomes the next scene. Scene notes and grid fields are copied for you to check." :
    "The later text joins the earlier scene with your chosen separator.";
  form.querySelector("[data-structure-error]").textContent = "";
  form.elements.separator.value = "blank"; dialog.showModal();
}

for (const [selector, kind] of [["[data-split-scene]", "split"], ["[data-join-scenes]", "join"]]) {
  document.querySelector(selector)?.addEventListener("mousedown", event => event.preventDefault());
  document.querySelector(selector)?.addEventListener("click", () => openStructure(kind).catch(error => window.verwrityDialog.alert(error.message)));
}
form?.addEventListener("submit", async event => {
  event.preventDefault(); const submit = form.querySelector("[type=submit]"); submit.disabled = true;
  try {
    if (api().getText() !== sourceText) throw new Error("The editor changed. Reopen the structural edit.");
    if (!(await window.verwritySaveActiveScene())) return;
    const response = await fetch(`/scene/${api().sceneId}/structure/${operation}`, {
      method: "POST", headers: headers(), credentials: "same-origin", body: JSON.stringify({
        snapshot: snapshot.snapshot, title: form.elements.title.value, summary: form.elements.summary.value,
        offset, later_id: snapshot.later?.id, separator: { blank: "\n\n", line: "\n", none: "" }[form.elements.separator.value],
      }),
    });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "Could not change scene structure");
    window.verwrityMarkProjectChanged(); window.verwrityAllowUnload(); location.assign(result.redirect);
  } catch (error) { form.querySelector("[data-structure-error]").textContent = error.message; }
  finally { submit.disabled = false; }
});

const exportDialog = document.querySelector("#manuscript-export-dialog");
document.querySelectorAll("[data-close-manuscript-export]").forEach(button => button.addEventListener("click", () => exportDialog.close()));
document.querySelectorAll("[data-export-manuscript]").forEach(button => {
  button.addEventListener("mousedown", event => event.preventDefault());
  button.addEventListener("click", () => {
    document.querySelector("#file-dialog")?.close();
    exportDialog.showModal();
  });
});
document.querySelector("[data-manuscript-export-form]")?.addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("[type=submit]");
    const includeSceneDetails = event.currentTarget.elements.include_scene_details.checked;
    button.disabled = true;
    try {
      if (api() && !api().isEditable()) throw new Error("Return to the current scene head before exporting the manuscript.");
      const response = await fetch("/project/manuscript.txt", { method: "POST", headers: headers(), credentials: "same-origin",
        body: JSON.stringify({ scene_id: api()?.sceneId, source_hash: window.verwritySceneHash(), text: api()?.getText(), include_scene_details: includeSceneDetails }) });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || "Could not export manuscript"); }
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url;
      link.download = response.headers.get("Content-Disposition")?.match(/filename="?([^";]+)/)?.[1] || "manuscript.txt";
      link.click(); exportDialog.close(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { await window.verwrityDialog.alert(error.message); }
    finally { button.disabled = false; }
});
