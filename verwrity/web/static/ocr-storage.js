/* OCR recovery is browser-local and never part of a project archive. */
const LIMIT = 256 * 1024 * 1024;
let connection;
async function db() {
  connection ||= new Promise((resolve, reject) => {
    const r = indexedDB.open("verwrity-ocr-v1", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("buffers", { keyPath: "projectId" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(new Error("OCR recovery storage is unavailable. Download text before closing."));
  });
  return connection;
}
export async function buffers() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("buffers").objectStore("buffers").getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(new Error("Could not read OCR recovery."));
  });
}
export async function saveBuffer(value, expected) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("buffers", "readwrite"), store = tx.objectStore("buffers");
    let error = "OCR recovery could not be saved. Keep this tab open; download review text and retry.";
    const r = store.getAll();
    r.onsuccess = () => {
      const stored = r.result.find(b => b.projectId === value.projectId);
      if ((stored?.version || 0) !== expected) {
        error = "Another tab changed this OCR buffer. Download this tab's text, then reload before continuing.";
        tx.abort(); return;
      }
      const next = { ...value, version: expected + 1, savedAt: new Date().toISOString() };
      const all = r.result.filter(b => b.projectId !== value.projectId).concat(next);
      const size = all.reduce((total, b) => total + JSON.stringify(b).length * 2 +
        b.pages.reduce((n, p) => n + (p.original?.size || 0), 0), 0);
      if (size > LIMIT) { error = "OCR recovery reached 256 MiB. Export text and delete old buffers or unchecked captures."; tx.abort(); return; }
      store.put(next);
    };
    tx.oncomplete = () => resolve(expected + 1);
    tx.onerror = tx.onabort = () => reject(new Error(error));
  });
}
export async function deleteBuffer(projectId, version) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("buffers", "readwrite"), store = tx.objectStore("buffers");
    const r = store.get(projectId);
    r.onsuccess = () => {
      if ((r.result?.version || 0) !== version) { tx.abort(); return; }
      store.delete(projectId);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(new Error("The OCR buffer changed; refresh the buffer list before deleting."));
  });
}
