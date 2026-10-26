// Evidence stays attached to the block that owns it, outside manuscript/wiki text.
export function wikiSourceButton(record) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "wiki-block-source";
  button.textContent = record.origin === "human_delegated" ? "AI permission" : "AI source";
  button.addEventListener("click", () => {
    const dialog = document.createElement("dialog"); dialog.className = "file-dialog app-dialog";
    dialog.setAttribute("aria-label", button.textContent);
    const heading = document.createElement("div"); heading.className = "file-dialog-heading";
    const title = document.createElement("h2"); title.textContent = button.textContent;
    const close = document.createElement("button"); close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", "Close AI source");
    close.onclick = () => dialog.close(); heading.append(title, close);
    const body = document.createElement("div"); body.className = "app-dialog-body";
    const attribution = document.createElement("p");
    attribution.textContent = [record.model, record.created_at && new Date(record.created_at).toLocaleString()].filter(Boolean).join(" · ");
    body.append(attribution);
    for (const evidence of record.evidence || []) {
      const quote = document.createElement("blockquote"); quote.textContent = evidence.quote; body.append(quote);
      const jump = document.createElement("button"); jump.type = "button"; jump.textContent = "Go to passage";
      jump.onclick = async () => {
        if (await window.verwritySaveActiveScene?.() === false) return;
        if (window.verwrityEditor?.sceneId === evidence.scene_id) {
          if (window.verwrityEditor.highlightSourceQuote(evidence.quote)) dialog.close();
          else await window.verwrityDialog.alert("This source passage has changed.");
          return;
        }
        if (await window.verwrityWiki?.prepareSceneNavigation() === false) return;
        const form = document.createElement("form"); form.method = "POST"; form.action = `/scene/select/${evidence.scene_id}`;
        const input = document.createElement("input"); input.name = "ai_quote"; input.value = evidence.quote; form.append(input);
        const project = document.createElement('input'); project.type = 'hidden'; project.name = 'expected_project_id';
        project.value = document.querySelector('[data-workspace]').dataset.projectId; form.append(project);
        document.body.append(form); window.verwrityAllowUnload?.(); form.submit();
      };
      body.append(jump);
    }
    if (!(record.evidence || []).length) {
      const empty = document.createElement("p");
      empty.textContent = record.origin === "human_delegated" ? "Human-written · AI updates allowed" : "Warning: no citation"; body.append(empty);
    }
    dialog.append(heading, body); document.body.append(dialog);
    dialog.addEventListener("close", () => { dialog.remove(); button.focus({ preventScroll: true }); }, { once: true }); dialog.showModal();
  });
  return button;
}
