"use strict";

const controls = document.querySelector("[data-scene-revision-controls]");
const editor = window.verwrityEditor;

if (controls && editor) {
  const sceneId = controls.dataset.sceneId;
  const revisionSelect = controls.querySelector("[data-scene-revision-select]");
  const recordButton = controls.querySelector("[data-record-scene-revision]");
  const restoreButton = controls.querySelector("[data-restore-scene-revision]");
  const leftSelect = controls.querySelector("[data-scene-diff-left]");
  const rightSelect = controls.querySelector("[data-scene-diff-right]");
  const compareButton = controls.querySelector("[data-compare-scene-revisions]");
  const diffDialog = document.querySelector("#scene-diff-dialog");
  let revisions = JSON.parse(controls.querySelector("[data-revision-list]")?.textContent || "[]");
  const initialHead = JSON.parse(controls.querySelector("[data-revision-head]")?.textContent || "{}");
  let headText = initialHead.text || "";
  let headComments = initialHead.comments || [];
  let headDialogue = initialHead.dialogue || [];
  let selectedVersion = "head";

  const byId = (id) => revisions.find((revision) => revision.id === id);
  const nextNumber = () => revisions.reduce((maximum, revision) => Math.max(maximum, revision.number), 0) + 1;
  const labelFor = (id) => id === "head" ? `Head · draft ${nextNumber()}` : `Revision ${byId(id)?.number ?? "?"}`;
  const previewing = () => selectedVersion !== "head";

  function updatePreviewState() {
    restoreButton.hidden = !previewing();
    recordButton.disabled = previewing();
    controls.closest(".manuscript")?.classList.toggle("is-revision-preview", previewing());
  }

  function fillSelect(select, includeHead) {
    if (!select) return;
    select.replaceChildren();
    if (includeHead) select.add(new Option(labelFor("head"), "head"));
    for (const revision of [...revisions].reverse()) {
      select.add(new Option(labelFor(revision.id), revision.id));
    }
  }

  function refreshSelectors() {
    const current = selectedVersion;
    fillSelect(revisionSelect, true);
    revisionSelect.value = byId(current) ? current : "head";
    selectedVersion = revisionSelect.value;
    fillSelect(leftSelect, true);
    fillSelect(rightSelect, true);
    if (revisions.length) leftSelect.value = revisions[revisions.length - 1].id;
    rightSelect.value = "head";
    compareButton.disabled = revisions.length === 0;
    updatePreviewState();
  }

  window.addEventListener("verwrity-scene-checkpoints-changed", event => {
    if (event.detail.sceneId !== sceneId || !Array.isArray(event.detail.revisions)) return;
    revisions = event.detail.revisions;
    refreshSelectors();
  });

  async function saveHead() {
    const saved = await window.verwritySaveActiveScene?.();
    if (!saved) return false;
    if (!previewing()) {
      headText = editor.getText();
      headComments = editor.getComments();
      headDialogue = editor.getDialogue();
    }
    return true;
  }

  async function showVersion(requested) {
    revisionSelect.disabled = true;
    if (!(await saveHead())) {
      revisionSelect.value = selectedVersion;
      revisionSelect.disabled = false;
      return false;
    }
    if (requested === "head") {
      selectedVersion = "head";
      editor.setText(headText, headComments, true, headDialogue);
    } else {
      const revision = byId(requested);
      if (!revision) {
        revisionSelect.value = "head";
        revisionSelect.disabled = false;
        return;
      }
      selectedVersion = requested;
      editor.setText(revision.text, revision.comments || [], false, revision.dialogue || []);
    }
    revisionSelect.disabled = false;
    updatePreviewState();
    return true;
  }

  revisionSelect?.addEventListener("change", () => showVersion(revisionSelect.value));
  window.verwrityShowSceneHead = async () => {
    if (!previewing()) return true;
    revisionSelect.value = "head";
    return showVersion("head");
  };

  recordButton?.addEventListener("click", async () => {
    if (!(await saveHead())) return;
    recordButton.disabled = true;
    try {
      const response = await fetch(`/scene/${sceneId}/revisions/record`, {
        method: "POST", credentials: "same-origin",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not record this revision");
      revisions = result.revisions;
      headText = result.head_text;
      headComments = result.head_comments;
      headDialogue = result.head_dialogue || [];
      window.verwrityMarkProjectChanged?.();
      selectedVersion = "head";
      refreshSelectors();
    } catch (error) {
      await window.verwrityDialog?.alert(error.message || "Could not record this revision");
    } finally {
      recordButton.disabled = previewing();
    }
  });

  restoreButton?.addEventListener("click", async () => {
    const revision = byId(selectedVersion);
    if (!revision) return;
    if (!(await window.verwrityDialog?.confirm(
      `Copy Revision ${revision.number} into a new head? The current head will first be recorded as Revision ${nextNumber()}.`,
      { title: "Copy revision to new head", acceptLabel: "Copy to new head" },
    ))) return;
    if (!(await saveHead())) return;
    restoreButton.disabled = true;
    try {
      const response = await fetch(`/scene/${sceneId}/revisions/${revision.id}/restore`, {
        method: "POST", credentials: "same-origin",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not restore this revision");
      window.verwrityUpdateSavedSceneHash?.(response);
      revisions = result.revisions;
      headText = result.head_text;
      headComments = result.head_comments;
      headDialogue = result.head_dialogue || [];
      window.verwrityMarkProjectChanged?.();
      selectedVersion = "head";
      editor.setText(headText, headComments, true, headDialogue);
      refreshSelectors();
    } catch (error) {
      await window.verwrityDialog?.alert(error.message || "Could not restore this revision");
    } finally {
      restoreButton.disabled = previewing();
    }
  });

  function alignDiff(leftText, rightText) {
    const left = leftText.split("\n");
    const right = rightText.split("\n");
    if (left.length * right.length > 250000) {
      return { rows: null, tooLarge: true };
    }
    const matrix = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i -= 1) {
      for (let j = right.length - 1; j >= 0; j -= 1) {
        matrix[i][j] = left[i] === right[j]
          ? matrix[i + 1][j + 1] + 1
          : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
      }
    }
    const rows = [];
    let i = 0;
    let j = 0;
    let leftNumber = 1;
    let rightNumber = 1;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) {
        rows.push({ left: left[i], right: right[j], leftNumber, rightNumber, kind: "same" });
        i += 1; j += 1; leftNumber += 1; rightNumber += 1;
      } else if (i < left.length && (j === right.length || matrix[i + 1][j] >= matrix[i][j + 1])) {
        rows.push({ left: left[i], right: "", leftNumber, rightNumber: "", kind: "removed" });
        i += 1; leftNumber += 1;
      } else {
        rows.push({ left: "", right: right[j], leftNumber: "", rightNumber, kind: "added" });
        j += 1; rightNumber += 1;
      }
    }
    return { rows, tooLarge: false };
  }

  function renderDiffPane(pre, side, rows, rawText) {
    pre.replaceChildren();
    if (!rows) {
      pre.textContent = rawText;
      return;
    }
    rows.forEach((row) => {
      const line = document.createElement("span");
      const changedSide = (side === "left" && row.kind === "removed") || (side === "right" && row.kind === "added");
      line.className = `scene-diff-line ${changedSide ? row.kind : ""}`;
      line.textContent = row[side] || " ";
      line.dataset.lineNumber = row[`${side}Number`] ? String(row[`${side}Number`]) : "";
      pre.append(line);
    });
  }

  compareButton?.addEventListener("click", async () => {
    if (!(await saveHead())) return;
    const leftId = leftSelect.value;
    const rightId = rightSelect.value;
    const textFor = (id) => id === "head" ? headText : byId(id)?.text || "";
    const leftLabel = labelFor(leftId);
    const rightLabel = labelFor(rightId);
    const diff = alignDiff(textFor(leftId), textFor(rightId));
    document.querySelector("[data-diff-left-title]").textContent = leftLabel;
    document.querySelector("[data-diff-right-title]").textContent = rightLabel;
    const note = document.querySelector("[data-diff-note]");
    note.hidden = !diff.tooLarge;
    note.textContent = diff.tooLarge
      ? "This scene is too large for inline change highlighting. Both full versions are shown side by side."
      : "Removed lines are marked on the left; added lines are marked on the right.";
    const panes = document.querySelector("[data-scene-diff-output]");
    panes.replaceChildren();
    for (const [side, rawText] of [["left", textFor(leftId)], ["right", textFor(rightId)]]) {
      const pre = document.createElement("pre");
      pre.className = "scene-diff-pane";
      pre.setAttribute("aria-label", `${side === "left" ? leftLabel : rightLabel} text`);
      renderDiffPane(pre, side, diff.rows, rawText);
      panes.append(pre);
    }
    diffDialog.showModal();
  });

  document.querySelector("[data-close-scene-diff]")?.addEventListener("click", () => diffDialog.close());
  refreshSelectors();
}

document.querySelector("[data-diff-wrap]")?.addEventListener("change", event => { document.querySelector("[data-scene-diff-output]").classList.toggle("wrap-lines", event.target.checked); });
