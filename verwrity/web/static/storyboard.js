const board = document.querySelector("[data-storyboard-board]");
const storyboardPage = document.querySelector(".storyboard-page");

if (storyboardPage) {
  let typewriterMode = false;
  try { typewriterMode = JSON.parse(window.localStorage.getItem("verwrity-workspace-layout-v1") || "{}").typewriterMode === true; } catch (_) { /* Focus preferences are optional. */ }
  if (typewriterMode) {
    storyboardPage.dataset.typewriterMode = "true";
    storyboardPage.querySelectorAll('input[name^="scene_title_"]').forEach((input) => { input.readOnly = true; });
    const notice = storyboardPage.querySelector("[data-typewriter-board-notice]");
    if (notice) notice.hidden = false;
  }
}

if (board) {
  let draggedNote = null;
  board.querySelectorAll("[data-note-title]").forEach(title => {
    const input = title.nextElementSibling;
    const begin = () => { if (storyboardPage.dataset.typewriterMode === "true") return; title.hidden = true; input.hidden = false; input.focus(); input.select(); };
    const finish = () => { input.value = input.value.trim() || title.textContent; title.textContent = input.value; input.hidden = true; title.hidden = false; };
    title.ondblclick = begin; title.onkeydown = event => { if (event.key === "Enter" || event.key === "F2") { event.preventDefault(); begin(); } };
    input.onblur = finish; input.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); finish(); title.focus(); } else if (event.key === "Escape") { input.value = title.textContent; finish(); title.focus(); } };
  });

  const notes = () => [...board.querySelectorAll("[data-story-note]")];
  const applyNoteColor = (picker) => {
    if (!/^#[0-9a-f]{6}$/i.test(picker.value)) return;
    const note = picker.closest("[data-story-note]");
    if (!note) return;
    note.style.setProperty("--story-note-color", picker.value);
    const channels = picker.value.slice(1).match(/.{2}/g).map((channel) => parseInt(channel, 16) / 255);
    const luminance = channels.map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    note.style.setProperty("--story-note-ink", luminance > .179 ? "#332c19" : "#ffffff");
  };
  board.querySelectorAll("[data-note-color]").forEach(applyNoteColor);
  board.addEventListener("input", (event) => {
    const picker = event.target.closest("[data-note-color]");
    if (picker) applyNoteColor(picker);
  });
  board.addEventListener("change", (event) => {
    const picker = event.target.closest("[data-note-color]");
    if (picker) applyNoteColor(picker);
  });
  board.addEventListener("submit", (event) => {
    if (event.submitter?.matches("[data-note-delete]") && board.dataset.confirmedAction !== "delete") return;
    window.verwrityMarkProjectChanged?.();
  });
  document.querySelector("[data-board-return]")?.addEventListener("click", (event) => {
    event.preventDefault();
    board.requestSubmit(board.querySelector("[data-board-save]"));
  });
  board.addEventListener("submit", async (event) => {
    const submitter = event.submitter;
    if (!submitter?.matches("[data-note-delete]")) return;
    if (board.dataset.confirmedAction === "delete") {
      delete board.dataset.confirmedAction;
      return;
    }
    event.preventDefault();
    const confirmed = await window.verwrityDialog?.confirm("Remove this scene from the current storyboard? It will be kept as historical material.", {
      title: "Remove scene", acceptLabel: "Remove",
    });
    if (!confirmed) return;
    board.dataset.confirmedAction = "delete";
    board.requestSubmit(submitter);
  });
  document.querySelector('[data-board-view-switch="grid"]')?.addEventListener("click", (event) => {
    event.preventDefault();
    board.requestSubmit(board.querySelector("[data-switch-grid]"));
  });
  const updateMoveButtons = () => notes().forEach((note, index, all) => {
    note.querySelector('[data-note-move="earlier"]').disabled = index === 0;
    note.querySelector('[data-note-move="later"]').disabled = index === all.length - 1;
  });

  board.addEventListener("dragstart", (event) => {
    const handle = event.target.closest("[data-note-drag-handle]");
    const note = handle?.closest("[data-story-note]");
    if (!note) return;
    draggedNote = note;
    note.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", note.dataset.sceneId);
  });

  board.addEventListener("dragover", (event) => {
    if (!draggedNote) return;
    const target = event.target.closest("[data-story-note]");
    if (!target || target === draggedNote) return;
    event.preventDefault();
    const bounds = target.getBoundingClientRect();
    const sameRow = Math.abs(event.clientY - (bounds.top + bounds.height / 2)) < bounds.height / 2;
    const after = sameRow
      ? event.clientX > bounds.left + bounds.width / 2
      : event.clientY > bounds.top + bounds.height / 2;
    board.insertBefore(draggedNote, after ? target.nextSibling : target);
  });

  board.addEventListener("dragend", () => {
    draggedNote?.classList.remove("is-dragging");
    draggedNote = null;
    updateMoveButtons();
  });

  board.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-note-delete]");
    if (deleteButton) board.querySelector("[name='delete_scene_id']").value = deleteButton.dataset.noteDelete;
    const button = event.target.closest("[data-note-move]");
    if (!button) return;
    const note = button.closest("[data-story-note]");
    if (button.dataset.noteMove === "earlier") board.insertBefore(note, note.previousElementSibling);
    else board.insertBefore(note.nextElementSibling, note);
    updateMoveButtons();
  });
}

const gridForm = document.querySelector("[data-storyboard-grid-form]");
if (gridForm) {
  const markProjectChanged = () => window.verwrityMarkProjectChanged?.();
  gridForm.addEventListener("submit", (event) => {
    if (event.submitter?.matches("[data-delete-column]") && gridForm.dataset.confirmedAction !== "delete-column") return;
    markProjectChanged();
  });
  gridForm.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-delete-column]");
    if (deleteButton) gridForm.querySelector("[name='delete_column_id']").value = deleteButton.dataset.deleteColumn;
  });
  gridForm.addEventListener("submit", async (event) => {
    const submitter = event.submitter;
    if (!submitter?.matches("[data-delete-column]")) return;
    if (gridForm.dataset.confirmedAction === "delete-column") {
      delete gridForm.dataset.confirmedAction;
      return;
    }
    event.preventDefault();
    const confirmed = await window.verwrityDialog?.confirm("Delete this column and all of its scene entries?", {
      title: "Delete storyboard column", acceptLabel: "Delete column",
    });
    if (!confirmed) return;
    gridForm.dataset.confirmedAction = "delete-column";
    gridForm.requestSubmit(submitter);
  });
  document.querySelector("[data-board-return]")?.addEventListener("click", (event) => {
    event.preventDefault();
    gridForm.requestSubmit(gridForm.querySelector("[data-grid-save]"));
  });
  document.querySelector('[data-board-view-switch="notes"]')?.addEventListener("click", (event) => {
    event.preventDefault();
    gridForm.requestSubmit(gridForm.querySelector("[data-switch-notes]"));
  });
}

document.querySelectorAll(".scene-row.has-note-color").forEach(row => {
  const hex = row.style.getPropertyValue("--scene-note-color").trim(); if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
  const c = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  row.style.setProperty("--scene-note-ink", c[0] * .2126 + c[1] * .7152 + c[2] * .0722 > .179 ? "#111111" : "#ffffff");
});
