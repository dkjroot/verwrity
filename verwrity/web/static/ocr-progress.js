/* Read bounded stage events. CPU inference has no arbitrary wall-clock timeout. */
export async function postProgress(url, data, { signal, onProgress = () => {} } = {}) {
  const response = await fetch(url, { method: "POST", signal,
    headers: { "Content-Type": "application/json", "X-Verwrity-Progress": "1" }, body: JSON.stringify(data) });
  if (!response.ok || !response.headers.get("Content-Type")?.includes("application/x-ndjson")) {
    const result = await response.json().catch(() => ({ error: `Server rejected the request (${response.status}).` }));
    if (!response.ok || result.error) { const error = new Error(result.error || "Provider request failed."); error.status = response.status; throw error; }
    return result;
  }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "", result, completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      if (buffer.length > 1024 * 1024) throw new Error("Provider progress packet exceeded its limit.");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.error) throw new Error(event.error);
        if ("result" in event) { result = event.result; completed = true; }
        else onProgress(event);
      }
      if (done) break;
    }
    if (!completed) throw new Error("Progress connection ended without a result. Source/review are retained; retry explicitly.");
    return result;
  } finally { await reader.cancel().catch(() => {}); }
}
