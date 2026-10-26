// Tab-scoped editing buffers survive scene navigation without saving the page.
export function wikiNavigation(projectId, capture) {
  const key = `verwrity-wiki-navigation:${projectId}`;
  let committed = false;
  function store() {
    const state = committed ? null : capture();
    if (state) sessionStorage.setItem(key, JSON.stringify({ version: 1, ...state }));
    else sessionStorage.removeItem(key);
  }
  window.addEventListener('beforeunload', event => {
    try { store(); } catch (_) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => { try { store(); } catch (_) { /* The unload guard retains the open editor. */ } });
  return {
    read() { try { const value = JSON.parse(sessionStorage.getItem(key)); return value?.version === 1 ? value : null; } catch (_) { return null; } },
    saved() { committed = true; sessionStorage.removeItem(key); },
    async preserve() {
      try { store(); return true; }
      catch (_) { await window.verwrityDialog?.alert('Your wiki editing buffer could not be kept for navigation. Keep this tab open and save or cancel the wiki edit first.'); return false; }
    },
  };
}
