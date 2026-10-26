/* Highlight validated code-point edits without interpreting transcript as HTML. */
export function showCleanupChanges(root, chunk) {
  root.replaceChildren();
  if (chunk?.cleaned === undefined) {
    root.textContent = chunk?.cleanup === "processing" ? "Preparing cleanup…" : "Run cleanup to prepare a review.";
    return;
  }
  if (!chunk.edits?.length) { root.textContent = chunk.cleaned; return; }
  const source = Array.from(chunk.raw || "");
  let offset = 0;
  for (const edit of chunk.edits) {
    root.append(document.createTextNode(source.slice(offset, edit.start).join("")));
    const label = `${JSON.stringify(edit.before)} → ${JSON.stringify(edit.after)}`;
    if (edit.after) {
      const mark = document.createElement("mark"); mark.textContent = edit.after;
      mark.tabIndex = 0;
      mark.title = label; mark.setAttribute("aria-label", label); root.append(mark);
    } else {
      // A deletion has no characters in the cleaned passage to colour. Keep a
      // distinct, inspectable marker; it never enters the editable review text.
      const removed = document.createElement("span"); removed.className = "draft-deletion-marker";
      removed.tabIndex = 0;
      removed.textContent = "[−]"; removed.title = label; removed.setAttribute("aria-label", label);
      root.append(removed);
    }
    offset = edit.end;
  }
  root.append(document.createTextNode(source.slice(offset).join("")));
}
