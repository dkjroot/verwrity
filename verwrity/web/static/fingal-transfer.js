"use strict";

let controller = null;
export function installFingalTransfer(root, enabled) {
  controller?.abort();
  document.querySelectorAll('[data-fingal-file-rows], [data-fingal-review]').forEach(node => { if (!root?.contains(node)) node.remove(); });
  if (!enabled) return;
  const rows = root.querySelector('[data-fingal-file-rows]'), dialog = root.querySelector('[data-fingal-review]');
  document.querySelector('#file-dialog .file-dialog-rows').append(rows);
  document.body.append(dialog);
  const projectId = document.querySelector('[data-workspace]').dataset.projectId;
  const report = dialog.querySelector('[data-fingal-report]'), status = dialog.querySelector('[data-fingal-status]'), accept = dialog.querySelector('[data-fingal-accept]');
  let pending = null, busy = false;
  function close() { controller?.abort(); pending = null; dialog.close(); }
  dialog.querySelector('[data-fingal-close]').addEventListener('click', close);
  dialog.addEventListener('cancel', () => { controller?.abort(); pending = null; });
  async function request(path, data, signal) {
    const form = data instanceof FormData;
    return fetch(`/project/fingal/${path}`, { method: 'POST', credentials: 'same-origin', signal,
      headers: { 'X-Verwrity-Project-Id': projectId, ...(!form ? { 'Content-Type': 'application/json' } : {}) },
      body: form ? data : JSON.stringify(data) });
  }
  async function json(path, data, signal) {
    const response = await request(path, data, signal), result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The Fingal file operation failed. Your edits are kept.');
    return result;
  }
  async function savePending() {
    if (await window.verwrityWiki?.savePending() === false || await window.verwritySaveActiveScene?.() === false)
      throw new Error('Save the current edits successfully before continuing. Your buffers are kept in the workspace.');
  }
  function paragraph(text) { const p = document.createElement('p'); p.textContent = text; report.append(p); }
  async function preview(action, data) {
    if (busy) return;
    busy = true; controller?.abort(); controller = new AbortController();
    const signal = controller.signal;
    document.querySelector('#file-dialog').close();
    pending = null; accept.hidden = true; report.replaceChildren(); status.textContent = 'Preparing review…'; dialog.showModal();
    try {
      if (action === 'export') await savePending();
      if (signal.aborted) return;
      const result = await json(`${action}/preview`, data, signal);
      if (signal.aborted) return;
      paragraph(result.title);
      paragraph(Object.entries(result.counts).map(([key, value]) => `${value} ${key}`).join(' · '));
      for (const text of [...result.warnings, ...(result.mapping || [])]) paragraph(text);
      for (const text of result.export_errors || []) paragraph('Before a later export: ' + text);
      for (const text of result.errors || []) paragraph('Please resolve: ' + text);
      status.textContent = result.errors?.length ? 'Resolve these issues, then review the export again.' : 'Ready for your review.';
      if (result.proposal) {
        pending = { action, proposal: result.proposal };
        accept.textContent = action === 'import' ? 'Save current edits and import as new project' : 'Download Fingal story';
        accept.hidden = false;
      }
    } catch (error) { if (!signal.aborted) status.textContent = error.message; }
    finally { busy = false; }
  }
  rows.querySelector('[data-fingal-import]').addEventListener('submit', event => { event.preventDefault(); preview('import', new FormData(event.currentTarget)); });
  rows.querySelector('[data-fingal-export]').addEventListener('click', () => preview('export', {}));
  accept.addEventListener('click', async () => {
    if (!pending || busy) return;
    busy = true; accept.disabled = true;
    const task = pending, signal = controller.signal;
    try {
      status.textContent = 'Saving current edits…';
      await savePending();
      if (signal.aborted) return;
      if (task.action === 'import') {
        const result = await json('import/apply', { proposal: task.proposal }, signal);
        if (!signal.aborted) { pending = null; window.location.assign(result.redirect); }
      } else {
        const response = await request('export/download', { proposal: task.proposal }, signal);
        if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Export failed; review the world again.'); }
        const blob = await response.blob();
        if (signal.aborted) return;
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)/)?.[1] || 'story.fingal.json';
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.textContent = 'Fingal story downloaded. Save your Verwrity archive to keep the complete writing project.';
      }
    } catch (error) { if (!signal.aborted) status.textContent = error.message; }
    finally { busy = false; accept.disabled = false; }
  });
}
