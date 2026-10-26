// Tab-local reading position. No manuscript text is placed in browser storage.
export function writingPosition(editor, viewport, projectId, sceneId) {
  const key = `verwrity-writing-position:${projectId}:${sceneId}`;
  let restoring = false;
  function save() {
    if (!sceneId || restoring || !editor.isEditable || editor.isDestroyed) return;
    try {
      sessionStorage.setItem(key, JSON.stringify({
        hash: window.verwritySceneHash?.(),
        from: editor.state.selection.from, to: editor.state.selection.to,
        top: viewport.scrollTop, left: viewport.scrollLeft,
      }));
    } catch (_) { /* Reading position is optional. */ }
  }
  function restore() {
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(key)); } catch (_) { return false; }
    if (!saved || saved.hash !== window.verwritySceneHash?.()
      || ![saved.from, saved.to, saved.top, saved.left].every(Number.isFinite)
      || saved.from < 0 || saved.to < saved.from || saved.to > editor.state.doc.content.size) return false;
    restoring = true;
    let cancelled = false;
    const cancel = () => { cancelled = true; restoring = false; };
    for (const type of ["pointerdown", "wheel", "keydown"]) window.addEventListener(type, cancel, { once: true, capture: true });
    editor.commands.setTextSelection({ from: saved.from, to: saved.to });
    editor.view.focus();
    document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!cancelled && !editor.isDestroyed) {
        viewport.scrollTop = saved.top;
        viewport.scrollLeft = saved.left;
      }
      restoring = false;
      for (const type of ["pointerdown", "wheel", "keydown"]) window.removeEventListener(type, cancel, { capture: true });
    })));
    return true;
  }
  window.addEventListener("pagehide", save);
  document.addEventListener("submit", save);
  return { save, restore };
}
