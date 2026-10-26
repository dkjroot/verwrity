const selectionMenu = document.querySelector("[data-wiki-selection-menu]");
const selectionTitle = selectionMenu?.querySelector("input[name='title']");
const editorElement = document.querySelector("[data-rich-editor]");
const commentDialog = document.querySelector("#add-comment-dialog");
const commentForm = document.querySelector("[data-comment-form]");
const commentPopover = document.querySelector("[data-comment-popover]");
let selectedCommentRange = null;
let shownCommentId = null;
let commentPopoverTimer;

selectionMenu?.querySelector("form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(await window.verwritySaveActiveScene())) return;
  window.verwrityMarkSceneSaved?.();
  window.verwrityAllowUnload?.();
  form.submit();
});

window.addEventListener("verwrity-context-opened", (event) => {
  selectedCommentRange = event.detail.range;
  selectionTitle.value = selectedCommentRange.quote.trim();
});

selectionMenu?.querySelector("[data-add-comment]")?.addEventListener("click", () => {
  selectionMenu.hidden = true;
  if (!selectedCommentRange || !commentDialog) return;
  commentForm?.reset();
  commentForm?.querySelector("[data-comment-error]")?.setAttribute("hidden", "");
  commentDialog.showModal();
  commentForm?.querySelector("textarea")?.focus();
});
document.querySelector("[data-close-comment]")?.addEventListener("click", () => commentDialog?.close());
commentForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = commentForm.querySelector("[data-comment-error]");
  if (!selectedCommentRange || !(await window.verwritySaveActiveScene())) {
    if (error) { error.textContent = "The selected text could not be saved. Please try again."; error.hidden = false; }
    return;
  }
  const sceneId = window.verwrityEditor?.sceneId;
  const body = new FormData(commentForm);
  try {
    const response = await fetch(`/scene/${sceneId}/comments`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...selectedCommentRange, body: body.get("body"), add_to_todo: body.has("add_to_todo") }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not add comment.");
    window.verwrityEditor.setComments([...window.verwrityEditor.getComments(), result.comment]);
    window.verwrityMarkProjectChanged?.();
    const commentsToggle = document.querySelector("[data-annotation-toggle='comments']");
    if (commentsToggle?.getAttribute("aria-pressed") !== "true") commentsToggle?.click();
    if (result.todo_page) window.dispatchEvent(new CustomEvent("verwrity-wiki-page-updated", { detail: result.todo_page }));
    commentDialog.close();
    commentForm.reset();
    selectedCommentRange = null;
  } catch (failure) {
    if (error) { error.textContent = failure.message; error.hidden = false; }
  }
});

function activeComment(id) {
  return window.verwrityEditor?.getComments().find((comment) => comment.id === id);
}
function showCommentPopover(mark) {
  const comment = activeComment(mark?.dataset.verwrityCommentId);
  if (!comment || !commentPopover) return;
  window.clearTimeout(commentPopoverTimer);
  shownCommentId = comment.id;
  commentPopover.querySelector("[data-comment-quote]").textContent = comment.quote;
  commentPopover.querySelector("[data-comment-body]").textContent = comment.body;
  const resolve = commentPopover.querySelector("[data-comment-resolve]");
  resolve.textContent = comment.resolved ? "Reopen" : "Resolve";
  commentPopover.hidden = false;
  const rect = mark.getBoundingClientRect();
  const width = commentPopover.offsetWidth;
  commentPopover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  commentPopover.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - commentPopover.offsetHeight - 8)}px`;
}
function delayHideCommentPopover() {
  commentPopoverTimer = window.setTimeout(() => { if (commentPopover) commentPopover.hidden = true; shownCommentId = null; }, 180);
}
editorElement?.addEventListener("pointerover", (event) => {
  const mark = event.target.closest("[data-verwrity-comment-id]");
  if (mark && editorElement.contains(mark)) showCommentPopover(mark);
});
editorElement?.addEventListener("focusin", (event) => {
  const mark = event.target.closest("[data-verwrity-comment-id]");
  if (mark) showCommentPopover(mark);
});
editorElement?.addEventListener("pointerout", (event) => {
  if (event.target.closest("[data-verwrity-comment-id]") && !event.relatedTarget?.closest?.("[data-verwrity-comment-id]")) delayHideCommentPopover();
});
commentPopover?.addEventListener("pointerenter", () => window.clearTimeout(commentPopoverTimer));
commentPopover?.addEventListener("pointerleave", delayHideCommentPopover);
commentPopover?.querySelector("[data-comment-resolve]")?.addEventListener("click", async () => {
  const comment = activeComment(shownCommentId);
  if (!comment || !(await window.verwritySaveActiveScene())) return;
  const response = await fetch(`/scene/${window.verwrityEditor.sceneId}/comments/${comment.id}/resolve`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolved: !comment.resolved }),
  });
  if (!response.ok) return;
  const result = await response.json();
  window.verwrityEditor.setComments(window.verwrityEditor.getComments().map((item) => item.id === comment.id ? { ...item, resolved: result.comment.resolved } : item));
  window.verwrityMarkProjectChanged?.();
  const mark = editorElement.querySelector(`[data-verwrity-comment-id="${CSS.escape(comment.id)}"]`);
  if (mark) showCommentPopover(mark);
});
commentPopover?.querySelector("[data-comment-delete]")?.addEventListener("click", async () => {
  const id = shownCommentId;
  if (!id) return;
  const response = await fetch(`/scene/${window.verwrityEditor.sceneId}/comments/${id}/delete`, { method: "POST", credentials: "same-origin" });
  if (!response.ok) return;
  window.verwrityEditor.setComments(window.verwrityEditor.getComments().filter((item) => item.id !== id));
  window.verwrityMarkProjectChanged?.();
  commentPopover.hidden = true;
});

document.addEventListener("mousedown", (event) => {
  if (selectionMenu && !selectionMenu.contains(event.target)) selectionMenu.hidden = true;
});
window.addEventListener("verwrity-hide-comment-popover", () => {
  if (commentPopover) commentPopover.hidden = true;
});

const commentsDialog = document.querySelector("#scene-comments-dialog");
const commentsList = commentsDialog?.querySelector("[data-comments-list]");
let reattachmentRange = null;
function renderCommentList() {
  if (!commentsList) return;
  commentsList.replaceChildren();
  const comments = window.verwrityEditor?.getComments() || [];
  if (!comments.length) { const empty = document.createElement("p"); empty.textContent = "No comments in this scene."; commentsList.append(empty); }
  for (const comment of comments) {
    const card = document.createElement("article"); card.dataset.commentId = comment.id;
    const state = document.createElement("strong"); state.textContent = `${comment.detached ? "Detached" : "Attached"}${comment.resolved ? " · resolved" : ""}`;
    const quote = document.createElement("blockquote"); quote.textContent = comment.original_quote || comment.quote;
    const body = document.createElement("p"); body.textContent = comment.body;
    card.append(state, quote, body);
    if (comment.prefix || comment.suffix) {
      const context = document.createElement("p"); context.className = "muted";
      context.textContent = `Original context: ${comment.prefix || ""} [${comment.original_quote || comment.quote}] ${comment.suffix || ""}`;
      card.append(context);
    }
    for (const [action, label] of [["reattach", "Attach to selected passage"], ["resolve", comment.resolved ? "Reopen" : "Resolve"], ["delete", "Delete"]]) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.dataset.commentAction = action;
      button.disabled = action === "reattach" && !reattachmentRange;
      button.addEventListener("click", async () => {
        const error = commentsDialog.querySelector("[data-comments-error]");
        button.disabled = true;
        try {
          if (document.querySelector(".manuscript.is-revision-preview")) throw new Error("Return to the current draft before changing comments.");
          if (!(await window.verwritySaveActiveScene())) throw new Error("Save the scene before changing this comment.");
          const payload = action === "reattach" ? reattachmentRange : { resolved: !comment.resolved };
          const response = await fetch(`/scene/${window.verwrityEditor.sceneId}/comments/${comment.id}/${action}`, {
            method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Could not update comment.");
          const current = window.verwrityEditor.getComments();
          window.verwrityEditor.setComments(action === "delete" ? current.filter(item => item.id !== comment.id)
            : current.map(item => item.id !== comment.id ? item : action === "reattach" ? result.comment : { ...item, resolved: result.comment.resolved }), action === "reattach");
          window.verwrityMarkProjectChanged?.();
          error.textContent = "";
          renderCommentList();
        } catch (failure) { error.textContent = failure.message; button.disabled = false; }
      });
      card.append(button);
    }
    commentsList.append(card);
  }
}
document.querySelector("[data-open-comments]")?.addEventListener("click", async () => {
  reattachmentRange = window.verwrityEditor?.getSelectedRange();
  if (!(await window.verwritySaveActiveScene())) return;
  renderCommentList();
  commentsDialog?.showModal();
});
commentsDialog?.querySelector("[data-close-comments]")?.addEventListener("click", () => commentsDialog.close());
window.addEventListener("verwrity-comments-changed", () => { if (commentsDialog?.open) renderCommentList(); });
