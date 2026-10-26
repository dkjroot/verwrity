/* Browser-local recovery, independent of canonical project files and servers. */
export const MAX_STORAGE_BYTES = 128 * 1024 * 1024;
let database;
async function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open("verwrity-dictate-draft-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sessions", { keyPath: "projectId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Browser recovery storage is unavailable."));
  });
  return database;
}
export async function loadDraft(projectId) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction("sessions").objectStore("sessions").get(projectId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(new Error("Could not reopen local draft recovery."));
  });
}
export async function listDrafts() {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction("sessions").objectStore("sessions").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Could not list local draft buffers."));
  });
}
export async function deleteDraft(projectId, expectedVersion) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");
    const request = store.get(projectId);
    request.onsuccess = () => {
      if ((request.result?.storageVersion || 0) !== expectedVersion) { tx.abort(); return; }
      store.delete(projectId);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(new Error("The buffer changed in another tab; reopen the buffer list before deleting."));
  });
}
export async function saveDraft(session, expectedVersion) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");
    let failure = "Could not save local draft recovery. Export the text before closing this tab.";
    const request = store.getAll();
    request.onsuccess = () => {
      const current = request.result.find(item => item.projectId === session.projectId);
      if ((current?.storageVersion || 0) !== expectedVersion) {
        failure = "Another tab changed this draft buffer. Recording paused; export this tab's text before reopening.";
        tx.abort(); return;
      }
      const value = { ...session, storageVersion: expectedVersion + 1, savedAt: new Date().toISOString() };
      const all = request.result.filter(item => item.projectId !== session.projectId).concat(value);
      const size = all.reduce((total, item) => total + JSON.stringify(item).length * 2 +
        item.chunks.reduce((bytes, chunk) => bytes + (chunk.audio?.size || 0), 0), 0);
      if (size > MAX_STORAGE_BYTES) {
        failure = "Local draft recovery reached its 128 MiB limit. Export text and delete retained audio or old buffers before resuming.";
        tx.abort(); return;
      }
      store.put(value);
    };
    tx.oncomplete = () => resolve(expectedVersion + 1);
    tx.onerror = tx.onabort = () => reject(new Error(failure));
  });
}
